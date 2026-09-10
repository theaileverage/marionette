import { Effect, Schema } from 'effect';
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { sync } from './effect-runtime.js';
import { inside, safePath } from './files.js';
import { workerRequestEffect } from './worker-transport.js';
import { leadActions } from './lead-capabilities.js';
import { privateJson } from './private-json.js';
import { terminalPath } from './terminal-path.js';
import { execEffect } from './process.js';
import { AppError, type Kind } from './types.js';

export const guardPolicySchema = Schema.Struct({
  version: Schema.Literal(1),
  root: Schema.String,
  role: Schema.Literals(['coordinate', 'inspect', 'documentation', 'implementation']),
  instructions: Schema.String,
  mcpName: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]+$/)),
  ownership: Schema.Array(Schema.String),
  taskId: Schema.optional(Schema.String),
});
export type GuardPolicy = Schema.Schema.Type<typeof guardPolicySchema>;
interface HookDecision {
  hookEventName: string;
  permissionDecision?: 'deny';
  permissionDecisionReason?: string;
}
interface SessionHook {
  type: string;
  command: string;
  timeout: number;
  additionalContextLimit?: number;
}
interface ScopedMcpServer {
  command: string;
  args: string[];
  required: boolean;
  enabled: boolean;
  startup_timeout_sec: number;
  default_tools_approval_mode: 'approve';
  env_vars?: string[];
}
const neutralTools = new Set([
  'AskUserQuestion',
  'request_user_input',
  'request_user_input_async',
  'update_plan',
  'get_context_remaining',
  'ask',
  'todo',
  'think',
  'yield',
]);
const readTools = new Set([
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'read',
  'grep',
  'glob',
  'web_search',
  'view_image',
]);
const writeTools = new Set(['Edit', 'Write', 'edit', 'write', 'apply_patch']);

/** Absence of a decision means permitted; unknown tools are denied for restricted roles. */
export function guardTool<Input>(
  policy: GuardPolicy,
  name: string,
  input: Input,
): string | undefined {
  if (neutralTools.has(name)) return;
  const scopedName = name.startsWith(`mcp__${policy.mcpName}__`)
    ? name.slice(`mcp__${policy.mcpName}__`.length)
    : name.startsWith(`mcp__${policy.mcpName}_`)
      ? name.slice(`mcp__${policy.mcpName}_`.length)
      : undefined;
  const allowedMcp =
    policy.role === 'coordinate'
      ? [...leadActions].map((action) => action.replace(/[.-]/g, '_'))
      : ['worker_inspect', 'worker_files', 'worker_call', 'worker_report'];
  if (scopedName && allowedMcp.includes(scopedName)) return;
  if (policy.role === 'coordinate')
    return 'Coordinator-only session: delegate research, inspection, edits, execution, and agent creation through Marionette. Skills do not expand user authority.';
  if (readTools.has(name)) return;
  if (writeTools.has(name) && policy.role !== 'inspect') {
    const args = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(input);
    const paths: string[] = [];
    if (name === 'apply_patch') {
      const patch = Schema.decodeUnknownSync(Schema.String)(args.command ?? args.patch);
      for (const match of patch.matchAll(
        /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm,
      ))
        paths.push(match[1]);
    } else {
      paths.push(Schema.decodeUnknownSync(Schema.String)(args.file_path ?? args.path));
    }
    if (!paths.length) return 'No verifiable write paths were supplied';
    for (const path of paths) {
      const target = safePath(policy.root, path);
      if (!policy.ownership.some((owned) => inside(safePath(policy.root, owned), target)))
        return 'Write exceeds the assigned paths';
      if (
        policy.role === 'documentation' &&
        !['.md', '.mdx', '.txt', '.rst'].includes(extname(target))
      )
        return 'Documentation authority does not permit changing source code or configuration';
    }
    return;
  }
  // Implementation workers retain the explicitly authorized execution surface. Native
  // delegation and administrative MCP still go through Marionette's scoped worker API.
  if (
    policy.role === 'implementation' &&
    !/^(?:mcp__|spawn_agent$|Agent$|Task$|task$|collab|send_message|followup_task)/.test(name)
  )
    return;
  return 'This worker role does not permit this tool. Report the missing capability through worker_report.';
}

