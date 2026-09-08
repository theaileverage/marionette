#!/usr/bin/env node
import { readFileSync, writeFileSync, openSync, closeSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { initConfig, homePath, loadConfig, call } from './config.js';
import { serve } from './server.js';
import { installRuntime, packageRoot } from './runtime.js';
import { setupSchema, setupPlan, wizard, runSetup, launchLead } from './setup.js';

const args = process.argv.slice(2);
function flag(name: string) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : undefined;
}
const home = homePath(flag('home'));
const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));
async function main() {
  const cmd = args[0] ?? 'help';
  if (cmd === '--version' || cmd === 'version') {
    console.log(JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')).version);
    return;
  }
  if (cmd === 'setup' || cmd === 'init') {
    if (args.includes('--help')) {
      console.log(
        'Usage: marionette setup [--yes] [--json] [--config FILE] [--dry-run]\n  --project DIR --home DIR --name TEXT --session NAME --socket PATH --workspace ID\n  --lead codex-desktop|codex|claude|agy --lead-name TEXT --lead-profile PROFILE_ID --port NUMBER\n  --no-trust-agy --mcp install|print|skip --takeover\n  --schema prints the accepted JSON configuration. --yes accepts defaults without prompts.',
      );
      return;
    }
    if (args.includes('--schema')) {
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
        trustAgy: true,
        mcp: ['install', 'print', 'skip'],
        takeover: false,
      });
      return;
    }
    const known = new Set([
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
      '--port',
      '--no-trust-agy',
      '--mcp',
      '--takeover',
    ]);
    for (const arg of args.slice(1))
      if (arg.startsWith('--') && !known.has(arg)) throw new Error(`Unknown setup option: ${arg}`);
    const switches = new Set(['--yes', '--json', '--dry-run', '--no-trust-agy', '--takeover']);
    for (let n = 1; n < args.length; n++) {
      if (!known.has(args[n])) throw new Error(`Unexpected setup argument: ${args[n]}`);
      if (!switches.has(args[n])) {
        if (!args[n + 1] || args[n + 1].startsWith('--'))
          throw new Error(`Missing value for ${args[n]}`);
        n++;
      }
    }
    let input: Record<string, unknown> = flag('config')
      ? JSON.parse(readFileSync(flag('config')!, 'utf8'))
      : {};
    for (const key of ['project', 'home', 'name', 'session', 'socket', 'workspace', 'lead', 'mcp'])
      if (flag(key)) input[key] = flag(key);
    if (flag('lead-name')) input.leadName = flag('lead-name');
    if (flag('lead-profile')) input.leadProfile = flag('lead-profile');
    if (flag('port')) input.port = Number(flag('port'));
    if (args.includes('--no-trust-agy')) input.trustAgy = false;
    if (args.includes('--takeover')) input.takeover = true;
    if (
      !args.includes('--yes') &&
      !args.includes('--json') &&
      !args.includes('--dry-run') &&
      !flag('config')
    ) {
      if (!process.stdin.isTTY)
        throw new Error(
          'Non-interactive setup requires --yes, --json, or --config FILE. Use --dry-run to review the plan.',
        );
      input = await wizard(input);
    }
    const parsed = input;
    if (args.includes('--dry-run')) {
      print(setupPlan(parsed));
      return;
    }
    const result = await runSetup(parsed);
    if (args.includes('--json')) print(result);
    else
      console.log(
        `\n${result.project} is ready.\nLead: ${result.lead.name} (${result.lead.agent})\nHerdr: ${result.session} / ${result.workspace}\nMCP: ${result.mcp.status} (${result.mcp.name})\n\n${result.next}\nLead prompt: ${result.lead.promptPath}\nRun marionette dashboard for your private dashboard link.\n${result.mcp.status === 'print' ? '\nMCP install command:\n' + result.mcp.shell : ''}`,
      );
    return;
  }
  if (cmd === 'lead') {
    await launchLead(
      resolve(flag('project') ?? process.cwd()),
      args.includes('--print'),
      flag('profile'),
    );
    return;
  }
  if (cmd === 'worker-report' || cmd === 'worker-call') {
    const {
      MARIONETTE_URL: url,
      MARIONETTE_TASK_ID: taskId,
      MARIONETTE_WORKER_TOKEN: token,
    } = process.env;
    if (!url || !taskId || !token)
      throw new Error('worker-report must run in a Marionette-created worker pane');
    const input = JSON.parse(readFileSync(flag('file') ?? 0, 'utf8'));
    const res = await fetch(
      `${url}/api/worker/${encodeURIComponent(taskId)}${cmd === 'worker-call' ? '/call' : ''}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(10000),
      },
    );
    const body = (await res.json()) as any;
    if (!res.ok) throw new Error(JSON.stringify(body.error));
    print(body.result);
    return;
  }
  if (cmd === 'serve') {
    await serve(home, flag('port') ? Number(flag('port')) : undefined);
    return;
  }
  if (cmd === 'start') {
    const c = initConfig(home, Number(flag('port') ?? 4380));
    try {
      const res = await fetch(`http://127.0.0.1:${c.port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      const health = (await res.json()) as any;
      if (health.id === c.id) {
        print({ running: true, url: `http://127.0.0.1:${c.port}` });
        return;
      }
      throw new Error('Port is occupied by a different service');
    } catch (e) {
      if (!String(e).includes('fetch failed') && !String(e).includes('TimeoutError')) throw e;
    }
    const cli = resolve(installRuntime(home), 'dist/cli.js');
    if (!existsSync(cli))
      throw new Error('Run npm run build before starting the background supervisor');
    const log = openSync(resolve(home, 'supervisor.log'), 'a', 0o600);
    const child = spawn(process.execPath, ['--no-warnings', cli, 'serve', '--home', home], {
      detached: true,
      stdio: ['ignore', log, log],
      env: process.env,
    });
    closeSync(log);
    child.unref();
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const h = (await (await fetch(`http://127.0.0.1:${c.port}/health`)).json()) as any;
        if (h.id === c.id) {
          print({ running: true, pid: h.pid, url: `http://127.0.0.1:${c.port}` });
          return;
        }
      } catch {}
    }
    throw new Error(`Supervisor did not start. Read ${resolve(home, 'supervisor.log')}`);
  }
  if (cmd === 'stop') {
    const c = loadConfig(home),
      url = `http://127.0.0.1:${c.port}`;
    const res = await fetch(`${url}/api/shutdown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error('Shutdown refused');
    for (let n = 0; n < 120; n++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
        const health = (await response.json()) as any;
        if (health.id !== c.id) {
          print({ stopped: true });
          return;
        }
      } catch {
        print({ stopped: true, workersPreserved: true });
        return;
      }
    }
    throw new Error(
      'Shutdown is still draining a pending operation. Inspect the supervisor log; workers remain in Herdr.',
    );
  }
  if (cmd === 'dashboard') {
    const c = loadConfig(home);
    console.log(`http://127.0.0.1:${c.port}/#token=${c.token}`);
    return;
  }
  if (cmd === 'mcp-config') {
    const server = resolve(installRuntime(home), 'dist/mcp.js');
    console.log(
      `[mcp_servers.marionette]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ["--no-warnings", ${JSON.stringify(server)}, "--home", ${JSON.stringify(home)}]\n`,
    );
    return;
  }
  if (cmd === 'call') {
    const action = args[1];
    if (!action) throw new Error('Provide an action; see help');
    const input = flag('file')
      ? JSON.parse(readFileSync(flag('file')!, 'utf8'))
      : flag('json')
        ? JSON.parse(flag('json')!)
        : {};
    if (flag('lease')) input.lease = JSON.parse(readFileSync(flag('lease')!, 'utf8'));
    const result = await call(home, action, input);
    if (flag('save-lease') && result.lease) {
      writeFileSync(flag('save-lease')!, JSON.stringify(result.lease, null, 2) + '\n', {
        mode: 0o600,
      });
      const { lease, ...rest } = result;
      print({ ...rest, leaseSaved: flag('save-lease') });
    } else print(result);
    return;
  }
  if (cmd === 'projects') {
    print(await call(home, 'project.list'));
    return;
  }
  if (cmd === 'briefing') {
    print(await call(home, 'project.briefing', { projectId: args[1] }));
    return;
  }
  if (cmd === 'inbox') {
    print(
      await call(home, 'inbox.read', {
        projectId: args[1],
        consumer: flag('consumer') ?? 'terminal',
      }),
    );
    return;
  }
  if (cmd === 'doctor') {
    const c = loadConfig(home),
      health = await (await fetch(`http://127.0.0.1:${c.port}/health`)).json();
    const projects = await call(home, 'project.list');
    const connections = [];
    for (const p of projects) {
      try {
        await call(home, 'project.inspect', { projectId: p.id });
        connections.push({ project: p.name, session: p.session, connected: true });
      } catch (e) {
        connections.push({ project: p.name, connected: false, error: String(e) });
      }
    }
    print({
      health,
      connections,
      notificationMode: 'Dashboard alerts and MCP inbox; no automatic desktop wakeup',
    });
    return;
  }
  console.log(
    `Marionette — one project, many workers\n\nUsage: marionette <command> [--home /absolute/state/directory]\n\n  setup | init            Guided setup (setup --help for automation flags)\n  lead [--print]          Open the selected lead or print its bootstrap prompt\n  start | serve | stop    Manage the persistent supervisor (workers survive stop)\n  dashboard               Print the private dashboard access link\n  mcp-config              Print the desktop/terminal MCP configuration\n  projects                List explicitly connected projects\n  briefing PROJECT        Current assignments, lead, decisions and questions\n  inbox PROJECT           Read durable notifications [--consumer NAME]\n  doctor                  Inspect configured connections\n  call ACTION --file JSON [--lease FILE] [--save-lease FILE]\n  worker-report --file JSON  Submit a scoped report from a worker pane\n  worker-call --file JSON    Inspect, delegate, revise or control within worker scope\n\nActions: project.register, project.inspect, project.briefing, lead.acquire,\nlead.handover, task.submit, task.get, task.control, task.retry, task.reconcile,\ndecision.record, inbox.read, inbox.ack. See README.md for examples.\n`,
  );
}
main().catch((e) => {
  if ((args[0] === 'setup' || args[0] === 'init') && args.includes('--json'))
    print({ ok: false, error: e.message });
  else console.error(e.message);
  process.exitCode = 1;
});
