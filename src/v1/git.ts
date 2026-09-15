import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Schema } from 'effect';
import { ArtifactFiles } from './artifacts.js';

const revision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/));

export const gitStateSchema = Schema.Struct({
  repositoryRoot: Schema.String,
  head: revision,
  tree: revision,
  statusDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  clean: Schema.Boolean,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

export type GitState = typeof gitStateSchema.Type;

function git(cwd: string, args: string[]): Buffer {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) throw result.error;

  if (result.status !== 0)
    throw new Error(`Git ${args[0]} failed: ${result.stderr.toString().trim()}`);

  return result.stdout;
}

function hash(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function captureGitState(workspacePath: string): GitState {
  const repositoryRoot = realpathSync(
    git(workspacePath, ['rev-parse', '--show-toplevel']).toString().trim(),
  );

  const head = Schema.decodeUnknownSync(revision)(
    git(repositoryRoot, ['rev-parse', '--verify', 'HEAD']).toString().trim(),
  );

  const tree = Schema.decodeUnknownSync(revision)(
    git(repositoryRoot, ['rev-parse', '--verify', 'HEAD^{tree}']).toString().trim(),
  );

  const status = git(repositoryRoot, ['status', '--porcelain=v2', '-z', '--untracked-files=all']);

  const indexDiff = git(repositoryRoot, [
    'diff',
    '--cached',
    '--binary',
    '--no-ext-diff',
    '--no-textconv',
    'HEAD',
    '--',
  ]);

  const worktreeDiff = git(repositoryRoot, [
    'diff',
    '--binary',
    '--no-ext-diff',
    '--no-textconv',
    '--',
  ]);

  const untracked = git(repositoryRoot, ['ls-files', '--others', '--exclude-standard', '-z'])
    .toString()
    .split('\0')
    .filter(Boolean)
    .sort();

  const files = untracked.map((path) => {
    const fullPath = join(repositoryRoot, path);
    const metadata = lstatSync(fullPath);
    const bytes = metadata.isSymbolicLink() ? readlinkSync(fullPath) : readFileSync(fullPath);

    return [path, metadata.mode, hash(bytes)];
  });

  return {
    repositoryRoot,
    head,
    tree,
    clean: status.byteLength === 0,
    statusDigest: hash(JSON.stringify([hash(status), hash(indexDiff), hash(worktreeDiff), files])),
  };
}

export function assertGitState(expected: GitState): GitState {
  const actual = captureGitState(expected.repositoryRoot);

  if (
    actual.head !== expected.head ||
    actual.tree !== expected.tree ||
    actual.statusDigest !== expected.statusDigest
  ) {
    throw new Error('Target Git state changed. Record a new integration plan before mutation.');
  }

  return actual;
}

export function exportCommit(options: {
  workspacePath: string;
  base: string;
  commit: string;
  artifacts: ArtifactFiles;
}) {
  const base = Schema.decodeUnknownSync(revision)(options.base);
  const commit = Schema.decodeUnknownSync(revision)(options.commit);

  const repositoryRoot = realpathSync(
    git(options.workspacePath, ['rev-parse', '--show-toplevel']).toString().trim(),
  );

  git(repositoryRoot, ['cat-file', '-e', `${base}^{commit}`]);
  git(repositoryRoot, ['cat-file', '-e', `${commit}^{commit}`]);

  const tree = Schema.decodeUnknownSync(revision)(
    git(repositoryRoot, ['rev-parse', `${commit}^{tree}`])
      .toString()
      .trim(),
  );

  const patch = options.artifacts.put(
    git(repositoryRoot, [
      'diff',
      '--binary',
      '--full-index',
      '--no-ext-diff',
      '--no-textconv',
      base,
      commit,
      '--',
    ]),
    'text/x-diff',
  );

  const changedPaths = git(repositoryRoot, ['diff', '--name-only', '-z', base, commit, '--'])
    .toString()
    .split('\0')
    .filter(Boolean);

  return { repositoryRoot, base, commit, tree, changedPaths, patch };
}
