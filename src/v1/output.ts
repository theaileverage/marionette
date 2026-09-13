import { z } from 'zod';
import { CliError } from './arguments.js';

export const outputModeSchema = z.enum(['human', 'json', 'ndjson']);
export type OutputMode = z.infer<typeof outputModeSchema>;
export function defaultOutput(): OutputMode {
  return process.stdin.isTTY && process.stdout.isTTY ? 'human' : 'json';
}
export function terminalText(text: string): string {
  return text.replace(
    /[\u0000-\u001f\u007f-\u009f]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
export function writeOutput<Value>(value: Value, mode: OutputMode) {
  if (mode === 'json') {
    process.stdout.write(JSON.stringify(value ?? null) + '\n');
    return;
  }
  if (mode === 'ndjson') {
    for (const row of Array.isArray(value) ? value : [value])
      process.stdout.write(JSON.stringify(row ?? null) + '\n');
    return;
  }
  const text = JSON.stringify(value ?? null, null, 2).replace(
    /[\u007f-\u009f]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  process.stdout.write(text.slice(0, 4000) + '\n');
  if (text.length > 4000)
    process.stdout.write(
      'Human output abbreviated. Repeat with --output json for the complete result.\n',
    );
}
// Errors are untrusted at the process boundary and classified before rendering.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export function writeError(error: unknown, mode: OutputMode, command?: string, started = false) {
  const retry = command ? `marionette schema ${command}` : 'marionette --help';
  const fields =
    error instanceof z.ZodError
      ? error.issues.map((issue) => issue.path.join('.')).filter(Boolean)
      : [];
  const result =
    error instanceof CliError
      ? { code: error.code, message: error.message, fields: error.fields, retry: error.retry }
      : error instanceof z.ZodError
        ? {
            code: 'invalid-input',
            message: 'Request fields do not match the command contract.',
            fields,
            retry,
          }
        : {
            code: 'operation-failed',
            message:
              error instanceof SyntaxError
                ? 'Stored or external JSON is invalid.'
                : error instanceof Error
                  ? error.message
                  : 'The operation failed.',
            fields: [],
            retry: started
              ? 'marionette context; inspect the target before retrying a mutation'
              : retry,
          };
  const envelope = { error: { ...result, mutation: started ? 'unknown' : 'not-started' } };
  if (mode === 'human')
    process.stderr.write(
      `Error: ${terminalText(result.message)}\n${result.fields.length ? `Fields: ${result.fields.map(terminalText).join(', ')}\n` : ''}Retry: ${terminalText(result.retry)}\n`,
    );
  else process.stderr.write(JSON.stringify(envelope) + '\n');
  return error instanceof CliError || error instanceof z.ZodError ? 2 : 1;
}
