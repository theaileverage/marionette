import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, isAbsolute } from 'node:path';
import { test, onTestFinished } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mcpServerName } from '../src/mcp-registration.js';
import { trustAgyWorkspace } from '../src/agy-trust.js';
import { installRuntime } from '../src/runtime.js';
import { Service } from '../src/service.js';
import { mcpCommand, privateJson, setupPlan } from '../src/setup.js';
import { Store } from '../src/store.js';

function fixture() {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'marionette-setup-')));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
test('AGY trust preserves settings, permissions and existing roots and is idempotent', () => {
  const root = fixture(),
    settings = resolve(root, 'settings.json');
  const original = {
    trustedWorkspaces: ['/existing/project'],
    model: 'chosen-model',
    permissions: { mode: 'ask' },
  };
  writeFileSync(settings, JSON.stringify(original), { mode: 0o640 });
  assert.equal(trustAgyWorkspace(root, settings).changed, true);
  const after = readFileSync(settings, 'utf8');
  assert.deepEqual(JSON.parse(after), {
    ...original,
    trustedWorkspaces: ['/existing/project', root],
  });
  assert.equal(statSync(settings).mode & 0o777, 0o640);
  assert.equal(trustAgyWorkspace(root, settings).changed, false);
  assert.equal(readFileSync(settings, 'utf8'), after);
});
test('AGY trust fails closed on malformed data and concurrent lock', () => {
  const root = fixture(),
    settings = resolve(root, 'settings.json');
  for (const input of ['invalid', '[]', '{"trustedWorkspaces":true}']) {
    writeFileSync(settings, input);
    assert.throws(() => trustAgyWorkspace(root, settings));
    assert.equal(readFileSync(settings, 'utf8'), input);
    assert.equal(existsSync(settings + '.marionette.lock'), false);
  }
  writeFileSync(settings, '{}');
  writeFileSync(settings + '.marionette.lock', 'existing');
  assert.throws(() => trustAgyWorkspace(root, settings), /being edited/);
  assert.equal(readFileSync(settings, 'utf8'), '{}');
});
test('setup dry plan is read-only, validates input and retains saved lead preferences', () => {
  const root = fixture(),
    home = resolve(root, 'state');
  assert.throws(() => setupPlan({ project: root, lead: 'typo' }));
  assert.throws(() => setupPlan({ project: root, trutsAgy: true }));
  const plan = setupPlan({ project: root, home, lead: 'claude', leadName: 'Ada', mcp: 'skip' });
  assert.equal(plan.leadName, 'Ada');
  assert.equal(existsSync(home), false);
  privateJson(resolve(root, '.marionette/project.json'), {
    home,
    lead: 'claude',
    leadName: 'Ada',
    trustAgy: false,
    mcp: 'skip',
    session: plan.session,
    socket: plan.socket,
    workspace: 'w9',
  });
  const repeat = setupPlan({ project: root });
  assert.equal(repeat.leadName, 'Ada');
  assert.equal(repeat.lead, 'claude');
  assert.equal(repeat.trustAgy, false);
  assert.equal(repeat.workspace, 'w9');
  assert.equal(repeat.workspaceExplicit, false);
  assert.equal(setupPlan({ project: root, workspace: 'w9' }).workspaceExplicit, true);
  assert.equal(statSync(resolve(root, '.marionette/project.json')).mode & 0o777, 0o600);
});
test('durable runtime survives deletion of the Bun package cache and reuses identical content', () => {
  const root = fixture(),
    source = resolve(root, 'bun-cache/package'),
    home = resolve(root, 'state');
  mkdirSync(resolve(source, 'dist'), { recursive: true });
  mkdirSync(resolve(source, 'public'), { recursive: true });
  writeFileSync(resolve(source, 'package.json'), '{"version":"1.2.3"}');
  writeFileSync(resolve(source, 'dist/cli.js'), 'cli');
  writeFileSync(resolve(source, 'dist/harness-guard.js'), 'guard');
  writeFileSync(resolve(source, 'dist/mcp.js'), 'mcp');
  writeFileSync(resolve(source, 'public/index.html'), 'dashboard');
  const runtime = installRuntime(home, source);
  assert.equal(installRuntime(home, source), runtime);
  rmSync(source, { recursive: true });
  assert.equal(readFileSync(resolve(runtime, 'dist/mcp.js'), 'utf8'), 'mcp');
  assert.equal(readFileSync(resolve(runtime, 'public/index.html'), 'utf8'), 'dashboard');
  assert.equal(installRuntime(home, runtime), runtime);
});
test('all MCP client commands use separate arguments and stable executable paths', () => {
  for (const agent of ['codex-desktop', 'codex', 'claude', 'agy'] as const) {
    const c = mcpCommand(
      agent,
      'marionette-test',
      '/path with spaces/runtime',
      '/state with spaces',
    );
    assert.equal(c.binary, agent === 'codex-desktop' ? 'codex' : agent);
    assert.equal(c.server.command, process.execPath);
    assert.ok(isAbsolute(c.server.command));
    assert.ok(!c.args.includes('--no-warnings') && !c.args.includes('--import'));
    assert.deepEqual(c.args.slice(-4), [
      process.execPath,
      '/path with spaces/runtime/dist/mcp.js',
      '--home',
      '/state with spaces',
    ]);
    if (agent === 'claude') assert.ok(c.args.includes('user'));
  }
});
test('named lead agent metadata follows handover while old leases are fenced', async () => {
  const root = fixture(),
    store = new Store(resolve(root, 'state.sqlite'));
  onTestFinished(() => store.close());
  const service = new Service(store, () => ({ call: async () => ({}) }));
  const p = await service.invoke('project.register', {
    name: 'Test',
    root,
    session: 'test',
    socketPath: '/tmp/test.sock',
    workspaceId: 'w1',
  });
  const first = await service.invoke('lead.acquire', {
    projectId: p.id,
    owner: 'Ada',
    agent: 'claude',
    expectedEpoch: 0,
    reason: 'setup',
  });
  assert.equal(first.briefing.lead.agent, 'claude');
  const next = await service.invoke('lead.handover', {
    lease: first.lease,
    toOwner: 'Grace',
    agent: 'agy',
    reason: 'handover',
  });
  assert.equal(next.briefing.lead.owner, 'Grace');
  assert.equal(next.briefing.lead.agent, 'agy');
  await assert.rejects(
    service.invoke('project.configure', { lease: first.lease, trustAgyWorkspaces: true }),
    /another lead/,
  );
  assert.equal(
    (await service.invoke('project.configure', { lease: next.lease, trustAgyWorkspaces: true }))
      .trustAgyWorkspaces,
    true,
  );
});

