import assert from 'node:assert/strict';
import { test, onTestFinished } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { versionAtLeast } from '../src/setup-dependencies.js';

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'marionette-dependencies-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const bin = resolve(root, 'bin');
  mkdirSync(bin);
  const marker = resolve(root, 'installed');
  for (const name of ['git', 'codex', 'claude', 'agy', 'npm'])
    writeFileSync(resolve(bin, name), '#!/bin/sh\necho "test 1.0.0"\n', { mode: 0o755 });
  writeFileSync(
    resolve(bin, 'herdr'),
    `#!/bin/sh\nif test -f '${marker}'; then echo 'herdr 0.9.0'; else exit 127; fi\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    resolve(bin, 'brew'),
    `#!/bin/sh\nif test "$1" = '--version'; then echo Homebrew; else test "$1 $2" = 'install herdr' || exit 2; : > '${marker}'; fi\n`,
    { mode: 0o755 },
  );
  const source = resolve('src/setup-dependencies.ts');
  function run(installTools: boolean) {
    return spawnSync(
      process.execPath,
      [
        '--eval',
        `import { Effect } from 'effect';
      import { ensureDependenciesEffect } from ${JSON.stringify(source)};
      try { console.log(JSON.stringify(await Effect.runPromise(ensureDependenciesEffect({ lead: 'codex', mcp: 'skip', installTools: ${installTools} }, false)))); }
      catch (error) { console.error(error.message); process.exitCode = 1; }`,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, PATH: bin },
        encoding: 'utf8',
        timeout: 15000,
      },
    );
  }
  return { marker, run, bin };
}

test('noninteractive preflight never installs without explicit authorization', () => {
  const f = fixture();
  const result = f.run(false);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing required tools: herdr/);
  assert.match(result.stderr, /--install-tools/);
  assert.equal(existsSync(f.marker), false);
  assert.equal(result.stdout, '');
});

test('authorized preflight runs the selected installer and rechecks the executable', () => {
  const f = fixture();
  const result = f.run(true);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(f.marker), true);
  const checks = JSON.parse(result.stdout);
  assert.equal(checks.find((tool: { binary: string }) => tool.binary === 'herdr').available, true);
  assert.equal(result.stderr, '');
});

test('successful installer exit cannot hide a missing executable', () => {
  const f = fixture();
  writeFileSync(resolve(f.bin, 'brew'), '#!/bin/sh\necho Homebrew\n', { mode: 0o755 });
  const result = f.run(true);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /herdr/);
});

test('runtime and Herdr version checks reject older or unrecognized releases', () => {
  assert.equal(versionAtLeast('herdr 0.9.0', [0, 9, 0]), true);
  assert.equal(versionAtLeast('herdr 0.8.9', [0, 9, 0]), false);
  assert.equal(versionAtLeast('1.3.14', [1, 3, 14]), true);
  assert.equal(versionAtLeast('1.3.9', [1, 3, 14]), false);
  assert.equal(versionAtLeast('unknown', [0, 9, 0]), false);
});
