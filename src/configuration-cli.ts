import { Effect, Schema } from 'effect';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { callEffect } from './config.js';
import { sync } from './effect-runtime.js';
import { findBinding } from './project-binding.js';
import { profileSchema } from './orchestration-types.js';
import { roleSchema } from './roles.js';

export const configurationHelp = {
  profiles: `Usage: marionette profiles [list|show ID|discover|set ID|remove ID|validate ID|default CATEGORY ID] [--project DIR]
  discover --kind codex|claude|agy|omp     Read the native model catalog
  set ID --kind KIND --model MODEL        Add or edit an exact model profile
    --name TEXT --reasoning EFFORT --supported-reasoning low,medium,high
    --categories orchestration,research --capabilities tools --strengths TEXT
    --can-delegate true|false --max-concurrency NUMBER
  validate ID                            Probe this model on your account (may incur usage)
  default CATEGORY ID                    Set a category default
  --file FILE                            Replace profiles from an array or {profiles, defaults}
New or changed models require validation. Existing running agents keep their model.`,
  roles: `Usage: marionette roles [list|show ID|set ID|remove ID] [--project DIR] [--global]
  set ID --profile PROFILE_ID --activity coordinate|inspect|documentation|implementation
    --can-delegate true|false             Add or edit a role
  --file FILE                            Replace roles from a JSON array
  --global                               Edit instance defaults instead of project overrides
Project roles override instance roles with the same ID. Removing an override reveals its default.
Use marionette profiles to configure and validate exact model profiles.`,
};
const profileList = Schema.Struct({
  profiles: Schema.mutable(Schema.Array(profileSchema)),
  profileDefaults: Schema.Record(Schema.String, Schema.String),
});
const roleList = Schema.Struct({
  roles: Schema.mutable(Schema.Array(roleSchema)),
  defaults: Schema.mutable(Schema.Array(roleSchema)),
  overrides: Schema.mutable(Schema.Array(roleSchema)),
});
function booleanValue(value: string | undefined, previous = false) {
  if (value === undefined) return previous;
  if (value !== 'true' && value !== 'false')
    throw new Error('Use true or false for --can-delegate');
  return value === 'true';
}
const csv = (value: string) =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export const configurationCommandEffect = Effect.fn('Cli.configuration')(function* (
  group: 'profiles' | 'roles',
  args: string[],
) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(configurationHelp[group]);
    return;
  }
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      project: { type: 'string' },
      home: { type: 'string' },
      file: { type: 'string' },
      global: { type: 'boolean' },
      profile: { type: 'string' },
      activity: { type: 'string' },
      kind: { type: 'string' },
      model: { type: 'string' },
      name: { type: 'string' },
      reasoning: { type: 'string' },
      'supported-reasoning': { type: 'string' },
      categories: { type: 'string' },
      capabilities: { type: 'string' },
      strengths: { type: 'string' },
      'max-concurrency': { type: 'string' },
      'can-delegate': { type: 'string' },
    },
  });
  const foreign =
    group === 'profiles'
      ? ['global', 'profile', 'activity']
      : [
          'kind',
          'model',
          'name',
          'reasoning',
          'supported-reasoning',
          'categories',
          'capabilities',
          'strengths',
          'max-concurrency',
        ];
  for (const key of foreign)
    if (args.some((arg) => arg === `--${key}` || arg.startsWith(`--${key}=`)))
      throw new Error(`--${key} is not an option for ${group}`);
  const action = positionals[0] ?? (values.file ? 'configure' : 'list');
  const id = positionals[1];
  const actions =
    group === 'profiles'
      ? ['list', 'show', 'configure', 'set', 'remove', 'discover', 'validate', 'default']
      : ['list', 'show', 'configure', 'set', 'remove'];
  if (!actions.includes(action))
    throw new Error(`Unknown ${group} command: ${action}. See ${group} --help.`);
  const needsId = ['show', 'set', 'remove', 'validate', 'default'].includes(action);
  const arity = action === 'default' ? 3 : needsId ? 2 : 1;
  if ((needsId && !id) || positionals.length > arity || (action === 'default' && !positionals[2]))
    throw new Error(`Invalid arguments for ${group} ${action}. See ${group} --help.`);
  if (values.file && action !== 'configure')
    throw new Error('--file requires configure or no subcommand');
  const { binding } = yield* sync('Cli.binding', () =>
    findBinding(values.project ?? process.cwd()),
  );
  if (values.home && values.home !== binding.home)
    throw new Error('--home must match the project binding');
  const call = (name: string, input: Schema.MutableJson) => callEffect(binding.home, name, input);
  const print = <T>(value: T) => console.log(JSON.stringify(value, null, 2));
  const lease = () => sync('Cli.lease', () => JSON.parse(readFileSync(binding.leasePath, 'utf8')));
  if (group === 'profiles') {
    if (action === 'discover' || action === 'validate') {
      if (action === 'discover' && !values.kind) throw new Error('discover requires --kind');
      print(
        yield* call(`profile.${action}`, {
          lease: yield* lease(),
          ...(action === 'discover' ? { kind: values.kind! } : { profileId: id! }),
        }),
      );
      return;
    }
    const board = yield* call('board.get', { projectId: binding.projectId }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(profileList)),
    );
    let profiles = board.profiles;
    let defaults = { ...board.profileDefaults };
    const previous = profiles.find((p) => p.id === id);
    if (action === 'list') {
      print({ profiles, defaults });
      return;
    }
    if (action === 'show') {
      if (!previous) throw new Error(`Unknown profile: ${id}`);
      print(previous);
      return;
    }
    if (action === 'configure') {
      if (!values.file) throw new Error('configure requires --file');
      const input = yield* sync('Cli.profilesFile', () =>
        JSON.parse(readFileSync(values.file!, 'utf8')),
      );
      profiles = yield* Schema.decodeUnknownEffect(Schema.mutable(Schema.Array(profileSchema)))(
        Array.isArray(input) ? input : input.profiles,
      );
      defaults = Array.isArray(input) ? defaults : (input.defaults ?? defaults);
    } else if (action === 'set') {
      const profile = yield* Schema.decodeUnknownEffect(profileSchema)({
        ...previous,
        id,
        name: values.name ?? previous?.name ?? id,
        kind: values.kind ?? previous?.kind,
        model: values.model ?? previous?.model,
        reasoning: values.reasoning ?? previous?.reasoning,
        supportedReasoning:
          values['supported-reasoning'] !== undefined
            ? csv(values['supported-reasoning'])
            : (previous?.supportedReasoning ?? []),
        categories:
          values.categories !== undefined
            ? csv(values.categories)
            : (previous?.categories ?? ['implementation']),
        capabilities:
          values.capabilities !== undefined
            ? csv(values.capabilities)
            : (previous?.capabilities ?? []),
        strengths: values.strengths ?? previous?.strengths ?? 'User-configured exact model profile',
        canDelegate: booleanValue(values['can-delegate'], previous?.canDelegate),
        maxConcurrency:
          values['max-concurrency'] !== undefined
            ? Number(values['max-concurrency'])
            : (previous?.maxConcurrency ?? 2),
      });
      profiles = [...profiles.filter((p) => p.id !== id), profile];
    } else if (action === 'remove') {
      if (!previous) throw new Error(`Unknown profile: ${id}`);
      profiles = profiles.filter((p) => p.id !== id);
      defaults = Object.fromEntries(Object.entries(defaults).filter(([, value]) => value !== id));
    } else if (action === 'default') defaults[id!] = positionals[2];
    print(yield* call('profile.configure', { lease: yield* lease(), profiles, defaults }));
    return;
  }
  const result = yield* call('role.list', { projectId: binding.projectId }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(roleList)),
  );
  let roles = values.global ? result.defaults : result.overrides;
  const previous = roles.find((r) => r.id === id);
  if (action === 'list') {
    print(values.global ? { roles: result.defaults } : result);
    return;
  }
  if (action === 'show') {
    const role = (values.global ? result.defaults : result.roles).find((r) => r.id === id);
    if (!role) throw new Error(`Unknown role: ${id}`);
    print(role);
    return;
  }
  if (action === 'configure') {
    if (!values.file) throw new Error('configure requires --file');
    roles = yield* sync('Cli.rolesFile', () =>
      Schema.decodeUnknownSync(Schema.mutable(Schema.Array(roleSchema)))(
        JSON.parse(readFileSync(values.file!, 'utf8')),
      ),
    );
  } else if (action === 'set') {
    const base = previous ?? result.roles.find((r) => r.id === id);
    const role = yield* Schema.decodeUnknownEffect(roleSchema)({
      id,
      profileId: values.profile ?? base?.profileId,
      activity: values.activity ?? base?.activity,
      canDelegate: booleanValue(values['can-delegate'], base?.canDelegate ?? id === 'lead'),
    });
    roles = [...roles.filter((r) => r.id !== id), role];
  } else if (action === 'remove') {
    if (!previous)
      throw new Error(`No ${values.global ? 'instance default' : 'project override'} role: ${id}`);
    roles = roles.filter((r) => r.id !== id);
  }
  print(
    yield* call('role.configure', {
      lease: yield* lease(),
      roles,
      scope: values.global ? 'instance' : 'project',
    }),
  );
});