test('preflight requires a terminal lead even without MCP installation, and treats other workers as optional', async () => {
  const { setupRequirements, toolInstaller } = await import('../src/setup-dependencies.js');
  assert.deepEqual(
    setupRequirements({ lead: 'claude', mcp: 'skip' })
      .filter((tool) => tool.required)
      .map((tool) => tool.binary),
    ['git', 'herdr', 'claude'],
  );
  assert.deepEqual(
    setupRequirements({ lead: 'codex-desktop', mcp: 'print' })
      .filter((tool) => tool.required)
      .map((tool) => tool.binary),
    ['git', 'herdr'],
  );
  assert.equal(setupPlan({ project: fixture() }).installTools, false);
  assert.deepEqual(toolInstaller('herdr', true, false), {
    binary: 'brew',
    args: ['install', 'herdr'],
  });
  assert.deepEqual(toolInstaller('herdr', false, false), {
    url: 'https://herdr.dev/install.sh',
    shell: 'sh',
  });
  assert.equal(toolInstaller('agy', true, true), undefined);
});

test('MCP display quotes only arguments that need shell escaping and round-trips special characters', () => {
  const ordinary = mcpCommand('codex', 'mnett-menderly-mendy', '/runtime', '/state');
  assert.ok(ordinary.shell.startsWith('codex mcp add mnett-menderly-mendy -- '));
  assert.ok(!ordinary.shell.includes("'"));
  const special = mcpCommand(
    'codex',
    'mnett-project-lead',
    "/runtime's files/$(false)",
    '/state with spaces; echo unsafe',
  );
  const args = execFileSync('/bin/sh', ['-c', `set -- ${special.shell}; printf '%s\\0' "$@"`], {
    encoding: 'utf8',
  })
    .split('\0')
    .slice(0, -1);
  assert.deepEqual(args, [special.binary, ...special.args]);
});

