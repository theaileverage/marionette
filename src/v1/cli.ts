#!/usr/bin/env node
import { resolve } from 'node:path';
import { z } from 'zod';
import { errorMessage, parseCommand, positiveInteger, printJson, readInput } from './arguments.js';
import { Marionette } from './client.js';
import { execute, operationSchema } from './operations.js';
import { VERSION } from './version.js';

const help = `Marionette v1

  marionette init [--project PATH] [--state-home PATH]
  marionette context [--project BINDING_FILE]
  marionette <group> <action> --input FILE
  marionette exec --input FILE
  marionette schema
  marionette watch [--stop-after MILLISECONDS]

Input is JSON. Use --input - for stdin. All results are JSON.
For group/action commands, omit the operation field from input.
For exec, include an operation such as "board.post" or "job.create".
Managed agents inherit their project and session from MARIONETTE_CONTEXT.

Groups: workspace, input, job, workflow, attempt, brief, result, board, sql, profile
Use marionette schema to list supported operations.
`;

async function main() {
  const { values, positionals } = parseCommand(process.argv.slice(2));
  const [command, action] = positionals;
  if (values.version || command === 'version') {
    printJson({ version: VERSION });
    return;
  }
  if (values.help || !command || command === 'help') {
    process.stdout.write(help);
    return;
  }
  if (command === 'schema') {
    printJson({
      operations: operationSchema.options.map((option) => option.shape.operation.value),
    });
    return;
  }
  if (command === 'init') {
    if (process.env.MARIONETTE_CONTEXT)
      throw new Error('Managed sessions cannot initialize another project');
    const client = Marionette.init({
      repositoryRoot: resolve(values.project ?? process.cwd()),
      stateHome: values['state-home'],
    });
    try {
      printJson(client.context());
    } finally {
      client.close();
    }
    return;
  }
  const client = Marionette.connect({ bindingPath: values.project });
  try {
    if (command === 'watch') {
      const abort = new AbortController();
      const stop = () => abort.abort();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      const deadline = values['stop-after']
        ? setTimeout(stop, positiveInteger(values['stop-after'], 30_000))
        : null;
      try {
        printJson(await client.watch({ signal: abort.signal }));
      } finally {
        if (deadline) clearTimeout(deadline);
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
      }
      return;
    }
    const raw = values.input ? readInput(values.input, z.record(z.unknown())) : {};
    const input =
      command === 'exec'
        ? raw
        : {
            ...z.record(z.unknown()).parse(raw),
            operation: action ? `${command}.${action}` : command,
          };
    const operation = operationSchema.parse(input);
    printJson(await execute(client, operation));
    if (
      [
        'attempt.admit',
        'attempt.start',
        'board.post',
        'board.subscribe',
        'sql.contribute',
      ].includes(operation.operation)
    )
      await client.ensureWatcher();
  } finally {
    client.close();
  }
}

main().catch((error) => {
  process.stderr.write(JSON.stringify({ error: errorMessage(error) }) + '\n');
  process.exitCode = 1;
});
