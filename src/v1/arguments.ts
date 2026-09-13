import { closeSync, openSync, readSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { commands, findCommand, globalOptions } from './command-registry.js';

export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retry: string,
    readonly fields: readonly string[] = [],
  ) {
    super(message);
  }
}
type InputRecord = z.infer<ReturnType<typeof z.record<z.ZodUnknown>>>;
function parserOptions() {
  return Object.fromEntries([
    ...Object.entries(globalOptions),
    ...Object.entries({
      'state-home': { type: 'string' },
      'stop-after': { type: 'string' },
      foreground: { type: 'boolean' },
    } satisfies Record<string, { type: 'string' | 'boolean' }>),
    ...commands.flatMap((command) =>
      command.flags.map((flag) => [
        flag.name,
        { type: flag.type === 'boolean' ? 'boolean' : 'string' } satisfies {
          type: 'string' | 'boolean';
        },
      ]),
    ),
  ]);
}
export function requestedOutput(argv: string[]) {
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: false,
      options: parserOptions(),
    });
    const output = z.enum(['human', 'json', 'ndjson']).safeParse(parsed.values.output);
    return output.success ? output.data : undefined;
  } catch {
    return undefined;
  }
}
export function parseCommand(argv: string[]) {
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: parserOptions(),
    });
    return {
      positionals: parsed.positionals,
      values: z.record(z.union([z.string(), z.boolean()]).optional()).parse(parsed.values),
    };
  } catch {
    throw new CliError(
      'invalid-options',
      'Unknown option, missing option value, or invalid flag syntax.',
      'marionette --help',
    );
  }
}
export function stringOption(
  values: Record<string, string | boolean | undefined>,
  name: string,
): string | undefined {
  return z.string().optional().parse(values[name]);
}
export function validateOptions(
  values: Record<string, string | boolean | undefined>,
  allowed: readonly string[],
  retry: string,
) {
  const unexpected = Object.keys(values).filter((name) => !allowed.includes(name));
  if (unexpected.length)
    throw new CliError(
      'invalid-options',
      `Options are not supported by this command: ${unexpected.map((name) => `--${name}`).join(', ')}.`,
      retry,
      unexpected,
    );
}
export function readInput(path: string): InputRecord {
  let fd: number;
  try {
    fd = path === '-' ? 0 : openSync(path, 'r');
  } catch {
    throw new CliError(
      'input-unreadable',
      'Cannot open the JSON input file.',
      'marionette COMMAND --input READABLE_FILE',
    );
  }
  const limit = 1024 * 1024;
  const bytes = Buffer.alloc(limit + 1);
  let length = 0;
  try {
    for (;;) {
      const read = readSync(fd, bytes, length, bytes.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > limit)
        throw new CliError(
          'input-too-large',
          'JSON input exceeds 1 MiB.',
          'marionette schema COMMAND',
        );
    }
  } finally {
    if (fd !== 0) closeSync(fd);
  }
  return parseJson(bytes.subarray(0, length).toString('utf8'));
}
function parseJson(text: string): InputRecord {
  if (Buffer.byteLength(text) > 1024 * 1024)
    throw new CliError('input-too-large', 'JSON input exceeds 1 MiB.', 'marionette schema COMMAND');
  try {
    return z.record(z.unknown()).parse(JSON.parse(text));
  } catch {
    throw new CliError(
      'invalid-json',
      'Expected one valid JSON value.',
      'marionette schema COMMAND',
    );
  }
}
export function operationInput(name: string, values: Record<string, string | boolean | undefined>) {
  const command = findCommand(name);
  const retry =
    name === 'exec' ? 'marionette schema' : `marionette ${name.replace('.', ' ')} --help`;
  if (!command && name !== 'exec')
    throw new CliError('unknown-command', 'Unknown command.', 'marionette --help');
  const flags = command?.flags ?? [];
  validateOptions(
    values,
    [...Object.keys(globalOptions), ...flags.map((flag) => flag.name)],
    retry,
  );
  const input = stringOption(values, 'input');
  const json = stringOption(values, 'json');
  const suppliedFlags = flags.filter((flag) => values[flag.name] !== undefined);
  if (
    (input !== undefined && json !== undefined) ||
    ((input !== undefined || json !== undefined) && suppliedFlags.length)
  )
    throw new CliError(
      'conflicting-input',
      'Choose request flags, --input FILE, or --json JSON_OR_FILE. Do not combine them.',
      retry,
    );
  let raw: InputRecord;
  if (input !== undefined) raw = readInput(input);
  else if (json !== undefined) raw = /^\s*[[{]/.test(json) ? parseJson(json) : readInput(json);
  else {
    const built: Record<string, string | number | boolean | undefined> = {};
    for (const flag of suppliedFlags) {
      const value = values[flag.name];
      if (flag.type === 'number') {
        const number = z.coerce.number().finite().safeParse(value);
        if (!number.success)
          throw new CliError('invalid-input', 'Expected a finite number.', retry, [flag.field]);
        built[flag.field] = number.data;
      } else built[flag.field] = value;
    }
    raw = built;
  }
  const record = z.record(z.unknown()).parse(raw);
  if (name === 'exec') return record;
  if (record.operation !== undefined && record.operation !== name)
    throw new CliError(
      'command-mismatch',
      'The JSON operation does not match the selected command.',
      retry,
      ['operation'],
    );
  return { ...record, operation: name };
}
export function positiveInteger(value: string | undefined, fallback: number): number {
  return value === undefined
    ? fallback
    : z.coerce.number().int().positive().max(2_147_483_647).parse(value);
}
