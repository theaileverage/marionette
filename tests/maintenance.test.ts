import assert from 'node:assert/strict';
import { test, onTestFinished } from 'bun:test';
import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { initConfig } from '../src/config.js';
import { privateJson } from '../src/private-json.js';
import { installRuntime } from '../src/runtime.js';
import { Store } from '../src/store.js';
import { readInstanceState, projectRecordKeys } from '../src/instance-state.js';

const sourceRoot = resolve('.');
function fixture() {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'marionette-maintenance-')));
  const home = resolve(root, 'home'),
    bin = resolve(root, 'bin'),
    codex = resolve(root, 'codex');
  mkdirSync(bin);
  mkdirSync(codex);
  const listener = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response('fixture'),
  });
  const port = listener.port;
  listener.stop(true);
  assert.ok(port);
  const config = initConfig(home, port);
  const client = resolve(bin, 'codex');
  // The shebang must remain runnable when the fixture PATH contains only test CLIs first.
  const clientSource = readFileSync(resolve('tests/fixtures/mcp-client.mjs'), 'utf8').replace(
    '#!/usr/bin/env bun',
    '#!' + process.execPath,
  );
  writeFileSync(client, clientSource, { mode: 0o755 });
  function packageFixture(version: string, fail = false) {
    const dir = resolve(root, 'package-' + version + (fail ? '-fail' : ''));
    mkdirSync(resolve(dir, 'dist'), { recursive: true });
    mkdirSync(resolve(dir, 'public'));
    privateJson(resolve(dir, 'package.json'), {
      name: '@theaileverage/marionette',
      version,
      testFailStart: fail,
    });
    copyFileSync(resolve('tests/fixtures/runtime-cli.mjs'), resolve(dir, 'dist/cli.js'));
    chmodSync(resolve(dir, 'dist/cli.js'), 0o755);
    writeFileSync(resolve(dir, 'dist/mcp.js'), '// fixture');
    writeFileSync(resolve(dir, 'public/index.html'), '<p>fixture</p>');
    return dir;
  }
  const old = installRuntime(home, packageFixture('0.2.2'));
  const projects = ['one', 'two'].map((id) => {
    const projectRoot = resolve(root, id);
    mkdirSync(projectRoot);
    const p = {
      id,
      name: id,
      root: projectRoot,
      session: 'test',
      socketPath: resolve(root, 'absent.sock'),
      workspaceId: id === 'one' ? 'w1' : 'w2',
      maxConcurrency: 3,
      agentArgs: {},
      createdAt: 'now',
    };
    privateJson(resolve(projectRoot, '.marionette/project.json'), {
      version: 1,
      instanceId: config.id,
      projectId: id,
      root: projectRoot,
      home,
      runtime: old,
      session: p.session,
      socket: p.socketPath,
      workspace: p.workspaceId,
      lead: 'codex',
      leadName: 'Mendy',
      leasePath: resolve(home, 'leads', id + '.json'),
      mcp: 'install',
      trustAgy: false,
    });
    privateJson(resolve(home, 'leads', id + '.json'), {
      projectId: id,
      owner: 'Mendy',
      epoch: 1,
      token: 'private-test-token',
    });
    writeFileSync(resolve(projectRoot, 'source.txt'), 'preserve this code');
    return p;
  });
  // Seed in a separate process so no parent SQLite handles retain WAL mappings
  // while the runtime fixture reproduces Node's sidecar removal on shutdown.
  execFileSync(process.execPath, [
    '--eval',
    `
    import { Store } from ${JSON.stringify(resolve(sourceRoot, 'src/store.ts'))};
    const store = new Store(${JSON.stringify(resolve(home, 'state.sqlite'))});
    for (const p of ${JSON.stringify(projects)}) {
      store.put('project', p.id, p);
      store.put('lead', p.id, { projectId: p.id, owner: 'Mendy', epoch: 1, tokenHash: 'preserve' });
      store.put('idempotency', p.id + ':request', { fingerprint: 'preserve', result: { value: p.id } });
      store.put('cursor', p.id + ':client', 12);
      store.event(p.id, 'test', 'preserve history');
    }
    store.close();
  `,
  ]);
  const name = 'marionette-' + config.id.slice(0, 8);
  execFileSync(
    client,
    ['mcp', 'add', name, '--', process.execPath, resolve(old, 'dist/mcp.js'), '--home', home],
    { env: { ...process.env, CODEX_HOME: codex } },
  );
  privateJson(resolve(home, 'clients/codex.json'), { name, runtime: old });
  const env = {
    ...process.env,
    CODEX_HOME: codex,
    MARIONETTE_CLAUDE_SETTINGS: resolve(root, 'claude.json'),
    MARIONETTE_AGY_SETTINGS: resolve(root, 'agy.json'),
    PATH: bin + ':' + process.env.PATH,
  };
  function run(code: string) {
    return JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--eval',
          `import { Effect } from 'effect';
      import { upgradeInstanceEffect, runtimeStatusEffect } from ${JSON.stringify(resolve(sourceRoot, 'src/runtime-upgrade.ts'))};
      import { removeProjectsEffect, inspectRemovalEffect } from ${JSON.stringify(resolve(sourceRoot, 'src/removal.ts'))};
      import { readInstanceState } from ${JSON.stringify(resolve(sourceRoot, 'src/instance-state.ts'))};
      const home = ${JSON.stringify(home)};
      ${code}`,
        ],
        { cwd: sourceRoot, env, encoding: 'utf8', timeout: 30000 },
      ),
    );
  }
  onTestFinished(() => {
    try {
      execFileSync(process.execPath, [resolve(old, 'dist/cli.js'), 'stop', '--home', home], {
        timeout: 10000,
        stdio: 'ignore',
      });
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  return { root, home, old, projects, packageFixture, run, env, codex, name };
}

test('upgrade moves both project bindings and the shared MCP registration while preserving durable authority', () => {
  const f = fixture(),
    target = f.packageFixture('0.3.0');
  execFileSync(process.execPath, [resolve(f.old, 'dist/cli.js'), 'start', '--home', f.home]);
  const result = f.run(
    `console.log(JSON.stringify(await Effect.runPromise(upgradeInstanceEffect(home, ${JSON.stringify(target)}))));`,
  );
  assert.equal(result.version, '0.3.0');
  assert.equal(result.projects, 2);
  for (const p of f.projects) {
    const binding = JSON.parse(readFileSync(resolve(p.root, '.marionette/project.json'), 'utf8'));
    assert.equal(binding.runtime, result.runtime);
    assert.equal(binding.leadName, 'Mendy');
    assert.equal(binding.trustAgy, false);
    assert.equal(readFileSync(resolve(p.root, 'source.txt'), 'utf8'), 'preserve this code');
  }
  const state = readInstanceState(f.home);
  assert.equal(
    state.rows.find((row) => row.kind === 'lead' && row.id === 'one')?.data,
    '{"projectId":"one","owner":"Mendy","epoch":1,"tokenHash":"preserve"}',
  );
  assert.match(
    readFileSync(resolve(f.codex, 'config.toml'), 'utf8'),
    new RegExp(result.runtime.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
  assert.equal(existsSync(resolve(f.home, 'maintenance.lock')), false);
});

test('failed upgraded startup restores SQLite, MCP, bindings and the previous supervisor', () => {
  const f = fixture(),
    target = f.packageFixture('0.3.0', true);
  execFileSync(process.execPath, [resolve(f.old, 'dist/cli.js'), 'start', '--home', f.home]);
  const before = f.projects.map((p) =>
    readFileSync(resolve(p.root, '.marionette/project.json'), 'utf8'),
  );
  const result = f.run(
    `try { await Effect.runPromise(upgradeInstanceEffect(home, ${JSON.stringify(target)})); console.log('{}'); } catch (error) { console.log(JSON.stringify({ error: error.message })); }`,
  );
  assert.match(result.error, /Previous runtime and configuration restored/);
  assert.deepEqual(
    f.projects.map((p) => readFileSync(resolve(p.root, '.marionette/project.json'), 'utf8')),
    before,
  );
  assert.equal(
    readInstanceState(f.home).rows.some((row) => row.id === 'failed-migration'),
    false,
  );
  assert.equal(
    JSON.parse(readFileSync(resolve(f.home, 'clients/codex.json'), 'utf8')).runtime,
    f.old,
  );
});

test('project removal deletes only that project and keeps shared MCP, state and source files', () => {
  const f = fixture();
  const state = readInstanceState(f.home);
  assert.ok(projectRecordKeys(state, ['one']).some((row) => row.kind === 'idempotency'));
  const result = f.run(
    `console.log(JSON.stringify(await Effect.runPromise(removeProjectsEffect(home, ['one'], { all: false, stopAgents: false, keepHerdr: true }))));`,
  );
  assert.equal(result.removedProjects.length, 1);
  assert.equal(existsSync(resolve(f.projects[0].root, '.marionette/project.json')), false);
  assert.equal(existsSync(resolve(f.projects[1].root, '.marionette/project.json')), true);
  assert.equal(existsSync(resolve(f.home, 'clients/codex.json')), true);
  const after = readInstanceState(f.home);
  assert.deepEqual(
    after.projects.map((p) => p.id),
    ['two'],
  );
  assert.equal(
    after.rows.some((row) => row.id.startsWith('one:')),
    false,
  );
  assert.equal(
    readFileSync(resolve(f.projects[0].root, 'source.txt'), 'utf8'),
    'preserve this code',
  );
});

test('full uninstallation removes instance and owned MCP registration while preserving both source trees', () => {
  const f = fixture();
  const result = f.run(
    `console.log(JSON.stringify(await Effect.runPromise(removeProjectsEffect(home, ['one','two'], { all: true, stopAgents: false, keepHerdr: true }))));`,
  );
  assert.equal(result.uninstalled, true);
  assert.equal(existsSync(f.home), false);
  for (const p of f.projects)
    assert.equal(readFileSync(resolve(p.root, 'source.txt'), 'utf8'), 'preserve this code');
  assert.ok(!readFileSync(resolve(f.codex, 'config.toml'), 'utf8').includes(f.name));
});

test('removal preview refuses active work and preserves all bindings', () => {
  const f = fixture();
  const db = new Store(resolve(f.home, 'state.sqlite'));
  db.put('task', 'active', { projectId: 'one', status: 'running' });
  db.close();
  const result = f.run(
    `console.log(JSON.stringify(await Effect.runPromise(inspectRemovalEffect(readInstanceState(home), ['one'], { all: false, stopAgents: false, keepHerdr: true }))));`,
  );
  assert.ok(result.blockers.some((reason: string) => reason.includes('running')));
  assert.equal(existsSync(resolve(f.projects[0].root, '.marionette/project.json')), true);
});

test('runtime detection sees older saved bindings even while the supervisor is stopped', () => {
  const f = fixture(),
    target = f.packageFixture('0.3.0');
  const status = f.run(
    `console.log(JSON.stringify(await Effect.runPromise(runtimeStatusEffect(home, ${JSON.stringify(target)}))));`,
  );
  assert.equal(status.needsUpgrade, true);
  assert.deepEqual(status.versions, ['0.2.2']);
  assert.deepEqual(status.projects, ['one', 'two']);
});

test('upgrading repairs the legacy dot runtime MCP receipt', () => {
  const f = fixture(),
    target = f.packageFixture('0.3.0');
  privateJson(resolve(f.home, 'clients/codex.json'), { name: f.name, runtime: '.' });
  const result = f.run(
    `console.log(JSON.stringify(await Effect.runPromise(upgradeInstanceEffect(home, ${JSON.stringify(target)}))));`,
  );
  assert.equal(
    JSON.parse(readFileSync(resolve(f.home, 'clients/codex.json'), 'utf8')).runtime,
    result.runtime,
  );
});

test('removal refuses unknown state files and retained worktrees before touching project bindings', () => {
  const f = fixture();
  writeFileSync(resolve(f.home, 'important.txt'), 'user data');
  const worktree = resolve(f.home, 'worktrees/task');
  mkdirSync(worktree, { recursive: true });
  writeFileSync(resolve(worktree, 'source.txt'), 'unmerged work');
  const plan = f.run(
    `console.log(JSON.stringify(await Effect.runPromise(inspectRemovalEffect(readInstanceState(home), ['one','two'], { all: true, stopAgents: false, keepHerdr: true }))));`,
  );
  assert.ok(plan.blockers.some((reason: string) => reason.includes('important.txt')));
  assert.ok(plan.blockers.some((reason: string) => reason.includes('worktrees')));
  assert.equal(existsSync(resolve(f.projects[0].root, '.marionette/project.json')), true);
});

test('removal requires explicit preservation when a Herdr session is offline', () => {
  const f = fixture();
  const plan = f.run(
    `console.log(JSON.stringify(await Effect.runPromise(inspectRemovalEffect(readInstanceState(home), ['one'], { all: false, stopAgents: false, keepHerdr: false }))));`,
  );
  assert.ok(plan.blockers.some((reason: string) => reason.includes('--keep-herdr')));
});

test('owned idle workspace removal closes only the selected workspace and keeps a shared session', () => {
  const f = fixture();
  const binding = resolve(f.projects[0].root, '.marionette/project.json');
  privateJson(binding, {
    ...JSON.parse(readFileSync(binding, 'utf8')),
    ownsWorkspace: true,
    ownsSession: true,
  });
  const result = f.run(`
    const calls = [];
    const pane = { pane_id: 'w1:p1', terminal_id: 'terminal-one' };
    const h = { async call(method) {
      calls.push(method);
      if (method === 'pane.list') return { panes: [pane] };
      if (method === 'pane.get') return { pane };
      if (method === 'pane.process_info') return { process_info: { shell_pid: 10, foreground_processes: [{ pid: 10 }] } };
      if (method === 'workspace.close') return {};
      throw new Error('Unexpected method ' + method);
    } };
    const result = await Effect.runPromise(removeProjectsEffect(home, ['one'], { all: false, stopAgents: false, keepHerdr: false }, () => h));
    console.log(JSON.stringify({ result, calls }));`);
  assert.equal(result.calls.filter((call: string) => call === 'workspace.close').length, 1);
  assert.equal(result.calls.includes('server.stop'), false);
  assert.equal(existsSync(resolve(f.projects[1].root, '.marionette/project.json')), true);
});

test('changed native agent identity blocks removal even with stop-agents', () => {
  const f = fixture();
  privateJson(resolve(f.home, 'leads/one.terminal.json'), {
    pane_id: 'w1:p1',
    terminal_id: 'term',
    name: 'lead-one',
    agent: 'codex',
    agent_session: { value: 'original' },
  });
  const plan = f.run(`
    const h = { async call(method) {
      if (method === 'pane.list') return { panes: [{ pane_id: 'w1:p1', terminal_id: 'term', agent: 'codex' }] };
      if (method === 'agent.get') return { agent: { name: 'lead-one', agent: 'codex', terminal_id: 'term', agent_session: { value: 'replacement' } } };
      throw new Error('Unexpected method ' + method);
    } };
    console.log(JSON.stringify(await Effect.runPromise(inspectRemovalEffect(readInstanceState(home), ['one'], { all: false, stopAgents: true, keepHerdr: false }, () => h))));`);
  assert.ok(plan.blockers.some((reason: string) => reason.includes('unverified agent')));
});

test('offline inspection and upgrade read a checkpointed WAL database without sidecar files', () => {
  const f = fixture();
  // Reproduce the on-disk state left by a clean Node SQLite shutdown.
  execFileSync(process.execPath, [
    '--eval',
    `
    import { Database } from 'bun:sqlite';
    import { unlinkSync, existsSync } from 'node:fs';
    const file = ${JSON.stringify(resolve(f.home, 'state.sqlite'))};
    const db = new Database(file); db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close();
    for (const suffix of ['-wal', '-shm']) if (existsSync(file + suffix)) unlinkSync(file + suffix);
  `,
  ]);
  assert.equal(existsSync(resolve(f.home, 'state.sqlite-wal')), false);
  assert.equal(existsSync(resolve(f.home, 'state.sqlite-shm')), false);
  const before = readInstanceState(f.home);
  assert.deepEqual(
    before.projects.map((p) => p.name),
    ['one', 'two'],
  );
  const target = f.packageFixture('0.3.0');
  const result = f.run(
    `console.log(JSON.stringify(await Effect.runPromise(upgradeInstanceEffect(home, ${JSON.stringify(target)}))));`,
  );
  assert.equal(result.updated, true);
  assert.deepEqual(readInstanceState(f.home).rows, before.rows);
});

for (const failStart of [false, true]) {
  test(`legacy Node --no-warnings MCP registration ${failStart ? 'rolls back exactly on startup failure' : 'upgrades with its instance'}`, () => {
    const f = fixture(),
      target = f.packageFixture('0.3.0', failStart);
    const legacy = {
      command: '/usr/local/bin/node',
      args: ['--no-warnings', resolve(f.old, 'dist/mcp.js'), '--home', f.home],
    };
    execFileSync(
      resolve(f.root, 'bin/codex'),
      ['mcp', 'add', f.name, '--', legacy.command, ...legacy.args],
      { env: f.env },
    );
    execFileSync(process.execPath, [resolve(f.old, 'dist/cli.js'), 'start', '--home', f.home]);
    const beforeConfig = readFileSync(resolve(f.codex, 'config.toml'), 'utf8');
    const beforeReceipt = readFileSync(resolve(f.home, 'clients/codex.json'), 'utf8');
    const result = f.run(
      `try { console.log(JSON.stringify(await Effect.runPromise(upgradeInstanceEffect(home, ${JSON.stringify(target)})))); } catch (error) { console.log(JSON.stringify({error: error.message})); }`,
    );
    if (failStart) {
      assert.match(result.error, /Previous runtime and configuration restored/);
      assert.equal(readFileSync(resolve(f.codex, 'config.toml'), 'utf8'), beforeConfig);
      assert.equal(readFileSync(resolve(f.home, 'clients/codex.json'), 'utf8'), beforeReceipt);
    } else {
      assert.equal(result.updated, true);
      const receipt = JSON.parse(readFileSync(resolve(f.home, 'clients/codex.json'), 'utf8'));
      assert.equal(receipt.runtime, result.runtime);
      assert.deepEqual(receipt.server.args, [
        resolve(result.runtime, 'dist/mcp.js'),
        '--home',
        f.home,
      ]);
    }
  });
}

test('unrecognized Node flags remain a conflict and fail before stopping the supervisor', () => {
  const f = fixture(),
    target = f.packageFixture('0.3.0');
  execFileSync(
    resolve(f.root, 'bin/codex'),
    [
      'mcp',
      'add',
      f.name,
      '--',
      '/usr/local/bin/node',
      '--no-warnings',
      '--require',
      '/custom/loader.js',
      resolve(f.old, 'dist/mcp.js'),
      '--home',
      f.home,
    ],
    { env: f.env },
  );
  execFileSync(process.execPath, [resolve(f.old, 'dist/cli.js'), 'start', '--home', f.home]);
  const beforeLock = readFileSync(resolve(f.home, 'supervisor.lock'), 'utf8');
  const beforeConfig = readFileSync(resolve(f.codex, 'config.toml'), 'utf8');
  const result = f.run(
    `try { await Effect.runPromise(upgradeInstanceEffect(home, ${JSON.stringify(target)})); console.log('{}'); } catch (error) { console.log(JSON.stringify({error: error.message})); }`,
  );
  assert.match(result.error, /another configuration/);
  assert.equal(readFileSync(resolve(f.home, 'supervisor.lock'), 'utf8'), beforeLock);
  assert.equal(readFileSync(resolve(f.codex, 'config.toml'), 'utf8'), beforeConfig);
  assert.equal(existsSync(resolve(f.home, 'updates')), false);
});

test('readable project MCP names migrate the shared entry, survive upgrades, and remove independently', () => {
  const f = fixture();
  const names = f.run(`
    import { projectMcpName, mcpCommand, installProjectMcpEffect } from ${JSON.stringify(resolve(sourceRoot, 'src/mcp-registration.ts'))};
    const names = [];
    for (const id of ['one', 'two']) {
      const name = projectMcpName('codex', home, id, 'Menderly', 'Mendy', ${JSON.stringify(f.old)});
      await Effect.runPromise(installProjectMcpEffect(mcpCommand('codex', name, ${JSON.stringify(f.old)}, home), home, id, id === 'two'));
      names.push(name);
    }
    console.log(JSON.stringify(names));`);
  assert.deepEqual(names, ['mnett-menderly-mendy', 'mnett-menderly-mendy-2']);
  assert.equal(existsSync(resolve(f.home, 'clients/codex.json')), false);
  const target = f.packageFixture('0.3.0');
  const result = f.run(
    `console.log(JSON.stringify(await Effect.runPromise(upgradeInstanceEffect(home, ${JSON.stringify(target)}))));`,
  );
  for (const name of names) {
    const receipt = JSON.parse(
      readFileSync(resolve(f.home, 'clients', 'codex--' + name + '.json'), 'utf8'),
    );
    assert.equal(receipt.runtime, result.runtime);
    assert.ok(['one', 'two'].includes(receipt.projectId));
  }
  f.run(
    `console.log(JSON.stringify(await Effect.runPromise(removeProjectsEffect(home, ['one'], {all:false,stopAgents:false,keepHerdr:true}))));`,
  );
  const settings = readFileSync(resolve(f.codex, 'config.toml'), 'utf8');
  assert.ok(!settings.includes('mcp_servers."mnett-menderly-mendy"'));
  assert.ok(settings.includes(names[1]));
  assert.equal(existsSync(resolve(f.home, 'clients', 'codex--' + names[0] + '.json')), false);
  assert.equal(existsSync(resolve(f.home, 'clients', 'codex--' + names[1] + '.json')), true);
});

test('changing a lead name replaces only that project MCP name and a failed runtime upgrade restores its receipt', () => {
  const f = fixture();
  const result = f.run(`
    import { projectMcpName, mcpCommand, installProjectMcpEffect } from ${JSON.stringify(resolve(sourceRoot, 'src/mcp-registration.ts'))};
    const names = [];
    for (const lead of ['Mendy','Ada']) {
      const name = projectMcpName('codex', home, 'one', 'Menderly', lead, ${JSON.stringify(f.old)});
      await Effect.runPromise(installProjectMcpEffect(mcpCommand('codex', name, ${JSON.stringify(f.old)}, home), home, 'one', false));
      names.push(name);
    }
    console.log(JSON.stringify(names));`);
  assert.equal(existsSync(resolve(f.home, 'clients', 'codex--' + result[0] + '.json')), false);
  assert.equal(existsSync(resolve(f.home, 'clients/codex.json')), true);
  const path = resolve(f.home, 'clients', 'codex--' + result[1] + '.json'),
    before = readFileSync(path, 'utf8');
  const target = f.packageFixture('0.3.0', true);
  const failed = f.run(
    `try { await Effect.runPromise(upgradeInstanceEffect(home, ${JSON.stringify(target)})); console.log('{}'); } catch(error) { console.log(JSON.stringify({error:error.message})); }`,
  );
  assert.match(failed.error, /Previous runtime and configuration restored/);
  assert.equal(readFileSync(path, 'utf8'), before);
});
