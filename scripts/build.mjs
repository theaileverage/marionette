import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

rmSync(join(root, 'dist'), { recursive: true, force: true });

const compiled = spawnSync(
  join(root, 'node_modules', '.bin', 'tsc'),
  ['--project', 'tsconfig.build.json'],
  {
    cwd: root,
    stdio: 'inherit',
  },
);

assert.ifError(compiled.error);

if (compiled.status !== 0) process.exit(compiled.status ?? 1);

for (const artifact of [
  'v1/cli.js',
  'v1/index.js',
  'v1/index.d.ts',
  'v1/sql-worker.js',
  'herdr-sdk.js',
]) {
  assert.ok(existsSync(join(root, 'dist', artifact)), `Missing build artifact: ${artifact}`);
}

chmodSync(join(root, 'dist', 'v1', 'cli.js'), 0o755);

for (const asset of ['workflows/feature.json', 'skills/marionette/SKILL.md']) {
  assert.ok(existsSync(join(root, asset)), `Missing packaged resource: ${asset}`);
}

process.stdout.write('Built root Marionette package and declaration files.\n');
