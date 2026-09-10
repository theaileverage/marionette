import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { Effect } from 'effect';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { cliActions, cliCommands } from '../src/cli-help.js';
import { privateJson } from '../src/private-json.js';
import { serve } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { swarmTools } from '../src/swarm-tools.js';

const exec = promisify(execFile);
const cli = resolve(process.env.MARIONETTE_TEST_CLI ?? 'src/cli.ts');

test('help enumerates every command and action; command help never performs its action', async () => {
  const home = realpathSync(mkdtempSync(resolve(tmpdir(), 'marionette-help-')));
  try {
    const { stdout } = await exec(process.execPath, [cli, '--help']);
    for (const command of Object.keys(cliCommands)) {
      assert.ok(stdout.includes(command), command);
      const help = await exec(process.execPath, [cli, command, '--help', '--home', home]);
      assert.match(help.stdout, /Usage:/, command);
    }
    assert.equal(existsSync(resolve(home, 'config.json')), false);
    for (const action of cliActions) assert.ok(stdout.includes(action), action);
    const mcp = readFileSync(resolve('src/mcp.ts'), 'utf8');
    for (const match of mcp.matchAll(/tool\(\s*'[^']+',\s*'([^']+)'/g))
      assert.ok(cliActions.includes(match[1]), match[1]);
    for (const tool of swarmTools) assert.ok(cliActions.includes(`swarm.${tool.action}`));
    for (const file of ['service.ts', 'orchestration.ts', 'continuation.ts', 'cleanup.ts']) {
      const source = readFileSync(resolve('src', file), 'utf8');
      for (const match of source.matchAll(/(?:action ===|case) '([^']+)'/g))
        assert.ok(cliActions.includes(match[1]), `${file}: ${match[1]}`);
    }
    const alias = await exec(process.execPath, [cli, 'help', 'profiles']);
    assert.match(alias.stdout, /validate ID/);
    await assert.rejects(exec(process.execPath, [cli, 'typo']), /Unknown command/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('profile and role CLI commands persist validated configuration without losing other entries', async () => {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'marionette-config-cli-')));
  const home = resolve(root, 'state');
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = probe.port;
  probe.stop(true);
  assert.ok(port);
  const runtime = await serve(home, port);
  try {
    await runtime.supervisor.stop();
    const config = loadConfig(home);
    runtime.service.store.put('project', 'cli-test', {
      id: 'cli-test',
      name: 'CLI test',
      root,
      session: 'default',
      socketPath: resolve(root, 'absent.sock'),
      workspaceId: 'w1',
      maxConcurrency: 1,
      agentArgs: {},
      createdAt: new Date().toISOString(),
    });
    const { lease } = await runtime.service.invoke('lead.acquire', {
      projectId: 'cli-test',
      owner: 'Ada',
      agent: 'codex',
      expectedEpoch: 0,
      reason: 'CLI fixture',
    });
    const leasePath = resolve(home, 'lead.json');
    privateJson(leasePath, lease);
    privateJson(resolve(root, '.marionette/project.json'), {
      version: 1,
      home,
      instanceId: config.id,
      projectId: 'cli-test',
      root,
      session: 'default',
      socket: resolve(root, 'absent.sock'),
      workspace: 'w1',
      lead: 'codex',
      leadName: 'Ada',
      leasePath,
      runtime: resolve('.'),
      mcp: 'skip',
    });
    const run = async (...args: string[]) =>
      JSON.parse((await exec(process.execPath, [cli, ...args, '--project', root])).stdout);
    runtime.service.orchestration.discoverModels = (kind) =>
      Effect.succeed({
        kind,
        models: [],
        source: 'fixture',
        fetchedAt: '2026-09-10',
      });
    runtime.service.orchestration.probeProfile = () =>
      Effect.succeed({ output: 'fixture', evidence: 'fixture validated' });
    const discovered = await run('profiles', 'discover', '--kind', 'codex');
    assert.deepEqual(discovered.added, []);
    const before = await run('profiles');
    await run(
      'profiles',
      'set',
      'fixture-model',
      '--kind',
      'codex',
      '--model',
      'exact-fixture-model',
      '--categories',
      'implementation,review',
      '--can-delegate',
      'true',
    );
    const after = await run('profiles');
    assert.equal(after.profiles.length, before.profiles.length + 1);
    assert.equal((await run('profiles', 'show', 'fixture-model')).availability, 'unverified');
    await run('profiles', 'validate', 'fixture-model');
    assert.equal((await run('profiles', 'show', 'fixture-model')).availability, 'available');
    await run('profiles', 'default', 'review', 'fixture-model');
    await run('profiles', 'set', 'fixture-model', '--max-concurrency', '3');
    assert.equal((await run('profiles')).defaults.review, 'fixture-model');
    await run(
      'roles',
      'set',
      'reviewer',
      '--profile',
      'fixture-model',
      '--activity',
      'inspect',
      '--global',
    );
    await run('roles', 'set', 'reviewer', '--can-delegate', 'true');
    const roles = await run('roles');
    assert.equal(roles.defaults[0].canDelegate, false);
    assert.equal(roles.roles[0].canDelegate, true);
    await assert.rejects(run('profiles', 'remove', 'fixture-model'), /unknown profile/);
    await assert.rejects(
      run('roles', 'set', 'bad', '--profile', 'missing', '--activity', 'inspect'),
      /unknown profile/,
    );
    await assert.rejects(
      run('profiles', 'set', 'fixture-model', '--reasoning', 'unsupported'),
      /Default effort must be supported/,
    );
    assert.equal((await run('profiles', 'show', 'fixture-model')).reasoning, undefined);
    await run('roles', 'remove', 'reviewer');
    assert.equal((await run('roles', 'show', 'reviewer')).canDelegate, false);
    await run('roles', 'remove', 'reviewer', '--global');
    await run('profiles', 'remove', 'fixture-model');
    assert.deepEqual((await run('profiles')).defaults, {});
    assert.equal((await run('profiles')).profiles.length, before.profiles.length);
  } finally {
    await runtime.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});