test('MCP names use readable project and lead slugs with bounded safe characters', () => {
  assert.equal(mcpServerName('Menderly', 'Mendy'), 'mnett-menderly-mendy');
  assert.equal(mcpServerName('Café & Co.', 'Ada Lovelace'), 'mnett-cafe-co-ada-lovelace');
  assert.match(mcpServerName('项目', '✨'), /^[a-z0-9-]+$/);
  assert.ok(mcpServerName('project'.repeat(30), 'lead'.repeat(30)).length <= 60);
});

test('setup and init both accept explicit takeover and preserve the chosen lead', () => {
  const root = fixture();
  for (const command of ['setup', 'init']) {
    const output = execFileSync(
      process.execPath,
      [
        'src/cli.ts',
        command,
        '--project',
        root,
        '--lead',
        'codex',
        '--lead-name',
        'Mendy',
        '--takeover',
        '--dry-run',
      ],
      { encoding: 'utf8' },
    );
    const plan = JSON.parse(output);
    assert.equal(plan.takeover, true);
    assert.equal(plan.lead, 'codex');
    assert.equal(plan.leadName, 'Mendy');
    assert.equal(existsSync(resolve(root, '.marionette')), false);
  }
});

test('lead recovery provides a shell-safe command with the selected project and lead', async () => {
  const { leadRecoveryInstructions } = await import('../src/setup.js');
  const root = fixture();
  const recovery = leadRecoveryInstructions(root, resolve(root, 'state'), 'codex', "Mendy's lead");
  const command = recovery.split('\n')[1].replace('marionette setup', 'setup');
  const result = execFileSync(
    '/bin/sh',
    ['-c', 'exec "$1" src/cli.ts ' + command + ' --dry-run', 'test', process.execPath],
    { encoding: 'utf8' },
  );
  const plan = JSON.parse(result);
  assert.equal(plan.takeover, true);
  assert.equal(plan.leadName, "Mendy's lead");
  assert.equal(plan.root, root);
  assert.match(recovery, /lead_handover/);
  assert.match(recovery, /invalidates/);
});

test('a stale saved lead reports the exact recovery command without acquiring control', async () => {
  const { Effect } = await import('effect');
  const { initConfig } = await import('../src/config.js');
  const { launchLeadEffect } = await import('../src/setup.js');
  const root = fixture();
  const home = resolve(root, 'state');
  mkdirSync(home);
  const store = new Store(resolve(home, 'state.sqlite'));
  onTestFinished(() => store.close());
  const service = new Service(store, () => ({ call: async () => ({}) }));
  const project = await service.invoke('project.register', {
    name: 'Test',
    root,
    session: 'test',
    socketPath: '/tmp/test.sock',
    workspaceId: 'w1',
  });
  const old = await service.invoke('lead.acquire', {
    projectId: project.id,
    owner: 'Mendy',
    agent: 'codex',
    expectedEpoch: 0,
    reason: 'setup',
  });
  await service.invoke('lead.acquire', {
    projectId: project.id,
    owner: 'Mendy',
    agent: 'codex',
    expectedEpoch: 1,
    takeover: true,
    reason: 'another session',
  });
  const calls: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const body = await request.json();
      calls.push(body.action);
      return Response.json({ result: await service.invoke(body.action, body.input) });
    },
  });
  onTestFinished(() => server.stop(true));
  initConfig(home, server.port!);
  const leasePath = resolve(home, 'leads', project.id + '.json');
  privateJson(leasePath, old.lease);
  privateJson(resolve(root, '.marionette/project.json'), {
    root,
    home,
    projectId: project.id,
    leasePath,
    lead: 'codex',
    leadName: 'Mendy',
  });
  await assert.rejects(Effect.runPromise(launchLeadEffect(root, true)), (error: Error) => {
    assert.match(error.message, /saved lead no longer controls/);
    assert.match(error.message, /marionette setup --project/);
    assert.match(error.message, /--takeover/);
    return true;
  });
  assert.deepEqual(calls, ['project.briefing']);
  assert.deepEqual(JSON.parse(readFileSync(leasePath, 'utf8')), old.lease);
});

