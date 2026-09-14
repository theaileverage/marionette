#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { resolve } from 'node:path';
import {
  CliError,
  parseCommand,
  requestedOutput,
  positiveInteger,
  stringOption,
  validateOptions,
  operationInput,
} from './arguments.js';
import { Marionette } from './client.js';
import { execute, operationSchema } from './operations.js';
import { describeSchema, operationDescriptions } from './schema.js';
import {
  operationOutputSchemas,
  outputContractVersion,
  retirementPreviewOutputSchema,
} from './output-contracts.js';
import {
  cliVersion,
  contractVersion,
  commands,
  environmentContract,
  exitCodes,
  findCommand,
  globalOptions,
} from './command-registry.js';
import { defaultOutput, outputModeSchema, writeError, writeOutput } from './output.js';
import { installProjectSkill } from './onboarding.js';

let output = requestedOutput(process.argv.slice(2)) ?? defaultOutput();
let activeCommand: string | undefined;
let mutationStarted = false;
const basic = ['help', 'version', 'output', 'no-input'];
function help(name?: string) {
  const command = name ? findCommand(name) : undefined;
  if (name && !command)
    throw new CliError('unknown-command', 'Unknown command.', 'marionette --help');
  const value = command
    ? {
        version: cliVersion,
        command: name,
        summary: command.summary,
        usage: `marionette ${name?.replace('.', ' ')} [FLAGS | --input FILE | --json JSON_OR_FILE]`,
        flags: command.flags,
        effect: command.effect,
        stability: command.stability,
        schema: `marionette schema ${name}`,
      }
    : {
        version: cliVersion,
        usage: 'marionette <group> <action> [FLAGS | --input FILE | --json JSON_OR_FILE]',
        commands: commands.map(({ name, summary }) => ({ name, summary })),
        utilities: [
          'init [--project PATH] [--state-home PATH]',
          'schema [OPERATION]',
          'describe [OPERATION]',
          'watch [--stop-after MILLISECONDS]',
          '--version',
        ],
        output: 'TTY: human; pipes: JSON. Override with --output human|json|ndjson.',
        input:
          'Never prompts. Use --input - for JSON on stdin. Request flags and raw JSON are mutually exclusive.',
        examples: [
          'marionette board create --title Notes --idempotency-key notes',
          'marionette board read --thread-id THREAD_ID --limit 20',
          'marionette workspace retire --workspace-id WORKSPACE_ID --idempotency-key retire --dry-run',
        ],
      };
  if (output === 'human') {
    if (command)
      process.stdout.write(
        `${command.name}\n${command.summary}\n\nRequest flags:\n${command.flags.map((flag) => `  --${flag.name} ${flag.type === 'boolean' ? '' : flag.type.toUpperCase()}`).join('\n')}\n\nUse --input FILE or --json JSON_OR_FILE for nested requests.\nContract: marionette schema ${command.name} --output json\n`,
      );
    else
      process.stdout.write(
        `Marionette ${cliVersion}\n\n${commands.map((entry) => `  ${entry.name.replace('.', ' ').padEnd(22)} ${entry.summary}`).join('\n')}\n\nUtilities: init, schema, describe, watch, --version\nOutput: --output human|json|ndjson. No prompts.\nExample: marionette board create --title Notes --idempotency-key notes\n`,
      );
  } else writeOutput(value, output);
}
async function main() {
  const { values, positionals } = parseCommand(process.argv.slice(2));
  const chosenOutput = stringOption(values, 'output');
  if (chosenOutput !== undefined) output = outputModeSchema.parse(chosenOutput);
  const [command, action, extra] = positionals;
  if (command === 'help') {
    const name = action ? (extra ? `${action}.${extra}` : action) : undefined;
    if (positionals.length > 3)
      throw new CliError(
        'extra-arguments',
        'Unexpected positional arguments.',
        'marionette --help',
      );
    validateOptions(values, basic, 'marionette --help');
    help(name);
    return;
  }
  if (!command || command === 'version' || values.version) {
    validateOptions(values, basic, 'marionette --help');
    if (
      (values.version && positionals.length > 0 && command !== 'version') ||
      (command === 'version' && positionals.length > 1)
    )
      throw new CliError(
        'extra-arguments',
        'Version does not accept positional arguments.',
        'marionette --version',
      );
    if (command === 'version' || values.version) writeOutput({ version: cliVersion }, output);
    else help();
    return;
  }
  if (extra !== undefined)
    throw new CliError('extra-arguments', 'Unexpected positional arguments.', 'marionette --help');
  if (command === 'schema' || command === 'describe') {
    validateOptions(values, basic, 'marionette schema [OPERATION]');
    const selected = operationDescriptions().filter((item) => !action || item.operation === action);
    if (!selected.length)
      throw new CliError('unknown-command', 'Unknown operation.', 'marionette schema');
    writeOutput(
      {
        version: cliVersion,
        contractVersion,
        outputContractVersion,
        environment: environmentContract,
        exitCodes,
        input: {
          maximumBytes: 1048576,
          raw: ['--input FILE', '--input -', '--json JSON_OR_FILE'],
          conflicts: 'Raw JSON and request-building flags cannot be combined.',
        },
        output: {
          json: 'One unwrapped result value; retained for compatibility.',
          ndjson: 'One line per top-level array item; one line for other results.',
          human: 'At most 4000 characters, with explicit abbreviation notice.',
          errors: {
            stderr: {
              error: {
                code: 'string',
                message: 'string',
                fields: 'string[]',
                retry: 'string',
                mutation: 'not-started | unknown',
              },
            },
          },
        },
        operations: selected.map((description) => {
          const metadata = findCommand(description.operation);
          return {
            ...description,
            outputSchema: metadata
              ? describeSchema(operationOutputSchemas[metadata.name])
              : undefined,
            summary: metadata?.summary,
            flags: metadata?.flags,
            sideEffects: metadata?.effect,
            startsWatcher: metadata?.watcher ?? false,
            dryRun: description.operation === 'workspace.retire',
            dryRunOutputSchema:
              description.operation === 'workspace.retire'
                ? describeSchema(retirementPreviewOutputSchema)
                : undefined,
            stability: 'alpha',
            authorization: metadata?.controller
              ? 'active user or controller; operation-specific checks also apply'
              : 'authenticated project session; operation-specific checks also apply',
          };
        }),
      },
      output,
    );
    return;
  }
  if (command === 'init') {
    validateOptions(values, [...basic, 'project', 'state-home'], 'marionette init --help');
    if (action)
      throw new CliError(
        'extra-arguments',
        'Init does not accept positional arguments.',
        'marionette init --project PATH',
      );
    if (values.help) {
      writeOutput(
        {
          usage: 'marionette init --project PATH [--state-home PATH]',
          effect:
            'Create project binding, private local session and SQLite state, then install the project-local Marionette skill when absent.',
          output: 'Project context, installed skill path and a first lead-agent prompt.',
        },
        output,
      );
      return;
    }
    mutationStarted = true;
    const client = Marionette.init({
      repositoryRoot: resolve(stringOption(values, 'project') ?? process.cwd()),
      stateHome: stringOption(values, 'state-home'),
    });
    try {
      const context = client.context();
      writeOutput(
        {
          ...context,
          onboarding: {
            skill: installProjectSkill(context.project.repositoryRoot),
            nextPrompt:
              'Use Marionette to coordinate this task: inspect the repository and report how to run its tests.',
          },
        },
        output,
      );
    } finally {
      client.close();
    }
    return;
  }
  if (command === 'watch') {
    validateOptions(
      values,
      [...basic, 'project', 'stop-after', 'foreground'],
      'marionette watch --help',
    );
    if (action)
      throw new CliError(
        'extra-arguments',
        'Watch does not accept positional arguments.',
        'marionette watch --stop-after 5000',
      );
    if (values.help) {
      writeOutput(
        {
          usage: 'marionette watch [--project BINDING_FILE] [--stop-after MILLISECONDS]',
          effect:
            'Reconcile admitted execution and deliver eligible notifications until stopped or idle.',
          signals: ['SIGINT', 'SIGTERM'],
        },
        output,
      );
      return;
    }
    const timeout = stringOption(values, 'stop-after');
    const duration = timeout === undefined ? undefined : positiveInteger(timeout, 30000);
    const client = Marionette.connect({ bindingPath: stringOption(values, 'project') });
    const abort = new AbortController();
    const stop = () => abort.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    const deadline = duration === undefined ? undefined : setTimeout(stop, duration);
    try {
      mutationStarted = true;
      writeOutput(await client.watch({ signal: abort.signal }), output);
    } finally {
      if (deadline) clearTimeout(deadline);
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      client.close();
    }
    return;
  }
  const name = action ? `${command}.${action}` : command;
  activeCommand = name;
  if (values.help) {
    validateOptions(
      values,
      [...Object.keys(globalOptions), ...(findCommand(name)?.flags.map((flag) => flag.name) ?? [])],
      'marionette --help',
    );
    help(name);
    return;
  }
  const operation = operationSchema.parse(operationInput(name, values));
  activeCommand = operation.operation;
  const metadata = findCommand(operation.operation);
  if (values['dry-run'] && operation.operation !== 'workspace.retire')
    throw new CliError(
      'unsupported-preview',
      'Dry run is supported for workspace.retire.',
      'marionette workspace retire --help',
    );
  if (values['no-watch'] && !metadata?.watcher)
    throw new CliError(
      'irrelevant-option',
      '--no-watch applies only to commands that can start the watcher.',
      `marionette ${name.replace('.', ' ')} --help`,
    );
  if (values['dry-run'] && operation.operation === 'workspace.retire') {
    writeOutput(
      Marionette.previewRetirement({ bindingPath: stringOption(values, 'project') }, operation),
      output,
    );
    return;
  }
  const client = Marionette.connect({ bindingPath: stringOption(values, 'project') });
  try {
    mutationStarted = metadata?.effect !== 'read';
    const result = await execute(client, operation);
    writeOutput(result, output);
    if (metadata?.watcher && !values['no-watch']) {
      try {
        await client.ensureWatcher();
      } catch {
        if (output === 'human')
          process.stderr.write(
            'Warning: The operation completed, but its background watcher could not start.\nRetry: marionette watch\n',
          );
        else
          process.stderr.write(
            JSON.stringify({
              warning: {
                code: 'watcher-start-failed',
                message: 'The operation completed, but its background watcher could not start.',
                retry: 'marionette watch',
              },
            }) + '\n',
          );
      }
    }
  } finally {
    client.close();
  }
}
main().catch((error) => {
  process.exitCode = writeError(error, output, activeCommand, mutationStarted);
});
