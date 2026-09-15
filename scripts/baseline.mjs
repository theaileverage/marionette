import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const canonicalCommit = '0ddd61dcf87f0180b17c4a16dafcca83b14493a5';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function git(args) {
  const result = spawnSync('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });

  if (result.error || result.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${result.error ?? result.stderr}`);

  return result.stdout;
}

function localFiles(directory) {
  return readdirSync(join(root, directory), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name))).sort();
}

export function verifyBaseline() {
  const expected = git(['ls-tree', '-r', '--name-only', canonicalCommit,
    'effect-port/src']).toString().trim().split('\n')
    .map((path) => path.slice('effect-port/'.length)).sort();

  const actual = localFiles('src');
  const differences = [];

  for (const path of expected) {
    if (!actual.includes(path)) {
      differences.push(`${path}: missing`);
      continue;
    }

  }

  for (const path of actual) if (!expected.includes(path)) differences.push(`${path}: unexpected`);

  if (differences.length)
    throw new Error(`Canonical Effect lift drift:\n${differences.map((line) => `- ${line}`).join('\n')}`);

  return { commit: canonicalCommit, files: expected.length,
    digest: hash(Buffer.from(expected.map((path) =>
      `${path} ${hash(readFileSync(join(root, path)))}`).join('\n'))) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyBaseline();
    process.stdout.write(`CANONICAL EFFECT LIFT FILESET VERIFIED ${result.commit} (${result.files} files)\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
