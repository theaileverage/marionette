#!/usr/bin/env bun
import { Effect, Option, Schema } from 'effect';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
const args = process.argv.slice(2);
function flag(name: string) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : undefined;
}
const home = homePath(flag('home'));
const print = <T>(v: T) => console.log(JSON.stringify(v, null, 2));
const mainEffect = Effect.fn('main')(function* () {
  const cmd = args[0] ?? 'help';
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
          'Usage: marionette setup [--yes] [--json] [--config FILE] [--dry-run]\n  --project DIR --home DIR --name TEXT --session NAME --socket PATH --workspace ID\n  --lead codex-desktop|codex|claude|agy --lead-name TEXT --lead-profile PROFILE_ID --port NUMBER\n  --agent-access inherit|full-access (all harnesses; use config for per-harness settings)\n  --no-trust-workspaces --mcp install|print|skip --takeover --install-tools --upgrade\n  --schema prints the accepted JSON configuration. --yes accepts defaults without prompts.',
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
          lead: ['codex-desktop', 'codex', 'claude', 'agy'],
          leadName: 'custom name (1–100 characters)',
          leadProfile: 'validated exact model profile ID (optional)',
          trustWorkspaces: true,
          agentAccess: {
            codex: 'inherit|full-access',
            claude: 'inherit|full-access',
            agy: 'inherit|full-access',
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
    yield* launchLeadEffect(
      resolve(flag('project') ?? process.cwd()),
      args.includes('--print'),
      flag('profile'),
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
  yield* sync('main.main', () =>
    console.log(
      `Marionette — one project, many workers\n\nUsage: marionette <command> [--home /absolute/state/directory]\n\n  setup | init            Guided setup (setup --help for automation flags)\n  lead [--print]          Open the selected lead or print its bootstrap prompt\n  update | upgrade       Update runtimes, shared supervisor and MCP clients\n  remove                  Remove this project from Marionette\n  uninstall               Remove the instance; --global also removes the CLI\n  start | serve | stop    Manage the persistent supervisor (workers survive stop)\n  dashboard               Print the private dashboard access link\n  mcp-config              Print the desktop/terminal MCP configuration\n  projects                List explicitly connected projects\n  briefing PROJECT        Current assignments, lead, decisions and questions\n  inbox PROJECT           Read durable notifications [--consumer NAME]\n  doctor                  Inspect configured connections\n  call ACTION --file JSON [--lease FILE] [--save-lease FILE]\n  worker-report --file JSON  Submit a scoped report from a worker pane\n  worker-call --file JSON    Inspect, delegate, revise or control within worker scope\n\nActions: project.register, project.inspect, project.briefing, lead.acquire,\nlead.handover, task.submit, task.get, task.control, task.retry, task.reconcile,\ndecision.record, inbox.read, inbox.ack. See README.md for examples.\n`,
    ),
  );
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
