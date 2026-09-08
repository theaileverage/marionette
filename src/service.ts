import { Effect, Schema } from 'effect';
import { randomBytes, randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { Cleanup } from './cleanup.js';
import { Continuation } from './continuation.js';
import { BoundaryError, herdrCall, sync } from './effect-runtime.js';
import { hash, inside, safePath } from './files.js';
import { Herdr } from './herdr.js';
import { Orchestration } from './orchestration.js';
import { Store } from './store.js';
import {
  AppError,
  assignmentSchema,
  checkSchema,
  credentialsSchema,
  kindSchema,
  leadAgentSchema,
  now,
  type Credentials,
  type Decision,
  type HerdrPort,
  type Lead,
  type Operation,
  type Project,
  type Question,
  type Run,
  type Task,
} from './types.js';
export const terminalStates = new Set(['completed', 'cancelled', 'failed']);
const reportSchema = Schema.Struct({
  revision: Schema.mutableKey(Schema.Finite.check(Schema.isInt())),
  type: Schema.mutableKey(Schema.Literals(['progress', 'blocked', 'complete', 'failure', 'yield'])),
  summary: Schema.mutableKey(
    Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(20000)),
  ),
  children: Schema.mutableKey(Schema.optional(Schema.mutable(Schema.Array(Schema.String)))),
  artifacts: Schema.mutableKey(
    Schema.mutable(Schema.Array(Schema.String)).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
    ),
  ),
  evidence: Schema.mutableKey(
    Schema.mutable(Schema.Array(Schema.String)).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
    ),
  ),
});
export class Service {
  orchestration = new Orchestration(this);
  continuation = new Continuation(this);
  cleanup = new Cleanup(this);
  constructor(
    public store: Store,
    public port: (project: Project) => HerdrPort = (p) => new Herdr(p.socketPath),
  ) {
    this.orchestration.migrateLegacyTasks();
  }
  project(id: string) {
    const p = this.store.get<Project>('project', id);
    if (!p) throw new AppError({ code: 'not_found', message: 'Project not found', status: 404 });
    return p;
  }
  task(id: string) {
    const t = this.store.get<Task>('task', id);
    if (!t) throw new AppError({ code: 'not_found', message: 'Task not found', status: 404 });
    return t;
  }
  guard(raw: Schema.Codec.Encoded<typeof credentialsSchema>): Credentials {
    const c = Schema.decodeSync(credentialsSchema)(raw),
      lead = this.store.get<Lead>('lead', c.projectId);
    if (
      !lead ||
      lead.owner !== c.owner ||
      lead.epoch !== c.epoch ||
      lead.tokenHash !== hash(c.token)
    )
      throw new AppError({
        code: 'stale_lead',
        message:
          'Control belongs to another lead. Fetch a briefing and explicitly acquire or hand over control.',
        status: 409,
      });
    return c;
  }
  publicLead(projectId: string) {
    const l = this.store.get<Lead>('lead', projectId);
    if (!l) return null;
    const { tokenHash: _tokenHash, ...rest } = l;
    return rest;
  }
  tasks(projectId: string) {
    return this.store.all<Task>('task').filter((t) => t.projectId === projectId);
  }
  briefing(projectId: string, compact = true) {
    const project = this.project(projectId),
      tasks = this.tasks(projectId).map((t) =>
        compact
          ? {
              ...t,
              output: '',
              prompt: t.prompt.slice(0, 800),
              receipt: t.receipt
                ? { ...t.receipt, summary: t.receipt.summary.slice(0, 1000) }
                : undefined,
            }
          : t,
      );
    return {
      project,
      cleanupPolicy: this.cleanup.policy(projectId),
      lead: this.publicLead(projectId),
      ...this.orchestration.board(projectId),
      tasks,
      ...this.continuation.briefing(projectId),
      decisions: this.store.all<Decision>('decision').filter((d) => d.projectId === projectId),
      eventCursor:
        Schema.decodeUnknownSync(Schema.Struct({ id: Schema.NullOr(Schema.Finite) }))(
          this.store.db
            .prepare('SELECT MAX(id) AS id FROM events WHERE project_id=?')
            .get(projectId),
        ).id ?? 0,
      questions: this.store.all<Question>('question').filter((q) => q.projectId === projectId),
      operations: this.store
        .all<Operation>('operation')
        .filter((o) => o.projectId === projectId && o.phase !== 'done'),
      notificationBoundary:
        'Worker events are persisted here and in the MCP inbox. An idle Codex desktop conversation is not automatically awakened.',
      generatedAt: now(),
    };
  }
  updateTask(task: Task, patch: Partial<Task>, event?: string) {
    // Merge onto the current row: worker reports and lead commands can arrive while
    // the supervisor is awaiting Herdr I/O. A stale output snapshot must not roll
    // back an accepted redirect, completion report, or control revision.
    const updated = { ...this.task(task.id), ...patch, updatedAt: now() };
    this.store.put('task', task.id, updated);
    if (event) this.store.event(task.projectId, 'task.' + updated.status, event, task.id);
    return updated;
  }
  ask(task: Task, text: string, native = false) {
    const existing = this.store
      .all<Question>('question')
      .find((q) => q.taskId === task.id && !q.answeredAt && q.text === text);
    if (existing) return existing;
    const q: Question = {
      id: randomUUID(),
      projectId: task.projectId,
      taskId: task.id,
      text,
      native,
      createdAt: now(),
    };
    this.store.put('question', q.id, q);
    this.store.event(task.projectId, 'question.opened', text, task.id, { questionId: q.id });
    return q;
  }
  idempotent<T, P>(projectId: string, key: string, payload: P, fn: () => T): T {
    const id = projectId + ':' + key,
      fingerprint = hash(JSON.stringify(payload));
    const old = this.store.get<{
      fingerprint: string;
      result: T;
    }>('idempotency', id);
    if (old) {
      if (old.fingerprint !== fingerprint)
        throw new AppError({
          code: 'key_conflict',
          message: 'This idempotency key was already used for different input',
          status: 409,
        });
      return old.result;
    }
    const result = fn();
    this.store.put('idempotency', id, { fingerprint, result });
    return result;
  }
  invoke(action: string, raw: any = {}) {
    return Effect.runPromise(this.invokeEffect(action, raw));
  }
  invokeEffect: (action: string, raw?: any) => Effect.Effect<any, AppError | BoundaryError> =
    Effect.fn('Service.invoke')(
      { self: this },
      function* (this: Service, action: string, raw: any = {}) {
        if (action.startsWith('cleanup.')) return yield* this.cleanup.invokeEffect(action, raw);
        if (/^(lead\.wait|checkpoint\.|usage\.|adapter\.)/.test(action))
          return yield* this.continuation.invokeEffect(action, raw);
        if (/^(outcome\.|plan\.|profile\.|limits\.|strategy\.|board\.)/.test(action))
          return yield* this.orchestration.invokeEffect(action, raw);
        switch (action) {
          case 'project.list':
            return yield* sync('Service.invoke', () => this.store.all<Project>('project'));
          case 'project.register': {
            const input = yield* sync('Service.invoke', () =>
              Schema.decodeUnknownSync(
                Schema.Struct({
                  name: Schema.mutableKey(Schema.String.check(Schema.isMinLength(1))),
                  root: Schema.mutableKey(Schema.String),
                  session: Schema.mutableKey(
                    Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]+$/)),
                  ),
                  socketPath: Schema.mutableKey(Schema.String),
                  workspaceId: Schema.mutableKey(Schema.String.check(Schema.isPattern(/^w\d+$/))),
                  maxConcurrency: Schema.mutableKey(
                    Schema.Finite.check(Schema.isInt())
                      .check(Schema.isGreaterThanOrEqualTo(1))
                      .check(Schema.isLessThanOrEqualTo(8))
                      .pipe(Schema.withDecodingDefault(Effect.succeed(3))),
                  ),
                  agentArgs: Schema.mutableKey(
                    Schema.Record(
                      kindSchema,
                      Schema.mutableKey(
                        Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
                      ),
                    ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
                  ),
                  trustWorkspaces: Schema.mutableKey(Schema.optional(Schema.Boolean)),
                  trustAgyWorkspaces: Schema.mutableKey(
                    Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
                  ),
                }),
              )(raw),
            );
            if (!isAbsolute(input.root) || !isAbsolute(input.socketPath))
              return yield* new AppError({
                code: 'absolute_paths',
                message: 'root and socketPath must be absolute',
                status: 400,
              });
            const root = yield* sync('Service.invoke', () => realpathSync(input.root));
            if (!statSync(root).isDirectory())
              return yield* new AppError({
                code: 'root',
                message: 'Project root is not a directory',
                status: 400,
              });
            const existing = yield* sync('Service.invoke', () =>
              this.store
                .all<Project>('project')
                .find(
                  (p) => p.socketPath === input.socketPath && p.workspaceId === input.workspaceId,
                ),
            );
            if (existing) {
              if (existing.root === root) return existing;
              return yield* new AppError({
                code: 'workspace_owned',
                message: 'This Herdr workspace is already bound to another project',
                status: 409,
              });
            }
            const p: Project = yield* sync<Project>('Service.invoke', () => ({
              ...input,
              root,
              id: randomUUID(),
              createdAt: now(),
            }));
            const h = yield* sync('Service.invoke', () => this.port(p));
            yield* herdrCall(h, 'ping');
            yield* herdrCall(h, 'workspace.get', { workspace_id: p.workspaceId });
            return yield* sync('Service.invoke', () =>
              this.store.transaction(() => {
                for (const task of this.store.all<Task>('task'))
                  if (task.worktree && inside(task.worktree.path, root))
                    this.cleanup.assertMutable(task);
                const concurrent = this.store
                  .all<Project>('project')
                  .find((v) => v.socketPath === p.socketPath && v.workspaceId === p.workspaceId);
                if (concurrent) {
                  if (concurrent.root === root) return concurrent;
                  throw new AppError({
                    code: 'workspace_owned',
                    message: 'This Herdr workspace is already bound to another project',
                    status: 409,
                  });
                }
                this.store.put('project', p.id, p);
                this.store.event(
                  p.id,
                  'project.registered',
                  `Connected ${p.name} to ${p.session} / ${p.workspaceId}`,
                );
                return p;
              }),
            );
          }
          case 'project.reconnect': {
            const i = yield* sync('Project.reconnectInput', () =>
              Schema.decodeUnknownSync(
                Schema.Struct({
                  lease: credentialsSchema,
                  expectedWorkspaceId: Schema.String.check(Schema.isPattern(/^w\d+$/)),
                  workspaceId: Schema.String.check(Schema.isPattern(/^w\d+$/)),
                }),
              )(raw),
            );
            const check = () => {
              const c = this.guard(i.lease),
                p = this.project(c.projectId);
              if (p.workspaceId === i.workspaceId) return p;
              if (p.workspaceId !== i.expectedWorkspaceId)
                throw new AppError({
                  code: 'project_connection_changed',
                  message:
                    'The project connection changed during setup. Retry with its current saved binding.',
                  status: 409,
                });
              if (
                this.tasks(p.id).some((t) => !terminalStates.has(t.status)) ||
                this.store
                  .all<Operation>('operation')
                  .some((op) => op.projectId === p.id && op.phase !== 'done') ||
                this.continuation
                  .waits(p.id)
                  .some((w) => !['acknowledged', 'invalidated'].includes(w.state))
              )
                throw new AppError({
                  code: 'project_reconnect_busy',
                  message:
                    'Resolve active tasks, pending operations and lead waits before reconnecting a missing workspace. Existing history and authority were preserved.',
                  status: 409,
                });
              if (
                this.store
                  .all<Project>('project')
                  .some(
                    (other) =>
                      other.id !== p.id &&
                      other.socketPath === p.socketPath &&
                      other.workspaceId === i.workspaceId,
                  )
              )
                throw new AppError({
                  code: 'workspace_owned',
                  message: 'The replacement workspace is already bound to another project.',
                  status: 409,
                });
              return p;
            };
            const p = yield* sync('Project.reconnectPreflight', check);
            if (p.workspaceId === i.workspaceId) return p;
            const h = this.port(p);
            const { workspaces }: { workspaces: { workspace_id: string }[] } = yield* herdrCall(
              h,
              'workspace.list',
            );
            if (workspaces.some((w) => w.workspace_id === p.workspaceId))
              return yield* new AppError({
                code: 'workspace_still_exists',
                message:
                  'The original workspace still exists. Setup will not replace an active connection.',
                status: 409,
              });
            yield* herdrCall(h, 'workspace.get', { workspace_id: i.workspaceId });
            return yield* sync('Project.reconnectCommit', () =>
              this.store.transaction(() => {
                const current = check();
                if (current.workspaceId === i.workspaceId) return current;
                const updated = { ...current, workspaceId: i.workspaceId };
                this.store.put('project', p.id, updated);
                this.store.event(
                  p.id,
                  'project.reconnected',
                  `Reconnected missing workspace ${current.workspaceId} to ${i.workspaceId}; project history and lead preserved.`,
                );
                return updated;
              }),
            );
          }
          case 'project.configure': {
            const i = yield* sync('Service.invoke', () =>
              Schema.decodeUnknownSync(
                Schema.Struct({
                  lease: Schema.mutableKey(credentialsSchema),
                  trustWorkspaces: Schema.mutableKey(Schema.optional(Schema.Boolean)),
                  trustAgyWorkspaces: Schema.mutableKey(Schema.optional(Schema.Boolean)),
                  agentArgs: Schema.mutableKey(
                    Schema.optional(
                      Schema.Record(
                        kindSchema,
                        Schema.mutableKey(
                          Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
                        ),
                      ),
                    ),
                  ),
                }),
              )(raw),
            );
            const c = yield* sync('Service.invoke', () => this.guard(i.lease)),
              p = yield* sync('Service.invoke', () => this.project(c.projectId));
            const updated = { ...p };
            if (i.trustWorkspaces !== undefined) updated.trustWorkspaces = i.trustWorkspaces;
            if (i.trustAgyWorkspaces !== undefined)
              updated.trustAgyWorkspaces = i.trustAgyWorkspaces;
            if (i.agentArgs) updated.agentArgs = i.agentArgs;
            yield* sync('Service.invoke', () => this.store.put('project', p.id, updated));
            yield* sync('Service.invoke', () =>
              this.store.event(p.id, 'project.configured', 'Project runtime preferences updated'),
            );
            return updated;
          }
          case 'project.inspect': {
            const p = yield* sync('Service.invoke', () =>
                this.project(Schema.decodeUnknownSync(Schema.String)(raw.projectId)),
              ),
              h = yield* sync('Service.invoke', () => this.port(p));
            const [workspace, panes, agents] = yield* Effect.all(
              [
                herdrCall(h, 'workspace.get', { workspace_id: p.workspaceId }),
                herdrCall(h, 'pane.list', { workspace_id: p.workspaceId }),
                herdrCall(h, 'agent.list'),
              ],
              { concurrency: 'unbounded' },
            );
            return yield* sync('Service.invoke', () => ({
              workspace,
              panes,
              agents: (agents.agents ?? []).filter((a: any) => a.workspace_id === p.workspaceId),
            }));
          }
          case 'project.briefing':
            return yield* sync('Service.invoke', () =>
              this.briefing(
                Schema.decodeUnknownSync(Schema.String)(raw.projectId),
                raw.compact !== false,
              ),
            );
          case 'lead.acquire': {
            const i = yield* sync('Service.invoke', () =>
              Schema.decodeUnknownSync(
                Schema.Struct({
                  projectId: Schema.mutableKey(Schema.String),
                  owner: Schema.mutableKey(
                    Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(100)),
                  ),
                  agent: Schema.mutableKey(Schema.optional(leadAgentSchema)),
                  expectedEpoch: Schema.mutableKey(
                    Schema.Finite.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)),
                  ),
                  takeover: Schema.mutableKey(
                    Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
                  ),
                  reason: Schema.mutableKey(Schema.String.check(Schema.isMinLength(1))),
                }),
              )(raw),
            );
            yield* sync('Service.invoke', () => this.project(i.projectId));
            return yield* sync('Service.invoke', () =>
              this.store.transaction(() => {
                const old = this.store.get<Lead>('lead', i.projectId);
                if ((old?.epoch ?? 0) !== i.expectedEpoch)
                  throw new AppError({
                    code: 'epoch_conflict',
                    message: 'Lead changed since this briefing. Refresh before taking control.',
                    status: 409,
                  });
                if (old && !i.takeover)
                  throw new AppError({
                    code: 'lead_owned',
                    message: `${old.owner} currently controls this project. Request handover or explicitly take over.`,
                    status: 409,
                  });
                const token = randomBytes(24).toString('hex'),
                  lead: Lead = {
                    projectId: i.projectId,
                    owner: i.owner,
                    agent: i.agent,
                    epoch: (old?.epoch ?? 0) + 1,
                    tokenHash: hash(token),
                    changedAt: now(),
                    reason: i.reason,
                  };
                this.store.put('lead', i.projectId, lead);
                this.orchestration.handover(i.projectId, i.owner);
                this.store.event(
                  i.projectId,
                  'lead.acquired',
                  `${i.owner} took control: ${i.reason}`,
                );
                return {
                  lease: { projectId: i.projectId, owner: i.owner, epoch: lead.epoch, token },
                  briefing: this.briefing(i.projectId),
                };
              }),
            );
          }
          case 'lead.handover': {
            const i = yield* sync('Service.invoke', () =>
              Schema.decodeUnknownSync(
                Schema.Struct({
                  lease: Schema.mutableKey(credentialsSchema),
                  toOwner: Schema.mutableKey(
                    Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(100)),
                  ),
                  agent: Schema.mutableKey(Schema.optional(leadAgentSchema)),
                  reason: Schema.mutableKey(Schema.String.check(Schema.isMinLength(1))),
                }),
              )(raw),
            );
            return yield* sync('Service.invoke', () =>
              this.store.transaction(() => {
                const c = this.guard(i.lease),
                  token = randomBytes(24).toString('hex');
                const l: Lead = {
                  projectId: c.projectId,
                  owner: i.toOwner,
                  agent: i.agent,
                  epoch: c.epoch + 1,
                  tokenHash: hash(token),
                  changedAt: now(),
                  reason: i.reason,
                };
                this.store.put('lead', c.projectId, l);
                this.orchestration.handover(c.projectId, i.toOwner);
                this.store.event(
                  c.projectId,
                  'lead.handover',
                  `${c.owner} handed control to ${i.toOwner}: ${i.reason}`,
                );
                return {
                  lease: { projectId: c.projectId, owner: i.toOwner, epoch: l.epoch, token },
                  briefing: this.briefing(c.projectId),
                };
              }),
            );
          }
          case 'task.submit': {
            return yield* sync('Service.invoke', () =>
              this.submitAssignment(raw.assignment, this.guard(raw.lease)),
            );
          }
          case 'task.get': {
            const t = yield* sync('Service.invoke', () =>
              this.task(Schema.decodeUnknownSync(Schema.String)(raw.taskId)),
            );
            const run = yield* sync('Service.invoke', () =>
              t.runId ? this.store.get<Run>('run', t.runId) : undefined,
            );
            const { tokenHash: _tokenHash, ...publicRun } = run ?? {};
            return yield* sync('Service.invoke', () => ({
              task: t,
              run: run ? publicRun : null,
              questions: this.store.all<Question>('question').filter((q) => q.taskId === t.id),
            }));
          }
          case 'task.control': {
            return yield* sync('Service.invoke', () =>
              this.controlTask(raw, this.guard(raw.lease)),
            );
          }
          case 'task.retry': {
            const c = yield* sync('Service.invoke', () => this.guard(raw.lease)),
              t = yield* sync('Service.invoke', () =>
                this.task(Schema.decodeUnknownSync(Schema.String)(raw.taskId)),
              ),
              key = yield* sync('Service.invoke', () =>
                Schema.decodeUnknownSync(Schema.String.check(Schema.isMinLength(1)))(raw.key),
              );
            if (c.projectId !== t.projectId)
              return yield* new AppError({
                code: 'project_mismatch',
                message: 'Task and lease differ',
                status: 400,
              });
            yield* sync('Service.invoke', () => this.cleanup.assertMutable(t));
            // Check idempotency before external reads, but never bypass fencing.
            const cached = yield* sync('Service.invoke', () =>
              this.store.get<any>('idempotency', t.projectId + ':retry:' + key),
            );
            if (cached)
              return yield* sync('Service.invoke', () =>
                this.store.transaction(() =>
                  this.idempotent(t.projectId, 'retry:' + key, { taskId: t.id }, () => null),
                ),
              );
            if (!['failed', 'cancelled'].includes(t.status))
              return yield* new AppError({
                code: 'retry_state',
                message:
                  'Only failed or cancelled tasks can be retried. Reconcile uncertain tasks first.',
                status: 409,
              });
            if (t.attempt >= t.maxAttempts)
              return yield* new AppError({
                code: 'retry_limit',
                message:
                  'Attempt limit reached. Create a new assignment after reviewing the failure.',
                status: 409,
              });
            if (t.runId) {
              const runId = t.runId;
              const r = yield* sync('Service.invoke', () => this.store.get<Run>('run', runId)!);
              if (r.paneId) {
                const result = yield* herdrCall(this.port(this.project(t.projectId)), 'agent.get', {
                  target: r.paneId,
                }).pipe(
                  Effect.catchIf(
                    (error) =>
                      error instanceof AppError &&
                      ['agent_not_found', 'pane_not_found'].includes(error.code),
                    () => Effect.succeed({ agent: undefined }),
                  ),
                );
                const a = result.agent;
                if (
                  a &&
                  a.terminal_id === r.terminalId &&
                  ['working', 'unknown', 'blocked'].includes(a.agent_status)
                )
                  return yield* new AppError({
                    code: 'worker_active',
                    message: 'Previous worker must be stopped before retrying',
                    status: 409,
                  });
              }
            }
            yield* sync('Service.invoke', () => this.guard(raw.lease));
            const current = yield* sync('Service.invoke', () => this.task(t.id));
            yield* sync('Service.invoke', () => this.cleanup.assertMutable(current));
            if (current.runId !== t.runId || !['failed', 'cancelled'].includes(current.status))
              return yield* new AppError({
                code: 'retry_state',
                message: 'Task changed while checking the previous worker; refresh before retrying',
                status: 409,
              });
            return yield* sync('Service.invoke', () =>
              this.store.transaction(() =>
                this.idempotent(t.projectId, 'retry:' + key, { taskId: t.id }, () =>
                  this.updateTask(
                    this.task(t.id),
                    {
                      status: 'queued',
                      revision: t.revision + 1,
                      runId: undefined,
                      receipt: undefined,
                      verification: undefined,
                      error: undefined,
                      output: '',
                    },
                    `Retry queued for ${t.title}`,
                  ),
                ),
              ),
            );
          }
          case 'task.reconcile': {
            const i = yield* sync('Service.invoke', () =>
                Schema.decodeUnknownSync(
                  Schema.Struct({
                    lease: Schema.mutableKey(credentialsSchema),
                    taskId: Schema.mutableKey(Schema.String),
                    resolution: Schema.mutableKey(Schema.Literals(['delivered', 'not-delivered'])),
                    reason: Schema.mutableKey(Schema.String.check(Schema.isMinLength(1))),
                  }),
                )(raw),
              ),
              c = yield* sync('Service.invoke', () => this.guard(i.lease)),
              t = yield* sync('Service.invoke', () => this.task(i.taskId));
            if (c.projectId !== t.projectId || t.status !== 'uncertain' || !t.runId)
              return yield* new AppError({
                code: 'reconcile_state',
                message: 'Only an uncertain run in this project can be reconciled',
                status: 400,
              });
            const runId = t.runId;
            const r = yield* sync('Service.invoke', () => this.store.get<Run>('run', runId)!),
              h = yield* sync('Service.invoke', () => this.port(this.project(t.projectId)));
            if (!r.paneId) {
              if (r.phase !== 'creating' || i.resolution !== 'not-delivered')
                return yield* new AppError({
                  code: 'creation_unconfirmed',
                  message:
                    'No task prompt was attempted. Inspect the workspace and reconcile creation as not-delivered.',
                  status: 400,
                });
              const project = yield* sync('Service.invoke', () => this.project(t.projectId));
              if (r.creation?.mode === 'pane') {
                const all = (yield* herdrCall(h, 'pane.list', {
                  workspace_id: project.workspaceId,
                })).panes;
                if (!Array.isArray(all) || !r.creation.beforePaneIds)
                  return yield* new AppError({
                    code: 'identity_changed',
                    message: 'Missing split membership; inspect the workspace',
                    status: 409,
                  });
                const added = yield* sync('Service.invoke', () =>
                  all.filter((pane: any) => !r.creation!.beforePaneIds!.includes(pane.pane_id)),
                );
                const panes = yield* sync('Service.invoke', () =>
                  added.filter((pane: any) => pane.tab_id === r.creation!.tabId),
                );
                // No prompt was sent. Never adopt a moved, occupied, or ambiguous new pane.
                if (
                  added.length !== panes.length ||
                  panes.length > 1 ||
                  (panes.length === 1 &&
                    (panes[0].agent ||
                      panes[0].launch_pending ||
                      panes[0].workspace_id !== project.workspaceId ||
                      panes[0].cwd !== t.cwd))
                )
                  return yield* new AppError({
                    code: 'identity_changed',
                    message:
                      'Interrupted split is ambiguous or no longer an untouched shell; inspect it before recovery',
                    status: 409,
                  });
                if (panes.length === 1)
                  yield* sync('Service.invoke', () =>
                    Object.assign(r, {
                      paneId: panes[0].pane_id,
                      terminalId: panes[0].terminal_id,
                      tabId: panes[0].tab_id,
                    }),
                  );
              } else {
                const tabs =
                  (yield* herdrCall(h, 'tab.list', { workspace_id: project.workspaceId })).tabs ??
                  [];
                const matches = yield* sync('Service.invoke', () =>
                  tabs.filter(
                    (tab: any) =>
                      tab.workspace_id === project.workspaceId && tab.label === r.agentName,
                  ),
                );
                if (matches.length > 1)
                  return yield* new AppError({
                    code: 'identity_changed',
                    message:
                      'Multiple tabs match the interrupted creation; manual inspection is required',
                    status: 409,
                  });
                if (matches.length === 1) {
                  const panes = (
                    (yield* herdrCall(h, 'pane.list', { workspace_id: project.workspaceId }))
                      .panes ?? []
                  ).filter((pane: any) => pane.tab_id === matches[0].tab_id);
                  if (
                    panes.length !== 1 ||
                    panes[0].agent ||
                    panes[0].launch_pending ||
                    panes[0].workspace_id !== project.workspaceId ||
                    panes[0].cwd !== t.cwd
                  )
                    return yield* new AppError({
                      code: 'identity_changed',
                      message:
                        'The orphan tab is no longer an untouched shell; inspect it before recovery',
                      status: 409,
                    });
                  yield* sync('Service.invoke', () =>
                    Object.assign(r, {
                      paneId: panes[0].pane_id,
                      terminalId: panes[0].terminal_id,
                      tabId: panes[0].tab_id,
                    }),
                  );
                }
              }
            } else {
              const a = (yield* herdrCall(h, 'agent.get', { target: r.paneId })).agent;
              if (
                !a ||
                a.workspace_id !== this.project(t.projectId).workspaceId ||
                a.terminal_id !== r.terminalId ||
                a.name !== r.agentName ||
                a.agent !== r.kind ||
                (r.nativeSession && a.agent_session?.value !== r.nativeSession)
              )
                return yield* new AppError({
                  code: 'identity_changed',
                  message: 'The original agent identity could not be established',
                  status: 409,
                });
              if (
                i.resolution === 'not-delivered' &&
                (!['idle', 'done'].includes(a.agent_status) || a.launch_pending)
              )
                return yield* new AppError({
                  code: 'worker_active',
                  message: 'Stop or resolve the original worker before declaring it undelivered',
                  status: 409,
                });
            }
            yield* sync('Service.invoke', () => this.guard(i.lease));
            if (this.task(t.id).status !== 'uncertain' || this.task(t.id).runId !== r.id)
              return yield* new AppError({
                code: 'reconcile_state',
                message: 'Run changed during inspection; refresh before reconciling',
                status: 409,
              });
            return yield* sync('Service.invoke', () =>
              this.store.transaction(() => {
                r.phase = i.resolution === 'delivered' ? 'running' : 'stopped';
                this.store.put('run', r.id, r);
                for (const op of this.store
                  .all<Operation>('operation')
                  .filter((o) => o.taskId === t.id && !['done', 'failed'].includes(o.phase)))
                  this.store.put('operation', op.id, {
                    ...op,
                    phase: 'failed',
                    error: 'Closed by explicit reconciliation',
                  });
                this.closeQuestions(t.id, i.reason);
                return this.updateTask(
                  this.task(t.id),
                  { status: i.resolution === 'delivered' ? 'running' : 'failed', error: undefined },
                  `Run reconciled as ${i.resolution}: ${i.reason}`,
                );
              }),
            );
          }
          case 'decision.record': {
            const c = yield* sync('Service.invoke', () => this.guard(raw.lease)),
              text = yield* sync('Service.invoke', () =>
                Schema.decodeUnknownSync(Schema.String.check(Schema.isMinLength(1)))(raw.text),
              ),
              rationale = yield* sync('Service.invoke', () =>
                Schema.decodeUnknownSync(
                  Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(''))),
                )(raw.rationale),
              );
            const d: Decision = yield* sync<Decision>('Service.invoke', () => ({
              id: randomUUID(),
              projectId: c.projectId,
              text,
              rationale,
              owner: c.owner,
              createdAt: now(),
            }));
            yield* sync('Service.invoke', () =>
              this.store.transaction(() => {
                this.store.put('decision', d.id, d);
                this.store.event(c.projectId, 'decision.recorded', text);
              }),
            );
            return d;
          }
          case 'inbox.read': {
            const i = yield* sync('Service.invoke', () =>
              Schema.decodeUnknownSync(
                Schema.Struct({
                  projectId: Schema.mutableKey(Schema.String),
                  consumer: Schema.mutableKey(Schema.String.check(Schema.isMinLength(1))),
                  after: Schema.mutableKey(
                    Schema.optional(
                      Schema.Finite.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)),
                    ),
                  ),
                  limit: Schema.mutableKey(
                    Schema.Finite.check(Schema.isInt())
                      .check(Schema.isGreaterThanOrEqualTo(1))
                      .check(Schema.isLessThanOrEqualTo(200))
                      .pipe(Schema.withDecodingDefault(Effect.succeed(100))),
                  ),
                }),
              )(raw),
            );
            yield* sync('Service.invoke', () => this.project(i.projectId));
            const cursor = yield* sync(
              'Service.invoke',
              () =>
                i.after ?? this.store.get<number>('cursor', i.projectId + ':' + i.consumer) ?? 0,
            );
            const events = yield* sync('Service.invoke', () =>
              this.store.events(i.projectId, cursor, i.limit),
            );
            return yield* sync('Service.invoke', () => ({
              events,
              cursor: events.at(-1)?.id ?? cursor,
              hasMore: events.length === i.limit,
            }));
          }
          case 'inbox.ack': {
            const i = yield* sync('Service.invoke', () =>
              Schema.decodeUnknownSync(
                Schema.Struct({
                  projectId: Schema.mutableKey(Schema.String),
                  consumer: Schema.mutableKey(Schema.String.check(Schema.isMinLength(1))),
                  cursor: Schema.mutableKey(
                    Schema.Finite.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)),
                  ),
                }),
              )(raw),
            );
            yield* sync('Service.invoke', () => this.project(i.projectId));
            const id = i.projectId + ':' + i.consumer;
            const current = yield* sync(
              'Service.invoke',
              () => this.store.get<number>('cursor', id) ?? 0,
            );
            // An acknowledgement cannot hide future events.
            const latest = yield* sync(
              'Service.invoke',
              () =>
                Schema.decodeUnknownSync(Schema.Struct({ id: Schema.NullOr(Schema.Finite) }))(
                  this.store.db
                    .prepare('SELECT MAX(id) AS id FROM events WHERE project_id=?')
                    .get(i.projectId),
                ).id ?? 0,
            );
            if (i.cursor > latest)
              return yield* new AppError({
                code: 'cursor_future',
                message: 'Cannot acknowledge an event that does not exist',
                status: 400,
              });
            yield* sync('Service.invoke', () =>
              this.store.put('cursor', id, Math.max(current, i.cursor)),
            );
            return yield* sync('Service.invoke', () => ({ cursor: Math.max(current, i.cursor) }));
          }
          default:
            return yield* new AppError({
              code: 'unknown_action',
              message: `Unknown action: ${action}`,
              status: 404,
            });
        }
      },
    );
  controlTask(raw: any, c: Credentials, cascade = true) {
    const i = Schema.decodeUnknownSync(
      Schema.Struct({
        taskId: Schema.mutableKey(Schema.String),
        key: Schema.mutableKey(Schema.String.check(Schema.isMinLength(1))),
        type: Schema.mutableKey(Schema.Literals(['redirect', 'pause', 'cancel', 'reply', 'keys'])),
        text: Schema.mutableKey(Schema.optional(Schema.String.check(Schema.isMaxLength(50000)))),
        keys: Schema.mutableKey(
          Schema.optional(Schema.mutable(Schema.Array(Schema.String)).check(Schema.isMinLength(1))),
        ),
        checks: Schema.mutableKey(
          Schema.optional(Schema.mutable(Schema.Array(checkSchema)).check(Schema.isMinLength(1))),
        ),
      }),
    )(raw);
    return this.store.transaction(() => {
      let t = this.task(i.taskId);
      this.cleanup.assertMutable(t);
      if (t.projectId !== c.projectId)
        throw new AppError({
          code: 'project_mismatch',
          message: 'Task and lease differ',
          status: 400,
        });
      return this.idempotent(c.projectId, 'control:' + i.key, i, () => {
        if (terminalStates.has(t.status))
          throw new AppError({
            code: 'task_finished',
            message: 'Task is already finished',
            status: 409,
          });
        if (t.runId && this.store.get<Run>('run', t.runId)?.cleanup?.state === 'closed')
          t = this.updateTask(t, { runId: undefined });
        if (['redirect', 'reply'].includes(i.type) && !i.text?.trim())
          throw new AppError({
            code: 'text_required',
            message: 'Provide the new instructions or answer',
            status: 400,
          });
        if (i.type === 'keys' && !i.keys)
          throw new AppError({
            code: 'keys_required',
            message: 'Provide explicit keys',
            status: 400,
          });
        if (t.status === 'uncertain')
          throw new AppError({
            code: 'uncertain',
            message: 'Reconcile the ambiguous run before sending further input',
            status: 409,
          });
        if (
          this.store
            .all<Operation>('operation')
            .some((o) => o.taskId === t.id && !['done', 'failed'].includes(o.phase))
        )
          throw new AppError({
            code: 'operation_pending',
            message: 'An operation is already pending for this task',
            status: 409,
          });
        if (i.checks)
          for (const check of i.checks) if (check.type === 'file') safePath(t.cwd, check.path);
        const op: Operation = {
          id: randomUUID(),
          projectId: t.projectId,
          taskId: t.id,
          type: i.type,
          text: i.text,
          keys: i.keys,
          checks: i.checks,
          phase: 'pending',
          createdAt: now(),
          revision: t.revision,
        };
        if (cascade && (i.type === 'cancel' || i.type === 'pause')) {
          for (const child of this.orchestration
            .descendants(t.id)
            .filter((child) => !terminalStates.has(child.status))) {
            this.controlTask(
              { taskId: child.id, key: `${i.key}:descendant:${child.id}`, type: i.type },
              c,
              false,
            );
          }
        }
        if (['redirect', 'reply'].includes(i.type)) {
          if (i.type === 'reply' && t.status !== 'blocked' && t.status !== 'paused')
            throw new AppError({
              code: 'not_blocked',
              message: 'Reply applies to a blocked or paused task',
              status: 409,
            });
          if (t.outcomeId)
            this.orchestration.changed(t.outcomeId, `${i.type}: ${i.text}`, c.owner, t, t);
          this.updateTask(t, {
            revision: t.revision + 1,
            receipt: undefined,
            verification: undefined,
          });
          op.revision = t.revision + 1;
        }
        if (!t.runId && ['queued', 'preparing', 'paused'].includes(t.status)) {
          if (i.type === 'keys')
            throw new AppError({
              code: 'no_worker',
              message: 'There is no worker to receive keys',
              status: 400,
            });
          const current = this.task(t.id);
          const patch: Partial<Task> = {
            status: i.type === 'cancel' ? 'cancelled' : i.type === 'pause' ? 'paused' : 'queued',
          };
          if (i.type === 'redirect') {
            patch.prompt = i.text!;
            patch.checks = i.checks ?? t.checks;
          }
          if (i.type === 'reply')
            patch.prompt = current.prompt + '\n\nLead continuation: ' + i.text;
          this.updateTask(current, patch, `Applied ${i.type} before dispatch`);
          op.phase = 'done';
        }
        this.store.put('operation', op.id, op);
        this.store.event(t.projectId, 'control.queued', `${c.owner}: ${i.type}`, t.id);
        return op;
      });
    });
  }
  submitAssignment(rawAssignment: Schema.Codec.Encoded<typeof assignmentSchema>, c: Credentials) {
    const a = Schema.decodeSync(assignmentSchema)(rawAssignment);
    if (c.projectId !== a.projectId)
      throw new AppError({
        code: 'project_mismatch',
        message: 'Lease does not match assignment',
        status: 400,
      });
    const p = this.project(a.projectId),
      cwd = realpathSync(a.cwd ?? p.root);
    const parent = a.parentId ? this.task(a.parentId) : undefined;
    if (parent) this.cleanup.assertMutable(parent);
    for (const task of this.store.all<Task>('task'))
      if (task.worktree && inside(task.worktree.path, cwd)) this.cleanup.assertMutable(task);
    const inheritedWorktree =
      parent?.projectId === p.id && parent.worktree?.state === 'ready' && parent.cwd === cwd;
    if (!inside(p.root, cwd) && !inheritedWorktree)
      throw new AppError({
        code: 'cwd_scope',
        message:
          'Task directory must be within the registered root. Register external worktrees as projects.',
        status: 400,
      });
    for (const path of a.ownership) {
      if (a.execution?.mode === 'worktree' && isAbsolute(path))
        throw new AppError({
          code: 'worktree_path',
          message: 'Worktree ownership paths must be relative to the task directory',
          status: 400,
        });
      if (/[?*[\]]/.test(path))
        throw new AppError({
          code: 'ownership_path',
          message: 'Ownership must name files or directory prefixes, not globs',
          status: 400,
        });
      safePath(cwd, path);
    }
    for (const check of a.checks)
      if (check.type === 'file') {
        if (a.execution?.mode === 'worktree' && isAbsolute(check.path))
          throw new AppError({
            code: 'worktree_path',
            message: 'Worktree file checks must be relative to the task directory',
            status: 400,
          });
        safePath(cwd, check.path);
      }
    for (const id of a.dependencies) {
      const d = this.task(id);
      if (this.cleanup.active(d.id))
        throw new AppError({
          code: 'cleanup_busy',
          message: 'Dependency is being cleaned up; retry after it finishes',
          status: 409,
        });
      if (d.projectId !== a.projectId)
        throw new AppError({
          code: 'dependency_scope',
          message: 'Dependencies must belong to the same project',
          status: 400,
        });
    }
    return this.store.transaction(() =>
      this.idempotent(a.projectId, 'submit:' + a.key, a, () => {
        const { key: _key, ...fields } = a;
        const task: Task = {
          ...fields,
          cwd,
          id: randomUUID(),
          status: a.deferStart ? 'paused' : 'queued',
          revision: 1,
          attempt: 0,
          createdAt: now(),
          updatedAt: now(),
          leadOwner: c.owner,
          output: '',
        };
        this.orchestration.attach(task, a, c.owner);
        this.store.put('task', task.id, task);
        this.store.event(a.projectId, 'task.queued', `Queued ${task.title}`, task.id);
        return task;
      }),
    );
  }
  closeQuestions(taskId: string, answer: string) {
    for (const q of this.store
      .all<Question>('question')
      .filter((q) => q.taskId === taskId && !q.answeredAt))
      this.store.put('question', q.id, { ...q, answer, answeredAt: now() });
  }
  workerGuard(taskId: string, token: string, revision: number) {
    const t = this.task(taskId),
      r = t.runId ? this.store.get<Run>('run', t.runId) : undefined;
    this.cleanup.assertMutable(t);
    if (!r || hash(token) !== r.tokenHash)
      throw new AppError({
        code: 'worker_auth',
        message: 'Invalid or obsolete worker token',
        status: 401,
      });
    if (terminalStates.has(t.status) || revision !== t.revision || r.phase === 'stopped')
      throw new AppError({
        code: 'stale_report',
        message: 'Report belongs to an obsolete assignment revision',
        status: 409,
      });
    return t;
  }
  report(taskId: string, token: string, raw: Schema.Codec.Encoded<typeof reportSchema>) {
    const i = Schema.decodeSync(reportSchema)(raw);
    return this.store.transaction(() => {
      const t = this.task(taskId),
        r = t.runId ? this.store.get<Run>('run', t.runId) : undefined;
      this.cleanup.assertMutable(t);
      if (!r || hash(token) !== r.tokenHash)
        throw new AppError({
          code: 'worker_auth',
          message: 'Invalid or obsolete worker token',
          status: 401,
        });
      if (terminalStates.has(t.status) || i.revision !== t.revision)
        throw new AppError({
          code: 'stale_report',
          message: 'Report belongs to an obsolete assignment revision',
          status: 409,
        });
      for (const path of i.artifacts) {
        const resolved = safePath(t.cwd, path, true);
        if (!t.ownership.some((owned) => inside(safePath(t.cwd, owned), resolved)))
          throw new AppError({
            code: 'artifact_ownership',
            message: 'Reported artifacts must belong to this assignment',
            status: 400,
          });
      }
      if (i.type === 'yield') {
        if (!t.canDelegate)
          throw new AppError({
            code: 'delegation_denied',
            message: 'Only coordinators can yield to children',
            status: 400,
          });
        const children =
          i.children ??
          this.tasks(t.projectId)
            .filter((c) => c.parentId === t.id)
            .map((c) => c.id);
        if (!children.length || children.some((id) => this.task(id).parentId !== t.id))
          throw new AppError({
            code: 'child_scope',
            message: 'Wait for one or more direct children',
            status: 400,
          });
        this.updateTask(
          t,
          {
            status: 'yielding',
            waitForChildren: children,
            receipt: undefined,
            resumePending: false,
          },
          'Coordinator yielding ownership to children',
        );
      } else if (i.type === 'complete') {
        if (!i.artifacts.length && !i.evidence.length)
          throw new AppError({
            code: 'evidence_required',
            message: 'Include artifacts or evidence with the completion report',
            status: 400,
          });
        const late = t.status === 'blocked' && t.blockKind === 'missing-report';
        if (late) this.closeQuestions(t.id, 'Completion report received');
        const patch: Partial<Task> = {
          receipt: {
            revision: i.revision,
            summary: i.summary,
            artifacts: i.artifacts,
            evidence: i.evidence,
            receivedAt: now(),
          },
        };
        if (late) {
          patch.status = 'running';
          patch.blockKind = undefined;
        }
        this.updateTask(t, patch, 'Worker submitted completion evidence; verification pending');
      } else if (i.type === 'blocked') {
        this.updateTask(
          t,
          { status: 'blocked', blockKind: 'question' },
          `${t.title} needs a decision`,
        );
        this.ask(t, i.summary);
      } else if (i.type === 'failure')
        this.updateTask(t, { status: 'failed', error: i.summary }, `Worker failed: ${i.summary}`);
      else this.store.event(t.projectId, 'task.progress', i.summary, t.id);
      return { accepted: true, taskId, revision: i.revision };
    });
  }
}
