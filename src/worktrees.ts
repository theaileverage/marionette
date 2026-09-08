import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { inside, safePath } from './files.js';
import { AppError, type ManagedWorktree, type Task } from './types.js';

const exec = promisify(execFile);
export async function git(cwd: string, args: string[]) {
  // A supervisor's inherited Git environment must not redirect task repository operations.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  env.GIT_TERMINAL_PROMPT = '0';
  try {
    const result = await exec('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], {
      env,
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout.trimEnd();
  } catch (error) {
    const e = error as Error & { stderr?: string };
    throw new AppError(
      'worktree_git',
      `Git worktree operation failed: ${e.stderr?.trim() || e.message}`,
    );
  }
}

/** Read-only planning. Persist this result before creating any branch or checkout. */
export async function planWorktree(task: Task, stateRoot: string): Promise<ManagedWorktree> {
  const repositoryRoot = realpathSync(await git(task.cwd, ['rev-parse', '--show-toplevel']));
  const commonDir = realpathSync(
    await git(task.cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
  );
  const baseRef = task.execution?.mode === 'worktree' ? (task.execution.baseRef ?? 'HEAD') : 'HEAD';
  const baseCommit = await git(task.cwd, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${baseRef}^{commit}`,
  ]);
  if (!inside(repositoryRoot, task.cwd))
    throw new AppError('worktree_scope', 'Task directory is outside its Git repository');
  const path = safePath(stateRoot, `worktrees/${task.projectId}/${task.id}`);
  return {
    state: 'planned',
    repositoryRoot,
    commonDir,
    sourceCwd: task.cwd,
    path,
    cwd: resolve(path, relative(repositoryRoot, task.cwd)),
    branch: `marionette/${task.id}`,
    baseCommit,
  };
}

/** Validate Git's registration as well as the checkout; never adopt an arbitrary directory. */
export async function validateWorktree(w: ManagedWorktree, requireClean = false) {
  const listing = await git(w.repositoryRoot, ['worktree', 'list', '--porcelain', '-z']);
  const records = listing.split('\0\0').map((record) => record.split('\0'));
  const record = records.find((fields) => fields.includes(`worktree ${w.path}`));
  if (
    !record ||
    !record.includes(`branch refs/heads/${w.branch}`) ||
    record.some((field) => /^(locked|prunable)( |$)/.test(field)) ||
    !existsSync(w.path) ||
    realpathSync(w.path) !== w.path
  )
    throw new AppError(
      'worktree_identity',
      'Managed worktree is missing, incomplete, or has changed identity. Inspect it before retrying; existing work is preserved.',
    );
  const commonDir = realpathSync(
    await git(w.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
  );
  const root = realpathSync(await git(w.path, ['rev-parse', '--show-toplevel']));
  const branch = await git(w.path, ['symbolic-ref', 'HEAD']);
  if (commonDir !== w.commonDir || root !== w.path || branch !== `refs/heads/${w.branch}`)
    throw new AppError(
      'worktree_identity',
      'Managed worktree repository or branch changed; refusing to reuse it.',
    );
  if (requireClean) {
    const head = await git(w.path, ['rev-parse', 'HEAD']);
    const status = await git(w.path, ['status', '--porcelain', '--untracked-files=all']);
    if (head !== w.baseCommit || status)
      throw new AppError(
        'worktree_incomplete',
        'Worktree creation was interrupted and its checkout is not clean at the pinned base. Inspect it before retrying; no files were reset.',
      );
  }
  const cwd = safePath(w.path, relative(w.path, w.cwd), true);
  if (!statSync(cwd).isDirectory())
    throw new AppError(
      'worktree_cwd',
      'Task working directory does not exist in the selected Git revision',
    );
  return cwd;
}

/** Called only after state=creating is durable. Never force, reset, prune, or delete work. */
export async function createWorktree(w: ManagedWorktree) {
  mkdirSync(dirname(w.path), { recursive: true, mode: 0o700 });
  await git(w.repositoryRoot, ['worktree', 'add', '-b', w.branch, '--', w.path, w.baseCommit]);
  return validateWorktree(w, true);
}
