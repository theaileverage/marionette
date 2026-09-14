import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBaseline } from './baseline.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseline = verifyBaseline();
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}
const originalModules = files(join(root, '..', 'src', 'v1')).filter((file) => file.endsWith('.ts'));
for (const original of originalModules) {
  const path = relative(join(root, '..'), original);
  readFileSync(join(root, path));
}
const preserved = [
  ...files(join(root, 'src/v1/migrations')).map((file) => relative(root, file)),
  ...['herdr-sdk', 'herdr-protocol', 'herdr-streams', 'herdr-transport'].map(
    (file) => `src/${file}.ts`,
  ),
];
for (const file of preserved)
  assert.equal(hash(join(root, file)), hash(join(root, '..', file)), file);
for (const file of files(join(root, 'src')).filter((file) => file.endsWith('.ts'))) {
  assert.doesNotMatch(
    readFileSync(file, 'utf8'),
    /(?:from\s*|import\s*\()['"]zod(?:\/|['"])/,
    file,
  );
}
const built = await build({
  absWorkingDir: root,
  entryPoints: ['src/v1/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  write: false,
  metafile: true,
});
for (const input of Object.keys(built.metafile.inputs)) {
  assert.ok(
    resolve(root, input).startsWith(join(root, 'src') + '/'),
    `External product source: ${input}`,
  );
}
for (const output of Object.values(built.metafile.outputs)) {
  assert.ok(!output.imports.some((entry) => entry.path === 'zod' || entry.path.startsWith('zod/')));
}
const report = {
  baseline,
  sourceModules: originalModules.length,
  byteIdentical: preserved,
  bundledProductModules: Object.keys(built.metafile.inputs).length,
};
writeFileSync(join(root, 'evidence/boundaries.json'), JSON.stringify(report, null, 2) + '\n');
process.stdout.write(
  `VERIFIED: ${originalModules.length} v1 modules, ${preserved.length} unchanged migrations/SDK files, no baseline or Zod product imports.\n`,
);
