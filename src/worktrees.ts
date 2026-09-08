import { Effect } from 'effect';
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { sync } from './effect-runtime.js';
import { inside, safePath } from './files.js';
import { execEffect } from './process.js';
import { AppError, type ManagedWorktree, type Task } from './types.js';

export const gitEffect = Effect.fn('Worktree.git')(
  function* (cwd: string, args: string[]) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
    env.GIT_TERMINAL_PROMPT = '0';
    const result = yield* execEffect(
      'git',
      ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args],
      { env, timeout: 120000 },
    );
    return result.stdout.trimEnd();
  },
  (effect) =>
    effect.pipe(
      Effect.mapError(
        (error) =>
          new AppError({
            code: 'worktree_git',
            message: `Git worktree operation failed: ${error.message}`,
            status: 400,
          }),
      ),
    ),
);
export const git = (cwd: string, args: string[]) => Effect.runPromise(gitEffect(cwd, args));

/** Read-only planning. Persist this result before creating any branch or checkout. */
export const planWorktreeEffect = Effect.fn('Worktree.plan')(function* (
  task: Task,
  stateRoot: string,
) {
  const repositoryRoot = realpathSync(yield* gitEffect(task.cwd, ['rev-parse', '--show-toplevel']));
  const commonDir = realpathSync(
    yield* gitEffect(task.cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
  );
  const baseRef = task.execution?.mode === 'worktree' ? (task.execution.baseRef ?? 'HEAD') : 'HEAD';
  const baseCommit = yield* gitEffect(task.cwd, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${baseRef}^{commit}`,
  ]);
  if (!inside(repositoryRoot, task.cwd))
    return yield* new AppError({
      code: 'worktree_scope',
      message: 'Task directory is outside its Git repository',
      status: 400,
    });
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
  } satisfies ManagedWorktree;
});

/** Validate Git's registration as well as the checkout; never adopt an arbitrary directory. */
export const validateWorktreeEffect = Effect.fn('Worktree.validate')(function* (
  w: ManagedWorktree,
  requireClean = false,
) {
  const listing = yield* gitEffect(w.repositoryRoot, ['worktree', 'list', '--porcelain', '-z']);
  const records = listing.split('\0\0').map((record) => record.split('\0'));
  const record = records.find((fields) => fields.includes(`worktree ${w.path}`));
  if (
    !record ||
    !record.includes(`branch refs/heads/${w.branch}`) ||
    record.some((field) => /^(locked|prunable)( |$)/.test(field)) ||
    !existsSync(w.path) ||
    realpathSync(w.path) !== w.path
  )
    return yield* new AppError({
      code: 'worktree_identity',
      message:
        'Managed worktree is missing, incomplete, or has changed identity. Inspect it before retrying; existing work is preserved.',
      status: 400,
    });
  const commonDir = realpathSync(
    yield* gitEffect(w.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
  );
  const root = realpathSync(yield* gitEffect(w.path, ['rev-parse', '--show-toplevel']));
  const branch = yield* gitEffect(w.path, ['symbolic-ref', 'HEAD']);
  if (commonDir !== w.commonDir || root !== w.path || branch !== `refs/heads/${w.branch}`)
    return yield* new AppError({
      code: 'worktree_identity',
      message: 'Managed worktree repository or branch changed; refusing to reuse it.',
      status: 400,
    });
  if (requireClean) {
    const head = yield* gitEffect(w.path, ['rev-parse', 'HEAD']);
    const status = yield* gitEffect(w.path, ['status', '--porcelain', '--untracked-files=all']);
    if (head !== w.baseCommit || status)
      return yield* new AppError({
        code: 'worktree_incomplete',
        message:
          'Worktree creation was interrupted and its checkout is not clean at the pinned base. Inspect it before retrying; no files were reset.',
        status: 400,
      });
  }
  const cwd = safePath(w.path, relative(w.path, w.cwd), true);
  if (!statSync(cwd).isDirectory())
    return yield* new AppError({
      code: 'worktree_cwd',
      message: 'Task working directory does not exist in the selected Git revision',
      status: 400,
    });
  return cwd;
});

/** Called only after state=creating is durable. Never force, reset, prune, or delete work. */
export const createWorktreeEffect = Effect.fn('Worktree.create')(function* (w: ManagedWorktree) {
  yield* sync('Worktree.mkdir', () => mkdirSync(dirname(w.path), { recursive: true, mode: 0o700 }));
  yield* gitEffect(w.repositoryRoot, [
    'worktree',
    'add',
    '-b',
    w.branch,
    '--',
    w.path,
    w.baseCommit,
  ]);
  return yield* validateWorktreeEffect(w, true);
});

export const planWorktree = (task: Task, stateRoot: string) =>
  Effect.runPromise(planWorktreeEffect(task, stateRoot));
export const validateWorktree = (worktree: ManagedWorktree, requireClean = false) =>
  Effect.runPromise(validateWorktreeEffect(worktree, requireClean));
export const createWorktree = (worktree: ManagedWorktree) =>
  Effect.runPromise(createWorktreeEffect(worktree));
