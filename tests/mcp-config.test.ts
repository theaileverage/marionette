import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { initConfig } from '../src/config.js';
import { packageRoot } from '../src/runtime.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'marionette-mcp-config-')));
  roots.push(root);
  const home = resolve(root, 'data');
  mkdirSync(home);
  return { root, home };
}
function run(root: string, home: string, args: string[] = []) {
  return Bun.spawnSync(
    [process.execPath, resolve(packageRoot, 'src/cli.ts'), 'mcp-config', ...args],
    {
      cwd: root,
      env: { ...process.env, MARIONETTE_HOME: home },
    },
  );
}
test('unbound output preserves Codex TOML and supports every adapter', () => {
  const { root, home } = fixture();
  const legacy = run(root, home);
  expect(legacy.exitCode).toBe(0);
  expect(Bun.TOML.parse(legacy.stdout.toString())).toHaveProperty('mcp_servers.marionette');
  for (const agent of ['codex', 'claude', 'agy', 'omp']) {
    const result = run(root, home, ['--agent', agent]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(agent === 'omp' ? 'mcpServers' : `${agent} mcp add`);
  }
  const all = run(root, home, ['--agent', 'all']);
  expect(all.exitCode).toBe(0);
  for (const text of ['codex mcp add', 'claude mcp add', 'agy mcp add', 'mcpServers'])
    expect(all.stdout.toString()).toContain(text);
});
test('bound output infers the lead and prints only the scoped connection', () => {
  const { root, home } = fixture();
  initConfig(home, 5432);
  mkdirSync(resolve(root, '.marionette'));
  const leasePath = resolve(home, 'lease.json');
  writeFileSync(
    resolve(root, '.marionette/project.json'),
    JSON.stringify({
      version: 1,
      home,
      instanceId: 'instance',
      projectId: 'project',
      root,
      session: 'default',
      socket: '/tmp/test.sock',
      workspace: 'w1',
      lead: 'claude',
      leadName: 'Ada',
      leasePath,
      runtime: packageRoot,
      mcp: 'print',
    }),
  );
  mkdirSync(resolve(home, 'clients'));
  writeFileSync(
    resolve(home, 'clients/claude--mnett-existing-ada.json'),
    JSON.stringify({
      name: 'mnett-existing-ada',
      runtime: packageRoot,
      projectId: 'project',
    }),
  );
  const result = run(root, home);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toStartWith('claude mcp add');
  expect(result.stdout.toString()).toContain('mnett-existing-ada');
  const all = run(root, home, ['--agent', 'all']);
  expect(all.exitCode).toBe(0);
  expect(all.stdout.toString()).toContain('--lead-lease');
  expect(all.stdout.toString()).toContain(leasePath);
  expect(all.stdout.toString()).toContain('http://127.0.0.1:5432');
  expect(all.stdout.toString()).not.toContain('--home');
  expect(all.stdout.toString()).not.toContain('token');
  const toml = run(root, home, ['--agent', 'codex', '--format', 'toml']);
  expect(toml.exitCode).toBe(0);
  expect(Bun.TOML.parse(toml.stdout.toString())).toHaveProperty('mcp_servers.mnett-project-ada');
});
test('invalid arguments and missing explicit projects fail', () => {
  const { root, home } = fixture();
  for (const args of [
    ['--bogus'],
    ['--agent', 'unknown'],
    ['--format', 'json'],
    ['--agent', 'all', '--format', 'toml'],
    ['--project', root],
  ]) {
    const result = run(root, home, args);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toBe('');
  }
});