const liveWorkerSchema = Schema.Struct({
  taskId: Schema.String,
  root: Schema.String,
  role: Schema.Literals(['inspect', 'documentation', 'implementation']),
  ownership: Schema.Array(Schema.String),
});
export function applyWorkerGuardState<Input>(policy: GuardPolicy, raw: Input): GuardPolicy {
  const live = Schema.decodeUnknownSync(liveWorkerSchema)(raw);
  if (
    !policy.taskId ||
    live.taskId !== policy.taskId ||
    realpathSync(live.root) !== realpathSync(policy.root)
  )
    throw new Error('Worker guard identity changed');
  return { ...policy, role: live.role, ownership: live.ownership };
}
const currentPolicyEffect = Effect.fn('Guard.currentPolicy')(function* (
  policy: GuardPolicy,
  name: string,
) {
  // Reporting remains available while paused or finished; the worker endpoint fences mutations.
  if (!policy.taskId || neutralTools.has(name) || name.startsWith('mcp__')) return policy;
  const current = yield* workerRequestEffect('worker-call', { action: 'guard' });
  return yield* sync('Guard.currentWorker', () => applyWorkerGuardState(policy, current));
});
export const guardToolEffect = Effect.fn('Guard.tool')(function* <Input>(
  policy: GuardPolicy,
  name: string,
  input: Input,
) {
  const current = yield* currentPolicyEffect(policy, name);
  return yield* sync('Guard.toolDecision', () => guardTool(current, name, input));
});
export function guardToolAsync<Input>(policy: GuardPolicy, name: string, input: Input) {
  return Effect.runPromise(guardToolEffect(policy, name, input));
}
export const guardHookEffect = Effect.fn('Guard.hook')(function* <Input>(
  policy: GuardPolicy,
  raw: Input,
) {
  const event = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ hook_event_name: Schema.String, tool_name: Schema.optional(Schema.String) }),
  )(raw);
  const current =
    event.hook_event_name === 'PreToolUse'
      ? yield* currentPolicyEffect(policy, event.tool_name ?? '')
      : policy;
  return yield* sync('Guard.hookDecision', () => guardHook(current, raw));
});

export function readGuardPolicy(path: string) {
  return Schema.decodeUnknownSync(guardPolicySchema)(JSON.parse(readFileSync(path, 'utf8')));
}

export function guardHook<Input>(policy: GuardPolicy, raw: Input) {
  const input = Schema.decodeUnknownSync(
    Schema.Struct({
      hook_event_name: Schema.String,
      cwd: Schema.String,
      tool_name: Schema.optional(Schema.String),
      tool_input: Schema.optional(Schema.Unknown),
    }),
  )(raw);
  if (realpathSync(input.cwd) !== realpathSync(policy.root))
    throw new Error('Guard identity does not match this workspace; relaunch the configured agent');
  if (input.hook_event_name === 'SessionStart')
    return {
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: policy.instructions },
    };
  if (input.hook_event_name !== 'PreToolUse') throw new Error('Unsupported guard event');
  const reason = guardTool(policy, input.tool_name ?? '', input.tool_input);
  const output: HookDecision = { hookEventName: 'PreToolUse' };
  if (reason) {
    output.permissionDecision = 'deny';
    output.permissionDecisionReason = reason;
  }
  return { hookSpecificOutput: output };
}

