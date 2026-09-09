import { Effect, Result, Schedule, Semaphore } from 'effect';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { trustWorkspace, workspaceTrustEnabled } from './workspace-trust.js';
import { BoundaryError, boundaryError, herdrCall, sync } from './effect-runtime.js';
import { commandEffect, digest, hash, inside, safePath } from './files.js';
import { renderWorkerFollowup, renderWorkerPrompt } from './prompts.js';
import { ScopedTasks } from './scoped-tasks.js';
import { workerMcpArgs } from './worker-mcp.js';
import { Service, terminalStates } from './service.js';
import {
  AppError,
  now,
  type AgentInfo,
  type Operation,
  type Project,
  type Run,
  type Task,
  type Verification,
} from './types.js';
import { planWorkerPaneEffect } from './worker-layout.js';
import { createWorktreeEffect, planWorktreeEffect, validateWorktreeEffect } from './worktrees.js';
const settled = (status: string) => status === 'idle' || status === 'done';
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
// Herdr manifests can lag new agent UIs. These narrow interactive-screen cues
// supplement (never replace) identity checks and explicit worker reports.
export function inputScreen(text: string) {
  const tail = text.slice(-3500);
  return (
    /(?:Allow (?:access to|creation of|editing of|edits to) this file\?|Do you trust the contents|Do you trust the files|Do you want to proceed\?|Would you like to run the following command)/i.test(
      tail,
    ) && /(?:[>›❯]\s*1?\.?\s*Yes|Press enter to continue|↑\/↓ Navigate|esc to cancel)/i.test(tail)
  );
}
export class Supervisor {
  private readonly jobs = new ScopedTasks();
  private stopped = false;
  private readonly layoutLock = Semaphore.makeUnsafe(1);
  private withLayoutEffect<A, E, R>(_projectId: string, action: () => Effect.Effect<A, E, R>) {
    return this.layoutLock.withPermits(1)(Effect.suspend(action));
  }
  constructor(
    public service: Service,
    public url: string,
    public cliPath: string,
    public pollMs = 1500,
  ) {}
  start() {
    this.recover();
    this.service.continuation.recover();
    this.service.cleanup.recover();
    this.jobs.run('poll', this.pollEffect());
  }
  pollEffect = Effect.fn('Supervisor.poll')({ self: this }, function* (this: Supervisor) {
    yield* sync('Supervisor.tick', () => this.tick()).pipe(
      Effect.tapError((error) => Effect.logError('Supervisor tick failed', error)),
      Effect.ignore,
      Effect.repeat(Schedule.spaced(this.pollMs)),
    );
  });
  stop() {
    return Effect.runPromise(this.stopEffect());
  }
  stopEffect = Effect.fn('Supervisor.stop')({ self: this }, function* (this: Supervisor) {
    this.stopped = true;
    yield* this.jobs.interrupt('poll');
    yield* this.jobs.close();
    yield* this.service.continuation.stopEffect();
    yield* this.service.cleanup.stopEffect();
  });
  recover() {
    for (const op of this.service.store.all<Operation>('operation'))
      if (op.phase === 'sending') {
        const t = this.service.task(op.taskId);
        this.uncertain(
          t,
          'Supervisor restarted while sending a control message. Inspect output and reconcile delivery before retrying.',
        );
      }
    for (const t of this.service.store.all<Task>('task')) {
      if (!t.runId) {
        if (t.status === 'preparing')
          this.service.updateTask(
            t,
            { status: 'queued' },
            'Recovered scheduling reservation; any managed worktree will be validated before reuse',
          );
        continue;
      }
      const r = this.run(t);
      if (t.status === 'preparing' && ['running', 'stopped'].includes(r.phase)) {
        this.service.updateTask(
          t,
          { status: 'queued', resumePending: true },
          'Recovered an unsent parent continuation reservation',
        );
        continue;
      }
      if (['creating', 'prompting'].includes(r.phase) && !terminalStates.has(t.status))
        this.uncertain(
          t,
          `Supervisor restarted during ${r.phase}. The previous side effect will not be repeated automatically.`,
        );
      if (r.phase === 'starting' && !terminalStates.has(t.status)) {
        this.service.updateTask(
          t,
          { status: 'blocked', blockKind: 'startup' },
          'Recovered an agent startup; inspect the existing pane before continuing',
        );
        this.service.ask(
          t,
          'Agent startup was in progress at restart. Resolve any startup screen in the existing pane and reply “continue”.',
          true,
        );
      }
      if (t.status === 'verifying')
        this.service.updateTask(
          t,
          { status: 'running' },
          'Restart recovered verification; checks will run again',
        );
    }
  }
  run(t: Task) {
    return this.service.store.get<Run>('run', t.runId!)!;
  }
  private saveRun(r: Run) {
    this.service.store.put('run', r.id, r);
  }
  private uncertain(t: Task, message: string) {
    this.service.store.transaction(() => {
      this.service.updateTask(
        this.service.task(t.id),
        { status: 'uncertain', error: message },
        message,
      );
      this.service.ask(t, message);
    });
  }
  tick() {
    if (this.stopped) return;
    this.service.orchestration.refreshEvidence();
    this.service.continuation.tick();
    this.service.cleanup.tick();
    const s = this.service,
      all = s.store.all<Task>('task');
    // Reserve each task synchronously before asynchronous Herdr operations begin.
    for (const t of all)
      if (
        t.runId &&
        !this.service.cleanup.active(t.id) &&
        !['closing', 'closed', 'uncertain'].includes(this.run(t).cleanup?.state ?? '') &&
        t.status !== 'queued' &&
        !this.jobs.has(t.id) &&
        (!terminalStates.has(t.status) || this.run(t).phase !== 'stopped')
      )
        this.launch(t.id, this.monitorEffect(t.id));
    for (const t of s.store
      .all<Task>('task')
      .filter(
        (t) =>
          t.status === 'waiting' ||
          (t.resumePending && t.status === 'blocked' && t.blockKind === 'missing-report'),
      )) {
      const children = (t.waitForChildren ?? []).map((id) => s.task(id));
      if (
        children.length &&
        children.every((child) => terminalStates.has(child.status) && !this.holds(child))
      ) {
        s.closeQuestions(t.id, 'Child results ready; scheduling the unsent continuation');
        s.updateTask(
          t,
          { status: 'queued', resumePending: true, blockKind: undefined },
          'Child results ready for parent evaluation and integration',
        );
      }
    }
    for (const project of s.store.all<Project>('project')) {
      const tasks = s.tasks(project.id);
      for (const task of tasks.filter(
        (t) =>
          t.status === 'queued' &&
          !t.archiveId &&
          !this.service.cleanup.active(t.id) &&
          !this.jobs.has(t.id),
      )) {
        const dependencies = task.dependencies.map((id) => s.task(id));
        let waitReason = dependencies.some((d) => d.status !== 'completed')
          ? 'Waiting for dependencies to complete'
          : undefined;
        if (!waitReason) waitReason = s.orchestration.capacity(task, (t) => !!this.holds(t));
        if (
          !waitReason &&
          s
            .tasks(project.id)
            .some(
              (t) =>
                t.id !== task.id && t.status !== 'queued' && this.holds(t) && this.overlap(task, t),
            )
        )
          waitReason = 'Waiting for ownership of files';
        if (task.waitReason !== waitReason) s.updateTask(task, { waitReason });
        if (waitReason) continue;
        s.updateTask(
          s.task(task.id),
          { status: 'preparing', waitReason: undefined },
          `Preparing ${task.kind} worker for ${task.title}`,
        );
        this.launch(task.id, this.dispatchEffect(task.id));
      }
    }
  }
  private holds(t: Task) {
    if (t.status === 'waiting') return false;
    return !terminalStates.has(t.status) || (t.runId && this.run(t)?.phase !== 'stopped');
  }
  private overlap(a: Task, b: Task) {
    // Managed worktrees have separate file ownership namespaces even before creation.
    const root = (t: Task) =>
      t.worktree?.cwd ??
      (t.execution?.mode === 'worktree'
        ? resolve(dirname(this.service.store.path), 'worktrees', t.projectId, t.id)
        : t.cwd);
    const path = (t: Task, owned: string) => {
      const cwd = root(t);
      // Future checkouts (including ownership ".") do not exist yet. Submission
      // validates source paths; preparation validates symlinks in the checkout.
      return t.execution?.mode === 'worktree' && !existsSync(cwd)
        ? resolve(cwd, owned)
        : safePath(cwd, owned);
    };
    return a.ownership.some((x) =>
      b.ownership.some((y) => {
        const p = path(a, x),
          q = path(b, y);
        return inside(p, q) || inside(q, p);
      }),
    );
  }
  private launch(id: string, operation: Effect.Effect<void, AppError | BoundaryError>) {
    this.jobs.run(
      id,
      operation.pipe(
        Effect.catch((error) =>
          sync('Supervisor.failed', () => {
            const task = this.service.task(id);
            this.service.store.event(task.projectId, 'supervisor.error', String(error), id);
            if (!terminalStates.has(task.status))
              this.uncertain(task, `Unexpected supervisor error: ${String(error)}`);
          }),
        ),
      ),
    );
  }
  private instructions(t: Task, extra = '') {
    const strategy = t.strategyId
      ? this.service.store.get<import('./orchestration-types.js').Strategy>(
          'strategy',
          t.strategyId,
        )
      : undefined;
    return renderWorkerPrompt({
      task: t,
      workerMcp: t.kind === 'codex',
      strategy,
      workerCall: `${quote(process.execPath)} ${quote(this.cliPath)} worker-call --file /absolute/path/to/request.json`,
      reportCommand: `${quote(process.execPath)} ${quote(this.cliPath)} worker-report --file /absolute/path/to/report.json`,
      extra,
    });
  }
  private modelArgs(t: Task, p: Project) {
    const args = [...(p.agentArgs[t.kind] ?? [])];
    if (t.kind === 'codex') args.push(...workerMcpArgs(process.execPath, this.cliPath));
    if (
      t.kind === 'codex' &&
      args.includes('--approve-for-me') &&
      args.some((a) => a === '--sandbox' || a.startsWith('--sandbox='))
    )
      throw new AppError({
        code: 'argument_conflict',
        message:
          'Codex --approve-for-me already selects its sandbox; remove the conflicting --sandbox argument',
        status: 400,
      });
    if (!t.model) return args;
    if (
      args.some(
        (arg) =>
          ['--model', '-m', '--effort', '--fallback-model'].includes(arg) ||
          /^(--model=|--effort=|--fallback-model=|model=|model_reasoning_effort=)/.test(arg),
      )
    )
      throw new AppError({
        code: 'model_conflict',
        message: 'Project agent arguments conflict with the exact assignment profile',
        status: 400,
      });
    args.push('--model', t.model);
    if (t.reasoning) {
      if (t.kind === 'codex')
        args.push('-c', `model_reasoning_effort=${JSON.stringify(t.reasoning)}`);
      else if (t.kind === 'claude') args.push('--effort', t.reasoning);
    }
    return args;
  }
  private dispatchEffect = Effect.fn('Supervisor.dispatch')(
    { self: this },
    function* (this: Supervisor, id: string) {
      const s = this.service;
      let t = yield* sync('Supervisor.dispatch', () => s.task(id));
      const p = yield* sync('Supervisor.dispatch', () => s.project(t.projectId)),
        h = yield* sync('Supervisor.dispatch', () => s.port(p));
      {
        const attempt1 = yield* Effect.result(
          Effect.gen({ self: this }, function* () {
            yield* herdrCall(h, 'ping');
            yield* herdrCall(h, 'workspace.get', { workspace_id: p.workspaceId });
          }),
        );
        if (Result.isFailure(attempt1)) {
          const e = attempt1.failure;
          if (s.task(id).status === 'preparing')
            yield* sync('Supervisor.dispatch', () =>
              s.updateTask(
                t,
                {
                  status: 'failed',
                  error: `Connection preflight failed before dispatch: ${String(e)}`,
                },
                'Dispatch preflight failed; no worker was started',
              ),
            );
          return;
        }
      }
      yield* sync('Supervisor.dispatch', () => (t = s.task(id)));
      if (t.status !== 'preparing') return;
      {
        const attempt2 = yield* Effect.result(
          Effect.gen({ self: this }, function* () {
            if (t.execution?.mode === 'worktree') {
              if (!t.worktree) {
                const plan = yield* planWorktreeEffect(t, realpathSync(dirname(s.store.path)));
                if (s.task(id).status !== 'preparing') return false;
                yield* sync(
                  'Supervisor.dispatch',
                  () => (t = s.updateTask(t, { worktree: plan }, 'Planned isolated Git worktree')),
                );
              }
              let w = t.worktree!;
              let cwd: string;
              if (w.state === 'planned') {
                w = { ...w, state: 'creating' };
                yield* sync('Supervisor.dispatch', () =>
                  s.updateTask(t, { worktree: w }, `Creating worktree on ${w.branch}`),
                );
                cwd = yield* createWorktreeEffect(w);
              } else {
                // After a crash, adopt only a complete, clean checkout at the pinned base.
                // Once ready, preserve worker commits and uncommitted changes across retries.
                cwd = yield* validateWorktreeEffect(w, w.state === 'creating');
              }
              yield* sync(
                'Supervisor.dispatch',
                () =>
                  (t = s.updateTask(
                    t,
                    { cwd, worktree: { ...w, state: 'ready' } },
                    'Managed worktree ready',
                  )),
              );
              // Revalidate relocated paths, including symlinks in the selected base revision.
              for (const path of t.ownership)
                yield* sync('Supervisor.dispatch', () => safePath(t.cwd, path));
              for (const c of t.checks)
                if (c.type === 'file')
                  yield* sync('Supervisor.dispatch', () => safePath(t.cwd, c.path));
            }
            yield* sync('Supervisor.dispatch', () => (t = s.task(id)));
            if (t.status !== 'preparing') return false;
            if (workspaceTrustEnabled(p, t.kind))
              yield* sync('Supervisor.trust', () =>
                trustWorkspace(t.cwd, t.kind, dirname(s.store.path), p.id),
              );
            return true;
          }),
        );
        if (Result.isFailure(attempt2)) {
          const e = attempt2.failure;
          if (s.task(id).status === 'preparing')
            yield* sync('Supervisor.dispatch', () =>
              s.updateTask(
                t,
                { status: 'failed', error: String(e) },
                'Working directory preparation failed; no worker was started',
              ),
            );
          return;
        } else if (!attempt2.success) return;
      }
      if (t.resumePending && t.runId) {
        const run = yield* sync('Supervisor.dispatch', () => this.run(t));
        const children = yield* sync('Supervisor.dispatch', () =>
          (t.waitForChildren ?? []).map((id) => s.task(id)),
        );
        {
          const attempt3 = yield* Effect.result(
            Effect.gen({ self: this }, function* () {
              yield* this.promptEffect(
                t,
                run,
                renderWorkerFollowup({ task: t, kind: 'children', children }),
              );
              yield* sync('Supervisor.dispatch', () =>
                s.updateTask(s.task(id), { resumePending: false, waitForChildren: undefined }),
              );
            }),
          );
          if (Result.isFailure(attempt3)) {
            const e = attempt3.failure;
            yield* sync('Supervisor.dispatch', () =>
              this.uncertain(s.task(id), `Parent continuation needs reconciliation: ${String(e)}`),
            );
          }
        }
        return;
      }
      // User can cancel an accepted task before the first side effect.
      const queuedOp = yield* sync('Supervisor.dispatch', () =>
        s.store.all<Operation>('operation').find((o) => o.taskId === id && o.phase === 'pending'),
      );
      if (queuedOp?.type === 'cancel') {
        yield* sync('Supervisor.dispatch', () =>
          s.updateTask(t, { status: 'cancelled' }, 'Cancelled before worker creation'),
        );
        yield* sync('Supervisor.dispatch', () =>
          s.store.put('operation', queuedOp.id, { ...queuedOp, phase: 'done' }),
        );
        return;
      }
      let resolvedArgs: string[];
      {
        const attempt4 = yield* Effect.result(
          Effect.gen({ self: this }, function* () {
            yield* sync('Supervisor.dispatch', () => (resolvedArgs = this.modelArgs(t, p)));
          }),
        );
        if (Result.isFailure(attempt4)) {
          const error = attempt4.failure;
          yield* sync('Supervisor.dispatch', () =>
            s.updateTask(
              t,
              { status: 'failed', error: String(error) },
              'Agent argument preflight failed; no worker started',
            ),
          );
          return;
        }
      }
      const token = yield* sync('Supervisor.dispatch', () => randomBytes(32).toString('hex'));
      const run: Run = yield* sync<Run>('Supervisor.dispatch', () => ({
        id: randomUUID(),
        taskId: id,
        attempt: t.attempt + 1,
        revision: t.revision,
        agentName: `m-${id.slice(0, 8)}-a${t.attempt + 1}`,
        kind: t.kind,
        tokenHash: hash(token),
        phase: 'creating',
        startedAt: now(),
        seenWork: false,
        baseline: {},
        resolvedModel: t.model,
        resolvedArgs,
        turns: 0,
      }));
      {
        const attempt5 = yield* Effect.result(
          Effect.gen({ self: this }, function* () {
            for (const c of t.checks)
              if (c.type === 'file')
                yield* sync(
                  'Supervisor.dispatch',
                  () => (run.baseline[c.path] = digest(safePath(t.cwd, c.path))),
                );
          }),
        );
        if (Result.isFailure(attempt5)) {
          const e = attempt5.failure;
          yield* sync('Supervisor.dispatch', () =>
            s.updateTask(t, { status: 'failed', error: String(e) }, 'Artifact preflight failed'),
          );
          return;
        }
      }
      yield* sync('Supervisor.dispatch', () =>
        s.store.transaction(() => {
          this.saveRun(run);
          t = s.updateTask(s.task(id), { runId: run.id, attempt: run.attempt });
        }),
      );
      return yield* Effect.gen({ self: this }, function* () {
        yield* this.withLayoutEffect(p.id, () =>
          Effect.gen({ self: this }, function* () {
            const taskIds = yield* sync(
              'Supervisor.work',
              () => new Set(s.tasks(p.id).map((task) => task.id)),
            );
            const runs = yield* sync('Supervisor.work', () =>
              s.store
                .all<Run>('run')
                .filter((r) => taskIds.has(r.taskId) && !s.cleanup.active(r.taskId)),
            );
            run.creation = yield* planWorkerPaneEffect(h, p.workspaceId, runs);
            run.terminalScope = 'pane';
            // Persist intent before the mutation, including the pre-split membership for recovery.
            yield* sync('Supervisor.work', () => this.saveRun(run));
            const options = {
              workspace_id: p.workspaceId,
              cwd: t.cwd,
              focus: false,
              env: {
                MARIONETTE_WORKER_TOKEN: token,
                MARIONETTE_TASK_ID: id,
                MARIONETTE_URL: this.url,
              },
            };
            const splitting = run.creation.mode === 'pane';
            const created = yield* herdrCall(
              h,
              splitting ? 'pane.split' : 'tab.create',
              splitting
                ? {
                    ...options,
                    target_pane_id: run.creation.targetPaneId,
                    direction: run.creation.direction,
                  }
                : { ...options, label: run.agentName },
            );
            const pane = splitting ? created.pane : created.root_pane;
            if (
              !pane?.pane_id ||
              !pane.terminal_id ||
              !pane.tab_id ||
              pane.workspace_id !== p.workspaceId ||
              (splitting &&
                (pane.tab_id !== run.creation.tabId ||
                  run.creation.beforePaneIds!.includes(pane.pane_id)))
            )
              return yield* boundaryError('Supervisor.work')(
                new Error('Herdr did not return the expected new scoped pane'),
              );
            yield* sync('Supervisor.work', () =>
              Object.assign(run, {
                paneId: pane.pane_id,
                terminalId: pane.terminal_id,
                tabId: pane.tab_id,
                phase: 'starting',
              }),
            );
            yield* sync('Supervisor.work', () => this.saveRun(run));
          }),
        );
        yield* this.startWorkerEffect(t, run);
        const a = yield* this.waitReadyEffect(p, run);
        run.nativeSession = a.agent_session?.value;
        yield* sync('Supervisor.dispatch', () => this.saveRun(run));
        yield* this.promptEffect(t, run, this.instructions(t));
      }).pipe(
        Effect.catch((e) =>
          Effect.gen({ self: this }, function* () {
            if (run.phase === 'starting') {
              // No task prompt has been attempted. A startup/approval screen must be handled by a human.
              yield* sync('Supervisor.dispatch', () =>
                s.updateTask(
                  s.task(id),
                  {
                    status: 'blocked',
                    blockKind: 'startup',
                    error: `Agent startup needs attention: ${String(e)}`,
                  },
                  'Worker startup needs attention',
                ),
              );
              yield* sync('Supervisor.dispatch', () =>
                s.ask(
                  t,
                  `Open ${p.session} / ${run.paneId}. Resolve the agent startup screen, then answer here with “continue”. ${String(e)}`,
                  true,
                ),
              );
            } else
              yield* sync('Supervisor.dispatch', () =>
                this.uncertain(
                  s.task(id),
                  `Dispatch interrupted during ${run.phase}: ${String(e)}. Inspect the worker before reconciling.`,
                ),
              );
          }),
        ),
      );
    },
    (effect, id) =>
      effect.pipe(
        Effect.onInterrupt(() =>
          sync('Supervisor.dispatchInterrupted', () => {
            const task = this.service.task(id);
            if (['creating', 'prompting'].includes(this.run(task).phase))
              this.uncertain(
                task,
                'Dispatch interrupted before acknowledgement. Inspect the worker before reconciling.',
              );
          }).pipe(Effect.orDie),
        ),
      ),
  );
  private startWorkerEffect = Effect.fn('Supervisor.startWorker')(
    { self: this },
    function* (this: Supervisor, t: Task, run: Run) {
      const h = this.service.port(this.service.project(t.projectId));
      yield* herdrCall(
        h,
        'agent.start',
        {
          name: run.agentName,
          kind: t.kind,
          pane_id: run.paneId,
          args: run.resolvedArgs ?? [],
          timeout_ms: 30000,
        },
        35000,
      ).pipe(
        Effect.retry({
          schedule: Schedule.spaced(500).pipe(Schedule.upTo({ times: 10 })),
          while: (error) => /not an available shell/.test(String(error)),
        }),
        Effect.catchIf(
          (error) =>
            error instanceof AppError &&
            ['agent_not_ready', 'agent_not_found'].includes(error.code),
          () => Effect.void,
        ),
      );
    },
  );
  private waitReadyEffect = Effect.fn('Supervisor.waitReady')(
    { self: this },
    function* (this: Supervisor, p: Project, run: Run) {
      const pass = Effect.gen({ self: this }, function* () {
        const a = yield* this.agentEffect(p, run);
        const read = yield* herdrCall(this.service.port(p), 'pane.read', {
          pane_id: run.paneId,
          source: 'recent_unwrapped',
          lines: 60,
          format: 'text',
        });
        const output = read.read?.text ?? '';
        yield* sync('Supervisor.startupOutput', () =>
          this.service.updateTask(this.service.task(run.taskId), { output }),
        );
        if (a.agent_status === 'blocked' || /do you trust|trust the contents/i.test(output))
          return yield* new AppError({
            code: 'startup_input',
            message: 'Agent is requesting startup input',
            status: 400,
          });
        if (
          a.agent === run.kind &&
          settled(a.agent_status) &&
          !a.launch_pending &&
          a.interactive_ready !== false
        )
          return a;
        return yield* new AppError({
          code: 'startup_pending',
          message: 'Agent is not ready yet',
          status: 400,
        });
      });
      return yield* pass.pipe(
        Effect.retry({
          schedule: Schedule.spaced(500).pipe(Schedule.upTo({ times: 59 })),
          while: (error) =>
            error instanceof AppError &&
            ['startup_pending', 'agent_not_ready', 'agent_not_found'].includes(error.code),
        }),
        Effect.mapError((error) =>
          error instanceof AppError &&
          ['startup_pending', 'agent_not_ready', 'agent_not_found'].includes(error.code)
            ? new AppError({
                code: 'startup_timeout',
                message: 'Agent did not become ready within 30 seconds',
                status: 400,
              })
            : error,
        ),
      );
    },
  );
  private agentEffect = Effect.fn('Supervisor.agent')(
    { self: this },
    function* (this: Supervisor, p: Project, r: Run) {
      const result = yield* herdrCall(this.service.port(p), 'agent.get', { target: r.paneId });
      const a: AgentInfo = result.agent;
      if (
        !a ||
        a.pane_id !== r.paneId ||
        a.workspace_id !== p.workspaceId ||
        a.terminal_id !== r.terminalId ||
        (a.name !== r.agentName && !(!a.name && r.nativeSession)) ||
        (a.agent !== r.kind && !(r.phase === 'starting' && !a.agent)) ||
        (r.nativeSession && a.agent_session?.value !== r.nativeSession)
      )
        return yield* new AppError({
          code: 'identity_changed',
          message: 'Pane occupant or native agent session changed; refusing to control it',
          status: 409,
        });
      return a;
    },
  );
  private promptEffect = Effect.fn('Supervisor.prompt')(
    { self: this },
    function* (this: Supervisor, t: Task, r: Run, text: string) {
      const s = this.service,
        h = yield* sync('Supervisor.prompt', () => s.port(s.project(t.projectId))),
        a = yield* this.agentEffect(s.project(t.projectId), r);
      if (
        !settled(a.agent_status) ||
        a.agent !== r.kind ||
        a.launch_pending ||
        a.interactive_ready === false
      )
        return yield* new AppError({
          code: 'not_ready',
          message: `Agent is ${a.agent_status}; refusing to submit another task`,
          status: 409,
        });
      if (!a)
        return yield* new AppError({
          code: 'identity_missing',
          message: 'Herdr returned no worker identity',
          status: 409,
        });
      if (!r.nativeSession && a.agent_session?.value) r.nativeSession = a.agent_session.value;
      yield* sync('Supervisor.prompt', () => s.orchestration.reserveTurn(t));
      r.turns = (r.turns ?? 0) + 1;
      r.phase = 'prompting';
      r.baselineSeq = a.state_change_seq ?? 0;
      r.seenWork = false;
      r.settledAt = undefined;
      r.revision = t.revision;
      yield* sync('Supervisor.prompt', () => this.saveRun(r));
      yield* sync('Supervisor.prompt', () =>
        s.updateTask(s.task(t.id), { status: 'running', blockKind: undefined, error: undefined }),
      );
      yield* herdrCall(h, 'agent.prompt', { target: r.paneId, text }, 12000);
      r.phase = 'running';
      yield* sync('Supervisor.prompt', () => this.saveRun(r));
      const current = yield* sync('Supervisor.prompt', () => s.task(t.id));
      const patch: Partial<Task> = {};
      if (
        !terminalStates.has(current.status) &&
        !(current.status === 'blocked' && current.blockKind === 'question') &&
        current.status !== 'yielding' &&
        current.status !== 'waiting'
      ) {
        patch.status = 'running';
        patch.error = undefined;
        patch.blockKind = undefined;
      }
      yield* sync('Supervisor.prompt', () =>
        s.updateTask(current, patch, `Dispatched revision ${t.revision} to ${r.agentName}`),
      );
    },
    (effect, t, r) =>
      effect.pipe(
        Effect.onInterrupt(() =>
          sync('Supervisor.promptInterrupted', () => {
            if (r.phase === 'prompting')
              this.uncertain(
                this.service.task(t.id),
                'Prompt interrupted before acknowledgement. No automatic replay.',
              );
          }).pipe(Effect.orDie),
        ),
      ),
  );
  private monitorEffect = Effect.fn('Supervisor.monitor')(
    { self: this },
    function* (this: Supervisor, id: string) {
      const s = this.service;
      let t = yield* sync('Supervisor.monitor', () => s.task(id));
      let r = yield* sync('Supervisor.monitor', () => this.run(t));
      const p = yield* sync('Supervisor.monitor', () => s.project(t.projectId)),
        h = yield* sync('Supervisor.monitor', () => s.port(p));
      if (!r.paneId) return;
      let a: AgentInfo | undefined;
      {
        const attempt6 = yield* Effect.result(
          Effect.gen({ self: this }, function* () {
            const read = yield* herdrCall(h, 'pane.read', {
              pane_id: r.paneId,
              source: 'recent_unwrapped',
              lines: 160,
              format: 'text',
            }).pipe(
              Effect.catchIf(
                (error) => error instanceof AppError && error.code === 'agent_not_idle',
                () =>
                  herdrCall(h, 'pane.read', {
                    pane_id: r.paneId,
                    source: 'visible',
                    format: 'text',
                  }),
              ),
            );
            const output = yield* sync('Supervisor.monitor', () =>
              (read.read?.text ?? read.text ?? read.content ?? '').slice(-32000),
            );
            if (output && output !== t.output)
              yield* sync('Supervisor.monitor', () => (t = s.updateTask(t, { output })));
            a = yield* this.agentEffect(p, r);
            if (r.disconnectedAt) {
              r.disconnectedAt = undefined;
              r.lastError = undefined;
              yield* sync('Supervisor.monitor', () =>
                s.store.event(
                  t.projectId,
                  'worker.reconnected',
                  `Reconnected to ${r.agentName}`,
                  id,
                ),
              );
            }
          }),
        );
        if (Result.isFailure(attempt6)) {
          const e = attempt6.failure;
          if (
            e instanceof AppError &&
            ['identity_changed', 'agent_not_found', 'pane_not_found'].includes(e.code)
          ) {
            if (r.phase === 'starting' && t.status === 'blocked') {
              const op = yield* sync('Supervisor.monitor', () =>
                s.store
                  .all<Operation>('operation')
                  .find((o) => o.taskId === id && o.type === 'cancel' && o.phase === 'pending'),
              );
              if (op && e instanceof AppError && e.code === 'agent_not_found') {
                const result = yield* herdrCall(h, 'pane.list', { workspace_id: p.workspaceId });
                const pane = yield* sync('Supervisor.monitor', () =>
                  result.panes?.find((pane: any) => pane.pane_id === r.paneId),
                );
                if (pane?.terminal_id === r.terminalId && !pane.agent && !pane.launch_pending) {
                  r.phase = 'stopped';
                  yield* sync('Supervisor.monitor', () => this.saveRun(r));
                  yield* sync('Supervisor.monitor', () =>
                    s.updateTask(
                      s.task(id),
                      { status: 'cancelled', error: undefined },
                      'Cancelled startup with no native agent present',
                    ),
                  );
                  yield* sync('Supervisor.monitor', () =>
                    s.store.put('operation', op.id, { ...op, phase: 'done' }),
                  );
                  yield* sync('Supervisor.monitor', () =>
                    s.closeQuestions(id, 'Empty startup cancelled by lead'),
                  );
                }
              }
              return;
            }
            if (t.status !== 'uncertain' && !terminalStates.has(t.status))
              yield* sync('Supervisor.monitor', () =>
                this.uncertain(t, `Worker identity unavailable: ${String(e)}`),
              );
          } else if (!r.disconnectedAt) {
            yield* sync('Supervisor.monitor', () => (r.disconnectedAt = Date.now()));
            yield* sync('Supervisor.monitor', () => (r.lastError = String(e)));
            yield* sync('Supervisor.monitor', () => this.saveRun(r));
            yield* sync('Supervisor.monitor', () =>
              s.store.event(
                t.projectId,
                'worker.disconnected',
                `Connection lost; preserving assignment without redispatch: ${String(e)}`,
                id,
              ),
            );
          }
          return;
        }
      }
      if (!a)
        return yield* new AppError({
          code: 'identity_missing',
          message: 'Herdr returned no worker identity',
          status: 409,
        });
      if (!r.nativeSession && a.agent_session?.value) {
        r.nativeSession = a.agent_session.value;
        yield* sync('Supervisor.monitor', () => this.saveRun(r));
      }
      yield* sync('Supervisor.monitor', () => (t = s.task(id)));
      // A waiting parent may have been queued by tick while this read was pending.
      // Its old settled turn cannot be classified as missing a new report.
      if (t.status === 'queued' || (t.resumePending && t.status === 'preparing')) return;
      const nativeInput = yield* sync('Supervisor.monitor', () => inputScreen(t.output));
      if (nativeInput) a = { ...a, agent_status: 'blocked' };
      r.lastStatus = a.agent_status;
      if (a.agent_status === 'working' || (a.state_change_seq ?? 0) > (r.baselineSeq ?? 0))
        r.seenWork = true;
      if (settled(a.agent_status))
        yield* sync('Supervisor.monitor', () => (r.settledAt ??= Date.now()));
      else r.settledAt = undefined;
      yield* sync('Supervisor.monitor', () => this.saveRun(r));
      if (terminalStates.has(t.status)) {
        if (settled(a.agent_status)) {
          r.phase = 'stopped';
          yield* sync('Supervisor.monitor', () => this.saveRun(r));
        }
        return;
      }
      if (t.status === 'uncertain') return;
      const op = yield* sync('Supervisor.monitor', () =>
        s.store
          .all<Operation>('operation')
          .find((o) => o.taskId === id && !['done', 'failed'].includes(o.phase)),
      );
      if (op) {
        yield* this.operationEffect(t, r, a, op);
        return;
      }
      if (r.phase === 'starting') return;
      if (a.agent_status === 'blocked' && t.blockKind !== 'native') {
        if (t.blockKind === 'missing-report' || (t.status === 'blocked' && !t.blockKind))
          yield* sync('Supervisor.monitor', () =>
            s.closeQuestions(t.id, 'Reclassified as a native agent input screen'),
          );
        yield* sync('Supervisor.monitor', () =>
          s.updateTask(
            t,
            { status: 'blocked', blockKind: t.blockKind === 'question' ? 'question' : 'native' },
            `${r.agentName} is blocked`,
          ),
        );
        yield* sync('Supervisor.monitor', () =>
          s.ask(
            t,
            'The agent is showing an approval or input screen. Inspect its output and resolve the specific prompt in Herdr, or send explicit keys from task controls.',
            true,
          ),
        );
        return;
      }
      if (t.status === 'blocked' && t.blockKind === 'native' && a.agent_status !== 'blocked') {
        yield* sync(
          'Supervisor.monitor',
          () =>
            (t = s.updateTask(
              t,
              { status: 'running', blockKind: undefined, error: undefined },
              'Native agent input resolved; monitoring resumed',
            )),
        );
        for (const q of s.store
          .all<any>('question')
          .filter((q) => q.taskId === t.id && q.native && !q.answeredAt))
          yield* sync('Supervisor.monitor', () =>
            s.store.put('question', q.id, {
              ...q,
              answer: 'Resolved in the agent interface',
              answeredAt: now(),
            }),
          );
      }
      if (t.status === 'yielding') {
        if (settled(a.agent_status) && r.settledAt && Date.now() - r.settledAt >= this.pollMs) {
          yield* sync('Supervisor.monitor', () =>
            s.updateTask(
              t,
              {
                status: 'waiting',
                waitReason: 'Waiting for children; execution capacity and ownership released',
              },
              'Coordinator settled and yielded to child workers',
            ),
          );
        }
        return;
      }
      if (t.status === 'waiting' || t.status === 'paused' || t.status === 'blocked') return;
      if (
        t.receipt &&
        settled(a.agent_status) &&
        r.settledAt &&
        Date.now() - r.settledAt >= this.pollMs
      ) {
        yield* this.verifyEffect(t, r);
        return;
      }
      if (
        !t.receipt &&
        !r.seenWork &&
        settled(a.agent_status) &&
        r.settledAt &&
        Date.now() - r.settledAt > 30000
      ) {
        yield* sync('Supervisor.monitor', () =>
          this.uncertain(
            t,
            'Prompt was acknowledged but no native work or state transition was observed. Inspect the pinned session and reconcile delivery; no automatic replay.',
          ),
        );
        return;
      }
      if (
        !t.receipt &&
        r.seenWork &&
        settled(a.agent_status) &&
        r.settledAt &&
        Date.now() - r.settledAt > 8000
      ) {
        yield* sync('Supervisor.monitor', () =>
          s.updateTask(
            t,
            { status: 'blocked', blockKind: 'missing-report' },
            'Worker settled without completion evidence',
          ),
        );
        yield* sync('Supervisor.monitor', () =>
          s.ask(
            t,
            /(?:Transport error|worker_transport|Cannot reach the Marionette worker endpoint|fetch failed)/i.test(
              t.output,
            )
              ? 'The agent stopped without a completion report and its output mentions a transport failure. Inspect the reporting connection before resuming. Prefer the scoped marionette_worker MCP tools; for an older worker without them, request normal network permission for the exact worker-call/worker-report command. Do not repeat the same sandboxed call or infer that the supervisor is down from a transport error.'
              : 'The agent stopped without a completion report. Inspect its output, then reply with instructions to submit its report.',
          ),
        );
      }
    },
  );
  private operationEffect = Effect.fn('Supervisor.operation')(
    { self: this },
    function* (this: Supervisor, t: Task, r: Run, a: AgentInfo, op: Operation) {
      const s = this.service,
        h = yield* sync('Supervisor.operation', () => s.port(s.project(t.projectId)));
      return yield* Effect.gen({ self: this }, function* () {
        if (op.type === 'keys') {
          op.phase = 'sending';
          yield* sync('Supervisor.operation', () => s.store.put('operation', op.id, op));
          yield* herdrCall(h, 'agent.send_keys', { target: r.paneId, keys: op.keys });
          op.phase = 'done';
          yield* sync('Supervisor.operation', () => s.store.put('operation', op.id, op));
          yield* sync('Supervisor.operation', () =>
            s.store.event(t.projectId, 'control.keys', 'Explicit keys sent to worker', t.id),
          );
          return;
        }
        if (op.phase === 'pending' && !settled(a.agent_status)) {
          op.phase = 'interrupting';
          yield* sync('Supervisor.operation', () => (op.interruptedAt = Date.now()));
          yield* sync('Supervisor.operation', () => s.store.put('operation', op.id, op));
          yield* herdrCall(h, 'agent.send_keys', { target: r.paneId, keys: ['esc'] });
          yield* sync('Supervisor.operation', () =>
            s.updateTask(
              s.task(t.id),
              { status: op.type === 'cancel' ? 'cancelling' : 'redirecting' },
              `Interrupt requested: ${op.type}`,
            ),
          );
          return;
        }
        if (!settled(a.agent_status)) {
          if (
            op.phase === 'interrupting' &&
            Date.now() - (op.interruptedAt ?? Date.parse(op.createdAt)) > 30000
          ) {
            op.phase = 'failed';
            op.error = 'Worker did not settle within 30 seconds after interruption';
            yield* sync('Supervisor.operation', () => s.store.put('operation', op.id, op));
            yield* sync('Supervisor.operation', () =>
              s.updateTask(
                s.task(t.id),
                { status: 'blocked', blockKind: 'native', error: op.error },
                op.error,
              ),
            );
            yield* sync('Supervisor.operation', () =>
              s.ask(
                t,
                'The interrupt did not settle the worker. Inspect its current output, resolve the specific native prompt, then submit the control request again.',
                true,
              ),
            );
          }
          return;
        }
        if (
          op.phase === 'interrupting' &&
          Date.now() - (r.settledAt ?? Date.now()) < Math.max(2, this.pollMs * 2)
        )
          return;
        if (op.type === 'cancel' || op.type === 'pause') {
          if (op.type === 'cancel') {
            r.phase = 'stopped';
            yield* sync('Supervisor.operation', () => this.saveRun(r));
            yield* sync('Supervisor.operation', () =>
              s.closeQuestions(t.id, 'Task cancelled by lead'),
            );
          }
          yield* sync('Supervisor.operation', () =>
            s.updateTask(
              s.task(t.id),
              { status: op.type === 'cancel' ? 'cancelled' : 'paused' },
              op.type === 'cancel' ? 'Worker stopped; task cancelled' : 'Worker paused',
            ),
          );
          op.phase = 'done';
          yield* sync('Supervisor.operation', () => s.store.put('operation', op.id, op));
          return;
        }
        if (op.type === 'redirect')
          yield* sync(
            'Supervisor.operation',
            () =>
              (t = s.updateTask(s.task(t.id), {
                prompt: op.text!,
                checks: op.checks ?? t.checks,
                receipt: undefined,
                verification: undefined,
              })),
          );
        else yield* sync('Supervisor.operation', () => (t = s.task(t.id)));
        if (op.checks) {
          r.baseline = {};
          for (const c of t.checks)
            if (c.type === 'file')
              yield* sync(
                'Supervisor.operation',
                () => (r.baseline[c.path] = digest(safePath(t.cwd, c.path))),
              );
        }
        op.phase = 'sending';
        yield* sync('Supervisor.operation', () => s.store.put('operation', op.id, op));
        yield* this.promptEffect(
          t,
          r,
          r.phase === 'starting'
            ? this.instructions(t)
            : renderWorkerFollowup({
                task: t,
                kind: op.type === 'reply' ? 'reply' : 'redirect',
                text: op.text ?? '',
              }),
        );
        op.phase = 'done';
        yield* sync('Supervisor.operation', () => s.store.put('operation', op.id, op));
        yield* sync('Supervisor.operation', () => s.closeQuestions(t.id, op.text ?? 'Resumed'));
      }).pipe(
        Effect.catch((e) =>
          Effect.gen({ self: this }, function* () {
            if (op.phase === 'sending')
              yield* sync('Supervisor.operation', () =>
                this.uncertain(s.task(t.id), `Control delivery may be ambiguous: ${String(e)}`),
              );
            else {
              op.phase = 'failed';
              yield* sync('Supervisor.operation', () => (op.error = String(e)));
              yield* sync('Supervisor.operation', () => s.store.put('operation', op.id, op));
              yield* sync('Supervisor.operation', () => s.ask(t, `Control failed: ${String(e)}`));
            }
          }),
        ),
      );
    },
    (effect, t, _r, _a, op) =>
      effect.pipe(
        Effect.onInterrupt(() =>
          sync('Supervisor.controlInterrupted', () => {
            if (op.phase === 'sending') {
              op.phase = 'failed';
              op.error = 'Control interrupted before acknowledgement. No automatic replay.';
              this.service.store.put('operation', op.id, op);
              this.uncertain(this.service.task(t.id), op.error);
            }
          }).pipe(Effect.orDie),
        ),
      ),
  );
  private verifyEffect = Effect.fn('Supervisor.verify')(
    { self: this },
    function* (this: Supervisor, t: Task, r: Run) {
      const s = this.service;
      const revision = t.revision;
      yield* sync('Supervisor.verify', () =>
        s.updateTask(t, { status: 'verifying' }, `Checking completion evidence for ${t.title}`),
      );
      const results: Verification[] = [];
      for (const check of t.checks) {
        let passed = false,
          detail = '',
          fileDigest: string | undefined;
        {
          const attempt7 = yield* Effect.result(
            Effect.gen({ self: this }, function* () {
              if (check.type === 'file') {
                const path = yield* sync('Supervisor.verify', () =>
                  safePath(t.cwd, check.path, true),
                );
                yield* sync('Supervisor.verify', () => (fileDigest = digest(path) ?? undefined));
                if (!fileDigest)
                  return yield* boundaryError('Supervisor.verify')(
                    new Error('Artifact is not a regular file'),
                  );
                if (!check.allowUnchanged && fileDigest === r.baseline[check.path])
                  return yield* boundaryError('Supervisor.verify')(
                    new Error('Artifact is unchanged from before dispatch'),
                  );
                if (
                  check.contains !== undefined &&
                  !readFileSync(path, 'utf8').includes(check.contains)
                )
                  return yield* boundaryError('Supervisor.verify')(
                    new Error('Artifact does not contain the expected content'),
                  );
                if (check.sha256 && check.sha256 !== fileDigest)
                  return yield* boundaryError('Supervisor.verify')(
                    new Error('Artifact SHA-256 does not match'),
                  );
                passed = true;
                detail = `Verified ${check.path}; SHA-256 ${fileDigest}`;
              } else {
                const result = yield* commandEffect(
                  check.command,
                  check.args,
                  t.cwd,
                  check.timeoutMs,
                );
                passed = result.code === 0 && !result.timedOut;
                detail = `Exit ${result.code}${result.timedOut ? ' (timed out)' : ''}\n${result.output}`;
              }
            }),
          );
          if (Result.isFailure(attempt7)) {
            const e = attempt7.failure;
            yield* sync('Supervisor.verify', () => (detail = String(e)));
          }
        }
        yield* sync('Supervisor.verify', () =>
          results.push({ check, passed, detail, digest: fileDigest, checkedAt: now() }),
        );
      }
      // A redirect may have arrived while a verification command was running.
      const current = yield* sync('Supervisor.verify', () => s.task(t.id));
      if (
        current.revision !== revision ||
        s.store
          .all<Operation>('operation')
          .some((o) => o.taskId === t.id && !['done', 'failed'].includes(o.phase))
      )
        return;
      const unmet = yield* sync('Supervisor.verify', () => s.orchestration.unmetTask(current));
      const passed = yield* sync(
        'Supervisor.verify',
        () => results.every((v) => v.passed) && unmet.length === 0,
      );
      r.phase = 'stopped';
      yield* sync('Supervisor.verify', () => this.saveRun(r));
      yield* sync('Supervisor.verify', () =>
        s.store.transaction(() => {
          s.updateTask(
            current,
            {
              status: passed ? 'completed' : 'failed',
              verification: results,
              error: passed
                ? undefined
                : unmet.length
                  ? `Required descendants incomplete: ${unmet.join('; ')}`
                  : 'Completion checks failed',
            },
            passed ? `Verified completion: ${t.title}` : `Verification failed: ${t.title}`,
          );
          s.closeQuestions(t.id, passed ? 'Completion verified' : 'Verification failed');
        }),
      );
    },
  );
}
