import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const tsc = resolve(root, 'node_modules', 'typescript', 'lib', 'tsc.js');

rmSync(dist, { recursive: true, force: true });
const compiled = spawnSync(process.execPath, [tsc, '--project', 'tsconfig.v1.json'], {
  cwd: root,
  stdio: 'inherit',
});
if (compiled.error) throw compiled.error;
if (compiled.status !== 0) process.exitCode = compiled.status ?? 1;
else {
  for (const path of [
    'dist/v1/cli.js',
    'dist/v1/index.js',
    'dist/v1/sql-worker.js',
    'dist/herdr-sdk.js',
    'dist/herdr-protocol.js',
    'dist/herdr-streams.js',
    'dist/herdr-transport.js',
  ])
    assert.ok(existsSync(resolve(root, path)), `Build did not produce ${path}`);
  chmodSync(resolve(root, 'dist/v1/cli.js'), 0o755);
  const herdrLicense = readFileSync(resolve(root, 'vendor/herdr-0.9.0/LICENSE'), 'utf8').trim();
  const feature = JSON.parse(readFileSync(resolve(root, 'workflows/feature.json'), 'utf8'));
  const pstackLicense = feature.resources?.['pstack/LICENSE']?.text;
  assert.match(pstackLicense, /^MIT License$/m, 'Feature package omits the pinned pstack license');
  writeFileSync(
    resolve(root, 'THIRD_PARTY_NOTICES.md'),
    '# Third-party notices\n\n## Herdr 0.9.0 API schema\n\n' +
      'The SDK protocol types are generated from Herdr (https://github.com/herdrdev/herdr/tree/v0.9.0), licensed under Apache-2.0.\n\n' +
      `\`\`\`text\n${herdrLicense}\n\`\`\`\n\n` +
      '## pstack workflow resource\n\n' +
      'The bundled feature workflow includes pstack/LICENSE, licensed under MIT.\n\n' +
      `\`\`\`text\n${pstackLicense.trim()}\n\`\`\`\n`,
  );
}
