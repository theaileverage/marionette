import { Effect, Latch, Result, Schema, Stream } from 'effect';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { LeadWait } from './continuation.js';
import { BoundaryError, boundaryError, herdrCall, sync } from './effect-runtime.js';
import { digest, hash, inside, safePath } from './files.js';
import type { Outcome } from './orchestration-types.js';
import { ScopedTasks } from './scoped-tasks.js';
import type { Service } from './service.js';
import {
  AppError,
  now,
  type Credentials,
  type ManagedWorktree,
  type Run,
  type Task,
} from './types.js';
import { gitEffect, validateWorktreeEffect } from './worktrees.js';
export const cleanupPolicySchema = Schema.Struct({
  autoRelease: Schema.mutableKey(
    Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  ),
  collectAfterHours: Schema.mutableKey(
    Schema.NullOr(
      Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).check(
        Schema.isLessThanOrEqualTo(87600),
      ),
    ).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  ),
  deleteMergedBranches: Schema.mutableKey(
    Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  ),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type CleanupPolicy = Schema.Schema.Type<typeof cleanupPolicySchema>;
export interface Delivery {
  taskId: string;
  projectId: string;
  disposition: 'merged' | 'published' | 'abandoned';
  head: string;
  targetRef?: string;
  targetCommit?: string;
  reason: string;
  owner: string;
  createdAt: string;
}
export interface Archive {
  id: string;
  taskId: string;
  projectId: string;
  taskIds: string[];
  phase: 'archived' | 'removing' | 'worktree-removed' | 'collected';
  worktree: ManagedWorktree;
  delivery: Delivery;
  // Original absolute file names are the lookup keys; the archive itself uses hashes.
  files: {
    source: string;
    digest: string;
  }[];
  manifestDigest: string;
  bundleDigest: string;
  createdAt: string;
  updatedAt: string;
  branchDeleted?: boolean;
  error?: string;
}
const terminal = (t: Task) => ['completed', 'failed', 'cancelled'].includes(t.status);
function refuse(message: string): never {
  throw new AppError({ code: 'cleanup_blocked', message: message, status: 409 });
}
function flush(path: string) {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
const fileHashEffect = Effect.fn('Archive.hash')(function* (path: string) {
  const value = createHash('sha256');
  yield* Stream.fromAsyncIterable(createReadStream(path), boundaryError('Archive.read')).pipe(
    Stream.runForEach((chunk) => sync('Archive.hashChunk', () => value.update(chunk))),
  );
  return value.digest('hex');
});
/** Release terminals separately from explicit delivery, evidence preservation and Git collection. */
export class Cleanup {
  private busy = new Set<string>();
  private readonly idle = Latch.makeUnsafe(true);
  private readonly jobs = new ScopedTasks();
  private stopped = false;
  private lastAutomatic = 0;
  constructor(public s: Service) {}
  policy(projectId: string): CleanupPolicy {
    return (
      this.s.store.get<CleanupPolicy>('cleanup-policy', projectId) ??
      Schema.decodeSync(cleanupPolicySchema)({})
    );
  }
  archive(t: Task) {
    return t.archiveId ? this.s.store.get<Archive>('archive', t.archiveId) : undefined;
  }
  group(t: Task) {
    return t.worktree
      ? this.s.store
          .all<Task>('task')
          .filter((x) => x.worktree?.path === t.worktree!.path || inside(t.worktree!.path, x.cwd))
      : [t];
  }
  assertMutable(t: Task) {
    if (t.archiveId || this.busy.has(t.id))
      refuse(
        'Task is archived or cleanup is in progress. Create a new assignment for further work.',
      );
    const affected = new Set([t.id]);
    const tasks = this.s.store.all<Task>('task');
    for (const id of affected) {
      const parentId = tasks.find((child) => child.id === id)?.parentId;
      for (const other of tasks)
        if (other.dependencies.includes(id) || other.id === parentId) affected.add(other.id);
    }
    if ([...affected].some((id) => this.busy.has(id)))
      refuse('Cleanup is inspecting a consumer of this task; retry after it finishes');
    const r = t.runId ? this.s.store.get<Run>('run', t.runId) : undefined;
    if (r?.cleanup && ['closing', 'uncertain'].includes(r.cleanup.state))
      refuse('Reconcile terminal cleanup before changing this task.');
  }
  active(taskId: string) {
    return this.busy.has(taskId);
  }
  assertOutcomeMutable(outcomeId: string) {
    if (
      this.s.store.all<Task>('task').some((t) => t.outcomeId === outcomeId && this.busy.has(t.id))
    )
      refuse('Cleanup is inspecting this outcome; retry after it finishes');
  }
  private consumers(tasks: Task[]) {
    const ids = new Set(tasks.map((t) => t.id));
    const roots = tasks.map((t) => t.worktree?.path ?? t.cwd);
    const reasons: string[] = [];
    for (const t of this.s.store.all<Task>('task')) {
      if (ids.has(t.id)) continue;
      if (
        !terminal(t) &&
        (ids.has(t.parentId ?? '') ||
          t.dependencies.some((id) => ids.has(id)) ||
          (t.waitForChildren ?? []).some((id) => ids.has(id)))
      )
        reasons.push(`Task ${t.id} still consumes these results`);
    }
    for (const p of this.s.store.all<any>('project')) {
      if (
        roots.some((root) => tasks.some((t) => t.worktree?.path === root) && inside(root, p.root))
      )
        reasons.push(`Registered project ${p.id} uses this checkout`);
    }
    return reasons;
  }
  private runReasons(t: Task, r: Run, automatic: boolean) {
    const reasons: string[] = [];
    if (!terminal(t) || r.phase !== 'stopped')
      reasons.push('Task and native run must be finished and settled');
    if (t.resumePending) reasons.push('A parent continuation is pending');
    if (
      this.s.store
        .all<any>('operation')
        .some((o) => o.taskId === t.id && !['done', 'failed'].includes(o.phase))
    )
      reasons.push('A task control is unresolved');
    if (
      this.s.store
        .all<LeadWait>('lead-wait')
        .some(
          (w) =>
            w.adapter.type === 'herdr' &&
            w.adapter.paneId === r.paneId &&
            !['invalidated', 'acknowledged'].includes(w.state),
        )
    )
      reasons.push('This pane is pinned by a lead wait');
    reasons.push(...this.consumers([t]));
    if (
      automatic &&
      (!this.policy(t.projectId).autoRelease ||
        t.status !== 'completed' ||
        !t.outcomeId ||
        this.s.orchestration.outcome(t.outcomeId).status !== 'completed')
    )
      reasons.push(
        'Automatic release waits for the completed integrated outcome and enabled policy; failures require inspection',
      );
    return reasons;
  }
  private groupReasons(t: Task) {
    const tasks = this.group(t),
      reasons = this.consumers(tasks);
    if (!t.worktree || t.worktree.state !== 'ready')
      reasons.push('Only ready Marionette-managed worktrees can be collected');
    for (const item of tasks) {
      if (!terminal(item)) reasons.push(`Task ${item.id} is ${item.status}`);
      for (const r of this.s.store.all<Run>('run').filter((r) => r.taskId === item.id))
        if (r.paneId && r.cleanup?.state !== 'closed')
          reasons.push(`Run ${r.id} must release its terminal first`);
      if (
        item.status === 'completed' &&
        item.outcomeId &&
        this.s.orchestration.outcome(item.outcomeId).status !== 'completed'
      )
        reasons.push(`Outcome ${item.outcomeId} still needs integration`);
      else if (
        item.status === 'completed' &&
        item.outcomeId &&
        this.s.orchestration.unmet(this.s.orchestration.outcome(item.outcomeId)).length
      )
        reasons.push(`Outcome ${item.outcomeId} evidence is no longer current`);
    }
    // References in an unfinished outcome remain live consumers, even across task trees.
    for (const o of this.s.store.all<Outcome>('outcome')) {
      if (o.status === 'completed') continue;
      for (const ref of [
        ...o.assessments.flatMap((a) => a.references),
        ...(o.integrated?.evidence ?? []),
      ]) {
        if (tasks.some((t) => ref.path.startsWith(`task:${t.id}:`)))
          reasons.push(`Outcome ${o.id} still references this checkout`);
      }
    }
    return [...new Set(reasons)];
  }
  preview(taskId: string) {
    return Effect.runPromise(this.previewEffect(taskId));
  }
  previewEffect = Effect.fn('Cleanup.preview')(
    { self: this },
    function* (this: Cleanup, taskId: string) {
      const t = yield* sync('Cleanup.preview', () => this.s.task(taskId)),
        runs = yield* sync('Cleanup.preview', () =>
          this.s.store.all<Run>('run').filter((r) => r.taskId === taskId),
        ),
        archive = yield* sync('Cleanup.preview', () => this.archive(t));
      let gitReason: string | undefined;
      if (t.worktree && !archive) {
        const worktree = t.worktree;
        const attempt1 = yield* Effect.result(
          Effect.gen({ self: this }, function* () {
            yield* this.cleanEffect(worktree);
          }),
        );
        if (Result.isFailure(attempt1)) {
          const e = attempt1.failure;
          yield* sync('Cleanup.preview', () => (gitReason = String(e)));
        }
      }
      return yield* sync('Cleanup.preview', () => ({
        taskId,
        policy: this.policy(t.projectId),
        runs: runs.map((r) => ({
          runId: r.id,
          tabId: r.tabId,
          paneId: r.paneId,
          cleanup: r.cleanup,
          reasons: this.runReasons(t, r, true),
        })),
        delivery: this.s.store.get<Delivery>('delivery', taskId),
        archive,
        collectionReasons: [
          ...this.groupReasons(t),
          ...(gitReason ? [gitReason] : []),
          ...(!this.s.store.get('delivery', taskId) && !archive
            ? ['Record delivery or explicit abandonment first']
            : []),
        ],
        boundary:
          'Completion retains branches and worktrees. Collection never removes sessions or workspaces.',
      }));
    },
  );
  private lockedEffect<T, E, R>(tasks: Task[], fn: () => Effect.Effect<T, E, R>) {
    return Effect.acquireUseRelease(
      sync('Cleanup.reserve', () => {
        if (this.stopped || tasks.some((t) => this.busy.has(t.id)))
          refuse('Cleanup is stopping or already in progress');
        tasks.forEach((t) => this.busy.add(t.id));
        this.idle.closeUnsafe();
      }),
      fn,
      () =>
        Effect.sync(() => {
          tasks.forEach((t) => this.busy.delete(t.id));
          if (this.busy.size === 0) this.idle.openUnsafe();
        }),
    );
  }
  recover() {
    this.stopped = false;
    for (const r of this.s.store.all<Run>('run'))
      if (r.cleanup?.state === 'closing')
        this.saveRun(r, {
          ...r.cleanup,
          state: 'uncertain',
          error: 'Restart during terminal closure; inspect and reconcile. No automatic replay.',
        });
  }
  stop() {
    return Effect.runPromise(this.stopEffect());
  }
  stopEffect = Effect.fn('Cleanup.stop')({ self: this }, function* (this: Cleanup) {
    this.stopped = true;
    yield* this.jobs.close();
    yield* this.idle.await;
  });
  private launch(task: Task, work: Effect.Effect<unknown, AppError | BoundaryError>) {
    this.jobs.run(
      task.id,
      work.pipe(
        Effect.asVoid,
        Effect.catch((error) =>
          sync('Cleanup.failed', () => {
            this.s.store.event(task.projectId, 'cleanup.error', String(error), task.id);
          }),
        ),
      ),
    );
  }
  tick() {
    if (this.stopped || Date.now() - this.lastAutomatic < 10000) return;
    this.lastAutomatic = Date.now();
    for (const t of this.s.store.all<Task>('task')) {
      if (this.busy.has(t.id)) continue;
      const p = this.policy(t.projectId);
      const r = t.runId ? this.s.store.get<Run>('run', t.runId) : undefined;
      if (p.autoRelease && r && !r.cleanup && !this.runReasons(t, r, true).length) {
        this.launch(
          t,
          this.lockedEffect([t], () =>
            this.releaseEffect(t, r, 'Integrated outcome completed', true),
          ),
        );
        continue;
      }
      const delivery = this.s.store.get<Delivery>('delivery', t.id),
        a = this.archive(t);
      if (
        p.collectAfterHours === null ||
        !delivery ||
        delivery.disposition === 'abandoned' ||
        (a && a.taskId !== t.id) ||
        this.group(t).some((x) => x.status !== 'completed')
      )
        continue;
      if (
        a?.phase === 'collected' &&
        (!p.deleteMergedBranches || a.branchDeleted || delivery.disposition !== 'merged')
      )
        continue;
      if (
        Date.now() - Date.parse(delivery.createdAt) < p.collectAfterHours * 3600000 ||
        this.groupReasons(t).length
      )
        continue;
      // Errors/partial operations require explicit review, not repeated automatic deletion attempts.
      if (a?.error || a?.phase === 'removing') continue;
      this.launch(
        t,
        this.lockedEffect(this.group(t), () =>
          Effect.gen({ self: this }, function* () {
            const guard = () => {
              if (JSON.stringify(this.policy(t.projectId)) !== JSON.stringify(p))
                refuse('Cleanup policy changed during inspection');
            };
            const archived = a ?? (yield* this.createArchiveEffect(t, guard));
            yield* this.collectEffect(
              archived,
              p.deleteMergedBranches && delivery.disposition === 'merged',
              guard,
            );
          }),
        ),
      );
    }
  }
  private saveRun(r: Run, cleanup: NonNullable<Run['cleanup']>) {
    const latest = this.s.store.get<Run>('run', r.id)!;
    this.s.store.put('run', r.id, { ...latest, cleanup: { ...cleanup, updatedAt: now() } });
  }
  private pinnedEffect = Effect.fn('Cleanup.pinned')(
    { self: this },
    function* (this: Cleanup, t: Task, r: Run) {
      const p = yield* sync('Cleanup.pinned', () => this.s.project(t.projectId)),
        h = yield* sync('Cleanup.pinned', () => this.s.port(p));
      if (!r.tabId || !r.paneId || !r.terminalId || !r.nativeSession)
        return yield* sync('Cleanup.pinned', () =>
          refuse('A full saved worker and native session identity is required'),
        );
      const tab = (yield* herdrCall(h, 'tab.get', { tab_id: r.tabId })).tab;
      const panes = (yield* herdrCall(h, 'pane.list', { workspace_id: p.workspaceId })).panes;
      const members = yield* sync('Cleanup.pinned', () =>
        panes?.filter((pane: any) => pane.tab_id === r.tabId),
      );
      if (
        tab?.workspace_id !== p.workspaceId ||
        tab.tab_id !== r.tabId ||
        (!r.terminalScope && (tab.pane_count !== 1 || members?.length !== 1)) ||
        members?.filter(
          (pane: any) => pane.pane_id === r.paneId && pane.terminal_id === r.terminalId,
        ).length !== 1
      )
        return yield* sync('Cleanup.pinned', () =>
          refuse('Tab contents changed; refusing to close another pane'),
        );
      const a = (yield* herdrCall(h, 'agent.get', { target: r.paneId })).agent;
      if (
        a?.workspace_id !== p.workspaceId ||
        a.pane_id !== r.paneId ||
        a.terminal_id !== r.terminalId ||
        a.name !== r.agentName ||
        a.agent !== r.kind ||
        a.agent_session?.value !== r.nativeSession ||
        !['idle', 'done'].includes(a.agent_status) ||
        a.launch_pending ||
        a.interactive_ready === false
      )
        return yield* sync('Cleanup.pinned', () =>
          refuse('Native worker identity or readiness changed'),
        );
      return h;
    },
  );
  private absentEffect = Effect.fn('Cleanup.absent')(
    { self: this },
    function* (this: Cleanup, t: Task, r: Run) {
      const h = yield* sync('Cleanup.absent', () => this.s.port(this.s.project(t.projectId)));
      if (r.terminalScope === 'pane') {
        const panes = (yield* herdrCall(h, 'pane.list')).panes;
        if (!Array.isArray(panes))
          return yield* sync('Cleanup.absent', () =>
            refuse('Cannot inspect worker terminal membership'),
          );
        if (
          panes.some(
            (pane: any) =>
              (pane.pane_id === r.paneId || pane.terminal_id === r.terminalId) &&
              (pane.pane_id !== r.paneId ||
                pane.tab_id !== r.tabId ||
                pane.terminal_id !== r.terminalId),
          )
        )
          return yield* sync('Cleanup.absent', () =>
            refuse('Original terminal may have moved; inspect it before cleanup'),
          );
        return yield* sync(
          'Cleanup.absent',
          () =>
            !panes.some(
              (pane: any) => pane.pane_id === r.paneId || pane.terminal_id === r.terminalId,
            ),
        );
      }
      {
        const attempt2 = yield* Effect.result(
          Effect.gen({ self: this }, function* () {
            yield* herdrCall(h, 'tab.get', { tab_id: r.tabId });
            return false;
          }),
        );
        if (Result.isFailure(attempt2)) {
          const e = attempt2.failure;
          if (!(e instanceof AppError) || e.code !== 'tab_not_found')
            return yield* boundaryError('Cleanup.absent')(e);
        } else return false;
      }
      const panes = (yield* herdrCall(h, 'pane.list')).panes;
      if (
        !Array.isArray(panes) ||
        panes.some((p: any) => p.pane_id === r.paneId || p.terminal_id === r.terminalId)
      )
        return yield* sync('Cleanup.absent', () =>
          refuse('Original terminal may have moved to another tab; inspect it before cleanup'),
        );
      return true;
    },
  );
  private checkReleasedEffect = Effect.fn('Cleanup.checkReleased')(
    { self: this },
    function* (this: Cleanup, tasks: Task[]) {
      for (const t of tasks) {
        for (const r of this.s.store.all<Run>('run').filter((r) => r.taskId === t.id && r.paneId))
          if (r.cleanup?.state !== 'closed' || !(yield* this.absentEffect(t, r)))
            return yield* sync('Cleanup.checkReleased', () =>
              refuse(
                'A recorded worker terminal is still present; inspect it before collecting its checkout',
              ),
            );
      }
    },
  );
  private releaseEffect = Effect.fn('Cleanup.release')(
    { self: this },
    function* (
      this: Cleanup,
      t: Task,
      r: Run,
      reason: string,
      automatic: boolean,
      guard = () => {},
    ) {
      if (r.cleanup?.state === 'closed') return r.cleanup;
      if (r.cleanup && ['closing', 'uncertain'].includes(r.cleanup.state))
        return yield* sync('Cleanup.release', () =>
          refuse('Reconcile ambiguous terminal closure first'),
        );
      return yield* Effect.gen({ self: this }, function* () {
        const reasons = yield* sync('Cleanup.release', () =>
          this.runReasons(this.s.task(t.id), r, automatic),
        );
        if (reasons.length) return yield* sync('Cleanup.release', () => refuse(reasons.join('; ')));
        if (yield* this.absentEffect(t, r)) {
          yield* sync('Cleanup.release', () => guard());
          yield* sync('Cleanup.release', () =>
            this.saveRun(r, { state: 'closed', reason, updatedAt: now(), output: t.output }),
          );
          return yield* sync('Cleanup.release', () => this.s.store.get<Run>('run', r.id)!.cleanup);
        }
        const h = yield* this.pinnedEffect(t, r);
        const output =
          (yield* herdrCall(h, 'pane.read', {
            pane_id: r.paneId,
            source: 'recent_unwrapped',
            lines: 500,
            format: 'text',
          })).read?.text ?? t.output;
        yield* this.pinnedEffect(t, r);
        yield* sync('Cleanup.release', () => guard());
        const current = yield* sync('Cleanup.release', () => this.s.task(t.id));
        if (
          current.revision !== t.revision ||
          this.runReasons(current, this.s.store.get<Run>('run', r.id)!, automatic).length
        )
          return yield* sync('Cleanup.release', () =>
            refuse('Task changed during cleanup inspection'),
          );
        yield* sync('Cleanup.release', () =>
          this.saveRun(r, {
            state: 'closing',
            reason,
            updatedAt: now(),
            output: String(output).slice(-100000),
          }),
        );
        if (r.terminalScope === 'pane') yield* herdrCall(h, 'pane.close', { pane_id: r.paneId });
        else yield* herdrCall(h, 'tab.close', { tab_id: r.tabId });
        yield* sync('Cleanup.release', () =>
          this.saveRun(r, { ...this.s.store.get<Run>('run', r.id)!.cleanup!, state: 'closed' }),
        );
        yield* sync('Cleanup.release', () =>
          this.s.store.event(
            t.projectId,
            'cleanup.released',
            'Saved worker diagnostics and closed its settled terminal',
            t.id,
            { runId: r.id },
          ),
        );
        return yield* sync('Cleanup.release', () => this.s.store.get<Run>('run', r.id)!.cleanup);
      }).pipe(
        Effect.catch((e) =>
          Effect.gen({ self: this }, function* () {
            const current = yield* sync(
              'Cleanup.release',
              () => this.s.store.get<Run>('run', r.id)!.cleanup,
            );
            yield* sync('Cleanup.release', () =>
              this.saveRun(r, {
                ...current,
                state: current?.state === 'closing' ? 'uncertain' : 'retained',
                reason,
                updatedAt: now(),
                error: String(e),
              }),
            );
            return yield* boundaryError('Cleanup.release')(e);
          }),
        ),
      );
    },
    (effect, _t, r) =>
      effect.pipe(
        Effect.onInterrupt(() =>
          sync('Cleanup.interrupted', () => {
            const current = this.s.store.get<Run>('run', r.id)?.cleanup;
            if (current?.state === 'closing')
              this.saveRun(r, {
                ...current,
                state: 'uncertain',
                updatedAt: now(),
                error:
                  'Terminal closure interrupted before acknowledgement; reconcile before retrying.',
              });
          }).pipe(Effect.orDie),
        ),
      ),
  );
  private cleanEffect = Effect.fn('Cleanup.clean')(
    { self: this },
    function* (this: Cleanup, w: ManagedWorktree) {
      yield* validateWorktreeEffect(w);
      const status = yield* gitEffect(w.path, [
        'status',
        '--porcelain',
        '--untracked-files=all',
        '--ignored',
      ]);
      if (status)
        return yield* sync('Cleanup.clean', () =>
          refuse(
            'Worktree has modified, untracked, or ignored files; preserve or remove them explicitly before collection',
          ),
        );
      return yield* gitEffect(w.path, ['rev-parse', 'HEAD']);
    },
  );
  private checkDeliveryEffect = Effect.fn('Cleanup.checkDelivery')(
    { self: this },
    function* (this: Cleanup, w: ManagedWorktree, d: Delivery) {
      if ((yield* this.cleanEffect(w)) !== d.head)
        return yield* sync('Cleanup.checkDelivery', () =>
          refuse('Worktree HEAD changed after delivery'),
        );
      if (d.disposition !== 'abandoned') {
        if (!d.targetRef || !d.targetCommit)
          return yield* sync('Cleanup.checkDelivery', () => refuse('Delivery target is missing'));
        const current = yield* gitEffect(w.repositoryRoot, [
          'rev-parse',
          '--verify',
          '--end-of-options',
          `${d.targetRef}^{commit}`,
        ]);
        yield* gitEffect(w.repositoryRoot, ['merge-base', '--is-ancestor', d.head, current]);
      }
    },
  );
  private archiveRoot(id: string) {
    return safePath(dirname(this.s.store.path), `archives/${id}`);
  }
  /** Live files remain authoritative until collection actually removes the checkout. */
  evidencePath(t: Task, input: string): string {
    const a = this.archive(t);
    if (!a || a.phase === 'archived' || existsSync(a.worktree.path))
      return safePath(t.cwd, input, true);
    const source = resolve(t.cwd, input);
    if (!inside(t.cwd, source)) refuse('Evidence escapes task directory');
    const f = a.files.find((f) => f.source === source);
    if (!f) refuse('Evidence was not preserved in this archive');
    const path = safePath(this.archiveRoot(a.id), `files/${f.digest}`, true);
    if (digest(path) !== f.digest) refuse('Archived evidence digest changed');
    return path;
  }
  private createArchiveEffect = Effect.fn('Cleanup.createArchive')(
    { self: this },
    function* (this: Cleanup, t: Task, guard: () => void) {
      const prior = yield* sync('Cleanup.createArchive', () => this.archive(t));
      if (prior) return prior;
      const reasons = yield* sync('Cleanup.createArchive', () => this.groupReasons(t));
      if (reasons.length)
        return yield* sync('Cleanup.createArchive', () => refuse(reasons.join('; ')));
      const w = t.worktree!,
        d = yield* sync('Cleanup.createArchive', () =>
          this.s.store.get<Delivery>('delivery', t.id),
        );
      if (!d)
        return yield* sync('Cleanup.createArchive', () =>
          refuse('Record delivery or abandonment before archiving'),
        );
      yield* this.checkDeliveryEffect(w, d);
      const tasks = yield* sync('Cleanup.createArchive', () => this.group(t)),
        taskIds = yield* sync('Cleanup.createArchive', () => new Set(tasks.map((t) => t.id)));
      yield* this.checkReleasedEffect(tasks);
      const id = yield* sync('Cleanup.createArchive', () => randomUUID()),
        root = yield* sync('Cleanup.createArchive', () => this.archiveRoot(id));
      yield* sync('Cleanup.createArchive', () =>
        mkdirSync(resolve(root, 'files'), { recursive: true, mode: 0o700 }),
      );
      const files = yield* sync('Cleanup.createArchive', () => new Map<string, string>());
      const copy = (source: string, expected?: string, alias = source) => {
        const actual = digest(source);
        if (!actual || (expected && expected !== actual))
          refuse('Evidence is missing or changed before archival');
        const bytes = readFileSync(source);
        if (hash(bytes) !== actual) refuse('Evidence changed during archival');
        writeFileSync(resolve(root, 'files', actual), bytes, { mode: 0o600, flush: true });
        files.set(source, actual);
        files.set(alias, actual);
      };
      for (const item of tasks) {
        for (const v of item.verification ?? [])
          if (v.passed && v.check.type === 'file') {
            const path = v.check.path;
            yield* sync('Cleanup.createArchive', () =>
              copy(safePath(item.cwd, path, true), v.digest, resolve(item.cwd, path)),
            );
          }
        for (const path of item.receipt?.artifacts ?? []) {
          const source = yield* sync('Cleanup.createArchive', () => safePath(item.cwd, path, true));
          if (!item.ownership.some((owned) => inside(safePath(item.cwd, owned), source)))
            return yield* sync('Cleanup.createArchive', () =>
              refuse('Reported artifact no longer belongs to the task'),
            );
          // Reports may name directories. Their committed contents are preserved in
          // the standalone bundle; regular file evidence also has direct hash lookup.
          if (statSync(source).isDirectory()) continue;
          yield* sync('Cleanup.createArchive', () =>
            copy(source, undefined, resolve(item.cwd, path)),
          );
        }
      }
      for (const o of this.s.store.all<Outcome>('outcome')) {
        for (const ref of [
          ...o.assessments.flatMap((a) => a.references),
          ...(o.integrated?.evidence ?? []),
        ]) {
          const match = yield* sync('Cleanup.createArchive', () =>
            /^task:([^:]+):(.+)$/.exec(ref.path),
          );
          if (match && taskIds.has(match[1]))
            yield* sync('Cleanup.createArchive', () =>
              copy(
                safePath(this.s.task(match[1]).cwd, match[2], true),
                ref.digest,
                resolve(this.s.task(match[1]).cwd, match[2]),
              ),
            );
          else if (!match) {
            const path = yield* sync('Cleanup.createArchive', () =>
              resolve(this.s.project(o.projectId).root, ref.path),
            );
            if (inside(w.path, path))
              return yield* sync('Cleanup.createArchive', () =>
                refuse(
                  'Project-relative evidence still uses this checkout; replace it with a task reference',
                ),
              );
          }
        }
      }
      // A standalone bundle retains the committed result, including abandoned unique commits.
      yield* gitEffect(w.repositoryRoot, [
        'bundle',
        'create',
        resolve(root, 'commits.bundle'),
        `refs/heads/${w.branch}`,
      ]);
      yield* gitEffect(w.repositoryRoot, ['bundle', 'verify', resolve(root, 'commits.bundle')]);
      yield* sync('Cleanup.createArchive', () => flush(resolve(root, 'commits.bundle')));
      const bundleDigest = yield* fileHashEffect(resolve(root, 'commits.bundle'));
      const manifest = yield* sync('Cleanup.createArchive', () =>
        JSON.stringify(
          {
            tasks,
            runs: this.s.store
              .all<Run>('run')
              .filter((r) => taskIds.has(r.taskId))
              .map(({ tokenHash: _tokenHash, ...r }) => r),
            outcomes: this.s.store
              .all<Outcome>('outcome')
              .filter((o) => tasks.some((t) => t.outcomeId === o.id)),
            delivery: d,
            files: [...files],
            archivedAt: now(),
          },
          null,
          2,
        ),
      );
      yield* sync('Cleanup.createArchive', () =>
        writeFileSync(resolve(root, 'manifest.json'), manifest, { mode: 0o600, flush: true }),
      );
      yield* sync('Cleanup.createArchive', () => flush(resolve(root, 'files')));
      yield* sync('Cleanup.createArchive', () => flush(root));
      yield* sync('Cleanup.createArchive', () => flush(dirname(root)));
      yield* sync('Cleanup.createArchive', () => flush(dirname(dirname(root))));
      yield* this.checkDeliveryEffect(w, d);
      yield* sync('Cleanup.createArchive', () => guard());
      if (
        this.groupReasons(t).length ||
        this.group(t).some((x) => !tasks.some((y) => x.id === y.id && x.revision === y.revision))
      )
        return yield* sync('Cleanup.createArchive', () =>
          refuse('Checkout consumers changed during archival'),
        );
      for (const [path, expected] of files)
        if (digest(path) !== expected)
          return yield* sync('Cleanup.createArchive', () =>
            refuse('Evidence changed during archival'),
          );
      const a: Archive = yield* sync<Archive>('Cleanup.createArchive', () => ({
        id,
        taskId: t.id,
        projectId: t.projectId,
        taskIds: [...taskIds],
        phase: 'archived',
        worktree: w,
        delivery: d,
        files: [...files].map(([source, digest]) => ({ source, digest })),
        manifestDigest: hash(manifest),
        bundleDigest,
        createdAt: now(),
        updatedAt: now(),
      }));
      yield* sync('Cleanup.createArchive', () =>
        this.s.store.transaction(() => {
          this.s.store.put('archive', id, a);
          for (const item of tasks) this.s.updateTask(item, { archiveId: id });
          this.s.store.event(
            t.projectId,
            'cleanup.archived',
            'Preserved evidence, diagnostics, and committed history; tasks are sealed',
            t.id,
            { archiveId: id },
          );
        }),
      );
      return a;
    },
  );
  private verifyArchiveEffect = Effect.fn('Cleanup.verifyArchive')(
    { self: this },
    function* (this: Cleanup, a: Archive) {
      const root = yield* sync('Cleanup.verifyArchive', () => this.archiveRoot(a.id));
      if (
        hash(readFileSync(safePath(root, 'manifest.json', true))) !== a.manifestDigest ||
        (yield* fileHashEffect(safePath(root, 'commits.bundle', true))) !== a.bundleDigest
      )
        return yield* sync('Cleanup.verifyArchive', () => refuse('Archive integrity check failed'));
      for (const f of a.files)
        if (digest(safePath(root, `files/${f.digest}`, true)) !== f.digest)
          return yield* sync('Cleanup.verifyArchive', () =>
            refuse('Archived evidence integrity check failed'),
          );
    },
  );
  private saveArchive(a: Archive, patch: Partial<Archive>) {
    const next = { ...this.s.store.get<Archive>('archive', a.id)!, ...patch, updatedAt: now() };
    this.s.store.put('archive', a.id, next);
    return next;
  }
  private collectEffect = Effect.fn('Cleanup.collect')(
    { self: this },
    function* (this: Cleanup, a: Archive, deleteBranch: boolean, guard: () => void) {
      if (a.phase === 'collected' && (!deleteBranch || a.branchDeleted)) return a;
      if (
        deleteBranch &&
        a.delivery.disposition !== 'merged' &&
        a.delivery.disposition !== 'abandoned'
      )
        return yield* sync('Cleanup.collect', () =>
          refuse('Published PR branches are retained until merged or explicitly abandoned'),
        );
      return yield* Effect.gen({ self: this }, function* () {
        yield* this.verifyArchiveEffect(a);
        const t = yield* sync('Cleanup.collect', () => this.s.task(a.taskId)),
          reasons = yield* sync('Cleanup.collect', () => this.groupReasons(t));
        if (reasons.length) return yield* sync('Cleanup.collect', () => refuse(reasons.join('; ')));
        yield* this.checkReleasedEffect(this.group(t));
        const w = a.worktree;
        const common = realpathSync(
          yield* gitEffect(w.repositoryRoot, [
            'rev-parse',
            '--path-format=absolute',
            '--git-common-dir',
          ]),
        );
        if (common !== w.commonDir)
          return yield* sync('Cleanup.collect', () => refuse('Source repository identity changed'));
        if (existsSync(w.path)) {
          yield* this.checkDeliveryEffect(w, a.delivery);
          for (const f of a.files)
            if (digest(f.source) !== f.digest)
              return yield* sync('Cleanup.collect', () =>
                refuse('Live evidence changed after archival'),
              );
          yield* sync('Cleanup.collect', () => guard());
          if (this.groupReasons(t).length)
            return yield* sync('Cleanup.collect', () =>
              refuse('Checkout consumers changed before collection'),
            );
          yield* sync(
            'Cleanup.collect',
            () => (a = this.saveArchive(a, { phase: 'removing', error: undefined })),
          );
          // Git itself refuses dirty/locked/changed worktrees; never force or recursively delete.
          yield* gitEffect(w.repositoryRoot, ['worktree', 'remove', '--', w.path]);
        }
        const listing = yield* gitEffect(w.repositoryRoot, [
          'worktree',
          'list',
          '--porcelain',
          '-z',
        ]);
        if (
          common !== w.commonDir ||
          listing.split('\0').includes(`worktree ${w.path}`) ||
          existsSync(w.path)
        )
          return yield* sync('Cleanup.collect', () =>
            refuse('Worktree removal is incomplete; inspect its registration'),
          );
        yield* sync(
          'Cleanup.collect',
          () => (a = this.saveArchive(a, { phase: 'worktree-removed', error: undefined })),
        );
        if (deleteBranch) {
          const refs = yield* gitEffect(w.repositoryRoot, [
            'for-each-ref',
            '--format=%(refname) %(objectname)',
            `refs/heads/${w.branch}`,
          ]);
          if (refs) {
            if (refs !== `refs/heads/${w.branch} ${a.delivery.head}`)
              return yield* sync('Cleanup.collect', () =>
                refuse('Branch moved after archival; preserving it'),
              );
            if (listing.split('\0').includes(`branch refs/heads/${w.branch}`))
              return yield* sync('Cleanup.collect', () =>
                refuse('Another checkout still uses the branch'),
              );
            if (a.delivery.disposition === 'abandoned') {
              yield* sync('Cleanup.collect', () => guard());
              // Explicit abandonment plus deleteBranch authorizes discarding this exact ref.
              // Compare-and-delete refuses a tip changed since the verified bundle was made.
              yield* gitEffect(w.repositoryRoot, [
                'update-ref',
                '-d',
                `refs/heads/${w.branch}`,
                a.delivery.head,
              ]);
            } else {
              const target = yield* gitEffect(w.repositoryRoot, [
                'rev-parse',
                '--verify',
                '--end-of-options',
                `${a.delivery.targetRef}^{commit}`,
              ]);
              yield* gitEffect(w.repositoryRoot, [
                'merge-base',
                '--is-ancestor',
                a.delivery.head,
                target,
              ]);
              yield* sync('Cleanup.collect', () => guard());
              yield* gitEffect(w.repositoryRoot, [
                'update-ref',
                '-d',
                `refs/heads/${w.branch}`,
                a.delivery.head,
              ]);
            }
          }
        }
        yield* sync(
          'Cleanup.collect',
          () =>
            (a = this.saveArchive(a, {
              phase: 'collected',
              branchDeleted: deleteBranch,
              error: undefined,
            })),
        );
        yield* sync('Cleanup.collect', () =>
          this.s.store.event(
            a.projectId,
            'cleanup.collected',
            'Collected delivered worktree; archive retained',
            a.taskId,
            { archiveId: a.id, branchDeleted: deleteBranch },
          ),
        );
        return a;
      }).pipe(
        Effect.catch((e) =>
          Effect.gen({ self: this }, function* () {
            yield* sync('Cleanup.collect', () => this.saveArchive(a, { error: String(e) }));
            return yield* boundaryError('Cleanup.collect')(e);
          }),
        ),
      );
    },
  );
  invoke(action: string, raw: any) {
    return Effect.runPromise(this.invokeEffect(action, raw));
  }
  invokeEffect = Effect.fn('Cleanup.invoke')(
    { self: this },
    function* (this: Cleanup, action: string, raw: any) {
      if (action === 'cleanup.preview')
        return yield* this.previewEffect(
          yield* Schema.decodeUnknownEffect(Schema.String)(raw.taskId).pipe(
            Effect.mapError(boundaryError('Cleanup.decode')),
          ),
        );
      const c: Credentials = yield* sync<Credentials>('Cleanup.invoke', () =>
          this.s.guard(raw.lease),
        ),
        reason = yield* sync('Cleanup.invoke', () =>
          Schema.decodeUnknownSync(
            Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(4000)),
          )(raw.reason),
        );
      const guard = () => {
        this.s.guard(raw.lease);
      };
      if (action === 'cleanup.configure') {
        const p = yield* sync('Cleanup.invoke', () =>
          Schema.decodeUnknownSync(cleanupPolicySchema)(raw.policy),
        );
        yield* sync('Cleanup.invoke', () => this.s.store.put('cleanup-policy', c.projectId, p));
        yield* sync('Cleanup.invoke', () =>
          this.s.store.event(c.projectId, 'cleanup.policy', `${c.owner}: ${reason}`, undefined, p),
        );
        return p;
      }
      const t = yield* sync('Cleanup.invoke', () =>
        this.s.task(Schema.decodeUnknownSync(Schema.String)(raw.taskId)),
      );
      if (t.projectId !== c.projectId)
        return yield* sync('Cleanup.invoke', () =>
          refuse('Task and lead belong to different projects'),
        );
      if (action === 'cleanup.release' || action === 'cleanup.reconcile') {
        const r = yield* sync('Cleanup.invoke', () =>
          this.s.store.get<Run>(
            'run',
            Schema.decodeUnknownSync(Schema.String)(raw.runId ?? t.runId),
          ),
        );
        if (!r || r.taskId !== t.id)
          return yield* sync('Cleanup.invoke', () => refuse('Run does not belong to this task'));
        return yield* this.lockedEffect([t], () =>
          Effect.gen({ self: this }, function* () {
            if (action === 'cleanup.release')
              return yield* this.releaseEffect(t, r!, reason, false, guard);
            if (r!.cleanup?.state !== 'uncertain')
              return yield* sync('Cleanup.work', () =>
                refuse('Only uncertain cleanup needs reconciliation'),
              );
            const resolution = yield* sync('Cleanup.work', () =>
              Schema.decodeUnknownSync(Schema.Literals(['closed', 'not-closed']))(raw.resolution),
            );
            if (resolution === 'closed') {
              if (yield* this.absentEffect(t, r!)) {
                yield* sync('Cleanup.work', () => guard());
                yield* sync('Cleanup.work', () =>
                  this.saveRun(r!, { ...r!.cleanup!, state: 'closed', reason, error: undefined }),
                );
                return yield* sync(
                  'Cleanup.work',
                  () => this.s.store.get<Run>('run', r!.id)!.cleanup,
                );
              }
              return yield* sync('Cleanup.work', () =>
                refuse('Original worker terminal is still present'),
              );
            }
            yield* this.pinnedEffect(t, r!);
            yield* sync('Cleanup.work', () => guard());
            yield* sync('Cleanup.work', () =>
              this.saveRun(r!, { ...r!.cleanup!, state: 'retained', reason, error: undefined }),
            );
            return yield* sync('Cleanup.work', () => this.s.store.get<Run>('run', r!.id)!.cleanup);
          }),
        );
      }
      if (!t.worktree)
        return yield* sync('Cleanup.invoke', () => refuse('Task has no managed worktree'));
      return yield* this.lockedEffect(this.group(t), () =>
        Effect.gen({ self: this }, function* () {
          if (action === 'cleanup.deliver') {
            const archived = yield* sync('Cleanup.work', () => this.archive(t));
            const disposition = yield* sync('Cleanup.work', () =>
              Schema.decodeUnknownSync(Schema.Literals(['merged', 'published', 'abandoned']))(
                raw.disposition,
              ),
            );
            if (archived && archived.taskId !== t.id)
              return yield* sync('Cleanup.work', () =>
                refuse('Update delivery on the task that owns the archive'),
              );
            const head =
              archived && !existsSync(t.worktree!.path)
                ? yield* gitEffect(t.worktree!.repositoryRoot, [
                    'rev-parse',
                    '--verify',
                    '--end-of-options',
                    `refs/heads/${t.worktree!.branch}^{commit}`,
                  ])
                : yield* this.cleanEffect(t.worktree!);
            if (archived && (head !== archived.delivery.head || archived.branchDeleted))
              return yield* sync('Cleanup.work', () =>
                refuse('Archived branch changed or was already deleted'),
              );
            let targetRef: string | undefined, targetCommit: string | undefined;
            if (disposition !== 'abandoned') {
              targetRef = yield* sync('Cleanup.deliveryTarget', () =>
                Schema.decodeUnknownSync(Schema.String.check(Schema.isMinLength(1)))(raw.targetRef),
              );
              if (
                !/^refs\/(heads|remotes)\//.test(targetRef) ||
                targetRef === `refs/heads/${t.worktree!.branch}` ||
                (disposition === 'published' && !targetRef.startsWith('refs/remotes/'))
              )
                return yield* sync('Cleanup.work', () =>
                  refuse(
                    'Use an explicit target branch ref; published delivery needs a refreshed remote-tracking ref',
                  ),
                );
              yield* gitEffect(t.worktree!.repositoryRoot, ['check-ref-format', targetRef]);
              targetCommit = yield* gitEffect(t.worktree!.repositoryRoot, [
                'rev-parse',
                '--verify',
                '--end-of-options',
                `${targetRef}^{commit}`,
              ]);
              yield* gitEffect(t.worktree!.repositoryRoot, [
                'merge-base',
                '--is-ancestor',
                head,
                targetCommit,
              ]);
            }
            yield* sync('Cleanup.work', () => guard());
            const d: Delivery = yield* sync<Delivery>('Cleanup.work', () => ({
              taskId: t.id,
              projectId: t.projectId,
              disposition,
              head,
              targetRef,
              targetCommit,
              reason,
              owner: c.owner,
              createdAt: now(),
            }));
            const previous = yield* sync('Cleanup.work', () =>
              this.s.store.get<Delivery>('delivery', t.id),
            );
            if (
              previous &&
              JSON.stringify({ ...previous, createdAt: '' }) ===
                JSON.stringify({ ...d, createdAt: '' })
            )
              return previous;
            yield* sync('Cleanup.work', () => this.s.store.put('delivery', t.id, d));
            if (archived)
              yield* sync('Cleanup.work', () =>
                this.saveArchive(archived, { delivery: d, error: undefined }),
              );
            yield* sync('Cleanup.work', () =>
              this.s.store.event(
                t.projectId,
                'cleanup.delivered',
                `${disposition}: ${reason}`,
                t.id,
                d,
              ),
            );
            return d;
          }
          if (action === 'cleanup.archive') return yield* this.createArchiveEffect(t, guard);
          if (action === 'cleanup.collect') {
            const a = yield* sync('Cleanup.work', () => this.archive(t));
            if (!a || a.id !== raw.archiveId)
              return yield* sync('Cleanup.work', () =>
                refuse('Preview and supply the current archiveId before collection'),
              );
            return yield* this.collectEffect(
              a!,
              yield* Schema.decodeUnknownEffect(Schema.Boolean)(raw.deleteBranch ?? false).pipe(
                Effect.mapError(boundaryError('Cleanup.decode')),
              ),
              guard,
            );
          }
          return yield* new AppError({
            code: 'unknown_action',
            message: `Unknown action: ${action}`,
            status: 404,
          });
        }),
      );
    },
  );
}
