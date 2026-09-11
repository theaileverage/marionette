import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { z } from 'zod';

export function parseCommand(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
      project: { type: 'string' },
      input: { type: 'string' },
      json: { type: 'boolean' },
      request: { type: 'string' },
      file: { type: 'string' },
      key: { type: 'string' },
      profile: { type: 'string' },
      socket: { type: 'string' },
      workspace: { type: 'string' },
      package: { type: 'string' },
      method: { type: 'string' },
      'stop-after': { type: 'string' },
      'state-home': { type: 'string' },
      timeout: { type: 'string' },
      limit: { type: 'string' },
      cursor: { type: 'string' },
      mode: { type: 'string' },
      wait: { type: 'boolean' },
      foreground: { type: 'boolean' },
    },
  });
}

export function readInput<T>(path: string | undefined, schema: z.ZodType<T>): T {
  if (!path) throw new Error('Provide --input FILE, or --input - to read JSON from stdin');
  const bytes = readFileSync(path === '-' ? 0 : path);
  if (bytes.byteLength > 1024 * 1024) throw new Error('JSON input exceeds 1 MiB');
  return schema.parse(JSON.parse(bytes.toString('utf8')));
}

export function positiveInteger(value: string | undefined, fallback: number): number {
  return value === undefined
    ? fallback
    : z.coerce.number().int().positive().max(2_147_483_647).parse(value);
}

export function printJson<T>(value: T): void {
  process.stdout.write(JSON.stringify(value) + '\n');
}

export function errorMessage<T>(error: T): string {
  return error instanceof Error ? error.message : String(error);
}
