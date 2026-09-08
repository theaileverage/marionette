import { randomUUID, randomBytes } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { z } from 'zod';
import { Continuation } from './continuation.js';
import { Cleanup } from './cleanup.js';
import { Orchestration } from './orchestration.js';
import { Store } from './store.js';
import { Herdr } from './herdr.js';
import { hash, safePath, inside } from './files.js';
import {
  AppError,
  assignmentSchema,
  checkSchema,
  credentialsSchema,
  kindSchema,
  leadAgentSchema,
  now,
  type Task,
  type Project,
  type Lead,
  type Credentials,
  type Question,
  type Run,
  type Operation,
  type Decision,
  type HerdrPort,
} from './types.js';

export const terminalStates = new Set(['completed', 'cancelled', 'failed']);
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
    if (!p) throw new AppError('not_found', 'Project not found', 404);
    return p;
  }
  task(id: string) {
    const t = this.store.get<Task>('task', id);
    if (!t) throw new AppError('not_found', 'Task not found', 404);
    return t;
  }
  guard(raw: unknown): Credentials {
    const c = credentialsSchema.parse(raw),
      lead = this.store.get<Lead>('lead', c.projectId);
    if (
      !lead ||
      lead.owner !== c.owner ||
      lead.epoch !== c.epoch ||
      lead.tokenHash !== hash(c.token)
    )
      throw new AppError(
        'stale_lead',
        'Control belongs to another lead. Fetch a briefing and explicitly acquire or hand over control.',
        409,
      );
    return c;
  }
  publicLead(projectId: string) {
    const l = this.store.get<Lead>('lead', projectId);
    if (!l) return null;
    const { tokenHash, ...rest } = l;
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
        (
          this.store.db
            .prepare('SELECT MAX(id) AS id FROM events WHERE project_id=?')
            .get(projectId) as { id: number | null }
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
  idempotent<T>(projectId: string, key: string, payload: unknown, fn: () => T): T {
    const id = projectId + ':' + key,
      fingerprint = hash(JSON.stringify(payload));
    const old = this.store.get<{ fingerprint: string; result: T }>('idempotency', id);
    if (old) {
      if (old.fingerprint !== fingerprint)
        throw new AppError(
          'key_conflict',
          'This idempotency key was already used for different input',
          409,
        );
      return old.result;
    }
    const result = fn();
    this.store.put('idempotency', id, { fingerprint, result });
    return result;
  }
  async invoke(action: string, raw: any = {}): Promise<any> {
    if (action.startsWith('cleanup.')) return this.cleanup.invoke(action, raw);
    if (/^(lead\.wait|checkpoint\.|usage\.|adapter\.)/.test(action))
      return this.continuation.invoke(action, raw);
    if (/^(outcome\.|plan\.|profile\.|limits\.|strategy\.|board\.)/.test(action))
      return this.orchestration.invoke(action, raw);
    switch (action) {
      case 'project.list':
        return this.store.all<Project>('project');
      case 'project.register': {
        const input = z
          .object({
            name: z.string().min(1),
            root: z.string(),
            session: z.string().regex(/^[a-zA-Z0-9_-]+$/),
            socketPath: z.string(),
            workspaceId: z.string().regex(/^w\d+$/),
            maxConcurrency: z.number().int().min(1).max(8).default(3),
            agentArgs: z.record(kindSchema, z.array(z.string())).default({}),
            trustAgyWorkspaces: z.boolean().default(false),
          })
          .parse(raw);
        if (!isAbsolute(input.root) || !isAbsolute(input.socketPath))
          throw new AppError('absolute_paths', 'root and socketPath must be absolute');
        const root = realpathSync(input.root);
        if (!statSync(root).isDirectory())
          throw new AppError('root', 'Project root is not a directory');
        const existing = this.store
          .all<Project>('project')
          .find((p) => p.socketPath === input.socketPath && p.workspaceId === input.workspaceId);
        if (existing) {
          if (existing.root === root) return existing;
          throw new AppError(
            'workspace_owned',
            'This Herdr workspace is already bound to another project',
            409,
          );
        }
        const p: Project = { ...input, root, id: randomUUID(), createdAt: now() };
        const h = this.port(p);
        await h.call('ping');
        await h.call('workspace.get', { workspace_id: p.workspaceId });
        return this.store.transaction(() => {
          for (const task of this.store.all<Task>('task'))
            if (task.worktree && inside(task.worktree.path, root)) this.cleanup.assertMutable(task);
          const concurrent = this.store
            .all<Project>('project')
            .find((v) => v.socketPath === p.socketPath && v.workspaceId === p.workspaceId);
          if (concurrent) {
            if (concurrent.root === root) return concurrent;
            throw new AppError(
              'workspace_owned',
              'This Herdr workspace is already bound to another project',
              409,
            );
          }
          this.store.put('project', p.id, p);
          this.store.event(
            p.id,
            'project.registered',
            `Connected ${p.name} to ${p.session} / ${p.workspaceId}`,
          );
          return p;
        });
      }
      case 'project.configure': {
        const i = z
          .object({
            lease: credentialsSchema,
            trustAgyWorkspaces: z.boolean().optional(),
            agentArgs: z.record(kindSchema, z.array(z.string())).optional(),
          })
          .parse(raw);
        const c = this.guard(i.lease),
          p = this.project(c.projectId);
        const updated = {
          ...p,
          ...(i.trustAgyWorkspaces === undefined
            ? {}
            : { trustAgyWorkspaces: i.trustAgyWorkspaces }),
          ...(i.agentArgs ? { agentArgs: i.agentArgs } : {}),
        };
        this.store.put('project', p.id, updated);
        this.store.event(p.id, 'project.configured', 'Project runtime preferences updated');
        return updated;
      }
      case 'project.inspect': {
        const p = this.project(z.string().parse(raw.projectId)),
          h = this.port(p);
        const [workspace, panes, agents] = await Promise.all([
          h.call('workspace.get', { workspace_id: p.workspaceId }),
          h.call('pane.list', { workspace_id: p.workspaceId }),
          h.call('agent.list'),
        ]);
        return {
          workspace,
          panes,
          agents: (agents.agents ?? []).filter((a: any) => a.workspace_id === p.workspaceId),
        };
      }
      case 'project.briefing':
        return this.briefing(z.string().parse(raw.projectId), raw.compact !== false);
      case 'lead.acquire': {
        const i = z
          .object({
            projectId: z.string(),
            owner: z.string().min(1).max(100),
            agent: leadAgentSchema.optional(),
            expectedEpoch: z.number().int().min(0),
            takeover: z.boolean().default(false),
            reason: z.string().min(1),
          })
          .parse(raw);
        this.project(i.projectId);
        return this.store.transaction(() => {
          const old = this.store.get<Lead>('lead', i.projectId);
          if ((old?.epoch ?? 0) !== i.expectedEpoch)
            throw new AppError(
              'epoch_conflict',
              'Lead changed since this briefing. Refresh before taking control.',
              409,
            );
          if (old && !i.takeover)
            throw new AppError(
              'lead_owned',
              `${old.owner} currently controls this project. Request handover or explicitly take over.`,
              409,
            );
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
          this.store.event(i.projectId, 'lead.acquired', `${i.owner} took control: ${i.reason}`);
          return {
            lease: { projectId: i.projectId, owner: i.owner, epoch: lead.epoch, token },
            briefing: this.briefing(i.projectId),
          };
        });
      }
      case 'lead.handover': {
        const i = z
          .object({
            lease: credentialsSchema,
            toOwner: z.string().min(1).max(100),
            agent: leadAgentSchema.optional(),
            reason: z.string().min(1),
          })
          .parse(raw);
        return this.store.transaction(() => {
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
        });
      }
      case 'task.submit': {
        return this.submitAssignment(raw.assignment, this.guard(raw.lease));
      }
      case 'task.get': {
        const t = this.task(z.string().parse(raw.taskId));
        const run = t.runId ? this.store.get<Run>('run', t.runId) : undefined;
        const { tokenHash, ...publicRun } = run ?? ({} as Run);
        return {
          task: t,
          run: run ? publicRun : null,
          questions: this.store.all<Question>('question').filter((q) => q.taskId === t.id),
        };
      }
      case 'task.control': {
        return this.controlTask(raw, this.guard(raw.lease));
      }
      case 'task.retry': {
        const c = this.guard(raw.lease),
          t = this.task(z.string().parse(raw.taskId)),
          key = z.string().min(1).parse(raw.key);
        if (c.projectId !== t.projectId)
          throw new AppError('project_mismatch', 'Task and lease differ');
        this.cleanup.assertMutable(t);
        // Check idempotency before external reads, but never bypass fencing.
        const cached = this.store.get<any>('idempotency', t.projectId + ':retry:' + key);
        if (cached)
          return this.store.transaction(() =>
            this.idempotent(t.projectId, 'retry:' + key, { taskId: t.id }, () => null),
          );
        if (!['failed', 'cancelled'].includes(t.status))
          throw new AppError(
            'retry_state',
            'Only failed or cancelled tasks can be retried. Reconcile uncertain tasks first.',
            409,
          );
        if (t.attempt >= t.maxAttempts)
          throw new AppError(
            'retry_limit',
            'Attempt limit reached. Create a new assignment after reviewing the failure.',
            409,
          );
        if (t.runId) {
          const r = this.store.get<Run>('run', t.runId)!;
          if (r.paneId) {
            try {
              const a = (
                await this.port(this.project(t.projectId)).call('agent.get', { target: r.paneId })
              ).agent;
              if (
                a &&
                a.terminal_id === r.terminalId &&
                ['working', 'unknown', 'blocked'].includes(a.agent_status)
              )
                throw new AppError(
                  'worker_active',
                  'Previous worker must be stopped before retrying',
                  409,
                );
            } catch (e) {
              if (!['agent_not_found', 'pane_not_found'].includes((e as AppError).code)) throw e;
            }
          }
        }
        this.guard(raw.lease);
        const current = this.task(t.id);
        this.cleanup.assertMutable(current);
        if (current.runId !== t.runId || !['failed', 'cancelled'].includes(current.status))
          throw new AppError(
            'retry_state',
            'Task changed while checking the previous worker; refresh before retrying',
            409,
          );
        return this.store.transaction(() =>
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
        );
      }
      case 'task.reconcile': {
        const i = z
            .object({
              lease: credentialsSchema,
              taskId: z.string(),
              resolution: z.enum(['delivered', 'not-delivered']),
              reason: z.string().min(1),
            })
            .parse(raw),
          c = this.guard(i.lease),
          t = this.task(i.taskId);
        if (c.projectId !== t.projectId || t.status !== 'uncertain' || !t.runId)
          throw new AppError(
            'reconcile_state',
            'Only an uncertain run in this project can be reconciled',
          );
        const r = this.store.get<Run>('run', t.runId)!,
          h = this.port(this.project(t.projectId));
        if (!r.paneId) {
          if (r.phase !== 'creating' || i.resolution !== 'not-delivered')
            throw new AppError(
              'creation_unconfirmed',
              'No task prompt was attempted. Inspect the workspace and reconcile creation as not-delivered.',
            );
          const project = this.project(t.projectId);
          const tabs = (await h.call('tab.list', { workspace_id: project.workspaceId })).tabs ?? [];
          const matches = tabs.filter(
            (tab: any) => tab.workspace_id === project.workspaceId && tab.label === r.agentName,
          );
          if (matches.length > 1)
            throw new AppError(
              'identity_changed',
              'Multiple tabs match the interrupted creation; manual inspection is required',
              409,
            );
          if (matches.length === 1) {
            const panes = (
              (await h.call('pane.list', { workspace_id: project.workspaceId })).panes ?? []
            ).filter((pane: any) => pane.tab_id === matches[0].tab_id);
            if (
              panes.length !== 1 ||
              panes[0].agent ||
              panes[0].launch_pending ||
              panes[0].workspace_id !== project.workspaceId ||
              panes[0].cwd !== t.cwd
            )
              throw new AppError(
                'identity_changed',
                'The orphan tab is no longer an untouched shell; inspect it before recovery',
                409,
              );
            Object.assign(r, {
              paneId: panes[0].pane_id,
              terminalId: panes[0].terminal_id,
              tabId: panes[0].tab_id,
            });
          }
        } else {
          const a = (await h.call('agent.get', { target: r.paneId })).agent;
          if (
            !a ||
            a.workspace_id !== this.project(t.projectId).workspaceId ||
            a.terminal_id !== r.terminalId ||
            a.name !== r.agentName ||
            a.agent !== r.kind ||
            (r.nativeSession && a.agent_session?.value !== r.nativeSession)
          )
            throw new AppError(
              'identity_changed',
              'The original agent identity could not be established',
              409,
            );
          if (
            i.resolution === 'not-delivered' &&
            (!['idle', 'done'].includes(a.agent_status) || a.launch_pending)
          )
            throw new AppError(
              'worker_active',
              'Stop or resolve the original worker before declaring it undelivered',
              409,
            );
        }
        this.guard(i.lease);
        if (this.task(t.id).status !== 'uncertain' || this.task(t.id).runId !== r.id)
          throw new AppError(
            'reconcile_state',
            'Run changed during inspection; refresh before reconciling',
            409,
          );
        return this.store.transaction(() => {
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
        });
      }
      case 'decision.record': {
        const c = this.guard(raw.lease),
          text = z.string().min(1).parse(raw.text),
          rationale = z.string().default('').parse(raw.rationale);
        const d: Decision = {
          id: randomUUID(),
          projectId: c.projectId,
          text,
          rationale,
          owner: c.owner,
          createdAt: now(),
        };
        this.store.transaction(() => {
          this.store.put('decision', d.id, d);
          this.store.event(c.projectId, 'decision.recorded', text);
        });
        return d;
      }
      case 'inbox.read': {
        const i = z
          .object({
            projectId: z.string(),
            consumer: z.string().min(1),
            after: z.number().int().min(0).optional(),
            limit: z.number().int().min(1).max(200).default(100),
          })
          .parse(raw);
        this.project(i.projectId);
        const cursor =
          i.after ?? this.store.get<number>('cursor', i.projectId + ':' + i.consumer) ?? 0;
        const events = this.store.events(i.projectId, cursor, i.limit);
        return { events, cursor: events.at(-1)?.id ?? cursor, hasMore: events.length === i.limit };
      }
      case 'inbox.ack': {
        const i = z
          .object({
            projectId: z.string(),
            consumer: z.string().min(1),
            cursor: z.number().int().min(0),
          })
          .parse(raw);
        this.project(i.projectId);
        const id = i.projectId + ':' + i.consumer;
        const current = this.store.get<number>('cursor', id) ?? 0;
        // An acknowledgement cannot hide future events.
        const latest =
          (
            this.store.db
              .prepare('SELECT MAX(id) AS id FROM events WHERE project_id=?')
              .get(i.projectId) as { id: number | null }
          ).id ?? 0;
        if (i.cursor > latest)
          throw new AppError('cursor_future', 'Cannot acknowledge an event that does not exist');
        this.store.put('cursor', id, Math.max(current, i.cursor));
        return { cursor: Math.max(current, i.cursor) };
      }
      default:
        throw new AppError('unknown_action', `Unknown action: ${action}`, 404);
    }
  }
  controlTask(raw: any, c: Credentials, cascade = true) {
    const i = z
      .object({
        taskId: z.string(),
        key: z.string().min(1),
        type: z.enum(['redirect', 'pause', 'cancel', 'reply', 'keys']),
        text: z.string().max(50000).optional(),
        keys: z.array(z.string()).min(1).optional(),
        checks: z.array(checkSchema).min(1).optional(),
      })
      .parse(raw);
    return this.store.transaction(() => {
      let t = this.task(i.taskId);
      this.cleanup.assertMutable(t);
      if (t.projectId !== c.projectId)
        throw new AppError('project_mismatch', 'Task and lease differ');
      return this.idempotent(c.projectId, 'control:' + i.key, i, () => {
        if (terminalStates.has(t.status))
          throw new AppError('task_finished', 'Task is already finished', 409);
        if (t.runId && this.store.get<Run>('run', t.runId)?.cleanup?.state === 'closed')
          t = this.updateTask(t, { runId: undefined });
        if (['redirect', 'reply'].includes(i.type) && !i.text?.trim())
          throw new AppError('text_required', 'Provide the new instructions or answer');
        if (i.type === 'keys' && !i.keys)
          throw new AppError('keys_required', 'Provide explicit keys');
        if (t.status === 'uncertain')
          throw new AppError(
            'uncertain',
            'Reconcile the ambiguous run before sending further input',
            409,
          );
        if (
          this.store
            .all<Operation>('operation')
            .some((o) => o.taskId === t.id && !['done', 'failed'].includes(o.phase))
        )
          throw new AppError(
            'operation_pending',
            'An operation is already pending for this task',
            409,
          );
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
            throw new AppError('not_blocked', 'Reply applies to a blocked or paused task', 409);
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
            throw new AppError('no_worker', 'There is no worker to receive keys');
          const current = this.task(t.id);
          this.updateTask(
            current,
            {
              status: i.type === 'cancel' ? 'cancelled' : i.type === 'pause' ? 'paused' : 'queued',
              ...(i.type === 'redirect' ? { prompt: i.text!, checks: i.checks ?? t.checks } : {}),
              ...(i.type === 'reply'
                ? { prompt: current.prompt + '\n\nLead continuation: ' + i.text }
                : {}),
            },
            `Applied ${i.type} before dispatch`,
          );
          op.phase = 'done';
        }
        this.store.put('operation', op.id, op);
        this.store.event(t.projectId, 'control.queued', `${c.owner}: ${i.type}`, t.id);
        return op;
      });
    });
  }
  submitAssignment(rawAssignment: unknown, c: Credentials) {
    const a = assignmentSchema.parse(rawAssignment);
    if (c.projectId !== a.projectId)
      throw new AppError('project_mismatch', 'Lease does not match assignment');
    const p = this.project(a.projectId),
      cwd = realpathSync(a.cwd ?? p.root);
    const parent = a.parentId ? this.task(a.parentId) : undefined;
    if (parent) this.cleanup.assertMutable(parent);
    for (const task of this.store.all<Task>('task'))
      if (task.worktree && inside(task.worktree.path, cwd)) this.cleanup.assertMutable(task);
    const inheritedWorktree =
      parent?.projectId === p.id && parent.worktree?.state === 'ready' && parent.cwd === cwd;
    if (!inside(p.root, cwd) && !inheritedWorktree)
      throw new AppError(
        'cwd_scope',
        'Task directory must be within the registered root. Register external worktrees as projects.',
      );
    for (const path of a.ownership) {
      if (a.execution?.mode === 'worktree' && isAbsolute(path))
        throw new AppError(
          'worktree_path',
          'Worktree ownership paths must be relative to the task directory',
        );
      if (/[?*\[\]]/.test(path))
        throw new AppError(
          'ownership_path',
          'Ownership must name files or directory prefixes, not globs',
        );
      safePath(cwd, path);
    }
    for (const check of a.checks)
      if (check.type === 'file') {
        if (a.execution?.mode === 'worktree' && isAbsolute(check.path))
          throw new AppError(
            'worktree_path',
            'Worktree file checks must be relative to the task directory',
          );
        safePath(cwd, check.path);
      }
    for (const id of a.dependencies) {
      const d = this.task(id);
      if (this.cleanup.active(d.id))
        throw new AppError(
          'cleanup_busy',
          'Dependency is being cleaned up; retry after it finishes',
          409,
        );
      if (d.projectId !== a.projectId)
        throw new AppError('dependency_scope', 'Dependencies must belong to the same project');
    }
    return this.store.transaction(() =>
      this.idempotent(a.projectId, 'submit:' + a.key, a, () => {
        const { key, ...fields } = a;
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
      throw new AppError('worker_auth', 'Invalid or obsolete worker token', 401);
    if (terminalStates.has(t.status) || revision !== t.revision || r.phase === 'stopped')
      throw new AppError('stale_report', 'Report belongs to an obsolete assignment revision', 409);
    return t;
  }
  report(taskId: string, token: string, raw: unknown) {
    const i = z
      .object({
        revision: z.number().int(),
        type: z.enum(['progress', 'blocked', 'complete', 'failure', 'yield']),
        summary: z.string().min(1).max(20000),
        children: z.array(z.string()).optional(),
        artifacts: z.array(z.string()).default([]),
        evidence: z.array(z.string()).default([]),
      })
      .parse(raw);
    return this.store.transaction(() => {
      const t = this.task(taskId),
        r = t.runId ? this.store.get<Run>('run', t.runId) : undefined;
      this.cleanup.assertMutable(t);
      if (!r || hash(token) !== r.tokenHash)
        throw new AppError('worker_auth', 'Invalid or obsolete worker token', 401);
      if (terminalStates.has(t.status) || i.revision !== t.revision)
        throw new AppError(
          'stale_report',
          'Report belongs to an obsolete assignment revision',
          409,
        );
      for (const path of i.artifacts) {
        const resolved = safePath(t.cwd, path, true);
        if (!t.ownership.some((owned) => inside(safePath(t.cwd, owned), resolved)))
          throw new AppError(
            'artifact_ownership',
            'Reported artifacts must belong to this assignment',
          );
      }
      if (i.type === 'yield') {
        if (!t.canDelegate)
          throw new AppError('delegation_denied', 'Only coordinators can yield to children');
        const children =
          i.children ??
          this.tasks(t.projectId)
            .filter((c) => c.parentId === t.id)
            .map((c) => c.id);
        if (!children.length || children.some((id) => this.task(id).parentId !== t.id))
          throw new AppError('child_scope', 'Wait for one or more direct children');
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
          throw new AppError(
            'evidence_required',
            'Include artifacts or evidence with the completion report',
          );
        const late = t.status === 'blocked' && t.blockKind === 'missing-report';
        if (late) this.closeQuestions(t.id, 'Completion report received');
        this.updateTask(
          t,
          {
            ...(late ? { status: 'running', blockKind: undefined } : {}),
            receipt: {
              revision: i.revision,
              summary: i.summary,
              artifacts: i.artifacts,
              evidence: i.evidence,
              receivedAt: now(),
            },
          },
          'Worker submitted completion evidence; verification pending',
        );
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