const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
function toml<Value>(value: Value): string {
  if (Array.isArray(value)) return `[${value.map(toml).join(',')}]`;
  if (Schema.is(Schema.Record(Schema.String, Schema.Unknown))(value))
    return `{${Object.entries(value)
      .map(([k, v]) => `${JSON.stringify(k)}=${toml(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export const verifyGuardHarnessEffect = Effect.fn('Guard.verifyHarness')(function* (
  kind: Kind,
  root: string,
) {
  if (kind === 'agy')
    return yield* new AppError({
      code: 'guard_unsupported',
      message:
        'AGY coordinator enforcement is not verified. Select Codex CLI, Claude Code, or oh-my-pi for a guarded lead.',
      status: 400,
    });
  const { stdout, stderr } = yield* execEffect(kind, ['--help'], { cwd: root, timeout: 15000 });
  const help = stdout + stderr;
  const required =
    kind === 'codex'
      ? ['--dangerously-bypass-hook-trust', '--config']
      : kind === 'claude'
        ? ['--settings', '--tools', '--strict-mcp-config']
        : ['--extension', '--no-extensions', '--no-tools', '--append-system-prompt'];
  if (required.some((flag) => !help.includes(flag)))
    return yield* new AppError({
      code: 'guard_unsupported',
      message: `${kind} does not expose the required guard controls. Upgrade the harness before starting this role.`,
      status: 400,
    });
});

export interface GuardLaunch {
  kind: Kind;
  directory: string;
  executable: string;
  cliPath: string;
  policy: GuardPolicy;
  server: { command: string; args: string[] };
}

/** Session-only configuration: never changes user/project harness settings. */
export function prepareGuardLaunch(input: GuardLaunch): string[] {
  const { kind, directory, executable, cliPath, policy, server } = input;
  if (kind === 'agy') throw new Error('AGY guard unavailable');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const policyPath = resolve(directory, 'policy.json');
  privateJson(policyPath, policy);
  const hookArgv = [executable, cliPath, 'guard-hook', '--policy', policyPath];
  const shortDirectory = kind === 'codex' ? terminalPath(directory) : directory;
  const launcher = (name: string, argv: string[]) => {
    const path = resolve(directory, name);
    writeFileSync(path, '#!/bin/sh\nexec ' + argv.map(quote).join(' ') + ' "$@"\n', {
      mode: 0o700,
    });
    chmodSync(path, 0o700);
    return resolve(shortDirectory, name);
  };
  // Herdr types the launch into a PTY. Keep nested hook/MCP argv in files so
  // shell quoting cannot expand a normal launch past the terminal input limit.
  const command = kind === 'codex' ? quote(launcher('h', hookArgv)) : hookArgv.map(quote).join(' ');
  const sessionHook: SessionHook = {
    type: 'command',
    command,
    timeout: 10,
  };
  // Codex otherwise spills long contracts to a file that a coordinator cannot
  // read. A byte-sized token budget fits the entire generated contract.
  if (kind === 'codex')
    sessionHook.additionalContextLimit = Buffer.byteLength(policy.instructions, 'utf8') + 1024;
  const hooks = {
    SessionStart: [
      {
        matcher: 'startup|resume|clear|compact',
        hooks: [sessionHook],
      },
    ],
    PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 10 }] }],
  };
  if (kind === 'codex') {
    const scopedServer: ScopedMcpServer = {
      command: launcher('m', [server.command, ...server.args]),
      args: [],
      required: true,
      enabled: true,
      startup_timeout_sec: 20,
      // This server exposes only the session capability. Marionette still
      // validates role, outcome authority, revision, and ownership per call.
      default_tools_approval_mode: 'approve',
    };
    if (policy.role !== 'coordinate')
      scopedServer.env_vars = ['MARIONETTE_URL', 'MARIONETTE_TASK_ID', 'MARIONETTE_WORKER_TOKEN'];
    const config = {
      'features.hooks': true,
      'features.shell_tool': policy.role === 'implementation',
      'features.multi_agent': false,
      web_search: policy.role === 'coordinate' ? 'disabled' : 'live',
      'hooks.SessionStart': hooks.SessionStart,
      'hooks.PreToolUse': hooks.PreToolUse,
      [`mcp_servers.${policy.mcpName}`]: scopedServer,
    };
    return [
      '--dangerously-bypass-hook-trust',
      ...(['coordinate', 'inspect'].includes(policy.role)
        ? ['--sandbox', 'read-only', '--ask-for-approval', 'never']
        : []),
      ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${toml(value)}`]),
    ];
  }
  if (kind === 'claude') {
    const settings = resolve(directory, 'settings.json'),
      mcp = resolve(directory, 'mcp.json');
    privateJson(settings, { hooks });
    privateJson(mcp, { mcpServers: { [policy.mcpName]: server } });
    const tools =
      policy.role === 'coordinate'
        ? 'AskUserQuestion'
        : policy.role === 'inspect'
          ? 'Read,Glob,Grep,WebSearch,WebFetch,AskUserQuestion'
          : policy.role === 'documentation'
            ? 'Read,Glob,Grep,Edit,Write,WebSearch,WebFetch,AskUserQuestion'
            : 'default';
    return ['--settings', settings, '--strict-mcp-config', '--mcp-config', mcp, '--tools', tools];
  }
  const plugin = resolve(directory, 'omp'),
    extension = resolve(plugin, 'index.js');
  mkdirSync(plugin, { recursive: true, mode: 0o700 });
  privateJson(resolve(plugin, 'package.json'), {
    name: 'marionette-session-guard',
    omp: { extensions: ['./index.js'] },
  });
  privateJson(resolve(plugin, '.mcp.json'), { mcpServers: { [policy.mcpName]: server } });
  const guardModule = resolve(dirname(cliPath), 'harness-guard.js');
  writeFileSync(
    extension,
    `import { realpathSync } from 'node:fs';
import { guardTool, guardToolAsync, readGuardPolicy } from ${JSON.stringify(guardModule)};
const policyPath = ${JSON.stringify(policyPath)};
export default function(pi) {
  pi.on('tool_call', async (event) => {
    try {
      const reason = await guardToolAsync(readGuardPolicy(policyPath), event.toolName, event.input);
      return reason ? { block: true, reason } : undefined;
    } catch { return { block: true, reason: 'Marionette guard could not validate this tool request' }; }
  });
  pi.on('before_agent_start', (event) => {
    const policy = readGuardPolicy(policyPath);
    const systemPrompt = Array.isArray(event.systemPrompt) ? [...event.systemPrompt, policy.instructions] : event.systemPrompt + '\\n' + policy.instructions;
    return { systemPrompt };
  });
  for (const event of ['session_start', 'session_switch', 'session_branch', 'session_compact']) {
    pi.on(event, async (_event, ctx) => {
      const policy = readGuardPolicy(policyPath);
      if (realpathSync(ctx.cwd) !== realpathSync(policy.root)) { ctx.shutdown(); throw new Error('Marionette guard workspace mismatch'); }
      if (policy.role === 'coordinate' || policy.role === 'inspect') {
        const allowed = pi.getAllTools().filter((tool) => !guardTool(policy, tool.name, {})).map((tool) => tool.name);
        await pi.setActiveTools(allowed);
      }
    });
  }
}
`,
    { mode: 0o600 },
  );
  const overlay = resolve(directory, 'omp-settings.json');
  privateJson(overlay, { retry: { modelFallback: false }, advisor: { enabled: false } });
  const instructions = resolve(directory, 'instructions.md');
  writeFileSync(instructions, policy.instructions, { mode: 0o600 });
  return [
    '--no-extensions',
    '--config',
    overlay,
    '--no-lsp',
    '--no-prewalk',
    '--no-title',
    '--extension',
    plugin,
    '--append-system-prompt',
    instructions,
    ...(policy.role === 'coordinate' ? ['--no-tools'] : []),
  ];
}

export const prepareGuardLaunchEffect = Effect.fn('Guard.prepare')(function* (input: GuardLaunch) {
  yield* verifyGuardHarnessEffect(input.kind, input.policy.root);
  return yield* sync('Guard.writeConfiguration', () => prepareGuardLaunch(input));
});
