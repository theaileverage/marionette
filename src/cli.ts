#!/usr/bin/env bun
import { Effect, Option, Schema } from 'effect';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { callEffect, homePath, loadConfig } from './config.js';
import { boundaryError, sync } from './effect-runtime.js';
import { healthEffect as readHealthEffect } from './http-client.js';
import { jsonObjectSchema, leaseResponseSchema, projectSchema } from './response-schemas.js';
import { installRuntime, packageRoot } from './runtime.js';
import { startInstanceEffect, stopInstanceEffect, workerCallEffect } from './server-control.js';
import { serveEffect } from './server.js';
import { maintenanceCommandEffect } from './maintenance-cli.js';
import { prompts } from './cli-prompts.js';
import { launchLeadEffect, runSetupEffect, setupPlan, wizardEffect } from './setup.js';
import { workerMcpEffect } from './worker-mcp.js';
import { guardHookEffect, readGuardPolicy } from './harness-guard.js';
import { cliCommands, commandHelp, fullHelp } from './cli-help.js';
import { configurationCommandEffect } from './configuration-cli.js';
import { findBinding } from './project-binding.js';
const args = process.argv.slice(2);
function flag(name: string) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : undefined;
}
const home = homePath(flag('home'));
const print = <T>(v: T) => console.log(JSON.stringify(v, null, 2));
const mainEffect = Effect.fn('main')(function* () {
  let cmd = args[0] ?? 'help';
  if (cmd === 'help' && args[1]) {
    cmd = args[1];
    args.splice(0, args.length, cmd, '--help');
  }
  if (['help', '--help', '-h'].includes(cmd)) {
    console.log(fullHelp());
    return;
  }
  if (args.includes('-h')) args[args.indexOf('-h')] = '--help';
  if (
    args.includes('--help') &&
    cmd in cliCommands &&
    ![
      'setup',
      'init',
      'lead',
      'authorize',
      'update',
      'upgrade',
      'remove',
      'uninstall',
      'profiles',
      'roles',
    ].includes(cmd)
  ) {
    console.log(commandHelp(cmd));
    return;
  }
  if (cmd === 'guard-hook') {
    yield* sync('Guard.readHook', () => ({
      policy: readGuardPolicy(flag('policy') ?? ''),
      input: JSON.parse(readFileSync(0, 'utf8')),
    })).pipe(
      Effect.flatMap(({ policy, input }) => guardHookEffect(policy, input)),
      Effect.match({
        onSuccess: print,
        onFailure: () => {
          console.error(
            'Marionette guard failed to validate this session or tool. Relaunch the configured agent.',
          );
          process.exitCode = 2;
        },
      }),
    );
    return;
  }
  if (cmd === 'authorize') {
    if (args.includes('--help')) {
      console.log(
        'Usage: marionette authorize --outcome ID --allow documentation,implementation,execute --scope PATH [--scope PATH] --source "User request" [--project DIR]\nReplaces the outcome grant. Use --allow none to revoke writes and execution after settling workers. This user command is unavailable to lead and worker MCP.',
      );
      return;
    }
    const values = parseArgs({
      args: args.slice(1),
      options: {
        outcome: { type: 'string' },
        allow: { type: 'string' },
        scope: { type: 'string', multiple: true },
        source: { type: 'string' },
        project: { type: 'string' },
        home: { type: 'string' },
      },
    }).values;
    const { binding } = findBinding(values.project ?? process.cwd());
    print(
      yield* callEffect(binding.home, 'authority.grant', {
        projectId: binding.projectId,
        outcomeId: values.outcome ?? '',
        activities: values.allow === 'none' ? [] : (values.allow ?? '').split(',').filter(Boolean),
        scope: values.scope ?? [],
        source: values.source ?? '',
      }),
    );
    return;
  }
  if (cmd === 'roles' || cmd === 'profiles') {
    yield* configurationCommandEffect(cmd, args.slice(1));
    return;
  }
  if (cmd === 'worker-mcp') {
    yield* workerMcpEffect();
    return;
  }
  if (cmd === '--version' || cmd === 'version') {
    yield* sync('main.main', () =>
      console.log(JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')).version),
    );
    return;
  }
  if (['update', 'upgrade', 'remove', 'uninstall'].includes(cmd)) {
    yield* maintenanceCommandEffect(cmd, args.slice(1), home);
    return;
  }
  if (cmd === 'setup' || cmd === 'init') {
    if (args.includes('--help')) {
      yield* sync('main.main', () =>
        console.log(
          'Usage: marionette setup [--yes] [--json] [--config FILE] [--dry-run]\n  --project DIR --home DIR --name TEXT --session NAME --socket PATH --workspace ID\n  --lead codex-desktop|codex|claude|agy|omp --lead-name TEXT --lead-profile PROFILE_ID --port NUMBER\n  --agent-access inherit|full-access (all harnesses; use config for per-harness settings)\n  --no-trust-workspaces --mcp install|print|skip --takeover --install-tools --upgrade\n  --takeover replaces the current lead and invalidates its credentials; init accepts the same flags.\n  --schema prints the accepted JSON configuration. --yes accepts defaults without prompts.',
        ),
      );
      return;
    }
    if (args.includes('--schema')) {
      yield* sync('main.main', () =>
        print({
          project: 'existing directory',
          home: 'state directory (optional)',
          name: 'project name',
          session: 'Herdr session (optional)',
          socket: 'Herdr socket (optional)',
          workspace: 'workspace ID (optional)',
          port: 'integer 1024–65535 (optional)',
          lead: ['codex-desktop', 'codex', 'claude', 'agy', 'omp'],
          leadName: 'custom name (1–100 characters)',
          leadProfile: 'validated exact model profile ID (optional)',
          coordinatorOnly: true,
          trustWorkspaces: true,
          agentAccess: {
            codex: 'inherit|full-access',
            claude: 'inherit|full-access',
            agy: 'inherit|full-access',
            omp: 'inherit|full-access',
          },
          mcp: ['install', 'print', 'skip'],
          takeover: false,
          installTools: false,
          upgrade: false,
        }),
      );
      return;
    }
    const known = yield* sync(
      'main.main',
      () =>
        new Set([
          '--yes',
          '--json',
          '--config',
          '--dry-run',
          '--project',
          '--home',
          '--name',
          '--session',
          '--socket',
          '--workspace',
          '--lead',
          '--lead-name',
          '--lead-profile',
          '--agent-access',
          '--port',
          '--no-trust-agy',
          '--no-trust-workspaces',
          '--trust-workspaces',
          '--mcp',
          '--takeover',
          '--install-tools',
          '--upgrade',
        ]),
    );
    for (const arg of args.slice(1))
      if (arg.startsWith('--') && !known.has(arg))
        return yield* boundaryError('main.main')(new Error(`Unknown setup option: ${arg}`));
    const switches = yield* sync(
      'main.main',
      () =>
        new Set([
          '--yes',
          '--json',
          '--dry-run',
          '--no-trust-agy',
          '--no-trust-workspaces',
          '--trust-workspaces',
          '--takeover',
          '--install-tools',
          '--upgrade',
        ]),
    );
    for (let n = 1; n < args.length; n++) {
      if (!known.has(args[n]))
        return yield* boundaryError('main.main')(
          new Error(`Unexpected setup argument: ${args[n]}`),
        );
      if (!switches.has(args[n])) {
        if (!args[n + 1] || args[n + 1].startsWith('--'))
          return yield* boundaryError('main.main')(new Error(`Missing value for ${args[n]}`));
        n++;
      }
    }
    let input = yield* sync('main.main', () => ({
      ...Schema.decodeUnknownSync(jsonObjectSchema)(
        flag('config') ? JSON.parse(readFileSync(flag('config')!, 'utf8')) : {},
      ),
    }));
    for (const key of ['project', 'home', 'name', 'session', 'socket', 'workspace', 'lead', 'mcp'])
      if (flag(key)) yield* sync('main.main', () => (input[key] = flag(key)));
    if (flag('lead-name')) yield* sync('main.main', () => (input.leadName = flag('lead-name')));
    if (flag('lead-profile'))
      yield* sync('main.main', () => (input.leadProfile = flag('lead-profile')));
    if (flag('agent-access'))
      input.agentAccess = {
        codex: flag('agent-access'),
        claude: flag('agent-access'),
        agy: flag('agent-access'),
        omp: flag('agent-access'),
      };
    if (flag('port')) yield* sync('main.main', () => (input.port = Number(flag('port'))));
    if (args.includes('--no-trust-agy') || args.includes('--no-trust-workspaces'))
      input.trustWorkspaces = false;
    if (args.includes('--trust-workspaces')) input.trustWorkspaces = true;
    if (
      args.includes('--trust-workspaces') &&
      (args.includes('--no-trust-workspaces') || args.includes('--no-trust-agy'))
    )
      return yield* boundaryError('Setup.flags')(
        new Error('Choose either --trust-workspaces or --no-trust-workspaces.'),
      );
    if (args.includes('--takeover')) input.takeover = true;
    if (args.includes('--install-tools')) input.installTools = true;
    if (args.includes('--upgrade')) input.upgrade = true;
    let interactive = false;
    if (
      !args.includes('--yes') &&
      !args.includes('--json') &&
      !args.includes('--dry-run') &&
      !flag('config')
    ) {
      if (!process.stdin.isTTY)
        return yield* boundaryError('main.main')(
          new Error(
            'Non-interactive setup requires --yes, --json, or --config FILE. Use --dry-run to review the plan.',
          ),
        );
      interactive = true;
      input = yield* wizardEffect(input);
    }
    const parsed = input;
    if (args.includes('--dry-run')) {
      yield* sync('main.main', () => print(setupPlan(parsed)));
      return;
    }
    const result = yield* runSetupEffect(parsed, interactive);
    if (args.includes('--json')) yield* sync('main.main', () => print(result));
    else
      yield* sync('main.main', () =>
        console.log(
          `\n${result.project} is ready.\nLead: ${result.lead.name} (${result.lead.agent})\nHerdr: ${result.session} / ${result.workspace}\nMCP: ${result.mcp.status} (${result.mcp.name})\n\n${result.next}\nLead prompt: ${result.lead.promptPath}\nRun marionette dashboard for your private dashboard link.\n${result.mcp.status === 'print' ? '\nMCP install command:\n' + result.mcp.shell : ''}`,
        ),
      );
    if (interactive) prompts.outro('Setup complete.', { output: process.stderr });
    return;
  }
  if (cmd === 'lead') {
    const values = yield* sync(
      'Lead.arguments',
      () =>
        parseArgs({
          args: args.slice(1),
          strict: true,
          allowPositionals: false,
          options: {
            project: { type: 'string' },
            home: { type: 'string' },
            profile: { type: 'string' },
            print: { type: 'boolean' },
            help: { type: 'boolean' },
            handover: { type: 'boolean' },
            takeover: { type: 'boolean' },
          },
        }).values,
    );
    if (values.help) {
      console.log(
        'Usage: marionette lead [--project DIR] [--profile ID] [--print]\nTo replace a stale lead, run marionette setup --takeover from the project directory, then marionette lead.\nFor cooperative handover, the current lead must call lead_handover using its valid lease and save the returned lease.',
      );
      return;
    }
    if (values.handover || values.takeover)
      return yield* boundaryError('Lead.arguments')(
        new Error(
          `marionette lead does not support --${values.handover ? 'handover' : 'takeover'}. To recover a stale lead, run marionette setup --takeover from the project directory, then marionette lead. This invalidates the previous lead's credentials.\nFor cooperative handover, the current lead must call lead_handover using its valid lease, save the returned lease to the project's leasePath, then rerun setup with the new --lead and --lead-name.`,
        ),
      );
    yield* launchLeadEffect(
      resolve(values.project ?? process.cwd()),
      values.print === true,
      values.profile,
    );
    return;
  }
  if (cmd === 'worker-report' || cmd === 'worker-call') {
    print(yield* workerCallEffect(cmd, flag('file')));
    return;
  }
  if (cmd === 'serve') {
    yield* serveEffect(home, flag('port') ? Number(flag('port')) : undefined);
    return;
  }
  if (cmd === 'start') {
    print(yield* startInstanceEffect(home, Number(flag('port') ?? 4380)));
    return;
  }
  if (cmd === 'stop') {
    print(yield* stopInstanceEffect(home));
    return;
  }
  if (cmd === 'dashboard') {
    const c = yield* sync('main.main', () => loadConfig(home));
    yield* sync('main.main', () => console.log(`http://127.0.0.1:${c.port}/#token=${c.token}`));
    return;
  }
  if (cmd === 'mcp-config') {
    const server = yield* sync('main.main', () => resolve(installRuntime(home), 'dist/mcp.js'));
    yield* sync('main.main', () =>
      console.log(
        `[mcp_servers.marionette]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(server)}, "--home", ${JSON.stringify(home)}]\n`,
      ),
    );
    return;
  }
  if (cmd === 'call') {
    const action = args[1];
    if (!action) return yield* boundaryError('main.main')(new Error('Provide an action; see help'));
    const input = yield* sync('main.main', () =>
      flag('file')
        ? JSON.parse(readFileSync(flag('file')!, 'utf8'))
        : flag('json')
          ? JSON.parse(flag('json')!)
          : {},
    );
    if (flag('lease'))
      yield* sync(
        'main.main',
        () => (input.lease = JSON.parse(readFileSync(flag('lease')!, 'utf8'))),
      );
    const result = yield* callEffect(home, action, input);
    const leased = yield* sync('main.main', () =>
      Schema.decodeUnknownOption(leaseResponseSchema)(result),
    );
    if (flag('save-lease') && Option.isSome(leased)) {
      yield* sync('main.main', () =>
        writeFileSync(flag('save-lease')!, JSON.stringify(leased.value.lease, null, 2) + '\n', {
          mode: 0o600,
        }),
      );
      const { lease: _lease, ...rest } = yield* sync('main.main', () =>
        Schema.decodeUnknownSync(jsonObjectSchema)(result),
      );
      yield* sync('main.main', () => print({ ...rest, leaseSaved: flag('save-lease') }));
    } else yield* sync('main.main', () => print(result));
    return;
  }
  if (cmd === 'projects') {
    print(yield* callEffect(home, 'project.list'));
    return;
  }
  if (cmd === 'briefing') {
    print(yield* callEffect(home, 'project.briefing', { projectId: args[1] }));
    return;
  }
  if (cmd === 'inbox') {
    print(
      yield* callEffect(home, 'inbox.read', {
        projectId: args[1],
        consumer: flag('consumer') ?? 'terminal',
      }),
    );
    return;
  }
  if (cmd === 'doctor') {
    const c = yield* sync('main.main', () => loadConfig(home)),
      health = yield* readHealthEffect(`http://127.0.0.1:${c.port}/health`);
    const projects = yield* Schema.decodeUnknownEffect(Schema.Array(projectSchema))(
      yield* callEffect(home, 'project.list'),
    ).pipe(Effect.mapError(boundaryError('cli.decode')));
    const connections = yield* Effect.forEach(projects, (project) =>
      callEffect(home, 'project.inspect', { projectId: project.id }).pipe(
        Effect.match({
          onSuccess: () => ({ project: project.name, session: project.session, connected: true }),
          onFailure: (error) => ({ project: project.name, connected: false, error: String(error) }),
        }),
      ),
    );
    yield* sync('main.main', () =>
      print({
        health,
        connections,
        notificationMode: 'Dashboard alerts and MCP inbox; no automatic desktop wakeup',
      }),
    );
    return;
  }
  throw new Error(`Unknown command: ${cmd}. Run marionette --help for all commands.`);
});
const main = () => Effect.runPromise(mainEffect());
main().catch((e) => {
  if (e.code === 'setup_cancelled' || e.code === 'operation_cancelled') {
    process.exitCode = 130;
    return;
  }
  if (args.includes('--json')) print({ ok: false, error: e.message });
  else console.error(e.message);
  process.exitCode = 1;
});
