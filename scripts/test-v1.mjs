import { build } from 'esbuild';
import { readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const requested = process.argv.slice(2);
const files = readdirSync('tests/v1').filter(
  (file) =>
    file.endsWith('.test.ts') &&
    (requested.length === 0 || requested.some((name) => file.includes(name))),
);
if (files.length === 0) throw new Error('No matching v1 tests');
mkdirSync('.v1-test', { recursive: true });
await build({
  entryPoints: files.map((file) => join('tests/v1', file)),
  outdir: '.v1-test',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  sourcemap: 'inline',
});
const result = spawnSync(
  process.execPath,
  ['--test', ...files.map((file) => join('.v1-test', file.replace(/\.ts$/, '.mjs')))],
  { stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
