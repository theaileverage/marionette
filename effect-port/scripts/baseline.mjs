import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const portRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(portRoot, '..');
const manifestPath = join(portRoot, 'evidence', 'baseline-source.json');

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function filesBelow(directory, predicate) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => relative(sourceRoot, join(entry.parentPath, entry.name)))
    .sort();
}

function capturedSourceFiles() {
  return [
    ...filesBelow(join(sourceRoot, 'src', 'v1'), (name) => name.endsWith('.ts')),
    ...filesBelow(join(sourceRoot, 'tests', 'v1'), (name) => name.endsWith('.test.ts')),
    'src/herdr-protocol.ts',
    'src/herdr-sdk.ts',
    'src/herdr-streams.ts',
    'src/herdr-transport.ts',
  ].sort();
}

export function verifyBaseline() {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (typeof manifest.head !== 'string' || !Array.isArray(manifest.files)) {
    throw new Error(`Invalid baseline manifest: ${manifestPath}`);
  }

  const expected = new Map();
  for (const entry of manifest.files) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof entry.path !== 'string' ||
      typeof entry.sha256 !== 'string'
    ) {
      throw new Error(`Invalid file entry in baseline manifest: ${manifestPath}`);
    }
    if (expected.has(entry.path)) throw new Error(`Duplicate baseline path: ${entry.path}`);
    expected.set(entry.path, entry.sha256);
  }

  const failures = [];
  for (const [path, expectedHash] of expected) {
    const absolute = join(sourceRoot, path);
    if (!existsSync(absolute)) {
      failures.push(`${path}: missing (expected ${expectedHash})`);
      continue;
    }
    const actualHash = sha256(absolute);
    if (actualHash !== expectedHash) {
      failures.push(`${path}: expected ${expectedHash}, received ${actualHash}`);
    }
  }

  for (const path of capturedSourceFiles()) {
    if (!expected.has(path)) failures.push(`${path}: present but absent from baseline manifest`);
  }

  if (failures.length > 0) {
    throw new Error(`Baseline drift detected:\n${failures.map((line) => `- ${line}`).join('\n')}`);
  }
  return { head: manifest.head, files: expected.size };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyBaseline();
    process.stdout.write(`BASELINE VERIFIED ${result.head} (${result.files} files)\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
