import { Effect, Result, Schema } from 'effect';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { boundaryError, BoundaryError, sync } from './effect-runtime.js';
import { digest, inside, safePath } from './files.js';
import { catalogProfiles, discoverModelsEffect } from './model-catalog.js';
import {
  criterionSchema,
  limitsSchema,
  outcomeSchema,
  planPatchSchema,
  profileSchema,
  strategySchema,
  type Assessment,
  type Limits,
  type Outcome,
  type Profile,
  type Revision,
  type Strategy,
} from './orchestration-types.js';
import { builtinProfiles, probeProfileEffect } from './profiles.js';
import type { Service } from './service.js';
import { AppError, now, type Assignment, type Credentials, type Run, type Task } from './types.js';
const fail = (code: string, message: string): never => {
  throw new AppError({ code: code, message: message, status: 409 });
};
const text = Schema.Trim.check(Schema.isMinLength(1));
export class Orchestration {
  constructor(public s: Service) {}
  probeProfile = probeProfileEffect;
  discoverModels = discoverModelsEffect;
  migrateLegacyTasks() {
    this.s.store.transaction(() => {
      for (const t of this.s.store.all<Task>('task').filter((t) => !t.outcomeId)) {
        const o: Outcome = {
          id: `legacy-${t.id}`,
          projectId: t.projectId,
          objective: t.prompt,
          scope: t.ownership.map((path) => resolve(t.worktree?.sourceCwd ?? t.cwd, path)),
          category: 'software',
          criteria: t.checks.map((check, index) => ({
            id: `check-${index + 1}`,
            description: JSON.stringify(check),
            requiredEvidence: 'Independent assignment verification and integrated lead review',
          })),
          leadOwner: this.s.publicLead(t.projectId)?.owner ?? t.leadOwner,
          revision: 1,
          status: 'open',
          turnsUsed: t.attempt,
          maxTurns: Math.max(60, t.attempt),
          maxDepth: 3,
          createdAt: t.createdAt,
          updatedAt: now(),
          assessments: [],
        };
        this.s.store.put('outcome', o.id, o);
        this.s.store.put('task', t.id, { ...t, outcomeId: o.id });
        this.revision(
          o,
          'Adopted the v0.1 assignment contract without redispatching or changing its lease, run, receipt or verification',
          o.leadOwner,
          t,
          o,
        );
      }
    });
  }
  handover(projectId: string, owner: string) {
    for (const o of this.outcomes(projectId))
      this.s.store.put('outcome', o.id, { ...o, leadOwner: owner });
  }
  outcome(id: string) {
    return this.s.store.get<Outcome>('outcome', id) ?? fail('outcome_missing', 'Outcome not found');
  }
  outcomes(projectId: string) {
    return this.s.store.all<Outcome>('outcome').filter((o) => o.projectId === projectId);
  }
  descendants(id: string): Task[] {
    const result: Task[] = [],
      seen = new Set([id]);
    const visit = (parent: string) => {
      for (const t of this.s.store.all<Task>('task').filter((t) => t.parentId === parent)) {
        if (seen.has(t.id)) fail('tree_cycle', 'Task tree contains a cycle');
        seen.add(t.id);
        result.push(t);
        visit(t.id);
      }
    };
    visit(id);
    return result;
  }
  ancestors(task: Task) {
    const list: Task[] = [],
      seen = new Set([task.id]);
    while (task.parentId) {
      if (seen.has(task.parentId)) fail('tree_cycle', 'Task tree contains a cycle');
      seen.add(task.parentId);
      task = this.s.task(task.parentId);
      list.push(task);
    }
    return list;
  }
  required(t: Task) {
    return t.required !== false && !t.supersededBy;
  }
  taskEvidenceCurrent(t: Task) {
    return (
      !!t.verification?.length &&
      t.verification.every((v) => {
        if (!v.passed) return false;
        if (v.check.type !== 'file') return true;
        try {
          return !!v.digest && digest(this.s.cleanup.evidencePath(t, v.check.path)) === v.digest;
        } catch {
          return false;
        }
      })
    );
  }
  refreshEvidence() {
    for (const task of this.s.store.all<Task>('task')) {
      const t = this.s.task(task.id);
      if (t.status !== 'completed' || !t.outcomeId || this.taskEvidenceCurrent(t)) continue;
      this.s.store.transaction(() => {
        const updated = this.s.updateTask(
          t,
          {
            status: 'paused',
            revision: t.revision + 1,
            receipt: undefined,
            verification: undefined,
            waitReason: 'Verified artifact changed; fresh acceptance is required',
          },
          'Completion evidence became stale',
        );
        this.changed(t.outcomeId!, 'Verified artifact changed on disk', 'supervisor', updated, t);
      });
    }
    for (const outcome of this.s.store.all<Outcome>('outcome')) {
      if (outcome.status === 'completed' && this.unmet(outcome).length)
        this.s.store.transaction(() =>
          this.changed(outcome.id, 'Outcome acceptance evidence became stale', 'supervisor'),
        );
    }
  }
  unmetTask(t: Task) {
    return this.descendants(t.id)
      .filter((d) => this.required(d) && (d.status !== 'completed' || !this.taskEvidenceCurrent(d)))
      .map((d) => `${d.title}: ${d.status}`);
  }
  evidencePath(projectId: string, reference: string) {
    const taskReference = /^task:([^:]+):(.+)$/.exec(reference);
    if (!taskReference) return safePath(this.s.project(projectId).root, reference, true);
    const t = this.s.task(taskReference[1]);
    if (t.projectId !== projectId)
      fail('evidence_scope', 'Evidence task belongs to another project');
    const original = resolve(t.cwd, taskReference[2]);
    const path = this.s.cleanup.evidencePath(t, taskReference[2]);
    const archived = !inside(t.cwd, path);
    if (
      !t.ownership.some((owned) =>
        inside(
          archived ? resolve(t.cwd, owned) : safePath(t.cwd, owned),
          archived ? original : path,
        ),
      )
    )
      fail('evidence_scope', 'Task evidence must be inside its ownership');
    return path;
  }
  evidenceCurrent(refs: Assessment['references'], projectId: string) {
    return (
      refs.length > 0 &&
      refs.every((r) => {
        try {
          return digest(this.evidencePath(projectId, r.path)) === r.digest;
        } catch {
          return false;
        }
      })
    );
  }
  unmet(o: Outcome) {
    const items = this.s
      .tasks(o.projectId)
      .filter(
        (t) =>
          t.outcomeId === o.id &&
          this.required(t) &&
          (t.status !== 'completed' || !this.taskEvidenceCurrent(t)),
      )
      .map(
        (t) => `${t.title}: ${t.status === 'completed' ? 'stale completion evidence' : t.status}`,
      );
    for (const c of o.criteria) {
      const a = o.assessments.find((a) => a.criterionId === c.id && a.revision === o.revision);
      if (!a || !this.evidenceCurrent(a.references, o.projectId))
        items.push(`${c.description}: acceptance evidence missing or stale`);
    }
    if (
      !o.integrated ||
      o.integrated.revision !== o.revision ||
      !this.evidenceCurrent(o.integrated.evidence, o.projectId)
    )
      items.push('Integrated outcome review missing or stale');
    for (const strategy of this.s.store
      .all<Strategy>('strategy')
      .filter((s) => s.outcomeId === o.id))
      if (
        strategy.status !== 'completed' ||
        strategy.entries.some(
          (e) => e.round === strategy.round && e.taskRevision !== this.s.task(e.taskId).revision,
        )
      )
        items.push(`${strategy.kind}: synthesis or participant evidence unresolved`);
    return items;
  }
  revision(
    o: Outcome,
    reason: string,
    owner: string,
    before: Revision['before'],
    after: Revision['after'],
    taskId?: string,
    evidence: string[] = [],
  ) {
    const r: Revision = {
      id: randomUUID(),
      projectId: o.projectId,
      outcomeId: o.id,
      revision: o.revision,
      taskId,
      reason,
      evidence,
      owner,
      before,
      after,
      createdAt: now(),
    };
    this.s.store.put('revision', r.id, r);
    this.s.store.event(o.projectId, 'plan.revised', reason, taskId, {
      revisionId: r.id,
      outcomeId: o.id,
    });
  }
  changed(
    outcomeId: string,
    reason: string,
    owner: string,
    task?: Task,
    before?: Revision['before'],
    evidence: string[] = [],
  ) {
    const o = this.outcome(outcomeId);
    const updated = {
      ...o,
      status: 'open' as const,
      revision: o.revision + 1,
      updatedAt: now(),
      integrated: undefined,
    };
    this.s.store.put('outcome', o.id, updated);
    const affected = new Map<string, Task>();
    if (task) {
      const frontier = [task.id];
      const tasks = this.s.store.all<Task>('task');
      // New task additions are not persisted yet, so seed their ancestors explicitly.
      for (const parent of this.ancestors(task)) {
        affected.set(parent.id, parent);
        frontier.push(parent.id);
      }
      const visited = new Set<string>();
      while (frontier.length) {
        const id = frontier.shift()!;
        if (visited.has(id)) continue;
        visited.add(id);
        for (const dependent of tasks.filter(
          (t) =>
            t.dependencies.includes(id) ||
            tasks.some((child) => child.id === id && child.parentId === t.id),
        )) {
          if (dependent.id === task.id) continue;
          affected.set(dependent.id, dependent);
          frontier.push(dependent.id);
        }
      }
      for (const dependent of affected.values()) {
        const patch: Partial<Task> = {
          revision: dependent.revision + 1,
          receipt: undefined,
          verification: undefined,
        };
        if (['completed', 'verifying'].includes(dependent.status)) {
          patch.status = 'paused';
          patch.waitReason = 'Required work changed; integrate and verify again';
        }
        this.s.updateTask(dependent, patch, `Reopened acceptance: ${reason}`);
      }
      const otherOutcomes = new Set(
        [...affected.values()].map((t) => t.outcomeId).filter((id) => id && id !== outcomeId),
      );
      for (const id of otherOutcomes) {
        const previous = this.outcome(id!);
        const reopened: Outcome = {
          ...previous,
          revision: previous.revision + 1,
          status: 'open',
          integrated: undefined,
          updatedAt: now(),
        };
        this.s.store.put('outcome', previous.id, reopened);
        this.revision(
          reopened,
          `Dependency changed: ${reason}`,
          owner,
          previous,
          reopened,
          undefined,
          evidence,
        );
      }
    }
    this.revision(
      updated,
      reason,
      owner,
      before ?? { outcome: o, affected: [...affected.values()] },
      task ?? updated,
      task?.id,
      evidence,
    );
    return updated;
  }
  checkRevision(o: Outcome, expected: number | undefined) {
    if (Schema.decodeUnknownSync(Schema.Finite.check(Schema.isInt()))(expected) !== o.revision)
      fail('tree_revision', 'The task tree changed. Refresh and evaluate the current revision.');
  }
  references(projectId: string, paths: string[]) {
    return Schema.decodeSync(Schema.mutable(Schema.Array(text)).check(Schema.isMinLength(1)))(
      paths,
    ).map((path) => {
      const taskReference = /^task:([^:]+):/.exec(path);
      if (taskReference && this.s.cleanup.active(taskReference[1]))
        fail('cleanup_busy', 'Evidence is being archived; retry after cleanup finishes');
      const value = digest(this.evidencePath(projectId, path));
      if (!value)
        fail(
          'evidence_file',
          'Evidence must reference an existing regular file inside the project',
        );
      return { path, digest: value! };
    });
  }
  validateGraph(tasks: Task[]) {
    const map = new Map(tasks.map((t) => [t.id, t]));
    const visiting = new Set<string>(),
      done = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id))
        fail(
          'dependency_cycle',
          'Dependencies and completion relationships must form an acyclic graph',
        );
      if (done.has(id)) return;
      const t = map.get(id);
      if (!t) fail('dependency_scope', 'Dependency not found in this project');
      visiting.add(id);
      for (const dependency of [
        ...t!.dependencies,
        ...tasks.filter((c) => c.parentId === id && this.required(c)).map((c) => c.id),
      ])
        visit(dependency);
      visiting.delete(id);
      done.add(id);
    };
    for (const t of tasks) visit(t.id);
  }
  profiles(projectId: string) {
    return (
      this.s.store.get<Profile[]>('profiles', projectId) ?? builtinProfiles.map((p) => ({ ...p }))
    );
  }
  resolveProfile(a: Assignment) {
    const defaults =
      this.s.store.get<Record<string, string>>('profile-defaults', a.projectId) ?? {};
    const id = a.profileId ?? (a.category ? defaults[a.category] : undefined);
    if (!id) return undefined;
    const profile =
      this.profiles(a.projectId).find((p) => p.id === id) ??
      fail('profile_missing', 'Requested profile is not configured');
    if (profile.availability !== 'available')
      fail(
        'model_unavailable',
        `${profile.model}: ${profile.availabilityEvidence}. No fallback was selected.`,
      );
    if (a.kind !== profile.kind)
      fail('profile_kind', 'Assignment runtime differs from its profile');
    if (a.model && a.model !== profile.model)
      fail(
        'model_conflict',
        'Explicit model differs from selected profile; choose a matching profile',
      );
    const reasoning = a.reasoning ?? profile.reasoning;
    if (reasoning && !profile.supportedReasoning.includes(reasoning))
      fail('reasoning_unsupported', 'Reasoning effort is not supported by this profile');
    if (a.canDelegate && !profile.canDelegate)
      fail('delegation_denied', 'Profile does not permit delegation');
    return { ...profile, reasoning };
  }
  attach(task: Task, assignment: Assignment, owner: string) {
    if (assignment.parentId) {
      const parent = this.s.task(assignment.parentId);
      if (
        parent.projectId !== task.projectId ||
        (assignment.outcomeId && assignment.outcomeId !== parent.outcomeId)
      )
        fail('parent_scope', 'Parent and child must belong to the same outcome and project');
      if (!parent.canDelegate)
        fail('delegation_denied', 'A parent task must have explicit coordination authority');
      for (const owned of task.ownership)
        if (
          !parent.ownership.some((p) => inside(safePath(parent.cwd, p), safePath(task.cwd, owned)))
        )
          fail('parent_scope', 'Child ownership exceeds parent scope');
      if (!parent.outcomeId)
        fail('legacy_parent', 'Attach the legacy parent to an outcome before delegating');
      if (['cancelled', 'failed', 'uncertain'].includes(parent.status))
        fail('parent_state', 'Resolve the parent before adding work');
      task.outcomeId = parent.outcomeId;
      if (parent.worktree) task.worktree = { ...parent.worktree };
      const o = this.outcome(task.outcomeId!);
      if (this.ancestors(task).length > o.maxDepth)
        fail('depth_limit', 'Outcome delegation depth reached');
    }
    if (task.outcomeId) {
      this.s.cleanup.assertOutcomeMutable(task.outcomeId);
      const o = this.outcome(task.outcomeId!);
      if (o.projectId !== task.projectId)
        fail('outcome_scope', 'Outcome belongs to another project');
      this.checkRevision(o, assignment.expectedTreeRevision);
      for (const owned of task.ownership)
        if (
          !o.scope.some((scope) =>
            inside(
              safePath(this.s.project(task.projectId).root, scope),
              task.worktree
                ? safePath(
                    task.worktree.sourceCwd,
                    relative(task.worktree.cwd, safePath(task.cwd, owned)),
                  )
                : safePath(task.cwd, owned),
            ),
          )
        )
          fail('outcome_scope', 'Task ownership exceeds the outcome scope');
      this.changed(
        o.id,
        assignment.planReason ?? `Added required work: ${task.title}`,
        owner,
        task,
      );
    } else {
      // Legacy callers already supply observable checks. Persist that contract before dispatch.
      const o: Outcome = {
        id: randomUUID(),
        projectId: task.projectId,
        objective: task.prompt,
        scope: task.ownership.map((p) => safePath(task.cwd, p)),
        category: 'software',
        criteria: task.checks.map((c, i) => ({
          id: `check-${i + 1}`,
          description: JSON.stringify(c),
          requiredEvidence: 'Independent supervisor verification and lead review',
        })),
        leadOwner: owner,
        revision: 1,
        status: 'open',
        turnsUsed: 0,
        maxTurns: 60,
        maxDepth: 3,
        createdAt: now(),
        updatedAt: now(),
        assessments: [],
      };
      this.s.store.put('outcome', o.id, o);
      task.outcomeId = o.id;
    }
    task.resolvedProfile = this.resolveProfile(assignment);
    if (task.resolvedProfile) {
      task.profileId = task.resolvedProfile.id;
      task.model = task.resolvedProfile.model;
      task.reasoning = task.resolvedProfile.reasoning;
      task.canDelegate ??= task.resolvedProfile.canDelegate;
    }
    if (task.model && !task.resolvedProfile)
      fail(
        'model_unverified',
        'Configure and validate an exact model profile before selecting a model',
      );
    this.validateGraph([...this.s.tasks(task.projectId), task]);
    return task;
  }
  limits(projectId: string): Limits {
    const local = this.s.store.get<Limits>('limits', projectId);
    const shared = this.s.store.get<Pick<Limits, 'global' | 'providers' | 'models'>>(
      'shared-limits',
      'instance',
    );
    return {
      ...(local ??
        Schema.decodeSync(limitsSchema)({
          project: this.s.project(projectId).maxConcurrency,
        })),
      ...(shared ?? { global: 8, providers: {}, models: {} }),
    };
  }
  capacity(task: Task, holds: (t: Task) => boolean) {
    const all = this.s.store
      .all<Task>('task')
      .filter((t) => t.id !== task.id && t.status !== 'queued' && holds(t));
    const limits = this.limits(task.projectId);
    const leads = this.s.continuation.reservations();
    if (all.length + leads.length >= limits.global) return 'Global execution capacity reached';
    if (
      all.filter((t) => t.projectId === task.projectId).length +
        leads.filter((w) => w.projectId === task.projectId).length >=
      limits.project
    )
      return 'Waiting for an available project execution slot';
    if (
      all.filter((t) => t.kind === task.kind).length +
        leads.filter((w) => w.kind === task.kind).length >=
      (limits.providers[task.kind] ?? limits.global)
    )
      return `${task.kind} provider capacity reached`;
    if (
      task.model &&
      all.filter((t) => t.model === task.model).length +
        leads.filter((w) => w.model === task.model).length >=
        (limits.models[task.model] ?? limits.global)
    )
      return `${task.model} model capacity reached`;
    if (
      task.resolvedProfile &&
      all.filter((t) => t.projectId === task.projectId && t.profileId === task.profileId).length +
        leads.filter((w) => w.projectId === task.projectId && w.profileId === task.profileId)
          .length >=
        task.resolvedProfile.maxConcurrency
    )
      return 'Profile capacity reached';
    if (
      task.outcomeId &&
      this.outcome(task.outcomeId).turnsUsed +
        all.filter((t) => t.outcomeId === task.outcomeId && t.status === 'preparing').length >=
        this.outcome(task.outcomeId).maxTurns
    )
      return 'Shared outcome execution budget exhausted';
    if (task.parentId) {
      const parent = this.s.task(task.parentId);
      if (!['waiting', 'completed'].includes(parent.status))
        return 'Parent must yield ownership before children execute';
    }
    return undefined;
  }
  reserveTurn(t: Task) {
    if (!t.outcomeId) return;
    const o = this.outcome(t.outcomeId);
    if (o.turnsUsed >= o.maxTurns)
      fail('budget_exhausted', 'Shared outcome execution budget exhausted');
    this.s.store.put('outcome', o.id, { ...o, turnsUsed: o.turnsUsed + 1 });
  }
  worker(taskId: string, token: string, revision: number) {
    const t = this.s.workerGuard(taskId, token, revision);
    if (!t.canDelegate) fail('delegation_denied', 'This assignment has no delegation authority');
    return t;
  }
  delegate(taskId: string, token: string, raw: any) {
    return Effect.runPromise(this.delegateEffect(taskId, token, raw));
  }
  delegateEffect = Effect.fn('Orchestration.delegate')(
    { self: this },
    function* (this: Orchestration, taskId: string, token: string, raw: any) {
      const t = yield* sync('Orchestration.delegate', () =>
        this.worker(
          taskId,
          token,
          Schema.decodeUnknownSync(Schema.Finite.check(Schema.isInt()))(raw.revision),
        ),
      );
      const a = raw.assignment;
      if (!a || a.projectId !== t.projectId || a.parentId !== t.id || a.outcomeId !== t.outcomeId)
        return yield* sync('Orchestration.delegate', () =>
          fail(
            'delegation_scope',
            'Children must name their authenticated parent and inherit its outcome',
          ),
        );
      if (a.cwd && a.cwd !== t.cwd)
        return yield* sync('Orchestration.delegate', () =>
          fail('delegation_scope', 'Children inherit their parent working directory'),
        );
      if (a.execution?.mode === 'worktree')
        return yield* sync('Orchestration.delegate', () =>
          fail('delegation_scope', 'Child delegation must stay in the parent working directory'),
        );
      for (const p of yield* Schema.decodeUnknownEffect(
        Schema.mutable(Schema.Array(text)).check(Schema.isMinLength(1)),
      )(a.ownership).pipe(Effect.mapError(boundaryError('orchestration.decode'))))
        if (!t.ownership.some((owned) => inside(safePath(t.cwd, owned), safePath(t.cwd, p))))
          return yield* sync('Orchestration.delegate', () =>
            fail('delegation_scope', 'Child ownership exceeds delegated scope'),
          );
      // A scoped internal submission is never returned as a reusable lead credential.
      const child = yield* sync('Orchestration.delegate', () =>
        this.s.submitAssignment(
          { ...a, cwd: t.cwd },
          { projectId: t.projectId, owner: `worker:${t.id}`, epoch: 0, token: '' },
        ),
      );
      return yield* sync('Orchestration.delegate', () => ({
        task: child,
        parentRevision: this.s.task(t.id).revision,
        outcomeRevision: this.outcome(t.outcomeId!).revision,
      }));
    },
  );
  reviseTask(raw: any, c: Credentials) {
    const t = this.s.task(Schema.decodeUnknownSync(text)(raw.taskId));
    this.s.cleanup.assertMutable(t);
    if (t.projectId !== c.projectId || !t.outcomeId)
      fail('project_mismatch', 'Task must belong to this lead and an outcome');
    const o = this.outcome(t.outcomeId!);
    this.checkRevision(o, raw.expectedTreeRevision);
    if (
      t.revision !==
      Schema.decodeUnknownSync(Schema.Finite.check(Schema.isInt()))(raw.expectedRevision)
    )
      fail('stale_revision', 'Task changed; refresh before revising');
    const patch = Schema.decodeUnknownSync(planPatchSchema)(raw.patch),
      reason = Schema.decodeUnknownSync(text)(raw.reason);
    for (const id of patch.dependencies ?? [])
      if (this.s.cleanup.active(id))
        fail('cleanup_busy', 'Dependency is being cleaned up; retry after it finishes');
    if (
      t.runId &&
      this.s.store.get<Run>('run', t.runId)?.phase !== 'stopped' &&
      !['paused', 'waiting'].includes(t.status)
    )
      fail('task_active', 'Pause and settle the task before revising it');
    if (patch.supersededBy) {
      const replacement = this.s.task(patch.supersededBy);
      if (
        replacement.id === t.id ||
        replacement.outcomeId !== t.outcomeId ||
        !this.required(replacement)
      )
        fail('supersede_scope', 'Replacement must be required work in the same outcome');
    }
    for (const check of patch.checks ?? []) if (check.type === 'file') safePath(t.cwd, check.path);
    const released = t.runId && this.s.store.get<Run>('run', t.runId)?.cleanup?.state === 'closed';
    const updated: Task = {
      ...t,
      ...patch,
      revision: t.revision + 1,
      receipt: undefined,
      verification: undefined,
      runId: released ? undefined : t.runId,
      status: patch.supersededBy ? 'cancelled' : t.runId && !released ? 'paused' : 'queued',
      updatedAt: now(),
    };
    this.validateGraph(
      this.s.tasks(c.projectId).map((task) => (task.id === t.id ? updated : task)),
    );
    this.s.store.put('task', t.id, updated);
    this.changed(
      o.id,
      reason,
      c.owner,
      updated,
      t,
      Schema.decodeUnknownSync(Schema.mutable(Schema.Array(text)))(raw.evidence ?? []),
    );
    return updated;
  }
  workerAction(taskId: string, token: string, raw: any) {
    return Effect.runPromise(this.workerActionEffect(taskId, token, raw));
  }
  workerActionEffect = Effect.fn('Orchestration.workerAction')(
    { self: this },
    function* (this: Orchestration, taskId: string, token: string, raw: any) {
      const task = yield* sync('Orchestration.workerAction', () => this.s.task(taskId));
      const t = yield* sync('Orchestration.workerAction', () =>
        this.s.workerGuard(
          taskId,
          token,
          raw.action === 'inspect'
            ? task.revision
            : Schema.decodeUnknownSync(Schema.Finite.check(Schema.isInt()))(raw.revision),
        ),
      );
      const descendants = yield* sync('Orchestration.workerAction', () => this.descendants(t.id));
      if (raw.action === 'inspect') {
        if (
          raw.taskId &&
          raw.taskId !== t.id &&
          !descendants.some((child) => child.id === raw.taskId)
        )
          return yield* sync('Orchestration.workerAction', () =>
            fail('worker_scope', 'Only this assignment and its descendants may be inspected'),
          );
        if (raw.taskId) return yield* this.s.invokeEffect('task.get', { taskId: raw.taskId });
        const outcome = yield* sync('Orchestration.workerAction', () =>
          t.outcomeId ? this.outcome(t.outcomeId) : undefined,
        );
        return yield* sync('Orchestration.workerAction', () => ({
          task: { ...t, output: '', prompt: t.prompt.slice(0, 800) },
          children: descendants.map((child) => ({
            ...child,
            output: '',
            prompt: child.prompt.slice(0, 800),
            receipt: child.receipt
              ? { ...child.receipt, summary: child.receipt.summary.slice(0, 1000) }
              : undefined,
          })),
          outcome: outcome
            ? {
                id: outcome.id,
                revision: outcome.revision,
                objective: outcome.objective,
                scope: outcome.scope,
                criteria: outcome.criteria,
                maxDepth: outcome.maxDepth,
                maxTurns: outcome.maxTurns,
                turnsUsed: outcome.turnsUsed,
              }
            : null,
        }));
      }
      if (raw.action === 'finding') {
        const finding = yield* sync('Orchestration.workerAction', () => ({
          id: randomUUID(),
          projectId: t.projectId,
          outcomeId: t.outcomeId,
          taskId: t.id,
          createdAt: now(),
          summary: Schema.decodeUnknownSync(text)(raw.summary),
          evidence: Schema.decodeUnknownSync(
            Schema.mutable(Schema.Array(text)).check(Schema.isMinLength(1)),
          )(raw.evidence),
          taskRevision: t.revision,
        }));
        yield* sync('Orchestration.workerAction', () =>
          this.s.store.put('finding', finding.id, finding),
        );
        yield* sync('Orchestration.workerAction', () =>
          this.s.store.event(t.projectId, 'worker.finding', finding.summary, t.id, finding),
        );
        return finding;
      }
      if (raw.action === 'delegate') return yield* this.delegateEffect(taskId, token, raw);
      yield* sync('Orchestration.workerAction', () => this.worker(taskId, token, raw.revision));
      if (!descendants.some((child) => child.id === raw.taskId))
        return yield* sync('Orchestration.workerAction', () =>
          fail('worker_scope', 'Coordinators can only change their own descendants'),
        );
      const actor: Credentials = {
        projectId: t.projectId,
        owner: `worker:${t.id}`,
        epoch: 0,
        token: '',
      };
      if (raw.action === 'revise')
        return yield* sync('Orchestration.workerAction', () =>
          this.s.store.transaction(() => this.reviseTask(raw, actor)),
        );
      if (raw.action === 'control')
        return yield* sync('Orchestration.workerAction', () => this.s.controlTask(raw, actor));
      return yield* sync('Orchestration.workerAction', () =>
        fail(
          'worker_action',
          'Supported worker actions: inspect, finding, delegate, revise, control',
        ),
      );
    },
  );
  board(projectId: string) {
    const outcomes = this.outcomes(projectId).map((o) => ({ ...o, unmet: this.unmet(o) }));
    return {
      outcomes,
      tasks: this.s.tasks(projectId).map(({ output: _output, prompt, ...task }) => ({
        ...task,
        prompt: prompt.slice(0, 1200),
        output: '',
      })),
      revisions: this.s.store
        .all<Revision>('revision')
        .filter((r) => r.projectId === projectId)
        .map(({ before: _before, after: _after, ...summary }) => summary),
      findings: this.s.store.all<any>('finding').filter((f) => f.projectId === projectId),
      profiles: this.profiles(projectId),
      profileDefaults:
        this.s.store.get<Record<string, string>>('profile-defaults', projectId) ?? {},
      limits: this.limits(projectId),
      strategies: this.s.store.all<Strategy>('strategy').filter((s) => s.projectId === projectId),
    };
  }
  invoke(action: string, raw: any) {
    return Effect.runPromise(this.invokeEffect(action, raw));
  }
  invokeEffect: (action: string, raw?: any) => Effect.Effect<any, AppError | BoundaryError> =
    Effect.fn('Orchestration.invoke')(
      { self: this },
      function* (this: Orchestration, action: string, raw: any) {
        if (action === 'outcome.list' || action === 'board.get')
          return yield* sync('Orchestration.invoke', () =>
            this.board(Schema.decodeUnknownSync(text)(raw.projectId)),
          );
        if (action === 'outcome.get') {
          const o = yield* sync('Orchestration.invoke', () =>
            this.outcome(Schema.decodeUnknownSync(text)(raw.outcomeId)),
          );
          return yield* sync('Orchestration.invoke', () => ({ ...o, unmet: this.unmet(o) }));
        }
        if (action === 'plan.get')
          return yield* sync(
            'Orchestration.invoke',
            () =>
              this.s.store.get<Revision>(
                'revision',
                Schema.decodeUnknownSync(text)(raw.revisionId),
              ) ?? fail('revision_missing', 'Revision not found'),
          );
        const c = yield* sync('Orchestration.invoke', () => this.s.guard(raw.lease));
        if (action === 'profile.discover') {
          const kind = yield* sync('Orchestration.invoke', () =>
            Schema.decodeUnknownSync(Schema.Literals(['codex', 'claude', 'agy']))(raw.kind),
          );
          const catalog = yield* this.discoverModels(kind, this.s.project(c.projectId).root);
          yield* sync('Orchestration.invoke', () => this.s.guard(raw.lease));
          return yield* sync('Orchestration.invoke', () =>
            this.s.store.transaction(() => {
              const profiles = this.profiles(c.projectId);
              const added = catalogProfiles(catalog).filter(
                (candidate) =>
                  !profiles.some((p) => p.kind === candidate.kind && p.model === candidate.model),
              );
              const merged = [...profiles, ...added];
              if (new Set(merged.map((p) => p.id)).size !== merged.length)
                fail(
                  'profile_ids',
                  'A discovered profile ID conflicts with a configured profile; rename the custom profile first',
                );
              this.s.store.put('profiles', c.projectId, merged);
              this.s.store.put('model-catalog', c.projectId + ':' + kind, catalog);
              this.s.store.event(
                c.projectId,
                'profiles.discovered',
                `Read ${catalog.models.length} ${kind} models; added ${added.length} profiles without changing defaults or existing profiles`,
              );
              return { catalog, added: added.map((p) => p.id), profiles: merged };
            }),
          );
        }
        if (action === 'profile.validate') {
          const id = yield* sync('Orchestration.invoke', () =>
              Schema.decodeUnknownSync(text)(raw.profileId),
            ),
            profile = yield* sync(
              'Orchestration.invoke',
              () =>
                this.profiles(c.projectId).find((p) => p.id === id) ??
                fail('profile_missing', 'Profile not found'),
            );
          const fingerprint = yield* sync('Orchestration.invoke', () => JSON.stringify(profile));
          let result: Effect.Success<ReturnType<typeof this.probeProfile>>,
            availability: Profile['availability'] = 'available';
          const probe = yield* Effect.result(
            this.probeProfile(profile, this.s.project(c.projectId).root),
          );
          if (Result.isFailure(probe)) {
            result = { output: String(probe.failure), evidence: String(probe.failure) };
            availability = 'unavailable';
          } else result = probe.success;
          yield* sync('Orchestration.invoke', () => this.s.guard(raw.lease));
          const profiles = yield* sync('Orchestration.invoke', () => this.profiles(c.projectId));
          if (JSON.stringify(profiles.find((p) => p.id === id)) !== fingerprint)
            return yield* sync('Orchestration.invoke', () =>
              fail(
                'profile_changed',
                'Profile changed during validation; validate the current configuration',
              ),
            );
          const path = yield* sync('Orchestration.invoke', () =>
            resolve(dirname(this.s.store.path), 'profile-evidence', randomUUID() + '.json'),
          );
          yield* sync('Orchestration.invoke', () =>
            mkdirSync(dirname(path), { recursive: true, mode: 0o700 }),
          );
          yield* sync('Orchestration.invoke', () =>
            writeFileSync(path, result.output, { mode: 0o600 }),
          );
          const updated = yield* sync('Orchestration.invoke', () => ({
            ...profile,
            availability,
            availabilityEvidence: `${result.evidence}. Probe ${now()}; evidence ${path}`,
          }));
          yield* sync('Orchestration.invoke', () =>
            this.s.store.put(
              'profiles',
              c.projectId,
              profiles.map((p) => (p.id === id ? updated : p)),
            ),
          );
          yield* sync('Orchestration.invoke', () =>
            this.s.store.event(c.projectId, 'profile.validated', updated.availabilityEvidence),
          );
          return updated;
        }
        return yield* sync('Orchestration.invoke', () =>
          this.s.store.transaction(() => {
            if (action === 'outcome.create') {
              const i = Schema.decodeUnknownSync(outcomeSchema)(raw.outcome);
              if (i.projectId !== c.projectId) fail('project_mismatch', 'Outcome and lead differ');
              if (new Set(i.criteria.map((c) => c.id)).size !== i.criteria.length)
                fail('criteria_ids', 'Criterion IDs must be unique');
              for (const p of i.scope) safePath(this.s.project(c.projectId).root, p);
              return this.s.idempotent(c.projectId, 'outcome:' + i.key, i, () => {
                const { key: _key, ...fields } = i;
                const o: Outcome = {
                  ...fields,
                  id: randomUUID(),
                  leadOwner: c.owner,
                  revision: 1,
                  status: 'open',
                  turnsUsed: 0,
                  assessments: [],
                  createdAt: now(),
                  updatedAt: now(),
                };
                this.s.store.put('outcome', o.id, o);
                this.revision(o, 'Established observable completion criteria', c.owner, null, o);
                return o;
              });
            }
            if (action === 'profile.configure') {
              const oldProfiles = this.profiles(c.projectId);
              const profiles = Schema.decodeUnknownSync(
                Schema.mutable(Schema.Array(profileSchema)),
              )(raw.profiles).map((profile) => {
                const old = oldProfiles.find(
                  (p) =>
                    p.id === profile.id &&
                    p.kind === profile.kind &&
                    p.model === profile.model &&
                    p.reasoning === profile.reasoning &&
                    JSON.stringify(p.supportedReasoning) ===
                      JSON.stringify(profile.supportedReasoning),
                );
                return {
                  ...profile,
                  availability: old?.availability ?? ('unverified' as const),
                  availabilityEvidence:
                    old?.availabilityEvidence ??
                    'Run profile.validate to verify this exact model on the current account',
                };
              });
              if (new Set(profiles.map((p) => p.id)).size !== profiles.length)
                fail('profile_ids', 'Profile IDs must be unique');
              for (const p of profiles)
                if (p.reasoning && !p.supportedReasoning.includes(p.reasoning))
                  fail('reasoning_unsupported', 'Default effort must be supported');
              const defaults = Schema.decodeUnknownSync(
                Schema.Record(text, Schema.mutableKey(text)),
              )(raw.defaults ?? {});
              for (const [category, id] of Object.entries(defaults))
                if (!profiles.some((p) => p.id === id && p.categories.includes(category)))
                  fail('profile_default', 'Category default does not match a configured profile');
              this.s.store.put('profiles', c.projectId, profiles);
              this.s.store.put('profile-defaults', c.projectId, defaults);
              this.s.store.event(
                c.projectId,
                'profiles.configured',
                'Updated exact model profiles and category defaults',
              );
              return { profiles, defaults };
            }
            if (action === 'limits.configure') {
              const limits = Schema.decodeUnknownSync(limitsSchema)(raw.limits),
                reason = Schema.decodeUnknownSync(text)(raw.reason);
              this.s.store.put('limits', c.projectId, limits);
              this.s.store.put('shared-limits', 'instance', {
                global: limits.global,
                providers: limits.providers,
                models: limits.models,
              });
              this.s.store.event(c.projectId, 'limits.configured', reason, undefined, limits);
              return limits;
            }
            if (action === 'plan.revise') {
              return this.reviseTask(raw, c);
            }
            if (action.startsWith('strategy.')) return this.strategy(action, raw, c);
            const o = this.outcome(Schema.decodeUnknownSync(text)(raw.outcomeId));
            this.s.cleanup.assertOutcomeMutable(o.id);
            if (o.projectId !== c.projectId) fail('project_mismatch', 'Outcome and lead differ');
            this.checkRevision(o, raw.expectedRevision);
            if (action === 'outcome.revise') {
              const criteria = Schema.decodeUnknownSync(
                  Schema.mutable(Schema.Array(criterionSchema)).check(Schema.isMinLength(1)),
                )(raw.criteria),
                reason = Schema.decodeUnknownSync(text)(raw.reason);
              if (new Set(criteria.map((c) => c.id)).size !== criteria.length)
                fail('criteria_ids', 'Criterion IDs must be unique');
              const updated: Outcome = {
                ...o,
                criteria,
                revision: o.revision + 1,
                status: 'open',
                integrated: undefined,
                updatedAt: now(),
              };
              this.s.store.put('outcome', o.id, updated);
              this.revision(updated, reason, c.owner, o, updated);
              return updated;
            }
            if (action === 'outcome.assess') {
              const criterionId = Schema.decodeUnknownSync(text)(raw.criterionId);
              if (!o.criteria.some((c) => c.id === criterionId))
                fail('criterion_missing', 'Criterion not found');
              const a: Assessment = {
                criterionId,
                rationale: Schema.decodeUnknownSync(text)(raw.rationale),
                references: this.references(o.projectId, raw.references),
                revision: o.revision,
                owner: c.owner,
                createdAt: now(),
              };
              o.assessments = [...o.assessments.filter((a) => a.criterionId !== criterionId), a];
              this.s.store.put('outcome', o.id, o);
              this.s.store.event(o.projectId, 'outcome.assessed', a.rationale);
              return a;
            }
            if (action === 'outcome.integrate') {
              o.integrated = {
                revision: o.revision,
                summary: Schema.decodeUnknownSync(text)(raw.summary),
                evidence: this.references(o.projectId, raw.references),
                owner: c.owner,
                createdAt: now(),
              };
              this.s.store.put('outcome', o.id, o);
              return o.integrated;
            }
            if (action === 'outcome.complete') {
              const unmet = this.unmet(o);
              if (unmet.length) fail('outcome_unmet', unmet.join('\n'));
              o.status = 'completed';
              o.updatedAt = now();
              this.s.store.put('outcome', o.id, o);
              this.s.store.event(o.projectId, 'outcome.completed', o.objective, undefined, {
                outcomeId: o.id,
                revision: o.revision,
              });
              return {
                outcome: o,
                satisfied: o.criteria,
                evidence: o.assessments,
                integrated: o.integrated,
                unresolved: [],
              };
            }
            throw new AppError({
              code: 'unknown_action',
              message: `Unknown action: ${action}`,
              status: 404,
            });
          }),
        );
      },
    );
  strategy(action: string, raw: any, c: Credentials) {
    const cleanupOutcome =
      raw.strategy?.outcomeId ??
      raw.outcomeId ??
      (raw.strategyId
        ? this.s.store.get<Strategy>('strategy', raw.strategyId)?.outcomeId
        : undefined);
    if (cleanupOutcome) this.s.cleanup.assertOutcomeMutable(cleanupOutcome);
    if (action === 'strategy.create') {
      const i = Schema.decodeUnknownSync(strategySchema)(raw.strategy),
        o = this.outcome(i.outcomeId);
      if (o.projectId !== c.projectId) fail('project_mismatch', 'Strategy and lead differ');
      this.checkRevision(o, raw.expectedRevision);
      if (
        new Set(i.participants).size !== i.participants.length ||
        i.participants.some((id) => this.s.task(id).outcomeId !== o.id)
      )
        fail('strategy_scope', 'Participants must be distinct tasks in this outcome');
      if ((i.quorum ?? i.participants.length) > i.participants.length)
        fail('quorum', 'Quorum exceeds participant count');
      const strategy: Strategy = {
        ...i,
        id: randomUUID(),
        projectId: c.projectId,
        revision: 1,
        round: 1,
        status: 'open',
        entries: [],
        reason: Schema.decodeUnknownSync(text)(raw.reason),
      };
      const participants = i.participants.map((id) => this.s.task(id));
      if (
        ['council', 'debate', 'competition'].includes(i.kind) &&
        participants.some((t) => t.attempt > 0 || !['queued', 'paused'].includes(t.status))
      )
        fail(
          'independent_start',
          'Create independent participants with deferStart: true, then register their strategy before starting any assessment',
        );
      const changes = participants.map((t, index) => ({
        ...t,
        strategyId: strategy.id,
        dependencies:
          i.kind === 'sequential' && index > 0
            ? [...new Set([...t.dependencies, participants[index - 1].id])]
            : t.dependencies,
        status: t.status === 'paused' && !t.runId ? ('queued' as const) : t.status,
      }));
      this.validateGraph(
        this.s.tasks(c.projectId).map((t) => changes.find((changed) => changed.id === t.id) ?? t),
      );
      for (const t of changes) this.s.store.put('task', t.id, t);
      this.s.store.put('strategy', strategy.id, strategy);
      this.changed(o.id, strategy.reason, c.owner);
      return strategy;
    }
    const strategy =
      this.s.store.get<Strategy>('strategy', Schema.decodeUnknownSync(text)(raw.strategyId)) ??
      fail('strategy_missing', 'Strategy not found');
    if (strategy.projectId !== c.projectId) fail('project_mismatch', 'Strategy and lead differ');
    if (
      (strategy.status === 'completed' && action !== 'strategy.reopen') ||
      strategy.revision !== raw.expectedRevision
    )
      fail('strategy_revision', 'Strategy completed or revision changed');
    if (action === 'strategy.contribute') {
      const taskId = Schema.decodeUnknownSync(text)(raw.taskId),
        task = this.s.task(taskId);
      if (!strategy.participants.includes(taskId) || task.status !== 'completed')
        fail('strategy_evidence', 'A contribution requires a verified participant result');
      if (
        strategy.entries.some(
          (e) =>
            e.taskId === taskId && e.round === strategy.round && e.taskRevision === task.revision,
        )
      )
        fail('duplicate_contribution', 'Participant already contributed this round');
      if (
        strategy.round > 1 &&
        strategy.entries.some(
          (e) =>
            e.taskId === taskId && e.round < strategy.round && e.taskRevision === task.revision,
        )
      )
        fail(
          'new_assessment_required',
          'A new discussion round requires a fresh verified participant revision',
        );
      strategy.entries = strategy.entries.filter(
        (e) => !(e.taskId === taskId && e.round === strategy.round),
      );
      strategy.entries.push({
        taskId,
        taskRevision: task.revision,
        round: strategy.round,
        claim: Schema.decodeUnknownSync(text)(raw.claim),
        evidence: Schema.decodeUnknownSync(
          Schema.mutable(Schema.Array(text)).check(Schema.isMinLength(1)),
        )(raw.evidence),
        rebuttal: Schema.decodeUnknownSync(Schema.optional(Schema.String))(raw.rebuttal),
      });
    } else if (action === 'strategy.reopen') {
      strategy.status = 'open';
      strategy.reason = Schema.decodeUnknownSync(text)(raw.reason);
      strategy.synthesis = undefined;
      this.changed(strategy.outcomeId, strategy.reason, c.owner);
    } else if (action === 'strategy.advance') {
      if (strategy.round >= strategy.maxRounds)
        fail('round_limit', 'Stop condition reached; synthesize the bounded discussion');
      if (
        strategy.entries.filter(
          (e) =>
            e.round === strategy.round &&
            this.s.task(e.taskId).status === 'completed' &&
            e.taskRevision === this.s.task(e.taskId).revision,
        ).length < (strategy.quorum ?? strategy.participants.length)
      )
        fail('quorum', 'Current round has not reached quorum');
      strategy.round++;
    } else if (action === 'strategy.finish') {
      if (
        strategy.entries.filter(
          (e) =>
            e.round === strategy.round &&
            this.s.task(e.taskId).status === 'completed' &&
            e.taskRevision === this.s.task(e.taskId).revision,
        ).length < (strategy.quorum ?? strategy.participants.length)
      )
        fail('quorum', 'Cannot synthesize before quorum');
      strategy.synthesis = Schema.decodeUnknownSync(text)(raw.synthesis);
      strategy.disagreements = Schema.decodeUnknownSync(Schema.mutable(Schema.Array(text)))(
        raw.disagreements,
      );
      strategy.status = 'completed';
    } else fail('unknown_action', 'Unknown strategy operation');
    strategy.revision++;
    this.s.store.put('strategy', strategy.id, strategy);
    this.s.store.event(
      c.projectId,
      action,
      strategy.synthesis ?? `Round ${strategy.round}`,
      undefined,
      { strategyId: strategy.id },
    );
    return strategy;
  }
}
