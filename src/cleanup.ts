import { randomUUID, createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  openSync,
  fsyncSync,
  closeSync,
  createReadStream,
  statSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import type { Service } from './service.js';
import type { Outcome } from './orchestration-types.js';
import type { LeadWait } from './continuation.js';
import {
  AppError,
  now,
  type Task,
  type Run,
  type Credentials,
  type ManagedWorktree,
} from './types.js';
import { digest, hash, inside, safePath } from './files.js';
import { git, validateWorktree } from './worktrees.js';

export const cleanupPolicySchema = z
  .object({
    autoRelease: z.boolean().default(true),
    collectAfterHours: z.number().min(0).max(87600).nullable().default(null),
    deleteMergedBranches: z.boolean().default(false),
  })
  .strict();
export type CleanupPolicy = z.infer<typeof cleanupPolicySchema>;
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
  files: { source: string; digest: string }[];
  manifestDigest: string;
  bundleDigest: string;
  createdAt: string;
  updatedAt: string;
  branchDeleted?: boolean;
  error?: string;
}
const terminal = (t: Task) => ['completed', 'failed', 'cancelled'].includes(t.status);
function refuse(message: string): never {
  throw new AppError('cleanup_blocked', message, 409);
}
function flush(path: string) {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
async function fileHash(path: string) {
  const value = createHash('sha256');
  for await (const chunk of createReadStream(path)) value.update(chunk);
  return value.digest('hex');
}

/** Release terminals separately from explicit delivery, evidence preservation and Git collection. */
export class Cleanup {
  private busy = new Set<string>();
  private stopped = false;
  private lastAutomatic = 0;
  constructor(public s: Service) {}
  policy(projectId: string): CleanupPolicy {
    return (
      this.s.store.get<CleanupPolicy>('cleanup-policy', projectId) ?? cleanupPolicySchema.parse({})
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
  async preview(taskId: string) {
    const t = this.s.task(taskId),
      runs = this.s.store.all<Run>('run').filter((r) => r.taskId === taskId),
      archive = this.archive(t);
    let gitReason: string | undefined;
    if (t.worktree && !archive)
      try {
        await this.clean(t.worktree);
      } catch (e) {
        gitReason = String(e);
      }
    return {
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
    };
  }
  private async locked<T>(tasks: Task[], fn: () => Promise<T>): Promise<T> {
    if (this.stopped || tasks.some((t) => this.busy.has(t.id)))
      refuse('Cleanup is stopping or already in progress');
    tasks.forEach((t) => this.busy.add(t.id));
    try {
      return await fn();
    } finally {
      tasks.forEach((t) => this.busy.delete(t.id));
    }
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
  async stop() {
    this.stopped = true;
    while (this.busy.size) await new Promise((r) => setTimeout(r, 25));
  }
  tick() {
    if (this.stopped || Date.now() - this.lastAutomatic < 10000) return;
    this.lastAutomatic = Date.now();
    for (const t of this.s.store.all<Task>('task')) {
      if (this.busy.has(t.id)) continue;
      const p = this.policy(t.projectId);
      const r = t.runId ? this.s.store.get<Run>('run', t.runId) : undefined;
      if (p.autoRelease && r && !r.cleanup && !this.runReasons(t, r, true).length) {
        void this.locked([t], () => this.release(t, r, 'Integrated outcome completed', true)).catch(
          (e) => this.s.store.event(t.projectId, 'cleanup.error', String(e), t.id),
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
      void this.locked(this.group(t), async () => {
        const guard = () => {
          if (JSON.stringify(this.policy(t.projectId)) !== JSON.stringify(p))
            refuse('Cleanup policy changed during inspection');
        };
        const archived = a ?? (await this.createArchive(t, guard));
        await this.collect(
          archived,
          p.deleteMergedBranches && delivery.disposition === 'merged',
          guard,
        );
      }).catch((e) => this.s.store.event(t.projectId, 'cleanup.error', String(e), t.id));
    }
  }
  private saveRun(r: Run, cleanup: NonNullable<Run['cleanup']>) {
    const latest = this.s.store.get<Run>('run', r.id)!;
    this.s.store.put('run', r.id, { ...latest, cleanup: { ...cleanup, updatedAt: now() } });
  }
  private async pinned(t: Task, r: Run) {
    const p = this.s.project(t.projectId),
      h = this.s.port(p);
    if (!r.tabId || !r.paneId || !r.terminalId || !r.nativeSession)
      refuse('A full saved worker and native session identity is required');
    const tab = (await h.call('tab.get', { tab_id: r.tabId })).tab;
    const panes = (await h.call('pane.list', { workspace_id: p.workspaceId })).panes;
    const members = panes?.filter((pane: any) => pane.tab_id === r.tabId);
    if (
      tab?.workspace_id !== p.workspaceId ||
      tab.tab_id !== r.tabId ||
      (!r.terminalScope && (tab.pane_count !== 1 || members?.length !== 1)) ||
      members?.filter((pane: any) => pane.pane_id === r.paneId && pane.terminal_id === r.terminalId)
        .length !== 1
    )
      refuse('Tab contents changed; refusing to close another pane');
    const a = (await h.call('agent.get', { target: r.paneId })).agent;
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
      refuse('Native worker identity or readiness changed');
    return h;
  }
  private async absent(t: Task, r: Run) {
    const h = this.s.port(this.s.project(t.projectId));
    if (r.terminalScope === 'pane') {
      const panes = (await h.call('pane.list')).panes;
      if (!Array.isArray(panes)) refuse('Cannot inspect worker terminal membership');
      if (
        panes.some(
          (pane: any) =>
            (pane.pane_id === r.paneId || pane.terminal_id === r.terminalId) &&
            (pane.pane_id !== r.paneId ||
              pane.tab_id !== r.tabId ||
              pane.terminal_id !== r.terminalId),
        )
      )
        refuse('Original terminal may have moved; inspect it before cleanup');
      return !panes.some(
        (pane: any) => pane.pane_id === r.paneId || pane.terminal_id === r.terminalId,
      );
    }
    try {
      await h.call('tab.get', { tab_id: r.tabId });
      return false;
    } catch (e) {
      if ((e as AppError).code !== 'tab_not_found') throw e;
    }
    const panes = (await h.call('pane.list')).panes;
    if (
      !Array.isArray(panes) ||
      panes.some((p: any) => p.pane_id === r.paneId || p.terminal_id === r.terminalId)
    )
      refuse('Original terminal may have moved to another tab; inspect it before cleanup');
    return true;
  }
  private async checkReleased(tasks: Task[]) {
    for (const t of tasks) {
      for (const r of this.s.store.all<Run>('run').filter((r) => r.taskId === t.id && r.paneId))
        if (r.cleanup?.state !== 'closed' || !(await this.absent(t, r)))
          refuse(
            'A recorded worker terminal is still present; inspect it before collecting its checkout',
          );
    }
  }
  private async release(t: Task, r: Run, reason: string, automatic: boolean, guard = () => {}) {
    if (r.cleanup?.state === 'closed') return r.cleanup;
    if (r.cleanup && ['closing', 'uncertain'].includes(r.cleanup.state))
      refuse('Reconcile ambiguous terminal closure first');
    try {
      const reasons = this.runReasons(this.s.task(t.id), r, automatic);
      if (reasons.length) refuse(reasons.join('; '));
      if (await this.absent(t, r)) {
        guard();
        this.saveRun(r, { state: 'closed', reason, updatedAt: now(), output: t.output });
        return this.s.store.get<Run>('run', r.id)!.cleanup;
      }
      const h = await this.pinned(t, r);
      const output =
        (
          await h.call('pane.read', {
            pane_id: r.paneId,
            source: 'recent_unwrapped',
            lines: 500,
            format: 'text',
          })
        ).read?.text ?? t.output;
      await this.pinned(t, r);
      guard();
      const current = this.s.task(t.id);
      if (
        current.revision !== t.revision ||
        this.runReasons(current, this.s.store.get<Run>('run', r.id)!, automatic).length
      )
        refuse('Task changed during cleanup inspection');
      this.saveRun(r, {
        state: 'closing',
        reason,
        updatedAt: now(),
        output: String(output).slice(-100000),
      });
      if (r.terminalScope === 'pane') await h.call('pane.close', { pane_id: r.paneId });
      else await h.call('tab.close', { tab_id: r.tabId });
      this.saveRun(r, { ...this.s.store.get<Run>('run', r.id)!.cleanup!, state: 'closed' });
      this.s.store.event(
        t.projectId,
        'cleanup.released',
        'Saved worker diagnostics and closed its settled terminal',
        t.id,
        { runId: r.id },
      );
      return this.s.store.get<Run>('run', r.id)!.cleanup;
    } catch (e) {
      const current = this.s.store.get<Run>('run', r.id)!.cleanup;
      this.saveRun(r, {
        ...current,
        state: current?.state === 'closing' ? 'uncertain' : 'retained',
        reason,
        updatedAt: now(),
        error: String(e),
      });
      throw e;
    }
  }
  private async clean(w: ManagedWorktree) {
    await validateWorktree(w);
    const status = await git(w.path, [
      'status',
      '--porcelain',
      '--untracked-files=all',
      '--ignored',
    ]);
    if (status)
      refuse(
        'Worktree has modified, untracked, or ignored files; preserve or remove them explicitly before collection',
      );
    return git(w.path, ['rev-parse', 'HEAD']);
  }
  private async checkDelivery(w: ManagedWorktree, d: Delivery) {
    if ((await this.clean(w)) !== d.head) refuse('Worktree HEAD changed after delivery');
    if (d.disposition !== 'abandoned') {
      if (!d.targetRef || !d.targetCommit) refuse('Delivery target is missing');
      const current = await git(w.repositoryRoot, [
        'rev-parse',
        '--verify',
        '--end-of-options',
        `${d.targetRef}^{commit}`,
      ]);
      await git(w.repositoryRoot, ['merge-base', '--is-ancestor', d.head, current]);
    }
  }
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
  private async createArchive(t: Task, guard: () => void): Promise<Archive> {
    const prior = this.archive(t);
    if (prior) return prior;
    const reasons = this.groupReasons(t);
    if (reasons.length) refuse(reasons.join('; '));
    const w = t.worktree!,
      d = this.s.store.get<Delivery>('delivery', t.id);
    if (!d) refuse('Record delivery or abandonment before archiving');
    await this.checkDelivery(w, d);
    const tasks = this.group(t),
      taskIds = new Set(tasks.map((t) => t.id));
    await this.checkReleased(tasks);
    const id = randomUUID(),
      root = this.archiveRoot(id);
    mkdirSync(resolve(root, 'files'), { recursive: true, mode: 0o700 });
    const files = new Map<string, string>();
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
        if (v.passed && v.check.type === 'file')
          copy(safePath(item.cwd, v.check.path, true), v.digest, resolve(item.cwd, v.check.path));
      for (const path of item.receipt?.artifacts ?? []) {
        const source = safePath(item.cwd, path, true);
        if (!item.ownership.some((owned) => inside(safePath(item.cwd, owned), source)))
          refuse('Reported artifact no longer belongs to the task');
        // Reports may name directories. Their committed contents are preserved in
        // the standalone bundle; regular file evidence also has direct hash lookup.
        if (statSync(source).isDirectory()) continue;
        copy(source, undefined, resolve(item.cwd, path));
      }
    }
    for (const o of this.s.store.all<Outcome>('outcome')) {
      for (const ref of [
        ...o.assessments.flatMap((a) => a.references),
        ...(o.integrated?.evidence ?? []),
      ]) {
        const match = /^task:([^:]+):(.+)$/.exec(ref.path);
        if (match && taskIds.has(match[1]))
          copy(
            safePath(this.s.task(match[1]).cwd, match[2], true),
            ref.digest,
            resolve(this.s.task(match[1]).cwd, match[2]),
          );
        else if (!match) {
          const path = resolve(this.s.project(o.projectId).root, ref.path);
          if (inside(w.path, path))
            refuse(
              'Project-relative evidence still uses this checkout; replace it with a task reference',
            );
        }
      }
    }
    // A standalone bundle retains the committed result, including abandoned unique commits.
    await git(w.repositoryRoot, [
      'bundle',
      'create',
      resolve(root, 'commits.bundle'),
      `refs/heads/${w.branch}`,
    ]);
    await git(w.repositoryRoot, ['bundle', 'verify', resolve(root, 'commits.bundle')]);
    flush(resolve(root, 'commits.bundle'));
    const bundleDigest = await fileHash(resolve(root, 'commits.bundle'));
    const manifest = JSON.stringify(
      {
        tasks,
        runs: this.s.store
          .all<Run>('run')
          .filter((r) => taskIds.has(r.taskId))
          .map(({ tokenHash, ...r }) => r),
        outcomes: this.s.store
          .all<Outcome>('outcome')
          .filter((o) => tasks.some((t) => t.outcomeId === o.id)),
        delivery: d,
        files: [...files],
        archivedAt: now(),
      },
      null,
      2,
    );
    writeFileSync(resolve(root, 'manifest.json'), manifest, { mode: 0o600, flush: true });
    flush(resolve(root, 'files'));
    flush(root);
    flush(dirname(root));
    flush(dirname(dirname(root)));
    await this.checkDelivery(w, d);
    guard();
    if (
      this.groupReasons(t).length ||
      this.group(t).some((x) => !tasks.some((y) => x.id === y.id && x.revision === y.revision))
    )
      refuse('Checkout consumers changed during archival');
    for (const [path, expected] of files)
      if (digest(path) !== expected) refuse('Evidence changed during archival');
    const a: Archive = {
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
    };
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
    });
    return a;
  }
  private async verifyArchive(a: Archive) {
    const root = this.archiveRoot(a.id);
    if (
      hash(readFileSync(safePath(root, 'manifest.json', true))) !== a.manifestDigest ||
      (await fileHash(safePath(root, 'commits.bundle', true))) !== a.bundleDigest
    )
      refuse('Archive integrity check failed');
    for (const f of a.files)
      if (digest(safePath(root, `files/${f.digest}`, true)) !== f.digest)
        refuse('Archived evidence integrity check failed');
  }
  private saveArchive(a: Archive, patch: Partial<Archive>) {
    const next = { ...this.s.store.get<Archive>('archive', a.id)!, ...patch, updatedAt: now() };
    this.s.store.put('archive', a.id, next);
    return next;
  }
  private async collect(a: Archive, deleteBranch: boolean, guard: () => void) {
    if (a.phase === 'collected' && (!deleteBranch || a.branchDeleted)) return a;
    if (
      deleteBranch &&
      a.delivery.disposition !== 'merged' &&
      a.delivery.disposition !== 'abandoned'
    )
      refuse('Published PR branches are retained until merged or explicitly abandoned');
    try {
      await this.verifyArchive(a);
      const t = this.s.task(a.taskId),
        reasons = this.groupReasons(t);
      if (reasons.length) refuse(reasons.join('; '));
      await this.checkReleased(this.group(t));
      const w = a.worktree;
      const common = realpathSync(
        await git(w.repositoryRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      );
      if (common !== w.commonDir) refuse('Source repository identity changed');
      if (existsSync(w.path)) {
        await this.checkDelivery(w, a.delivery);
        for (const f of a.files)
          if (digest(f.source) !== f.digest) refuse('Live evidence changed after archival');
        guard();
        if (this.groupReasons(t).length) refuse('Checkout consumers changed before collection');
        a = this.saveArchive(a, { phase: 'removing', error: undefined });
        // Git itself refuses dirty/locked/changed worktrees; never force or recursively delete.
        await git(w.repositoryRoot, ['worktree', 'remove', '--', w.path]);
      }
      const listing = await git(w.repositoryRoot, ['worktree', 'list', '--porcelain', '-z']);
      if (
        common !== w.commonDir ||
        listing.split('\0').includes(`worktree ${w.path}`) ||
        existsSync(w.path)
      )
        refuse('Worktree removal is incomplete; inspect its registration');
      a = this.saveArchive(a, { phase: 'worktree-removed', error: undefined });
      if (deleteBranch) {
        const refs = await git(w.repositoryRoot, [
          'for-each-ref',
          '--format=%(refname) %(objectname)',
          `refs/heads/${w.branch}`,
        ]);
        if (refs) {
          if (refs !== `refs/heads/${w.branch} ${a.delivery.head}`)
            refuse('Branch moved after archival; preserving it');
          if (listing.split('\0').includes(`branch refs/heads/${w.branch}`))
            refuse('Another checkout still uses the branch');
          if (a.delivery.disposition === 'abandoned') {
            guard();
            // Explicit abandonment plus deleteBranch authorizes discarding this exact ref.
            // Compare-and-delete refuses a tip changed since the verified bundle was made.
            await git(w.repositoryRoot, [
              'update-ref',
              '-d',
              `refs/heads/${w.branch}`,
              a.delivery.head,
            ]);
          } else {
            const target = await git(w.repositoryRoot, [
              'rev-parse',
              '--verify',
              '--end-of-options',
              `${a.delivery.targetRef}^{commit}`,
            ]);
            await git(w.repositoryRoot, ['merge-base', '--is-ancestor', a.delivery.head, target]);
            guard();
            await git(w.repositoryRoot, [
              'update-ref',
              '-d',
              `refs/heads/${w.branch}`,
              a.delivery.head,
            ]);
          }
        }
      }
      a = this.saveArchive(a, {
        phase: 'collected',
        branchDeleted: deleteBranch,
        error: undefined,
      });
      this.s.store.event(
        a.projectId,
        'cleanup.collected',
        'Collected delivered worktree; archive retained',
        a.taskId,
        { archiveId: a.id, branchDeleted: deleteBranch },
      );
      return a;
    } catch (e) {
      this.saveArchive(a, { error: String(e) });
      throw e;
    }
  }
  async invoke(action: string, raw: any) {
    if (action === 'cleanup.preview') return this.preview(z.string().parse(raw.taskId));
    const c: Credentials = this.s.guard(raw.lease),
      reason = z.string().min(1).max(4000).parse(raw.reason);
    const guard = () => {
      this.s.guard(raw.lease);
    };
    if (action === 'cleanup.configure') {
      const p = cleanupPolicySchema.parse(raw.policy);
      this.s.store.put('cleanup-policy', c.projectId, p);
      this.s.store.event(c.projectId, 'cleanup.policy', `${c.owner}: ${reason}`, undefined, p);
      return p;
    }
    const t = this.s.task(z.string().parse(raw.taskId));
    if (t.projectId !== c.projectId) refuse('Task and lead belong to different projects');
    if (action === 'cleanup.release' || action === 'cleanup.reconcile') {
      const r = this.s.store.get<Run>('run', z.string().parse(raw.runId ?? t.runId));
      if (!r || r.taskId !== t.id) refuse('Run does not belong to this task');
      return this.locked([t], async () => {
        if (action === 'cleanup.release') return this.release(t, r!, reason, false, guard);
        if (r!.cleanup?.state !== 'uncertain')
          refuse('Only uncertain cleanup needs reconciliation');
        const resolution = z.enum(['closed', 'not-closed']).parse(raw.resolution);
        if (resolution === 'closed') {
          if (await this.absent(t, r!)) {
            guard();
            this.saveRun(r!, { ...r!.cleanup!, state: 'closed', reason, error: undefined });
            return this.s.store.get<Run>('run', r!.id)!.cleanup;
          }
          refuse('Original worker terminal is still present');
        }
        await this.pinned(t, r!);
        guard();
        this.saveRun(r!, { ...r!.cleanup!, state: 'retained', reason, error: undefined });
        return this.s.store.get<Run>('run', r!.id)!.cleanup;
      });
    }
    if (!t.worktree) refuse('Task has no managed worktree');
    return this.locked(this.group(t), async () => {
      if (action === 'cleanup.deliver') {
        const archived = this.archive(t);
        const disposition = z.enum(['merged', 'published', 'abandoned']).parse(raw.disposition);
        if (archived && archived.taskId !== t.id)
          refuse('Update delivery on the task that owns the archive');
        const head =
          archived && !existsSync(t.worktree!.path)
            ? await git(t.worktree!.repositoryRoot, [
                'rev-parse',
                '--verify',
                '--end-of-options',
                `refs/heads/${t.worktree!.branch}^{commit}`,
              ])
            : await this.clean(t.worktree!);
        if (archived && (head !== archived.delivery.head || archived.branchDeleted))
          refuse('Archived branch changed or was already deleted');
        let targetRef: string | undefined, targetCommit: string | undefined;
        if (disposition !== 'abandoned') {
          targetRef = z.string().min(1).parse(raw.targetRef);
          if (
            !/^refs\/(heads|remotes)\//.test(targetRef) ||
            targetRef === `refs/heads/${t.worktree!.branch}` ||
            (disposition === 'published' && !targetRef.startsWith('refs/remotes/'))
          )
            refuse(
              'Use an explicit target branch ref; published delivery needs a refreshed remote-tracking ref',
            );
          await git(t.worktree!.repositoryRoot, ['check-ref-format', targetRef]);
          targetCommit = await git(t.worktree!.repositoryRoot, [
            'rev-parse',
            '--verify',
            '--end-of-options',
            `${targetRef}^{commit}`,
          ]);
          await git(t.worktree!.repositoryRoot, [
            'merge-base',
            '--is-ancestor',
            head,
            targetCommit,
          ]);
        }
        guard();
        const d: Delivery = {
          taskId: t.id,
          projectId: t.projectId,
          disposition,
          head,
          targetRef,
          targetCommit,
          reason,
          owner: c.owner,
          createdAt: now(),
        };
        const previous = this.s.store.get<Delivery>('delivery', t.id);
        if (
          previous &&
          JSON.stringify({ ...previous, createdAt: '' }) === JSON.stringify({ ...d, createdAt: '' })
        )
          return previous;
        this.s.store.put('delivery', t.id, d);
        if (archived) this.saveArchive(archived, { delivery: d, error: undefined });
        this.s.store.event(t.projectId, 'cleanup.delivered', `${disposition}: ${reason}`, t.id, d);
        return d;
      }
      if (action === 'cleanup.archive') return this.createArchive(t, guard);
      if (action === 'cleanup.collect') {
        const a = this.archive(t);
        if (!a || a.id !== raw.archiveId)
          refuse('Preview and supply the current archiveId before collection');
        return this.collect(a!, z.boolean().parse(raw.deleteBranch ?? false), guard);
      }
      throw new AppError('unknown_action', `Unknown action: ${action}`, 404);
    });
  }
}
