import { leadPreferencesSchema } from './lead-preferences.js';
import { agentAccessSchema, agentAccessArgs } from './agent-access.js';
import { prepareGuardLaunchEffect, verifyGuardHarnessEffect } from './harness-guard.js';
import { Effect, Config as Environment, Option, Result, Schedule, Schema, Struct } from 'effect';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { prompts, promptEffect } from './cli-prompts.js';
import {
  openLeadTerminalEffect,
  resumeLeadTerminalEffect,
  terminalLeadArgs,
} from './lead-terminal.js';
import { toolPathEffect, ensureDependenciesEffect } from './setup-dependencies.js';
import { trustWorkspace, workspaceTrustEnabled } from './workspace-trust.js';
import { callEffect, initConfig, loadConfig } from './config.js';
import { boundaryError, BoundaryError, herdrCall, sync } from './effect-runtime.js';
import { Herdr } from './herdr.js';
import { healthEffect } from './http-client.js';
import { execEffect, processEffect } from './process.js';
import { profileArgs } from './profiles.js';
import { renderLeadPrompt } from './prompts.js';
import { briefingSchema, leaseResponseSchema, projectSchema } from './response-schemas.js';
import { installRuntime } from './runtime.js';
import {
  AppError,
  credentialsSchema,
  leadAgentSchema,
  workspaceIdSchema,
  type Project,
} from './types.js';
import { privateJson } from './private-json.js';
export { privateJson } from './private-json.js';
import {
  mcpCommand,
  installProjectMcpEffect,
  projectMcpName,
  listClientReceipts,
} from './mcp-registration.js';
import { readInstanceState } from './instance-state.js';
export { mcpCommand } from './mcp-registration.js';
import { runtimeStatusEffect, upgradeInstanceEffect } from './runtime-upgrade.js';
import { maintenanceLockEffect } from './maintenance.js';
import { packageRoot } from './runtime.js';
import { SETUP_VERSION } from './version.js';
import { herdrSessionSocket } from './herdr-session.js';
import { setupWorkspaceEffect } from './setup-workspace.js';
import { installProjectSkills } from './project-skills.js';
export const setupSchema = Schema.Struct({
  project: Schema.mutableKey(Schema.optional(Schema.String)),
  home: Schema.mutableKey(Schema.optional(Schema.String)),
  name: Schema.mutableKey(
    Schema.optional(Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(100))),
  ),
  session: Schema.mutableKey(
    Schema.optional(Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]+$/))),
  ),
  socket: Schema.mutableKey(Schema.optional(Schema.String)),
  workspace: Schema.mutableKey(Schema.optional(workspaceIdSchema)),
  port: Schema.mutableKey(
    Schema.optional(
      Schema.Finite.check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(1024))
        .check(Schema.isLessThanOrEqualTo(65535)),
    ),
  ),
  lead: Schema.mutableKey(
    leadAgentSchema.pipe(Schema.withDecodingDefault(Effect.succeed('codex'))),
  ),
  leadName: Schema.mutableKey(
    Schema.Trim.check(Schema.isMinLength(1))
      .check(Schema.isMaxLength(100))
      .pipe(Schema.withDecodingDefault(Effect.succeed('Lead'))),
  ),
  leadProfile: Schema.mutableKey(Schema.optional(Schema.String.check(Schema.isMinLength(1)))),
  coordinatorOnly: Schema.mutableKey(
    Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  ),
  trustWorkspaces: Schema.mutableKey(
    Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  ),
  agentAccess: Schema.mutableKey(Schema.optionalKey(agentAccessSchema)),
  trustAgy: Schema.mutableKey(Schema.optional(Schema.Boolean)),
  mcp: Schema.mutableKey(
    Schema.Literals(['install', 'print', 'skip']).pipe(
      Schema.withDecodingDefault(Effect.succeed('install')),
    ),
  ),
  upgrade: Schema.mutableKey(
    Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  ),
  installSkills: Schema.mutableKey(
    Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  ),
  authorityMode: Schema.mutableKey(
    Schema.Literals(['conversation', 'external']).pipe(
      Schema.withDecodingDefault(Effect.succeed('conversation')),
    ),
  ),
  installTools: Schema.mutableKey(
    Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  ),
  takeover: Schema.mutableKey(
    Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  ),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type SetupOptions = Schema.Schema.Type<typeof setupSchema>;
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
export function leadRecoveryInstructions(
  root: string,
  home: string,
  lead: string,
  leadName: string,
) {
  return `To take control, run:\nmarionette setup --project ${quote(root)} --home ${quote(home)} --lead ${quote(lead)} --lead-name ${quote(leadName)} --takeover\nThen run marionette lead --project ${quote(root)}. The takeover invalidates the previous lead's credentials.\nFor a cooperative handover, ask the current lead to call lead_handover with toOwner and agent, save the returned lease to this project's lease file, then rerun setup with the matching --lead and --lead-name. init accepts the same options as setup.`;
}
export function setupPlan<Input extends object>(input: Input) {
  const supplied = Schema.decodeUnknownSync(
    setupSchema
      .mapFields(Struct.map(Schema.optional))
      .annotate({ parseOptions: { onExcessProperty: 'error' } }),
  )(input);
  const root = realpathSync(resolve(supplied.project ?? process.cwd()));
  if (!statSync(root).isDirectory()) throw new Error('Project must be an existing directory');
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 10);
  const bindingPath = resolve(root, '.marionette/project.json');
  const binding = existsSync(bindingPath) ? JSON.parse(readFileSync(bindingPath, 'utf8')) : null;
  const options = Schema.decodeSync(setupSchema)({
    lead: binding?.lead,
    leadName: binding?.leadName,
    leadProfile: binding?.leadProfile,
    coordinatorOnly: binding?.coordinatorOnly,
    authorityMode: binding?.authorityMode,
    trustAgy: binding?.trustAgy,
    mcp: binding?.mcp,
    ...supplied,
    agentAccess: { ...binding?.agentAccess, ...supplied.agentAccess },
    trustWorkspaces:
      supplied.trustWorkspaces ??
      (supplied.trustAgy === false
        ? false
        : (binding?.trustWorkspaces ?? (binding?.trustAgy !== undefined ? false : undefined))),
  });
  const configuredHome = Effect.runSync(Environment.option(Environment.string('MARIONETTE_HOME')));
  const dataHome = Effect.runSync(
    Environment.string('XDG_DATA_HOME').pipe(
      Environment.withDefault(resolve(homedir(), '.local/share')),
    ),
  );
  const legacy = resolve(root, '.marionette');
  const home = resolve(
    options.home ??
      Option.getOrUndefined(configuredHome) ??
      binding?.home ??
      (existsSync(resolve(legacy, 'config.json')) ? legacy : resolve(dataHome, 'marionette')),
  );
  const session = options.session ?? binding?.session ?? 'default';
  const sessionSelection =
    supplied.session !== undefined
      ? session === 'default'
        ? 'default'
        : 'named'
      : (binding?.sessionSelection ?? (session === 'default' ? 'default' : 'legacy'));
  const socket = resolve(
    options.socket ??
      (options.session && options.session !== binding?.session ? undefined : binding?.socket) ??
      herdrSessionSocket(session),
  );
  return {
    ...options,
    root,
    home,
    name: options.name ?? basename(root),
    session,
    sessionSelection,
    sessionExplicit: supplied.session !== undefined,
    socket,
    workspace: options.workspace ?? (socket === binding?.socket ? binding.workspace : undefined),
    workspaceExplicit: supplied.workspace !== undefined,
    savedProjectId: binding?.home && resolve(binding.home) === home ? binding.projectId : undefined,
    bindingPath,
    ownsWorkspace:
      binding?.ownsWorkspace === true &&
      (!options.workspace || options.workspace === binding.workspace) &&
      socket === binding.socket,
    ownsSession:
      session !== 'default' && binding?.ownsSession === true && socket === binding.socket,
    workspaceLabel: `Marionette ${hash}`,
    effects: [
      'Check required tools and report optional worker CLIs',
      ...Object.entries(options.agentAccess ?? {})
        .filter(([, mode]) => mode === 'full-access')
        .map(
          ([kind]) =>
            `Launch new ${kind} leads and workers with full harness access; host-managed restrictions still apply`,
        ),
      ...(options.installTools
        ? ['Install missing required tools using supported installers']
        : []),
      ...(options.installSkills
        ? [
            'Install the Marionette project skill in .agents/skills and .claude/skills, preserving customized files',
          ]
        : []),
      'Install a durable local runtime and start the loopback supervisor',
      'Create or reuse the selected Herdr session and project workspace',
      ...(options.trustWorkspaces
        ? [
            'Register workspace trust for the selected lead and future Codex, Claude Code, and AGY workers',
          ]
        : []),
      ...(options.mcp === 'install'
        ? [`Register MCP in ${options.lead === 'codex-desktop' ? 'codex' : options.lead}`]
        : []),
      'Save the named lead and private lease; preserve an existing lead unless takeover is explicit',
    ],
  };
}
export const wizardEffect = Effect.fn('Setup.wizard')(function* (input: Partial<SetupOptions>) {
  prompts.intro('Marionette setup', { output: process.stderr });
  prompts.log.info('Connect a project, choose its lead, and prepare your agents.', {
    output: process.stderr,
  });
  const ask = Effect.fn('Setup.ask')(
    (message: string, fallback: string, validate?: (value: string) => string | undefined) =>
      promptEffect((signal) =>
        prompts.text({
          message,
          initialValue: fallback,
          validate: (value) => validate?.(value ?? ''),
          signal,
          output: process.stderr,
        }),
      ).pipe(Effect.map((value) => value.trim())),
  );
  input.project ??= yield* ask('Project directory', process.cwd(), (value) => {
    try {
      return statSync(resolve(value)).isDirectory() ? undefined : 'Choose an existing directory.';
    } catch {
      return 'Choose an existing directory.';
    }
  });
  const defaults = yield* sync('Setup.defaults', () => setupPlan(input));
  if (input.home === undefined) {
    if (existsSync(defaults.bindingPath)) input.home = defaults.home;
    else {
      const storage = yield* promptEffect((signal) =>
        prompts.select({
          message: 'Where should Marionette store this project’s data?',
          initialValue: 'shared',
          signal,
          output: process.stderr,
          options: [
            { value: 'shared' as const, label: 'Shared instance', hint: defaults.home },
            {
              value: 'local' as const,
              label: 'Inside this project',
              hint: '.marionette, private state excluded from Git',
            },
            { value: 'custom' as const, label: 'Choose a directory' },
          ],
        }),
      );
      input.home =
        storage === 'local'
          ? resolve(defaults.root, '.marionette')
          : storage === 'custom'
            ? yield* ask('State directory', defaults.home, (value) =>
                value ? undefined : 'Enter a directory.',
              )
            : defaults.home;
    }
  }
  input.installSkills ??= yield* promptEffect((signal) =>
    prompts.confirm({
      message: 'Add the Marionette skill to this project in .agents/skills and .claude/skills?',
      initialValue: true,
      signal,
      output: process.stderr,
    }),
  );
  input.authorityMode ??= yield* promptEffect((signal) =>
    prompts.select({
      message: 'How should the lead record permission for requested work?',
      initialValue: defaults.authorityMode,
      signal,
      output: process.stderr,
      options: [
        {
          value: 'conversation' as const,
          label: 'Use your requests in conversation',
          hint: 'Trust the lead to record the activities and paths you authorize',
        },
        {
          value: 'external' as const,
          label: 'Require external authorization',
          hint: 'Use marionette authorize for each outcome',
        },
      ],
    }),
  );
  const nameError = (value: string) =>
    value.trim().length > 0 && value.trim().length <= 100 ? undefined : 'Enter 1–100 characters.';
  input.name ??= yield* ask('Project name', defaults.name, nameError);
  input.lead ??= yield* promptEffect((signal) =>
    prompts.select({
      message: 'Lead agent',
      initialValue: defaults.lead,
      signal,
      output: process.stderr,
      options: [
        {
          value: 'codex-desktop' as const,
          label: 'Codex desktop',
          hint: 'Prompt-only; requires coordinatorOnly: false',
        },
        { value: 'codex' as const, label: 'Codex CLI', hint: 'Open in Herdr' },
        { value: 'claude' as const, label: 'Claude Code', hint: 'Open in Herdr' },
        {
          value: 'agy' as const,
          label: 'AGY',
          hint: 'Legacy mode; requires coordinatorOnly: false',
        },
        { value: 'omp' as const, label: 'oh-my-pi', hint: 'Open in Herdr' },
      ],
    }),
  );
  input.leadName ??= yield* ask(
    'What would you like to call your lead?',
    defaults.leadName,
    nameError,
  );
  input.trustWorkspaces ??= yield* promptEffect((signal) =>
    prompts.confirm({
      message: 'Trust this project and its task directories in Codex, Claude Code, and AGY?',
      initialValue: defaults.trustWorkspaces,
      signal,
      output: process.stderr,
    }),
  );
  input.agentAccess ??= {};
  for (const kind of ['codex', 'claude', 'agy', 'omp'] as const) {
    input.agentAccess[kind] ??= yield* promptEffect((signal) =>
      prompts.select({
        message: `${kind} access for new Marionette sessions`,
        initialValue: defaults.agentAccess?.[kind] ?? 'inherit',
        signal,
        output: process.stderr,
        options: [
          { value: 'inherit' as const, label: 'Use native settings' },
          {
            value: 'full-access' as const,
            label: 'Full access',
            hint: 'Disable harness sandbox and approval prompts; host restrictions still apply',
          },
        ],
      }),
    );
  }
  input.mcp ??= yield* promptEffect((signal) =>
    prompts.select({
      message: 'Marionette MCP configuration',
      initialValue: defaults.mcp,
      signal,
      output: process.stderr,
      options: [
        { value: 'install' as const, label: 'Configure the selected agent' },
        { value: 'print' as const, label: 'Print the install command' },
        { value: 'skip' as const, label: 'Skip MCP configuration' },
      ],
    }),
  );
  return input;
});
export const wizard = (input: Partial<SetupOptions>) => Effect.runPromise(wizardEffect(input));
const availablePortEffect = Effect.fn('Setup.availablePort')(function* (requested?: number) {
  for (let port = requested ?? 4380; port <= (requested ?? 4480); port++) {
    const free = yield* Effect.callback<boolean>((resume) => {
      const server = net.createServer();
      server.once('error', () => resume(Effect.succeed(false)));
      server.listen(port, '127.0.0.1', () => server.close(() => resume(Effect.succeed(true))));
      return Effect.callback<void>((done) => {
        if (server.listening) server.close(() => done(Effect.void));
        else done(Effect.void);
      });
    });
    if (free) return port;
  }
  return yield* boundaryError('Setup.availablePort')(
    new Error(
      requested ? `Port ${requested} is occupied` : 'No free Marionette port from 4380 to 4480',
    ),
  );
});
/** Starting these daemons is an explicit persistent setup operation; they outlive this CLI. */
export const startDaemonEffect = Effect.fn('Setup.startDaemon')(function* (
  binary: string,
  args: string[],
  logPath: string,
) {
  const log = yield* Effect.acquireRelease(
    sync('Setup.openLog', () => openSync(logPath, 'a', 0o600)),
    (fd) => Effect.sync(() => closeSync(fd)),
  );
  yield* Effect.callback<void, AppError | BoundaryError>((resume) => {
    const child = spawn(binary, args, { detached: true, stdio: ['ignore', log, log] });
    child.once('error', (error) => resume(boundaryError('Setup.spawnDaemon')(error)));
    child.once('spawn', () => {
      child.unref();
      resume(Effect.void);
    });
  }).pipe(Effect.uninterruptible);
}, Effect.scoped);
const ensureHerdrEffect = Effect.fn('Setup.ensureHerdr')(function* (
  plan: ReturnType<typeof setupPlan>,
) {
  let h = new Herdr(plan.socket);
  const connected = yield* Effect.result(herdrCall(h, 'ping'));
  if (Result.isSuccess(connected)) return h;
  if (plan.socket !== herdrSessionSocket(plan.session) && plan.sessionSelection !== 'legacy')
    return yield* boundaryError('Setup.ensureHerdr')(
      new Error(`Cannot connect to supplied socket ${plan.socket}; start its Herdr session first`),
    );
  if (plan.sessionSelection === 'legacy' && plan.session !== 'default') {
    const absent = yield* sync('Setup.sessionAbsent', () => {
      try {
        statSync(plan.socket);
        return false;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true;
        throw error;
      }
    });
    if (!absent) return yield* connected.failure;
    if (plan.savedProjectId && plan.workspace) {
      const lease = yield* sync('Setup.migrationLease', () =>
        Schema.decodeUnknownSync(credentialsSchema)(
          JSON.parse(
            readFileSync(resolve(plan.home, 'leads', plan.savedProjectId + '.json'), 'utf8'),
          ),
        ),
      );
      yield* verifyReconnectProtocolEffect(plan.home, {
        lease,
        expectedWorkspaceId: plan.workspace,
        workspaceId: plan.workspace,
        expectedSocketPath: plan.socket,
        expectedSession: plan.session,
        session: 'default',
        socketPath: herdrSessionSocket('default'),
        preflight: true,
      });
    }
    plan.session = 'default';
    plan.socket = herdrSessionSocket('default');
    plan.workspace = undefined;
    plan.sessionSelection = 'default';
    plan.ownsSession = false;
    plan.ownsWorkspace = false;
    h = new Herdr(plan.socket);
    const shared = yield* Effect.result(herdrCall(h, 'ping'));
    if (Result.isSuccess(shared)) return h;
  }
  const ownsSession =
    plan.session !== 'default' &&
    plan.sessionSelection === 'named' &&
    !existsSync(dirname(plan.socket));
  yield* startDaemonEffect(
    'herdr',
    ['--session', plan.session, 'server'],
    resolve(plan.home, 'herdr.log'),
  );
  yield* herdrCall(h, 'ping', {}, 500).pipe(
    Effect.retry(Schedule.spaced(100).pipe(Schedule.upTo({ times: 99 }))),
  );
  plan.ownsSession ||= ownsSession;
  return h;
});
const verifyReconnectProtocolEffect = Effect.fn('Setup.reconnectProtocol')(function* (
  home: string,
  input: Schema.MutableJson,
) {
  const value = yield* callEffect(home, 'project.reconnect', input);
  if (
    Schema.decodeUnknownOption(Schema.Struct({ reconnectProtocol: Schema.Literal(1) }))(value)
      ._tag === 'None'
  )
    return yield* new AppError({
      code: 'supervisor_upgrade_required',
      message:
        'The running supervisor does not support safe workspace recovery. Upgrade and restart this Marionette instance before retrying. No replacement workspace was created.',
      status: 409,
    });
});
const recoverProjectWorkspaceEffect = Effect.fn('Setup.recoverProjectWorkspace')(function* (
  home: string,
  project: Project,
  h: Herdr,
  plan: ReturnType<typeof setupPlan>,
) {
  const migrating = project.socketPath !== plan.socket || project.session !== plan.session;
  const { workspaces } = yield* herdrCall(h, 'workspace.list');
  if (
    !migrating &&
    workspaces.some((w: { workspace_id: string }) => w.workspace_id === project.workspaceId) &&
    (!plan.workspaceExplicit || plan.workspace === project.workspaceId)
  ) {
    yield* herdrCall(h, 'workspace.get', { workspace_id: project.workspaceId });
    return { project, ownsWorkspace: plan.ownsWorkspace };
  }
  const lease = yield* sync('Setup.reconnectLease', () =>
    Schema.decodeUnknownSync(credentialsSchema)(
      JSON.parse(readFileSync(resolve(home, 'leads', project.id + '.json'), 'utf8')),
    ),
  );
  if (lease.projectId !== project.id)
    return yield* new AppError({
      code: 'project_lease_mismatch',
      message: 'The saved lease belongs to another project.',
      status: 409,
    });
  const request = {
    lease,
    expectedWorkspaceId: project.workspaceId,
    expectedSocketPath: project.socketPath,
    expectedSession: project.session,
    session: plan.session,
    socketPath: plan.socket,
  };
  yield* verifyReconnectProtocolEffect(home, {
    ...request,
    workspaceId: project.workspaceId,
    preflight: true,
  });
  if (
    !migrating &&
    workspaces.some((w: { workspace_id: string }) => w.workspace_id === project.workspaceId)
  )
    return yield* new AppError({
      code: 'workspace_still_exists',
      message: 'The original workspace still exists. Setup will not replace an active connection.',
      status: 409,
    });
  const selected = yield* setupWorkspaceEffect(h, {
    ...plan,
    workspace: migrating && !plan.workspaceExplicit ? undefined : plan.workspace,
  });
  const updated = yield* Schema.decodeUnknownEffect(projectSchema)(
    yield* callEffect(home, 'project.reconnect', { ...request, workspaceId: selected.workspaceId }),
  ).pipe(Effect.mapError(boundaryError('setup.decode')));
  return { project: updated, ownsWorkspace: selected.ownsWorkspace };
});
export function leadPrompt(
  projectId: string,
  leadName: string,
  leasePath: string,
  projectName = `Marionette project ${projectId}`,
) {
  return renderLeadPrompt({ projectId, projectName, leadName, leasePath });
}
export const runSetupEffect = Effect.fn('runSetup')(function* (
  input: Partial<SetupOptions>,
  interactive = false,
) {
  const p = yield* sync('runSetup.runSetup', () => setupPlan(input));
  if (p.coordinatorOnly && (p.lead === 'codex-desktop' || p.lead === 'agy'))
    return yield* new AppError({
      code: 'guard_unsupported',
      message:
        'Coordinator enforcement requires Codex CLI, Claude Code, or oh-my-pi. Select --lead codex, --lead claude, or --lead omp. Legacy prompt-only setups require coordinatorOnly: false in the setup configuration.',
      status: 400,
    });
  const dependencies = yield* ensureDependenciesEffect(p, interactive);
  if (p.coordinatorOnly && p.lead !== 'codex-desktop')
    yield* verifyGuardHarnessEffect(p.lead, p.root);
  const status = yield* runtimeStatusEffect(p.home);
  if (status.needsUpgrade || (p.upgrade && existsSync(resolve(p.home, 'config.json')))) {
    const approved =
      p.upgrade ||
      (interactive &&
        (yield* promptEffect((signal) =>
          prompts.confirm({
            message: `Upgrade the saved runtime (${status.versions.join(', ') || status.runningVersion}) to ${status.targetVersion}? This restarts the shared supervisor for ${status.projects.length} project(s) and refreshes MCP.`,
            initialValue: true,
            signal,
            output: process.stderr,
          }),
        )));
    if (!approved)
      return yield* new AppError({
        code: 'runtime_upgrade_required',
        message: `Saved/running Marionette runtime is older or different from this CLI (${status.targetVersion}). Run marionette update --home ${quote(p.home)}, or repeat setup --upgrade.`,
        status: 409,
      });
    yield* upgradeInstanceEffect(p.home, packageRoot);
  }
  yield* maintenanceLockEffect(p.home);
  const progress = yield* Effect.acquireRelease(
    sync('Setup.progress', () => {
      const progress = interactive ? prompts.spinner({ output: process.stderr }) : undefined;
      progress?.start('Preparing the local supervisor');
      return progress;
    }),
    (progress, exit) =>
      Effect.sync(() =>
        progress?.stop(exit._tag === 'Success' ? 'Project configured' : 'Setup failed'),
      ),
  );
  yield* sync('runSetup.runSetup', () => mkdirSync(p.home, { recursive: true, mode: 0o700 }));
  const lockPath = yield* sync('runSetup.runSetup', () => resolve(p.home, 'setup.lock'));
  const lockId = randomUUID();
  yield* Effect.acquireRelease(
    sync('Setup.lock', () => {
      const fd = openSync(lockPath, 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, id: lockId }));
      } catch (error) {
        closeSync(fd);
        unlinkSync(lockPath);
        throw error;
      }
      return fd;
    }),
    (fd) =>
      Effect.sync(() => {
        closeSync(fd);
        if (existsSync(lockPath)) {
          const owner = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.String }))(
            JSON.parse(readFileSync(lockPath, 'utf8')),
          );
          if (owner._tag === 'Some' && owner.value.id === lockId) unlinkSync(lockPath);
        }
      }),
  );
  const runtime = yield* sync('runSetup.runSetup', () => installRuntime(p.home));
  const skills = p.installSkills
    ? yield* sync('Setup.installProjectSkills', () => installProjectSkills(p.root, runtime))
    : [];
  if (!existsSync(resolve(p.home, 'config.json')))
    initConfig(p.home, yield* availablePortEffect(p.port));
  const config = yield* sync('runSetup.runSetup', () => loadConfig(p.home));
  if (p.port && config.port !== p.port)
    return yield* boundaryError('runSetup.runSetup')(
      new Error(
        `Existing instance uses port ${config.port}; use a separate --home for a new port.`,
      ),
    );
  yield* execEffect(
    process.execPath,
    [resolve(runtime, 'dist/cli.js'), 'start', '--home', p.home],
    { timeout: 15000 },
  );
  const health = yield* healthEffect(`http://127.0.0.1:${config.port}/health`);
  if (health.setupVersion !== SETUP_VERSION)
    return yield* boundaryError('runSetup.runSetup')(
      new Error(
        'The running supervisor does not support the 0.2 orchestration contract. Run marionette stop and marionette start with this --home, then repeat setup. Existing workers and state remain in Herdr and Marionette.',
      ),
    );
  progress?.message('Connecting the project’s Herdr workspace');
  let savedProject: Project | undefined;
  if (p.savedProjectId) {
    const saved = yield* Schema.decodeUnknownEffect(briefingSchema)(
      yield* callEffect(p.home, 'project.briefing', { projectId: p.savedProjectId }),
    ).pipe(Effect.mapError(boundaryError('setup.decode')));
    savedProject = saved.project;
    if (savedProject.root !== p.root)
      return yield* new AppError({
        code: 'project_connection_changed',
        message: 'The saved project belongs to another root.',
        status: 409,
      });
    if (!p.sessionExplicit) {
      p.session = savedProject.session;
      p.socket = savedProject.socketPath;
      if (!p.workspaceExplicit) p.workspace = savedProject.workspaceId;
      if (p.session === 'default') p.sessionSelection = 'default';
    }
  }
  const h = yield* ensureHerdrEffect(p);
  let project: Project;
  let ownsWorkspace = p.ownsWorkspace;
  if (savedProject) {
    const recovered = yield* recoverProjectWorkspaceEffect(p.home, savedProject, h, p);
    project = recovered.project;
    ownsWorkspace = recovered.ownsWorkspace;
  } else {
    const selected = yield* setupWorkspaceEffect(h, p);
    ownsWorkspace = selected.ownsWorkspace;
    project = yield* Schema.decodeUnknownEffect(projectSchema)(
      yield* callEffect(p.home, 'project.register', {
        name: p.name,
        root: p.root,
        session: p.session,
        socketPath: p.socket,
        workspaceId: selected.workspaceId,
        trustWorkspaces: p.trustWorkspaces,
        agentAccess: p.agentAccess ?? {},
      }),
    ).pipe(Effect.mapError(boundaryError('setup.decode')));
  }
  const workspaceId = project.workspaceId;
  const ownsSession = p.session !== 'default' && p.ownsSession;
  const leasePath = yield* sync('runSetup.runSetup', () =>
    resolve(p.home, 'leads', project.id + '.json'),
  );
  let lease = yield* sync('runSetup.runSetup', () =>
    existsSync(leasePath)
      ? Schema.decodeUnknownSync(credentialsSchema)(JSON.parse(readFileSync(leasePath, 'utf8')))
      : null,
  );
  const briefing = yield* Schema.decodeUnknownEffect(briefingSchema)(
    yield* callEffect(p.home, 'project.briefing', { projectId: project.id }),
  ).pipe(Effect.mapError(boundaryError('setup.decode')));
  const same = briefing.lead?.owner === p.leadName && briefing.lead?.agent === p.lead;
  let takeover = p.takeover;
  if (
    briefing.lead &&
    !(
      same &&
      lease &&
      lease.epoch === briefing.lead.epoch &&
      lease.owner === briefing.lead.owner
    ) &&
    !takeover
  ) {
    if (interactive) {
      progress?.stop('Existing lead requires a decision');
      const currentOwner = briefing.lead.owner;
      takeover = yield* promptEffect((signal) =>
        prompts.confirm({
          message: `${currentOwner} currently controls this project. Take over as ${p.leadName} (${p.lead}) and invalidate the previous lead's credentials?`,
          initialValue: false,
          signal,
          output: process.stderr,
        }),
      );
      progress?.start('Configuring the project lead');
    }
    if (!takeover)
      return yield* boundaryError('runSetup.runSetup')(
        new Error(
          `${briefing.lead.owner} already controls this project.\n${leadRecoveryInstructions(p.root, p.home, p.lead, p.leadName)}`,
        ),
      );
  }
  if (!briefing.lead || takeover) {
    lease = (yield* Schema.decodeUnknownEffect(leaseResponseSchema)(
      yield* callEffect(p.home, 'lead.acquire', {
        projectId: project.id,
        owner: p.leadName,
        agent: p.lead,
        expectedEpoch: briefing.lead?.epoch ?? 0,
        takeover,
        reason: 'Selected during Marionette setup',
      }),
    ).pipe(Effect.mapError(boundaryError('setup.decode')))).lease;
    yield* sync('runSetup.runSetup', () => privateJson(leasePath, lease));
  }
  yield* callEffect(p.home, 'project.configure', {
    lease,
    authorityMode: p.authorityMode,
    coordinatorOnly: p.coordinatorOnly,
    trustWorkspaces: p.trustWorkspaces,
    agentAccess: p.agentAccess ?? {},
  });
  const binding = {
    version: 1,
    home: p.home,
    instanceId: config.id,
    projectId: project.id,
    root: p.root,
    session: p.session,
    sessionSelection: p.sessionSelection,
    socket: p.socket,
    workspace: workspaceId,
    ownsWorkspace,
    ownsSession,
    lead: p.lead,
    leadName: p.leadName,
    leadProfile: p.leadProfile,
    coordinatorOnly: p.coordinatorOnly,
    authorityMode: p.authorityMode,
    leasePath,
    runtime,
    runtimeExecutable: process.execPath,
    agentAccess: p.agentAccess,
    trustWorkspaces: p.trustWorkspaces,
    mcp: p.mcp,
  };
  yield* sync('runSetup.runSetup', () => {
    privateJson(p.bindingPath, binding);
    privateJson(resolve(p.home, 'runtime.json'), { runtime, version: status.targetVersion });
  });
  const ignore = yield* sync('runSetup.runSetup', () =>
    resolve(dirname(p.bindingPath), '.gitignore'),
  );
  if (!existsSync(ignore))
    yield* sync('runSetup.runSetup', () => writeFileSync(ignore, '*\n', { flag: 'wx' }));
  const trust = yield* sync('runSetup.runSetup', () =>
    p.trustWorkspaces
      ? trustWorkspace(p.root, p.lead === 'codex-desktop' ? 'codex' : p.lead, p.home, project.id)
      : { changed: false, disabled: true },
  );
  const mcpName = yield* sync('Setup.mcpName', () =>
    projectMcpName(p.lead, p.home, project.id, p.name, p.leadName, runtime),
  );
  const command = yield* sync('runSetup.runSetup', () =>
    mcpCommand(p.lead, mcpName, runtime, p.home),
  );
  progress?.message('Configuring the selected MCP client');
  const retireShared = yield* sync('Setup.sharedMcpConsumers', () => {
    const state = readInstanceState(p.home),
      receipts = listClientReceipts(p.home, command.binary);
    return state.projects.every((other) => {
      if (other.id === project.id) return true;
      const binding = state.bindings.find((b) => b.binding.projectId === other.id)?.binding;
      if (!binding) return false;
      const client = binding.lead === 'codex-desktop' ? 'codex' : binding.lead;
      return (
        client !== command.binary || receipts.some(({ receipt }) => receipt.projectId === other.id)
      );
    });
  });
  const mcpStatus =
    p.mcp === 'install'
      ? yield* installProjectMcpEffect(command, p.home, project.id, retireShared)
      : p.mcp;
  const prompt = yield* sync('runSetup.runSetup', () =>
    leadPrompt(project.id, p.leadName, leasePath, project.name),
  );
  const promptPath = yield* sync('runSetup.runSetup', () =>
    resolve(p.home, 'leads', project.id + '.md'),
  );
  yield* sync('runSetup.runSetup', () => writeFileSync(promptPath, prompt + '\n', { mode: 0o600 }));
  return {
    ok: true,
    dependencies,
    skills,
    home: p.home,
    projectId: project.id,
    project: project.name,
    session: p.session,
    workspace: workspaceId,
    ownsWorkspace,
    ownsSession,
    lead: { agent: p.lead, name: p.leadName, leasePath, promptPath },
    runtime,
    trust,
    mcp: { status: mcpStatus, ...command },
    dashboard: `http://127.0.0.1:${config.port}`,
    next:
      p.lead === 'codex-desktop'
        ? 'Refresh MCP in Codex desktop, then give your lead the prompt file.'
        : 'Run marionette lead from this project to open your chosen lead.',
    prompt,
  };
}, Effect.scoped);
export const runSetup = (input: Partial<SetupOptions>) => Effect.runPromise(runSetupEffect(input));
export const launchLeadEffect = Effect.fn('launchLead')(function* (
  project: string,
  printOnly: boolean,
  profileId?: string,
) {
  while (!existsSync(resolve(project, '.marionette/project.json'))) {
    if (dirname(project) === project)
      return yield* boundaryError('launchLead.launchLead')(
        new Error('No configured Marionette project found. Run marionette setup first.'),
      );
    yield* sync('launchLead.launchLead', () => (project = dirname(project)));
  }
  const binding = yield* sync('launchLead.launchLead', () =>
    JSON.parse(readFileSync(resolve(project, '.marionette/project.json'), 'utf8')),
  );
  const brief = yield* Schema.decodeUnknownEffect(briefingSchema)(
    yield* callEffect(binding.home, 'project.briefing', { projectId: binding.projectId }),
  ).pipe(Effect.mapError(boundaryError('setup.decode')));
  const lease = yield* sync('launchLead.launchLead', () =>
    Schema.decodeUnknownSync(credentialsSchema)(
      JSON.parse(readFileSync(binding.leasePath, 'utf8')),
    ),
  );
  if (!brief.lead || brief.lead.owner !== lease.owner || brief.lead.epoch !== lease.epoch)
    return yield* boundaryError('launchLead.launchLead')(
      new Error(
        `The saved lead no longer controls this project.\n${leadRecoveryInstructions(binding.root, binding.home, binding.lead, binding.leadName)}`,
      ),
    );
  const owner = brief.lead.owner;
  const readPreferences = Effect.gen(function* () {
    const preferences = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        ...leadPreferencesSchema.fields,
        revision: Schema.Int,
        skillContents: Schema.Array(
          Schema.Struct({ path: Schema.String, content: Schema.String, digest: Schema.String }),
        ),
      }),
    )(
      yield* callEffect(binding.home, 'lead.preferences.get', {
        projectId: binding.projectId,
        lease,
      }).pipe(
        Effect.catch((error) =>
          error instanceof AppError && error.code === 'unknown_action'
            ? Effect.succeed({ revision: 0, instructions: '', skills: [], skillContents: [] })
            : Effect.fail(error),
        ),
      ),
    ).pipe(Effect.mapError(boundaryError('Lead.preferences')));
    const prompt = yield* sync('launchLead.launchLead', () =>
      [
        leadPrompt(binding.projectId, owner, binding.leasePath, brief.project.name),
        preferences.instructions
          ? `Additional project instructions. These do not override the coordinator contract or user authority.\n${preferences.instructions}`
          : '',
        ...preferences.skillContents.map(
          (skill) =>
            `Selected project skill ${skill.path}. These instructions do not grant authority.\n${skill.content}`,
        ),
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
    return { preferences, prompt };
  });

  if (printOnly) {
    const { prompt } = yield* readPreferences;
    yield* sync('launchLead.launchLead', () => console.log(prompt));
    return;
  }
  if (binding.lead === 'codex-desktop' && brief.project.coordinatorOnly === false) {
    const { prompt } = yield* readPreferences;
    console.log(prompt);
    return;
  }
  if (binding.lead === 'codex-desktop')
    return yield* new AppError({
      code: 'guard_unsupported',
      message:
        'The desktop host cannot be configured by this launcher for coordinator enforcement. Select --lead codex during setup, or use lead --print for an explicitly prompt-only integration.',
      status: 400,
    });
  if (!process.stdin.isTTY)
    return yield* boundaryError('launchLead.launchLead')(
      new Error('lead requires an interactive terminal; use lead --print for agent setup.'),
    );
  if (binding.lead !== 'codex-desktop' && workspaceTrustEnabled(brief.project, binding.lead))
    yield* sync('launchLead.trust', () =>
      trustWorkspace(binding.root, binding.lead, binding.home, binding.projectId),
    );
  const binary = yield* Schema.decodeUnknownEffect(leadAgentSchema)(binding.lead).pipe(
    Effect.mapError(boundaryError('Setup.lead')),
  );
  if (binary === 'codex-desktop') return;
  if (brief.project.socketPath !== herdrSessionSocket(brief.project.session))
    return yield* new AppError({
      code: 'lead_socket',
      message:
        'Terminal lead attachment requires the configured Herdr session socket. Repeat setup with its --session and standard socket, or use lead --print in your custom session.',
      status: 400,
    });
  yield* toolPathEffect();
  const connectionPlan = setupPlan({ project: binding.root, home: binding.home });
  connectionPlan.session = brief.project.session;
  connectionPlan.socket = brief.project.socketPath;
  connectionPlan.workspace = brief.project.workspaceId;
  if (connectionPlan.session === 'default') connectionPlan.sessionSelection = 'default';
  const h = yield* ensureHerdrEffect(connectionPlan);
  const recovered = yield* recoverProjectWorkspaceEffect(
    binding.home,
    brief.project,
    h,
    connectionPlan,
  );
  binding.session = recovered.project.session;
  binding.socket = recovered.project.socketPath;
  binding.workspace = recovered.project.workspaceId;
  binding.ownsWorkspace = recovered.ownsWorkspace;
  binding.sessionSelection = connectionPlan.sessionSelection;
  binding.ownsSession = connectionPlan.ownsSession;
  yield* sync('Lead.saveConnection', () =>
    privateJson(resolve(binding.root, '.marionette/project.json'), binding),
  );
  const lockPath = resolve(binding.root, '.marionette/lead.lock');
  yield* Effect.gen(function* () {
    yield* Effect.acquireRelease(
      sync('Lead.lock', () => {
        const fd = openSync(lockPath, 'wx', 0o600);
        closeSync(fd);
      }),
      () => Effect.sync(() => unlinkSync(lockPath)),
    );
    // Recheck authority after acquiring the lock and before creating an agent.
    const current = yield* Schema.decodeUnknownEffect(briefingSchema)(
      yield* callEffect(binding.home, 'project.briefing', { projectId: binding.projectId }),
    ).pipe(Effect.mapError(boundaryError('Lead.briefing')));
    if (
      !current.lead ||
      current.lead.owner !== lease.owner ||
      current.lead.epoch !== lease.epoch ||
      current.lead.agent !== binary
    )
      return yield* new AppError({
        code: 'lead_changed',
        message: 'Lead ownership changed during launch. Refresh setup before retrying.',
        status: 409,
      });
    const receiptPath = resolve(binding.home, 'leads', binding.projectId + '.terminal.json');
    const receipt = yield* sync('Lead.previousReceipt', () =>
      existsSync(receiptPath)
        ? Schema.decodeUnknownOption(
            Schema.Struct({
              launchHash: Schema.optional(Schema.String),
              pane_id: Schema.String,
              terminal_id: Schema.String,
              agent_session: Schema.optional(
                Schema.NullOr(Schema.Struct({ value: Schema.String })),
              ),
            }),
          )(JSON.parse(readFileSync(receiptPath, 'utf8')))
        : Option.none(),
    );
    const resumed = yield* resumeLeadTerminalEffect(
      h,
      {
        projectId: binding.projectId,
        root: binding.root,
        workspace: binding.workspace,
        epoch: lease.epoch,
        owner,
        kind: binary,
      },
      Option.getOrUndefined(receipt),
      current.project.coordinatorOnly !== false,
    );
    if (resumed) {
      console.log('Reconnected to the existing lead conversation.');
      console.log(
        'The running lead keeps its model and reasoning. Saved preferences apply on the next new launch. Read lead_preferences_get in the conversation to apply updated instructions and skills.',
      );
      return;
    }
    const { preferences, prompt } = yield* readPreferences;
    const requestedProfile =
      profileId ??
      preferences.profileId ??
      binding.leadProfile ??
      current.roles?.find((r) => r.id === 'lead')?.profileId ??
      current.profileDefaults?.orchestration;
    const profile = yield* sync('launchLead.launchLead', () =>
      requestedProfile ? current.profiles.find((p) => p.id === requestedProfile) : undefined,
    );
    if (requestedProfile && (!profile || profile.availability !== 'available'))
      return yield* boundaryError('launchLead.launchLead')(
        new Error(
          'The requested lead model profile is not validated. Run profile.validate for its exact ID first. No fallback was selected.',
        ),
      );
    if (profile && profile.kind !== binding.lead)
      return yield* boundaryError('launchLead.launchLead')(
        new Error(
          'The requested profile runtime differs from the configured lead. Select the intended lead explicitly.',
        ),
      );
    const reasoning =
      !profileId && preferences.profileId === profile?.id
        ? (preferences.reasoning ?? profile?.reasoning)
        : profile?.reasoning;
    if (profile && reasoning && !profile.supportedReasoning.includes(reasoning))
      return yield* new AppError({
        code: 'reasoning_unsupported',
        message:
          'Saved reasoning is no longer supported by the selected profile. Update lead preferences before launch.',
        status: 400,
      });
    const model = yield* sync('launchLead.launchLead', () =>
      profile ? profileArgs({ ...profile, reasoning }) : [],
    );
    const promptPath = resolve(binding.home, 'leads', binding.projectId + '.md');
    yield* sync('Lead.promptFile', () => writeFileSync(promptPath, prompt + '\n', { mode: 0o600 }));
    const guarded = current.project.coordinatorOnly !== false;
    const guardArgs = guarded
      ? yield* prepareGuardLaunchEffect({
          kind: binary,
          directory: resolve(binding.home, 'guards', binding.projectId, `lead-${lease.epoch}`),
          executable: binding.runtimeExecutable ?? process.execPath,
          cliPath: resolve(binding.runtime, 'dist/cli.js'),
          policy: {
            version: 1,
            root: binding.root,
            role: 'coordinate',
            instructions: prompt,
            mcpName: 'marionette_lead',
            ownership: [],
          },
          server: {
            command: binding.runtimeExecutable ?? process.execPath,
            args: [
              resolve(binding.runtime, 'dist/mcp.js'),
              '--lead-lease',
              binding.leasePath,
              '--url',
              `http://127.0.0.1:${loadConfig(binding.home).port}`,
            ],
          },
        })
      : [];
    if (guarded && !current.project.coordinatorOnly)
      yield* callEffect(binding.home, 'project.configure', { lease, coordinatorOnly: true });
    const launchArgs = terminalLeadArgs(
      binary,
      guarded
        ? [...model, ...guardArgs]
        : agentAccessArgs(binary, current.project.agentAccess, model),
      promptPath,
      guarded,
    );
    const launchHash = createHash('sha256')
      .update(JSON.stringify({ args: launchArgs, prompt, runtime: binding.runtime }))
      .digest('hex');
    const opened = yield* openLeadTerminalEffect(h, {
      projectId: binding.projectId,
      root: binding.root,
      workspace: binding.workspace,
      epoch: lease.epoch,
      owner,
      kind: binary,
      args: launchArgs,
      guard: guarded ? { launchHash } : undefined,
    });
    if (opened.status === 'inspect') {
      console.log(opened.message);
      return;
    }
    const terminal = opened.agent;
    yield* sync('Lead.terminalReceipt', () =>
      privateJson(resolve(binding.home, 'leads', binding.projectId + '.terminal.json'), {
        launchHash,
        pane_id: terminal.pane_id,
        terminal_id: terminal.terminal_id,
        name: terminal.name,
        agent: binary,
        agent_session: terminal.agent_session,
      }),
    );
  }).pipe(Effect.scoped);
  const insideHerdr = yield* Environment.string('HERDR_ENV').pipe(Environment.withDefault(''));
  const currentSocket = yield* Environment.string('HERDR_SOCKET_PATH').pipe(
    Environment.withDefault(''),
  );
  if (insideHerdr === '1') {
    console.log(`Lead opened in Herdr session ${binding.session}.`);
    if (currentSocket !== binding.socket)
      console.log(`Attach with: herdr --session ${quote(binding.session)}`);
    return;
  }
  const result = yield* processEffect('herdr', ['--session', binding.session], {
    cwd: binding.root,
    inherit: true,
    timeout: null,
  });
  process.exitCode = result.code ?? 1;
});

export const launchLead = (project: string, printOnly: boolean, profileId?: string) =>
  Effect.runPromise(launchLeadEffect(project, printOnly, profileId));
