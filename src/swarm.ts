import { Effect, Schema } from 'effect';
import { randomUUID } from 'node:crypto';
import { sync } from './effect-runtime.js';
import { inside, safePath } from './files.js';
import { execEffect } from './process.js';
import { recipes } from './recipes.js';
import type { Outcome } from './orchestration-types.js';
import type { Service } from './service.js';
import { SwarmRuntime } from './swarm-runtime.js';
import {
  swarmRequestSchema,
  type Intent,
  type Message,
  type SwarmDecision,
  type SwarmRequest,
  type Experiment,
  type Watch,
  type Activity,
} from './swarm-types.js';
import { AppError, now, type Credentials, type Task, type Run } from './types.js';

const terminal = new Set(['completed', 'cancelled', 'failed']);
function fail(code: string, message: string): never {
  throw new AppError({ code, message, status: 409 });
}

/** General coordination records share the existing transaction, lease and evidence boundaries. */
export class Swarm {
  runtime: SwarmRuntime;
  constructor(private s: Service) {
    this.runtime = new SwarmRuntime(s);
  }

  intent(outcomeId: string): Intent {
    const o = this.s.orchestration.outcome(outcomeId);
    return (
      this.s.store.get<Intent>('swarm-intent', o.id) ?? {
        outcomeId: o.id,
        projectId: o.projectId,
        original: o.originalRequest ?? o.objective,
        originalSource: o.requestSource ?? `Outcome established by ${o.leadOwner}`,
        version: 1,
        amendments: [],
      }
    );
  }
  captureIntent(o: Outcome) {
    if (!this.s.store.get('swarm-intent', o.id))
      this.s.store.put<Intent>('swarm-intent', o.id, {
        outcomeId: o.id,
        projectId: o.projectId,
        original: o.originalRequest ?? o.objective,
        originalSource: o.requestSource ?? `Outcome established by ${o.leadOwner}`,
        version: 1,
        amendments: [],
      });
  }
  messages(taskId: string) {
    return this.s.store.all<Message>('swarm-message').filter((m) => m.taskId === taskId);
  }
  decisions(outcomeId: string) {
    return this.s.store
      .all<SwarmDecision>('swarm-decision')
      .filter((d) => d.outcomeId === outcomeId);
  }
  context(t: Task) {
    return {
      intent: t.outcomeId ? this.intent(t.outcomeId) : null,
      implementationGuidance: t.prompt,
      writablePaths: t.retainedOwnership ?? t.ownership,
      concurrentChildren: t.concurrentChildren ?? [],
      instructions: this.messages(t.id).filter((m) => !m.acknowledgedAt),
      decisions: t.outcomeId
        ? this.decisions(t.outcomeId).filter(
            (d) => !d.resolution && (!d.taskId || d.taskId === t.id),
          )
        : [],
      delivery: t.outcomeId ? (this.s.store.get('swarm-delivery', t.outcomeId) ?? null) : null,
      recipes: recipes.map(({ name, trigger }) => ({ name, trigger })),
    };
  }
  unmetTask(t: Task): string[] {
    return this.messages(t.id)
      .filter((m) => m.required && !m.acknowledgedAt)
      .map((m) => `Instruction ${m.id} has not been acknowledged`);
  }
  references(outcomeId: string) {
    return [
      ...this.s.store
        .all<Message>('swarm-message')
        .filter((m) => m.outcomeId === outcomeId)
        .flatMap((m) => m.references),
      ...this.s.store
        .all<Experiment>('swarm-experiment')
        .filter((e) => e.outcomeId === outcomeId)
        .flatMap((e) => e.selection?.references ?? []),
      ...this.s.store
        .all<{ outcomeId: string; references: { path: string; digest: string }[] }>(
          'swarm-evaluation',
        )
        .filter((e) => e.outcomeId === outcomeId)
        .flatMap((e) => e.references),
    ].filter((ref) =>
      this.s.orchestration.evidenceCurrent(
        [ref],
        this.s.orchestration.outcome(outcomeId).projectId,
      ),
    );
  }
  unmet(outcomeId: string): string[] {
    return this.decisions(outcomeId)
      .filter((d) => d.blocking && !d.resolution)
      .map((d) => `Unresolved decision ${d.id}: ${d.text}`);
  }
  private outcome(outcomeId: string, c: Credentials) {
    const o = this.s.orchestration.outcome(outcomeId);
    if (o.projectId !== c.projectId) fail('project_mismatch', 'Outcome belongs to another project');
    this.s.cleanup.assertOutcomeMutable(o.id);
    return o;
  }
  private task(taskId: string, c: Credentials, outcomeId?: string) {
    const t = this.s.task(taskId);
    if (t.projectId !== c.projectId || (outcomeId && t.outcomeId !== outcomeId))
      fail('task_scope', 'Task does not belong to the selected objective');
    this.s.cleanup.assertMutable(t);
    return t;
  }
  private checkRevision(o: Outcome, expected: number) {
    if (o.revision !== expected)
      fail(
        'stale_revision',
        `Outcome ${o.id} is at revision ${o.revision}; refresh intent.get or outcome.get before retrying`,
      );
  }
  private send(
    c: Credentials,
    outcomeId: string,
    taskIds: readonly string[],
    text: string,
    required = true,
    references: string[] = [],
    intentVersion?: number,
  ) {
    const evidence = references.length
      ? this.s.orchestration.references(c.projectId, references)
      : [];
    return [...new Set(taskIds)].map((taskId) => {
      const t = this.task(taskId, c, outcomeId);
      if (terminal.has(t.status))
        fail('task_settled', `Task ${taskId} is ${t.status}; revise or resume it before steering`);
      if (required && t.receipt) {
        this.s.updateTask(
          t,
          {
            revision: t.revision + 1,
            receipt: undefined,
            verification: undefined,
            status: t.status === 'verifying' ? 'running' : t.status,
          },
          'New instructions require current completion evidence',
        );
        this.s.orchestration.changed(
          outcomeId,
          'Required steering after a completion report',
          c.owner,
          this.s.task(t.id),
          t,
        );
      }
      const m: Message = {
        id: randomUUID(),
        projectId: c.projectId,
        outcomeId,
        from: c.owner,
        taskId,
        text,
        references: evidence,
        required,
        intentVersion,
        createdAt: now(),
      };
      this.s.store.put('swarm-message', m.id, m);
      this.s.store.event(c.projectId, 'swarm.message', text, taskId, {
        messageId: m.id,
        outcomeId,
      });
      return m;
    });
  }
  private dispatch(
    i: Extract<SwarmRequest, { action: 'dispatch' | 'experiment.create' }>,
    c: Credentials,
    baseCommit?: string,
  ) {
    const o = this.outcome(i.outcomeId, c);
    this.checkRevision(o, i.expectedRevision);
    const keys = new Set(i.entries.map((e) => e.assignment.key));
    if (keys.size !== i.entries.length)
      fail('duplicate_key', 'Each batch assignment needs a distinct key');
    const remaining = [...i.entries];
    const tasks: Task[] = [];
    const submitted = new Map<string, string>();
    while (remaining.length) {
      const index = remaining.findIndex((e) => (e.dependsOn ?? []).every((k) => submitted.has(k)));
      if (index < 0)
        fail('batch_dependencies', 'Batch dependencies contain a cycle or unknown assignment key');
      const e = remaining.splice(index, 1)[0];
      if (
        e.assignment.projectId !== c.projectId ||
        (e.assignment.outcomeId && e.assignment.outcomeId !== o.id)
      )
        fail('task_scope', 'Every batch entry must belong to the selected objective');
      if (i.action === 'experiment.create' && e.assignment.parentId)
        fail('experiment_scope', 'Experiment candidates must be independent root assignments');
      const assignment = {
        ...e.assignment,
        outcomeId: o.id,
        expectedTreeRevision: this.s.orchestration.outcome(o.id).revision,
        dependencies: [
          ...e.assignment.dependencies,
          ...(e.dependsOn ?? []).map((k) => submitted.get(k)!),
        ],
      };
      if (i.action === 'experiment.create') {
        assignment.execution = {
          mode: 'worktree',
          baseRef: baseCommit,
        };
        assignment.checks = i.checks;
        // Selection decides which candidate is required. Failed alternatives do not falsely count as success.
        assignment.required = false;
      }
      const t = this.s.submitAssignment(assignment, c);
      submitted.set(e.assignment.key, t.id);
      tasks.push(t);
    }
    if (i.action === 'experiment.create') {
      const experiment: Experiment = {
        id: randomUUID(),
        projectId: c.projectId,
        outcomeId: o.id,
        criteria: i.criteria,
        checks: i.checks,
        taskIds: tasks.map((t) => t.id),
        createdAt: now(),
      };
      this.s.store.put('swarm-experiment', experiment.id, experiment);
      this.s.store.event(c.projectId, 'swarm.experiment', i.criteria, undefined, {
        outcomeId: o.id,
        experimentId: experiment.id,
      });
      return { experiment, tasks, treeRevision: this.s.orchestration.outcome(o.id).revision };
    }
    return { tasks, treeRevision: this.s.orchestration.outcome(o.id).revision };
  }
  compare(experimentId: string) {
    const e = this.s.store.get<Experiment>('swarm-experiment', experimentId);
    if (!e) fail('not_found', 'Experiment not found');
    const candidates = e.taskIds.map((id) => {
      const t = this.s.task(id);
      return {
        taskId: id,
        title: t.title,
        revision: t.revision,
        status: t.status,
        current: this.s.orchestration.taskCurrent(t),
        verification: t.verification ?? [],
        receipt: t.receipt ?? null,
        worktree: t.worktree ?? null,
      };
    });
    return {
      ...e,
      candidates,
      selectionCurrent:
        !!e.selection &&
        e.selection.outcomeRevision === this.s.orchestration.outcome(e.outcomeId).revision &&
        candidates.every((t) => t.revision === e.selection?.taskRevisions[t.taskId]) &&
        this.s.orchestration.evidenceCurrent(e.selection.references, e.projectId),
    };
  }
  observe(projectId: string, after = 0) {
    this.s.project(projectId);
    const events = this.s.store.events(projectId, after, 200);
    const outcomes = this.s.orchestration.outcomes(projectId);
    return {
      observedAt: now(),
      cursor: events.at(-1)?.id ?? after,
      hasMore: events.length === 200,
      changes: events,
      objectives: outcomes.map((o) => ({
        id: o.id,
        objective: o.objective,
        revision: o.revision,
        status: o.status,
        intentVersion: this.intent(o.id).version,
      })),
      decisions: outcomes.flatMap((o) => this.decisions(o.id).filter((d) => !d.resolution)),
      tasks: this.s.tasks(projectId).map((t) => ({
        id: t.id,
        outcomeId: t.outcomeId,
        title: t.title,
        status: t.status,
        revision: t.revision,
        waitingFor: t.waitReason,
        observation: this.runtime.observation(t),
        pendingInstructions: this.messages(t.id)
          .filter((m) => !m.acknowledgedAt)
          .map((m) => m.id),
      })),
      watches: this.s.store.all<Watch>('swarm-watch').filter((w) => w.projectId === projectId),
      supervision: this.runtime.health(projectId),
      capacity: this.runtime.capacitySnapshot(projectId),
    };
  }
  trajectory(outcomeId: string, after = 0) {
    const o = this.s.orchestration.outcome(outcomeId);
    const tasks = this.s.tasks(o.projectId).filter((t) => t.outcomeId === o.id);
    const ids = new Set(tasks.map((t) => t.id));
    const page = this.s.store.events(o.projectId, after, 500);
    const events = page.filter(
      (e) =>
        ids.has(e.taskId ?? '') ||
        Schema.is(Schema.Struct({ outcomeId: Schema.Literal(o.id) }))(e.data),
    );
    return {
      schemaVersion: 1,
      outcome: o,
      intent: this.intent(o.id),
      tasks: tasks.map(({ output: _output, ...t }) => t),
      runs: this.s.store
        .all<Run>('run')
        .filter((r) => ids.has(r.taskId))
        .map(({ tokenHash: _tokenHash, ...r }) => r),
      messages: tasks.flatMap((t) => this.messages(t.id)),
      decisions: this.decisions(o.id),
      experiments: this.s.store
        .all<Experiment>('swarm-experiment')
        .filter((e) => e.outcomeId === o.id),
      watches: this.s.store.all<Watch>('swarm-watch').filter((w) => w.outcomeId === o.id),
      delivery: this.s.store.get('swarm-delivery', o.id) ?? null,
      revisions: this.s.store
        .all<{ outcomeId: string }>('revision')
        .filter((r) => r.outcomeId === o.id),
      findings: this.s.store
        .all<{ outcomeId: string }>('finding')
        .filter((r) => r.outcomeId === o.id),
      events,
      nextCursor: page.at(-1)?.id ?? after,
      hasMore: page.length === 500,
      usage: this.s.store.all<{ outcomeId: string }>('usage').filter((u) => u.outcomeId === o.id),
      evaluations: this.s.store
        .all<{ outcomeId: string }>('swarm-evaluation')
        .filter((e) => e.outcomeId === o.id),
      metricBoundary:
        'Usage may be unavailable. Evaluation success is an attributed assessment supported by evidence, not a model-independent guarantee.',
    };
  }
  invokeEffect = Effect.fn('Swarm.invoke')(
    { self: this },
    function* (this: Swarm, action: string, raw: any) {
      const i = yield* sync('Swarm.decode', () =>
        Schema.decodeUnknownSync(swarmRequestSchema)({
          ...raw,
          action: action.slice('swarm.'.length),
        }),
      );
      if (i.action === 'intent.get')
        return yield* sync('Swarm.read', () => ({
          ...this.intent(i.outcomeId),
          outcomeRevision: this.s.orchestration.outcome(i.outcomeId).revision,
        }));
      if (i.action === 'observe')
        return yield* sync('Swarm.read', () => this.observe(i.projectId, i.after));
      if (i.action === 'trajectory')
        return yield* sync('Swarm.read', () => this.trajectory(i.outcomeId, i.after));
      if (i.action === 'experiment.compare')
        return yield* sync('Swarm.read', () => this.compare(i.experimentId));
      if (i.action === 'recipe.get')
        return yield* sync('Swarm.read', () => {
          const r = recipes.find((r) => r.name === i.name);
          if (!r)
            fail('recipe_missing', `Available recipes: ${recipes.map((r) => r.name).join(', ')}`);
          return r;
        });
      const c = yield* sync('Swarm.authorize', () => this.s.guard(raw.lease));
      if (
        'key' in i &&
        this.s.store.get('idempotency', `${c.projectId}:swarm:${i.action}:${i.key}`)
      )
        return yield* sync('Swarm.replay', () =>
          this.s.idempotent(c.projectId, `swarm:${i.action}:${i.key}`, i, () =>
            fail('missing_record', 'Expected saved operation'),
          ),
        );
      let baseCommit: string | undefined;
      if (i.action === 'experiment.create') {
        const refs = new Set(
          i.entries.map((e) =>
            e.assignment.execution?.mode === 'worktree'
              ? (e.assignment.execution.baseRef ?? 'HEAD')
              : 'HEAD',
          ),
        );
        if (refs.size !== 1)
          return yield* sync('Swarm.base', () =>
            fail('experiment_base', 'All candidates must start from the same base ref'),
          );
        const ref = [...refs][0];
        const result = yield* execEffect(
          'git',
          ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
          { cwd: this.s.project(c.projectId).root },
        );
        baseCommit = result.stdout.trim();
      }
      return yield* sync('Swarm.transaction', () => {
        this.s.guard(raw.lease);
        return this.s.store.transaction(() => {
          if ('key' in i)
            return this.s.idempotent(c.projectId, `swarm:${i.action}:${i.key}`, i, () =>
              this.mutate(i, c, baseCommit),
            );
          return this.mutate(i, c, baseCommit);
        });
      });
    },
  );
  private mutate(i: SwarmRequest, c: Credentials, baseCommit?: string): any {
    if (i.action === 'dispatch' || i.action === 'experiment.create')
      return this.dispatch(i, c, baseCommit);
    if (i.action === 'intent.amend') {
      const o = this.outcome(i.outcomeId, c);
      this.checkRevision(o, i.expectedRevision);
      const intent = this.intent(o.id);
      const tasks = i.taskIds
        ? [...new Set(i.taskIds)].map((id) => this.task(id, c, o.id))
        : this.s
            .tasks(c.projectId)
            .filter((t) => t.outcomeId === o.id && !['cancelled', 'failed'].includes(t.status));
      for (const t of tasks) this.s.cleanup.assertMutable(t);
      const amendment = {
        id: randomUUID(),
        version: intent.version + 1,
        text: i.text,
        source: i.source,
        createdAt: now(),
        taskIds: tasks.map((t) => t.id),
      };
      const updated = {
        ...intent,
        version: amendment.version,
        amendments: [...intent.amendments, amendment],
      };
      this.s.store.put('swarm-intent', o.id, updated);
      this.s.store.put('outcome', o.id, { ...o, objective: i.objective ?? o.objective });
      this.s.orchestration.changed(o.id, `User intent amended: ${i.text}`, c.owner);
      for (const old of tasks) {
        const t = this.s.task(old.id);
        this.s.updateTask(
          t,
          {
            revision: t.revision + 1,
            receipt: undefined,
            verification: undefined,
            status: ['completed', 'verifying'].includes(t.status) ? 'paused' : t.status,
          },
          'User intent changed; current evidence and instruction acknowledgement required',
        );
        this.s.orchestration.changed(
          o.id,
          `Amendment ${amendment.id}`,
          c.owner,
          this.s.task(t.id),
          t,
        );
      }
      const messages = tasks.length
        ? this.send(
            c,
            o.id,
            tasks.map((t) => t.id),
            i.text,
            true,
            [],
            amendment.version,
          )
        : [];
      return {
        intent: updated,
        amendment,
        messages,
        treeRevision: this.s.orchestration.outcome(o.id).revision,
      };
    }
    if (i.action === 'message.send') {
      this.outcome(i.outcomeId, c);
      return {
        messages: this.send(c, i.outcomeId, i.taskIds, i.text, i.required ?? true, i.references),
      };
    }
    if (i.action === 'decision.open') {
      this.outcome(i.outcomeId, c);
      if (i.taskId) this.task(i.taskId, c, i.outcomeId);
      const d: SwarmDecision = {
        id: randomUUID(),
        projectId: c.projectId,
        outcomeId: i.outcomeId,
        taskId: i.taskId,
        text: i.text,
        options: i.options,
        source: i.source,
        blocking: i.blocking ?? true,
        revision: 1,
        createdAt: now(),
      };
      this.s.store.put('swarm-decision', d.id, d);
      this.s.orchestration.changed(d.outcomeId, `Decision opened: ${d.text}`, c.owner);
      this.s.store.event(c.projectId, 'swarm.decision', d.text, d.taskId, {
        outcomeId: d.outcomeId,
        decisionId: d.id,
      });
      return d;
    }
    if (i.action === 'decision.resolve') {
      const d = this.s.store.get<SwarmDecision>('swarm-decision', i.decisionId);
      if (!d || d.projectId !== c.projectId)
        fail('decision_scope', 'Decision not found in this project');
      this.outcome(d.outcomeId, c);
      if (d.revision !== i.expectedRevision)
        fail('stale_revision', `Decision is at revision ${d.revision}`);
      if (d.resolution) fail('decision_resolved', 'Decision is already resolved');
      const updated = {
        ...d,
        revision: d.revision + 1,
        resolution: i.resolution,
        answer: i.answer,
        answerSource: i.source,
        resolvedAt: now(),
      };
      this.s.store.put('swarm-decision', d.id, updated);
      this.s.store.event(c.projectId, 'swarm.decision-resolved', i.answer, d.taskId, {
        outcomeId: d.outcomeId,
        decisionId: d.id,
      });
      return updated;
    }
    if (i.action === 'ownership.transfer') {
      const t = this.task(i.taskId, c);
      if (t.revision !== i.expectedRevision)
        fail('stale_revision', `Task is at revision ${t.revision}`);
      if (!['paused', 'waiting', 'queued'].includes(t.status))
        fail('task_active', 'Pause and settle the coordinator before transferring writable paths');
      if (t.runId) {
        const run = this.s.store.get<Run>('run', t.runId);
        if (!run?.settledAt || !['idle', 'done'].includes(run.lastStatus ?? ''))
          fail('task_active', 'Coordinator has not been observed settled');
      }
      const children = [...new Set(i.childIds)].map((id) => this.task(id, c, t.outcomeId));
      if (
        !t.canDelegate ||
        children.some(
          (child) =>
            child.parentId !== t.id || !['queued', 'paused', 'waiting'].includes(child.status),
        )
      )
        fail('child_scope', 'Transfer requires settled direct children of a coordinator');
      const retained = i.retainedOwnership.map((p) => safePath(t.cwd, p));
      if (retained.some((p) => !t.ownership.some((owned) => inside(safePath(t.cwd, owned), p))))
        fail('ownership_scope', 'Retained paths must stay inside the original assignment');
      for (const child of this.s
        .tasks(c.projectId)
        .filter((child) => child.parentId === t.id && !terminal.has(child.status)))
        for (const owned of child.ownership) {
          const p = safePath(child.cwd, owned);
          if (retained.some((q) => inside(p, q) || inside(q, p)))
            fail(
              'ownership_overlap',
              'Retained paths overlap child ownership; enumerate disjoint paths instead of a parent directory',
            );
        }
      const updated = this.s.updateTask(
        t,
        {
          retainedOwnership: [...i.retainedOwnership],
          concurrentChildren: [...new Set([...(t.concurrentChildren ?? []), ...i.childIds])],
          revision: t.revision + 1,
          receipt: undefined,
          verification: undefined,
        },
        i.reason,
      );
      if (t.outcomeId) this.s.orchestration.changed(t.outcomeId, i.reason, c.owner, updated, t);
      return {
        task: updated,
        treeRevision: t.outcomeId ? this.s.orchestration.outcome(t.outcomeId).revision : null,
        nextAction:
          'Resume the coordinator and any paused children through task.control; each reads its current writable paths with worker_inspect.',
      };
    }
    if (i.action === 'capacity.configure' || i.action === 'capacity.feedback')
      return this.runtime.configure(i, c);
    if (i.action === 'watch.create') {
      this.outcome(i.outcomeId, c);
      if (i.taskId) this.task(i.taskId, c, i.outcomeId);
      if (i.condition.type === 'file') safePath(this.s.project(c.projectId).root, i.condition.path);
      const w: Watch = {
        id: randomUUID(),
        projectId: c.projectId,
        outcomeId: i.outcomeId,
        taskId: i.taskId,
        condition: i.condition,
        description: i.description,
        intervalMs: i.intervalMs,
        nextAt: Date.now(),
        state: 'waiting',
        createdAt: now(),
      };
      this.s.store.put('swarm-watch', w.id, w);
      this.s.store.event(c.projectId, 'swarm.watch-created', i.description, i.taskId, {
        outcomeId: i.outcomeId,
        watchId: w.id,
      });
      return w;
    }
    if (i.action === 'watch.ack' || i.action === 'watch.cancel') {
      const w = this.s.store.get<Watch>('swarm-watch', i.watchId);
      if (!w || w.projectId !== c.projectId)
        fail('watch_scope', 'Watch does not belong to this project');
      this.outcome(w.outcomeId, c);
      if (
        i.action === 'watch.ack' &&
        (!w.result ||
          w.result.id !== i.resultId ||
          !['ready', 'failed', 'acknowledged'].includes(w.state))
      )
        fail('watch_result', 'Acknowledge the exact captured result');
      const updated: Watch = {
        ...w,
        state: i.action === 'watch.ack' ? 'acknowledged' : 'cancelled',
      };
      this.s.store.put('swarm-watch', w.id, updated);
      this.s.store.event(
        c.projectId,
        `swarm.${i.action}`,
        i.action === 'watch.cancel' ? i.reason : 'External result acknowledged',
        w.taskId,
        { outcomeId: w.outcomeId, watchId: w.id },
      );
      return updated;
    }
    if (i.action === 'experiment.select') {
      const e = this.compare(i.experimentId);
      const o = this.outcome(e.outcomeId, c);
      this.checkRevision(o, i.expectedRevision);
      if (!e.taskIds.includes(i.taskId) || !this.s.orchestration.taskCurrent(this.s.task(i.taskId)))
        fail('experiment_unverified', 'Select a candidate with current verified completion');
      const references = this.s.orchestration.references(c.projectId, i.references);
      const task = this.s.task(i.taskId);
      this.s.cleanup.assertMutable(task);
      if (e.selection && e.selection.taskId !== task.id) {
        const previous = this.task(e.selection.taskId, c, e.outcomeId);
        this.s.updateTask(
          previous,
          { required: false },
          'Experiment selection superseded explicitly',
        );
      }
      this.s.updateTask(
        task,
        { required: true },
        'Selected experiment candidate; integrated review still required',
      );
      this.s.orchestration.changed(o.id, i.rationale, c.owner);
      const selection: NonNullable<Experiment['selection']> = {
        taskId: i.taskId,
        rationale: i.rationale,
        references,
        outcomeRevision: this.s.orchestration.outcome(o.id).revision,
        taskRevisions: Object.fromEntries(e.taskIds.map((id) => [id, this.s.task(id).revision])),
      };
      this.s.store.put<Experiment>('swarm-experiment', e.id, {
        id: e.id,
        projectId: e.projectId,
        outcomeId: e.outcomeId,
        criteria: e.criteria,
        taskIds: e.taskIds,
        checks: e.checks,
        createdAt: e.createdAt,
        selection,
      });
      return this.compare(e.id);
    }
    if (i.action === 'delivery.configure') {
      const o = this.outcome(i.outcomeId, c);
      this.checkRevision(o, i.expectedRevision);
      const record = { ...i, projectId: c.projectId, owner: c.owner, recordedAt: now() };
      this.s.store.put('swarm-delivery', o.id, record);
      this.s.orchestration.changed(o.id, 'Delivery expectations updated', c.owner);
      return {
        ...record,
        treeRevision: this.s.orchestration.outcome(o.id).revision,
        boundary:
          'Records instructions and authorization provenance; performs no Git or publication operation.',
      };
    }
    if (i.action === 'evaluation.record') {
      const o = this.outcome(i.outcomeId, c);
      this.checkRevision(o, i.expectedRevision);
      if (i.success && (o.status !== 'completed' || this.s.orchestration.unmet(o).length))
        fail(
          'evaluation_unverified',
          'Successful evaluations require current integrated outcome completion',
        );
      const references = this.s.orchestration.references(c.projectId, i.references);
      const record = {
        ...i,
        id: randomUUID(),
        projectId: c.projectId,
        evaluator: c.owner,
        references,
        recordedAt: now(),
        elapsedMs: Date.now() - Date.parse(o.createdAt),
        turns: o.turnsUsed,
      };
      this.s.store.put('swarm-evaluation', record.id, record);
      this.s.store.event(c.projectId, 'swarm.evaluation', i.notes, undefined, {
        outcomeId: o.id,
        evaluationId: record.id,
      });
      return record;
    }
    return fail('unknown_action', 'Unsupported mutation');
  }
  worker(t: Task, raw: any) {
    const actor: Credentials = {
      projectId: t.projectId,
      owner: `worker:${t.id}`,
      epoch: 0,
      token: '',
    };
    if (raw.action === 'message.ack') {
      const i = Schema.decodeUnknownSync(Schema.Struct({ messageId: Schema.String }))(raw);
      const m = this.s.store.get<Message>('swarm-message', i.messageId);
      if (!m || m.taskId !== t.id)
        fail('message_scope', 'Only the recipient may acknowledge an instruction');
      if (m.acknowledgedAt) return m;
      const updated = {
        ...m,
        acknowledgedAt: now(),
        acknowledgedRunId: t.runId,
        acknowledgedRevision: t.revision,
      };
      this.s.store.put('swarm-message', m.id, updated);
      this.s.store.event(t.projectId, 'swarm.message-ack', 'Worker accepted instruction', t.id, {
        outcomeId: t.outcomeId,
        messageId: m.id,
      });
      return updated;
    }
    if (raw.action === 'message.send') {
      const i = Schema.decodeUnknownSync(
        Schema.Struct({
          key: Schema.String,
          taskId: Schema.String,
          text: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(20000)),
          references: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
        }),
      )(raw);
      const target = this.s.task(i.taskId);
      if (
        target.id !== t.parentId &&
        !(
          t.canDelegate &&
          this.s.orchestration.descendants(t.id).some((child) => child.id === target.id)
        )
      )
        fail('message_scope', 'Workers may message their parent or authorized descendants');
      return this.s.idempotent(t.projectId, `worker-message:${t.id}:${i.key}`, i, () =>
        this.send(actor, t.outcomeId!, [i.taskId], i.text, false, i.references),
      );
    }
    if (raw.action === 'activity') {
      const i = Schema.decodeUnknownSync(
        Schema.Struct({
          state: Schema.Literals(['busy', 'idle', 'external-wait']),
          detail: Schema.String.check(Schema.isMinLength(1)),
          until: Schema.optionalKey(Schema.Finite),
        }),
      )(raw);
      if (i.until !== undefined && (i.until <= Date.now() || i.until > Date.now() + 7 * 86400000))
        fail(
          'wait_time',
          'External wait until must be a future Unix millisecond timestamp within seven days',
        );
      const activity: Activity = {
        taskId: t.id,
        runId: t.runId!,
        state: i.state,
        detail: i.detail,
        until: i.until,
        observedAt: Date.now(),
        source: 'worker-report',
      };
      this.s.store.put('swarm-activity', t.id, activity);
      return activity;
    }
    if (raw.action === 'decision.open') {
      const i = Schema.decodeUnknownSync(swarmRequestSchema)({
        ...raw,
        action: 'decision.open',
        outcomeId: t.outcomeId,
        taskId: t.id,
        source: `worker:${t.id}`,
      });
      return this.s.idempotent(t.projectId, `worker-decision:${t.id}:${raw.key}`, i, () =>
        this.mutate(i, actor),
      );
    }
    return fail('worker_action', 'Unsupported swarm worker action');
  }
}