test('lead rejects recovery flags and unknown options before loading project state', () => {
  for (const option of ['--handover', '--takeover', '--typo', '--project']) {
    const result = Bun.spawnSync([process.execPath, 'src/cli.ts', 'lead', option], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.notEqual(result.exitCode, 0);
    const output = result.stderr.toString();
    if (option === '--handover' || option === '--takeover') {
      assert.match(output, /marionette setup --takeover/);
      assert.match(output, /current lead must call lead_handover/);
    } else assert.match(output, /Unknown option|argument missing/);
    assert.doesNotMatch(output, /saved lead no longer controls/);
  }
  const help = execFileSync(process.execPath, ['src/cli.ts', 'lead', '--help'], {
    encoding: 'utf8',
  });
  assert.match(help, /Usage: marionette lead/);
});

test('new projects share the default Herdr session while saved and explicit sessions remain stable', () => {
  const root = fixture();
  const other = fixture();
  const first = setupPlan({ project: root });
  const second = setupPlan({ project: other });
  assert.equal(first.session, 'default');
  assert.equal(second.socket, first.socket);
  assert.notEqual(first.workspaceLabel, second.workspaceLabel);
  assert.equal(setupPlan({ project: root, session: 'custom' }).session, 'custom');
  privateJson(resolve(root, '.marionette/project.json'), {
    session: 'marionette-legacy',
    socket: '/saved/herdr.sock',
    workspace: 'w9',
  });
  const saved = setupPlan({ project: root });
  assert.equal(saved.session, 'marionette-legacy');
  assert.equal(saved.socket, '/saved/herdr.sock');
  assert.equal(saved.workspace, 'w9');
  const explicit = setupPlan({ project: root, session: 'default' });
  assert.equal(explicit.session, 'default');
  assert.notEqual(explicit.socket, '/saved/herdr.sock');
});

test('runtime installer copies future bundles and includes them in its content identity', () => {
  const root = fixture();
  const source = resolve(root, 'package');
  mkdirSync(resolve(source, 'dist/chunks'), { recursive: true });
  mkdirSync(resolve(source, 'public'), { recursive: true });
  writeFileSync(resolve(source, 'package.json'), '{"version":"0.5.3"}');
  writeFileSync(resolve(source, 'dist/cli.js'), 'cli');
  writeFileSync(resolve(source, 'dist/mcp.js'), 'mcp');
  writeFileSync(resolve(source, 'dist/harness-guard.js'), 'guard');
  writeFileSync(resolve(source, 'dist/chunks/future.js'), 'future-v1');
  writeFileSync(resolve(source, 'public/index.html'), 'ui');
  const first = installRuntime(resolve(root, 'home'), source);
  const alias = resolve(root, 'home-alias');
  symlinkSync(resolve(root, 'home'), alias, 'dir');
  assert.equal(
    installRuntime(alias, first),
    first,
    'An installed runtime retains its path through a home alias',
  );
  assert.equal(readFileSync(resolve(first, 'dist/chunks/future.js'), 'utf8'), 'future-v1');
  writeFileSync(resolve(source, 'dist/chunks/future.js'), 'future-v2');
  const second = installRuntime(resolve(root, 'home'), source);
  assert.notEqual(first, second);
  assert.equal(readFileSync(resolve(second, 'dist/chunks/future.js'), 'utf8'), 'future-v2');
});

test('lead reconnects a legacy receipt after update without rewriting live guard files or validating new profiles', async () => {
  const { createHash } = await import('node:crypto');
  const { createServer } = await import('node:net');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { initConfig } = await import('../src/config.js');
  const root = fixture();
  const home = resolve(root, 'state');
  const xdg = resolve(root, 'xdg');
  const socket = resolve(xdg, 'herdr/herdr.sock');
  mkdirSync(resolve(xdg, 'herdr'), { recursive: true });
  const projectId = 'legacy-project';
  const name = `lead-${createHash('sha256').update(projectId).digest('hex').slice(0, 12)}-1`;
  const agent = {
    name,
    agent: 'codex',
    cwd: root,
    workspace_id: 'w1',
    tab_id: 'w1:t2',
    pane_id: 'w1:p2',
    terminal_id: 'original-terminal',
  };
  const methods: string[] = [];
  const herdr = createServer((stream) => {
    let buffer = '';
    stream.on('data', (data) => {
      buffer += data;
      if (!buffer.includes('\n')) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
      methods.push(request.method);
      if (!['ping', 'workspace.get', 'agent.list', 'tab.focus'].includes(request.method)) {
        stream.end(
          JSON.stringify({
            id: request.id,
            error: { code: 'unexpected', message: request.method },
          }) + '\n',
        );
        return;
      }
      const result = request.method === 'agent.list' ? { agents: [agent] } : { type: 'ok' };
      stream.end(JSON.stringify({ id: request.id, result }) + '\n');
    });
  });
  await new Promise<void>((ok, fail) => {
    herdr.once('error', fail);
    herdr.listen(socket, ok);
  });
  onTestFinished(() => new Promise<void>((ok) => herdr.close(() => ok())));
  const calls: string[] = [];
  const http = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const input = await request.json();
      calls.push(input.action);
      assert.equal(input.action, 'project.briefing');
      return Response.json({
        result: {
          project: {
            id: projectId,
            name: 'Legacy project',
            root,
            session: 'default',
            socketPath: socket,
            workspaceId: 'w1',
            maxConcurrency: 1,
            agentArgs: {},
            coordinatorOnly: true,
            trustWorkspaces: false,
            createdAt: 'now',
          },
          lead: { owner: 'Ada', epoch: 1, agent: 'codex' },
          profiles: [],
        },
      });
    },
  });
  onTestFinished(() => http.stop(true));
  initConfig(home, http.port!);
  const leasePath = resolve(home, 'leads/legacy-project.json');
  privateJson(leasePath, { projectId, owner: 'Ada', epoch: 1, token: 'a'.repeat(48) });
  const receiptPath = resolve(home, 'leads/legacy-project.terminal.json');
  privateJson(receiptPath, {
    name,
    agent: 'codex',
    pane_id: agent.pane_id,
    terminal_id: agent.terminal_id,
  });
  const receipt = readFileSync(receiptPath, 'utf8');
  const policy = resolve(home, 'guards/legacy-project/lead-1/policy.json');
  privateJson(policy, { marker: 'original-live-policy' });
  const originalPolicy = readFileSync(policy, 'utf8');
  for (const version of ['0.5.2', '0.5.3']) {
    privateJson(resolve(root, '.marionette/project.json'), {
      root,
      home,
      projectId,
      leasePath,
      lead: 'codex',
      leadName: 'Ada',
      session: 'default',
      socket,
      workspace: 'w1',
      runtime: resolve(home, 'runtimes', version),
      leadProfile: 'not-validated-yet',
    });
    const cli = resolve(process.env.MARIONETTE_TEST_CLI ?? 'src/cli.ts');
    const output = await promisify(execFile)(
      process.execPath,
      [
        '--eval',
        `Object.defineProperty(process.stdin, 'isTTY', {value:true}); process.argv = ['bun', ${JSON.stringify(cli)}, 'lead', '--project', ${JSON.stringify(root)}]; await import(${JSON.stringify(cli)});`,
      ],
      {
        env: { ...process.env, XDG_CONFIG_HOME: xdg, HERDR_ENV: '1', HERDR_SOCKET_PATH: socket },
      },
    );
    assert.match(output.stdout, /Reconnected to the existing lead conversation/);
    assert.equal(readFileSync(receiptPath, 'utf8'), receipt);
    assert.equal(readFileSync(policy, 'utf8'), originalPolicy);
    assert.equal(existsSync(resolve(root, '.marionette/lead.lock')), false);
  }
  assert.deepEqual(methods, [
    'ping',
    'workspace.get',
    'agent.list',
    'tab.focus',
    'ping',
    'workspace.get',
    'agent.list',
    'tab.focus',
  ]);
  assert.deepEqual(calls, Array(4).fill('project.briefing'));
});
