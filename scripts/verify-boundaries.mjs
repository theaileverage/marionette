import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBaseline } from './baseline.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const lift = verifyBaseline();

function files(directory) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

for (const file of files(join(root, 'src')).filter((path) => path.endsWith('.ts'))) {
  assert.doesNotMatch(readFileSync(file, 'utf8'),
    /(?:from\s*|import\s*\()['"]zod(?:\/|['"])/, file);
}

const built = await build({
  absWorkingDir: root, entryPoints: ['src/v1/index.ts'], bundle: true,
  platform: 'node', format: 'esm', packages: 'external', write: false, metafile: true,
});

for (const input of Object.keys(built.metafile.inputs))
  assert.ok(resolve(root, input).startsWith(join(root, 'src') + '/'),
    `Product graph escapes root source: ${input}`);

for (const output of Object.values(built.metafile.outputs))
  assert.ok(!output.imports.some((entry) => entry.path === 'zod' || entry.path.startsWith('zod/')));

const report = { lift, productModules: Object.keys(built.metafile.inputs).length,
  zodProductImports: 0 };

mkdirSync(join(root, '.test-output'), { recursive: true });

writeFileSync(join(root, '.test-output/boundaries.json'), JSON.stringify(report, null, 2) + '\n');

process.stdout.write(`VERIFIED: ${lift.files} lifted source files, ${report.productModules} product modules, no product Zod imports.\n`);
