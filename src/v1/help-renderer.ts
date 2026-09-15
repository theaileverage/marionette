import { commands, type CommandName } from './command-registry.js';

const sections = [
  { title: 'Get started', roots: ['context', 'route'] },
  { title: 'Work', roots: ['job', 'workflow', 'brief', 'result'] },
  { title: 'Execution', roots: ['attempt', 'native', 'profile'] },
  { title: 'Discussion', roots: ['board'] },
  { title: 'Delivery', roots: ['handoff'] },
  { title: 'Workspace and data', roots: ['workspace', 'input', 'sql'] },
] as const;

type HelpCommand = (typeof commands)[number];

function commandRoot(name: CommandName): string {
  return name.split('.')[0] ?? name;
}

function color(text: string, code: number, enabled: boolean): string {
  return enabled ? `\u001b[${code}m${text}\u001b[0m` : text;
}

function row(command: HelpCommand, width: number, colorEnabled: boolean): string {
  const name = command.name.replace('.', ' ');

  return `  ${color(name.padEnd(width), 36, colorEnabled)}  ${command.summary}`;
}

export function renderCommandHelp(command: HelpCommand, colorEnabled: boolean): string {
  const name = command.name.replace('.', ' ');

  const flags = command.flags.map((flag) => {
    const value = flag.type === 'boolean' ? '' : ` ${flag.type.toUpperCase()}`;

    return `  ${color(`--${flag.name}`, 36, colorEnabled)}${value}`;
  });

  return [
    color(`marionette ${name}`, 1, colorEnabled),
    command.summary,
    '',
    color('Usage:', 1, colorEnabled),
    `  marionette ${name} [FLAGS | --input FILE | --json JSON_OR_FILE]`,
    '',
    color('Request flags:', 1, colorEnabled),
    ...(flags.length ? flags : ['  None']),
    '',
    'Use --input FILE or --json JSON_OR_FILE for nested requests.',
    `Contract: marionette schema ${command.name} --output json`,
    '',
  ].join('\n');
}

export function renderMainHelp(version: string, colorEnabled: boolean): string {
  const width = Math.max(...commands.map((command) => command.name.replace('.', ' ').length));
  const listed = new Set<CommandName>();

  const groups: { title: string; members: HelpCommand[] }[] = sections.map((section) => {
    const members = commands.filter((command) =>
      section.roots.some((root) => commandRoot(command.name) === root),
    );

    for (const member of members) listed.add(member.name);

    return { title: section.title, members };
  });

  const unlisted = commands.filter((command) => !listed.has(command.name));

  if (unlisted.length) groups.push({ title: 'Other commands', members: unlisted });

  return [
    color(`Marionette ${version}`, 1, colorEnabled),
    'Coordinate durable work across coding agents.',
    '',
    color('Usage:', 1, colorEnabled),
    '  marionette [command] [flags]',
    '  marionette help [command]',
    '',
    ...groups.flatMap(({ title, members }) => [
      color(`${title}:`, 1, colorEnabled),
      ...members.map((command) => row(command, width, colorEnabled)),
      '',
    ]),
    color('Utilities:', 1, colorEnabled),
    `  ${color('init'.padEnd(width), 36, colorEnabled)}  Bind this project to Marionette`,
    `  ${color('schema'.padEnd(width), 36, colorEnabled)}  Inspect operation contracts`,
    `  ${color('describe'.padEnd(width), 36, colorEnabled)}  Describe operation contracts`,
    `  ${color('watch'.padEnd(width), 36, colorEnabled)}  Run the project watcher`,
    `  ${color('--version'.padEnd(width), 36, colorEnabled)}  Print the CLI version`,
    '',
    'Output: TTY uses human text; pipes use JSON. Override with --output human|json|ndjson.',
    'Input: No prompts. Use --input - for JSON on stdin.',
    '',
  ].join('\n');
}

export function helpColorEnabled(): boolean {
  return Boolean(process.stdout.isTTY) && !('NO_COLOR' in process.env) && process.env.TERM !== 'dumb';
}
