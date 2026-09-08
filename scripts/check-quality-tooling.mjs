import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Keep fixtures beside node_modules so both compilers resolve the pinned Effect package.
const fixture = mkdtempSync(resolve(root, '.quality-check-'));
const source = resolve(fixture, 'fixture.ts');
const project = resolve(fixture, 'tsconfig.json');
const run = (binary, args) => {
  const result = spawnSync(
    process.execPath,
    ['--bun', resolve(root, 'node_modules/.bin', binary), ...args],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 30000,
    },
  );
  if (result.error) throw result.error;
  return { status: result.status, output: result.stdout + result.stderr };
};

try {
  writeFileSync(
    project,
    JSON.stringify({
      extends: '../tsconfig.json',
      compilerOptions: { rootDir: '.', noEmit: true },
      include: ['fixture.ts'],
    }),
  );
  writeFileSync(
    source,
    'import { Effect } from "effect"; export const value = Effect.succeed(1);\n',
  );
  const valid = run('tsc', ['--project', project]);
  assert.equal(valid.status, 0, `Valid Effect fixture failed:\n${valid.output}`);

  writeFileSync(source, 'import { Effect } from "effect"; Effect.succeed(1);\n');
  const floating = run('tsc', ['--project', project]);
  assert.notEqual(floating.status, 0, 'The patched compiler accepted a floating Effect');
  assert.match(floating.output, /floatingEffect|floating effect/i);
  const diagnostics = run('effect-tsgo', ['diagnostics', '--project', project]);
  assert.notEqual(diagnostics.status, 0, 'Standalone diagnostics accepted a floating Effect');
  assert.match(diagnostics.output, /floatingEffect|floating effect/i);

  writeFileSync(source, 'export const value = "unsafe" as unknown as number;\n');
  const cast = run('oxlint', ['--config', '.oxlintrc.json', source]);
  assert.notEqual(cast.status, 0, 'Oxlint accepted a chained assertion');
  assert.match(cast.output, /anti-slop.*no-chained-type-assertions/);

  console.log(
    'Quality tooling verified: valid Effect passes; floating Effect and unsafe cast fail.',
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
