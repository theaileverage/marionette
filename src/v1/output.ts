import { Schema, SchemaIssue } from 'effect';
import { CliError } from './arguments.js';

export const outputModeSchema = Schema.Literals(['human', 'json', 'ndjson']);

export type OutputMode = typeof outputModeSchema.Type;

export function defaultOutput(): OutputMode {
  return process.stdin.isTTY && process.stdout.isTTY ? 'human' : 'json';
}

export function terminalText(text: string): string {
  return text.replace(
    /\p{Cc}/gu,
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

  const rendered = JSON.stringify(value ?? null, null, 2).replace(
    /[\u007f-\u009f]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

  process.stdout.write(rendered.slice(0, 4000) + '\n');

  if (rendered.length > 4000)
    process.stdout.write(
      'Human output abbreviated. Repeat with --output json for the complete result.\n',
    );
}

function schemaFields(error: Schema.SchemaError): readonly string[] {
  const formatted = SchemaIssue.makeFormatterStandardSchemaV1()(error.issue);

  return formatted.issues
    .map((issue) => issue.path?.map(String).join('.') ?? '')
    .filter((path) => path.length > 0);
}

export function writeError(cause: unknown, mode: OutputMode, command?: string, started = false) {
  const retry = command ? `marionette schema ${command}` : 'marionette --help';
  const fields = Schema.isSchemaError(cause) ? schemaFields(cause) : [];

  const result =
    cause instanceof CliError
      ? { code: cause.code, message: cause.message, fields: cause.fields, retry: cause.retry }
      : Schema.isSchemaError(cause)
        ? {
            code: 'invalid-input',
            message: 'Request fields do not match the command contract.',
            fields,
            retry,
          }
        : {
            code: 'operation-failed',
            message:
              cause instanceof SyntaxError
                ? 'Stored or external JSON is invalid.'
                : cause instanceof Error
                  ? cause.message
                  : 'The operation failed.',
            fields: [] satisfies readonly string[],
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

  return cause instanceof CliError || Schema.isSchemaError(cause) ? 2 : 1;
}
