import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const manifestPath = join(root, 'evidence/effect-source-manifest.json');

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function sourceFiles() {
  return readdirSync(join(root, 'src'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name))).sort();
}

export function verifyBaseline() {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  if (manifest.version !== 1 || !Array.isArray(manifest.files))
    throw new Error('Effect source manifest is invalid');
  const actual = sourceFiles();
  const expected = manifest.files.map((entry) => entry.path);
  const differences = [];

  for (const entry of manifest.files) {
    if (!actual.includes(entry.path)) {
      differences.push(`${entry.path}: missing`);
      continue;
    }

    const digest = hash(readFileSync(join(root, entry.path)));

    if (digest !== entry.sha256) differences.push(`${entry.path}: content changed`);
  }

  for (const path of actual)
    if (!expected.includes(path)) differences.push(`${path}: unreviewed source file`);

  if (new Set(expected).size !== expected.length ||
    expected.some((path) => !path.startsWith('src/') || path !== relative(root, join(root, path))) ||
    manifest.files.some((entry) => !/^[a-f0-9]{64}$/.test(entry.sha256)))
    differences.push('manifest: duplicate or invalid source path');

  if (differences.length)
    throw new Error(`Reviewed Effect source drift:\n${differences.map((line) => `- ${line}`).join('\n')}`);

  return { revision: manifest.reviewedRevision, files: expected.length,
    digest: hash(readFileSync(manifestPath)) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyBaseline();
    process.stdout.write(`REVIEWED EFFECT SOURCE VERIFIED ${result.revision} (${result.files} files)\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
