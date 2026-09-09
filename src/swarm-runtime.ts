import { Effect } from 'effect';
import { randomUUID } from 'node:crypto';
import { availableParallelism, freemem, loadavg } from 'node:os';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { herdrCall, sync } from './effect-runtime.js';
import { digest, safePath } from './files.js';
import { processEffect } from './process.js';
import { ScopedTasks } from './scoped-tasks.js';
import type { LeadWait } from './continuation.js';
import type { Service } from './service.js';
import type { Activity, CapacityPolicy, SwarmRequest, Watch } from './swarm-types.js';
import { now, type AgentInfo, type Credentials, type Run, type Task } from './types.js';

export interface Pressure {
  provider: string;
  until: number;
  evidence: string;
}
interface Observation {
  taskId: string;
  runId: string;
  state: string;
  source: string;
  observedAt: number;
  changedAt: number;
}
interface Doorbell {
  taskId: string;
  runId: string;
  messageId: string;
  attempts: number;
  lastAt: number;
  escalated?: boolean;
}
export interface HostCapacity {
  cpus: number;
  freeMb: number;
  load: number;
}
const settled = new Set(['idle', 'done']);
const terminal = new Set(['completed', 'failed', 'cancelled']);

/** Bounded external reads run outside transactions and belong to the supervisor's lifecycle. */
export class SwarmRuntime {
  private jobs = new ScopedTasks();
  private lastTick = 0;
  constructor(
    private s: Service,
    private host: () => HostCapacity = () => ({
      cpus: availableParallelism(),
      freeMb: freemem() / 1048576,
      load: loadavg()[0],
    }),
  ) {}
  close = Effect.fn('SwarmRuntime.close')({ self: this }, function* (this: SwarmRuntime) {
    yield* this.jobs.cancel();
  });
  recover() {
    for (const w of this.s.store.all<Watch>('swarm-watch'))
      if (w.state === 'checking') {
        // Authors must supply repeatable queries; restart re-runs an interrupted probe.
        this.s.store.put<Watch>('swarm-watch', w.id, {
          ...w,
          state: 'waiting',
          nextAt: Date.now(),
        });
      }
  }
  configure(
    i: Extract<SwarmRequest, { action: 'capacity.configure' | 'capacity.feedback' }>,
    c: Credentials,
  ) {
    if (i.action === 'capacity.configure') {
      this.s.store.put('swarm-capacity', 'instance', i.policy);
      this.s.store.event(c.projectId, 'swarm.capacity', i.reason);
      return this.capacitySnapshot(c.projectId, true);
    }
    const feedback: Pressure = {
      provider: i.provider,
      until: Date.now() + i.retryAfterMs,
      evidence: i.evidence,
    };
    this.s.store.put('swarm-pressure', i.provider, feedback);
    this.s.store.event(c.projectId, 'swarm.pressure', i.evidence);
    return feedback;
  }
  capacitySnapshot(projectId: string, update = false) {
    const policy = this.s.store.get<CapacityPolicy>('swarm-capacity', 'instance');
    if (!policy || policy.mode === 'fixed')
      return { mode: 'fixed', limits: this.s.orchestration.limits(projectId) };
    const host = this.host();
    const active =
      this.s.store
        .all<Task>('task')
        .filter((t) =>
          ['preparing', 'running', 'verifying', 'redirecting', 'cancelling', 'yielding'].includes(
            t.status,
          ),
        ).length + this.s.continuation.reservations().length;
    const memory = Math.max(1, active + Math.floor(host.freeMb / policy.memoryPerWorkerMb));
    const desired = Math.max(
      1,
      Math.min(
        policy.maxConcurrency ?? Infinity,
        memory,
        host.load > host.cpus * 1.5 ? Math.max(1, Math.floor(active / 2)) : host.cpus * 2,
      ),
    );
    const previous = this.s.store.get<{ target: number; at: number }>(
      'swarm-capacity-target',
      'instance',
    );
    const at = Date.now();
    const target = !previous
      ? Math.min(desired, Math.max(1, host.cpus))
      : desired < previous.target
        ? desired
        : at - previous.at >= 5000
          ? Math.min(desired, previous.target + 1)
          : previous.target;
    if (update && (!previous || target !== previous.target))
      this.s.store.put('swarm-capacity-target', 'instance', { target, at });
    return {
      mode: 'adaptive',
      policy,
      target,
      host,
      active,
      pressure: this.s.store.all<Pressure>('swarm-pressure').filter((p) => p.until > at),
      boundary:
        'Host load and available memory are estimates; provider throttling requires explicit feedback. This is not a spending limit.',
    };
  }
  capacityBlock(
    projectId: string,
    kind: string | undefined,
    model: string | undefined,
    active: { projectId: string; kind?: string; model?: string }[],
  ) {
    const snapshot = this.capacitySnapshot(projectId);
    if (snapshot.mode !== 'adaptive' || !snapshot.policy || snapshot.target === undefined)
      return undefined;
    const p = snapshot.policy;
    if (active.length >= snapshot.target)
      return `Adaptive host capacity reached (${snapshot.target})`;
    if (
      p.projectConcurrency &&
      active.filter((t) => t.projectId === projectId).length >= p.projectConcurrency
    )
      return 'Configured project capacity reached';
    if (kind && (snapshot.pressure ?? []).some((r) => r.provider === kind))
      return `${kind} is cooling down after reported provider pressure`;
    if (
      kind &&
      p.providers?.[kind] &&
      active.filter((t) => t.kind === kind).length >= p.providers[kind]
    )
      return `${kind} configured capacity reached`;
    if (
      model &&
      p.models?.[model] &&
      active.filter((t) => t.model === model).length >= p.models[model]
    )
      return `${model} configured capacity reached`;
    if (!model && Object.keys(p.models ?? {}).length)
      return 'An exact model is required to enforce configured model capacity';
    return undefined;
  }
  adaptive() {
    return this.s.store.get<CapacityPolicy>('swarm-capacity', 'instance')?.mode === 'adaptive';
  }
  observe(t: Task, r: Run, a: AgentInfo) {
    const old = this.s.store.get<Observation>('swarm-observation', t.id);
    const state =
      a.agent_status === 'working'
        ? 'busy'
        : a.agent_status === 'blocked'
          ? 'blocked'
          : settled.has(a.agent_status)
            ? 'idle'
            : 'unknown';
    const record: Observation = {
      taskId: t.id,
      runId: r.id,
      state,
      source: 'herdr',
      observedAt: Date.now(),
      changedAt: old?.runId === r.id && old.state === state ? old.changedAt : Date.now(),
    };
    this.s.store.put('swarm-observation', t.id, record);
  }
  unavailable(t: Task, r: Run, code: string) {
    this.s.store.put<Observation>('swarm-observation', t.id, {
      taskId: t.id,
      runId: r.id,
      state: ['agent_not_found', 'pane_not_found'].includes(code) ? 'dead' : 'unknown',
      source: `herdr:${code}`,
      observedAt: Date.now(),
      changedAt: Date.now(),
    });
  }
  notificationRecent(t: Task) {
    const d = this.s.store.get<Doorbell>('swarm-doorbell', t.id);
    return !!d && d.runId === t.runId && Date.now() - d.lastAt < 30000;
  }
  declaredWait(t: Task) {
    const a = this.s.store.get<Activity>('swarm-activity', t.id);
    if (a?.runId !== t.runId || a?.state !== 'external-wait') return false;
    return Date.now() < Math.min(a.until ?? a.observedAt + 4 * 3600000, a.observedAt + 4 * 3600000);
  }
  reportedBusy(t: Task) {
    const a = this.s.store.get<Activity>('swarm-activity', t.id);
    return !!a && a.runId === t.runId && a.state === 'busy' && Date.now() - a.observedAt < 300000;
  }
  observation(t: Task) {
    const native = this.s.store.get<Observation>('swarm-observation', t.id);
    const worker = this.s.store.get<Activity>('swarm-activity', t.id);
    if (native?.runId === t.runId && native?.source.startsWith('herdr:'))
      return {
        ...native,
        state: Date.now() - native.observedAt < 30000 ? native.state : 'unknown',
        authoritative: false,
      };
    if (this.declaredWait(t) || this.reportedBusy(t)) return { ...worker, authoritative: false };
    if (native && native.runId === t.runId && Date.now() - native.observedAt < 30000)
      return { ...native, authoritative: false };
    return {
      state: 'unknown',
      source: 'no-fresh-observation',
      observedAt: native?.observedAt ?? null,
      authoritative: false,
    };
  }
  health(projectId: string) {
    const active = this.s.tasks(projectId).filter((t) => !terminal.has(t.status));
    const waits = this.s.store
      .all<LeadWait>('lead-wait')
      .filter(
        (w) => w.projectId === projectId && ['waiting', 'ready', 'sending'].includes(w.state),
      );
    return {
      supervisorObservedAt: this.lastTick || null,
      supervisorFresh: this.lastTick > 0 && Date.now() - this.lastTick < 30000,
      objectivesWithoutWait: [...new Set(active.map((t) => t.outcomeId))].filter(
        (id) => id && !waits.some((w) => w.outcomeId === id),
      ),
      nextMessageOnly: waits
        .filter((w) => w.adapter.type === 'next-message')
        .map((w) => w.outcomeId),
      boundary:
        'A missing wait is an attention signal, not proof the lead is idle. Unsupported clients require another user message. No host turn-end hook is assumed.',
    };
  }
  tick() {
    this.lastTick = Date.now();
    const project = this.s.store.all<{ id: string }>('project')[0];
    if (project) this.capacitySnapshot(project.id, true);
    for (const w of this.s.store.all<Watch>('swarm-watch')) {
      if (w.state === 'waiting' && w.nextAt <= Date.now() && !this.jobs.has(w.id))
        this.jobs.run(w.id, this.checkWatch(w));
    }
    for (const t of this.s.store.all<Task>('task')) {
      if (
        !t.runId ||
        terminal.has(t.status) ||
        t.status === 'uncertain' ||
        this.s.cleanup.active(t.id)
      )
        continue;
      const key = `message:${t.id}`;
      const m = this.s.swarm.messages(t.id).find((m) => !m.acknowledgedAt);
      if (m && !this.jobs.has(key)) this.jobs.run(key, this.ring(t, m.id));
      const observation = this.s.store.get<Observation>('swarm-observation', t.id);
      if (!observation || observation.runId !== t.runId || this.declaredWait(t)) continue;
      const activity = this.s.store.get<Activity>('swarm-activity', t.id);
      const lastProgress = Math.max(
        observation.changedAt,
        activity?.runId === t.runId ? activity.observedAt : 0,
      );
      if (Date.now() - lastProgress > 30 * 60000) {
        const marker = `${t.runId}:${lastProgress}`;
        if (!this.s.store.get('swarm-stall', marker)) {
          this.s.store.put('swarm-stall', marker, { taskId: t.id, at: now() });
          this.s.store.event(
            t.projectId,
            'swarm.attention',
            'No new activity evidence for 30 minutes; inspect before recovery',
            t.id,
            { outcomeId: t.outcomeId },
          );
        }
      }
    }
  }
  checkWatch = Effect.fn('SwarmRuntime.checkWatch')(
    { self: this },
    function* (this: SwarmRuntime, w: Watch) {
      const reserved = yield* sync('Watch.reserve', () => {
        const current = this.s.store.get<Watch>('swarm-watch', w.id);
        if (current?.state !== 'waiting') return false;
        this.s.store.put<Watch>('swarm-watch', w.id, { ...current, state: 'checking' });
        return true;
      });
      if (!reserved) return;
      const result = yield* Effect.gen({ self: this }, function* () {
        const root = this.s.project(w.projectId).root;
        if (w.condition.type === 'file') {
          const condition = w.condition;
          return yield* sync('Watch.file', () => {
            const path = safePath(root, condition.path);
            if (!existsSync(path))
              return { passed: false, pending: true, detail: `${condition.path}: absent` };
            if (!statSync(path).isFile() || statSync(path).size > 1048576)
              return {
                passed: false,
                pending: false,
                detail: 'Condition file must be a regular file under 1 MiB',
              };
            const hash = digest(path);
            const matches =
              (!condition.sha256 || hash === condition.sha256) &&
              (condition.contains === undefined ||
                readFileSync(path, 'utf8').includes(condition.contains));
            return {
              passed: matches,
              pending: !matches,
              detail: `${condition.path}: SHA-256 ${hash}`,
            };
          });
        }
        const r = yield* processEffect(w.condition.command, w.condition.args, {
          cwd: root,
          timeout: w.condition.timeoutMs,
          maxBuffer: 65536,
        });
        return {
          passed: r.code === 0 && !r.timedOut,
          pending: r.code === 1 && !r.timedOut,
          detail: `${r.timedOut ? 'timeout' : `exit ${r.code}`}\n${r.output}`,
        };
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({ passed: false, pending: false, detail: String(error) }),
        ),
      );
      yield* sync('Watch.capture', () =>
        this.s.store.transaction(() => {
          const current = this.s.store.get<Watch>('swarm-watch', w.id);
          if (current?.state !== 'checking') return;
          if (result.pending) {
            this.s.store.put<Watch>('swarm-watch', w.id, {
              ...current,
              state: 'waiting',
              nextAt: Date.now() + w.intervalMs,
            });
            return;
          }
          const captured = {
            id: randomUUID(),
            observedAt: now(),
            detail: result.detail,
            passed: result.passed,
          };
          this.s.store.put<Watch>('swarm-watch', w.id, {
            ...current,
            state: result.passed ? 'ready' : 'failed',
            result: captured,
          });
          this.s.store.event(w.projectId, 'swarm.watch-result', w.description, w.taskId, {
            outcomeId: w.outcomeId,
            watchId: w.id,
            result: captured,
          });
        }),
      );
    },
  );
  private ring = Effect.fn('SwarmRuntime.ring')(
    { self: this },
    function* (this: SwarmRuntime, t: Task, messageId: string) {
      const r = this.s.store.get<Run>('run', t.runId!);
      if (!r?.paneId || r.phase !== 'running' || t.status !== 'running') return;
      const old = this.s.store.get<Doorbell>('swarm-doorbell', t.id);
      const d: Doorbell =
        old?.runId === r.id && old.messageId === messageId
          ? old
          : { taskId: t.id, runId: r.id, messageId, attempts: 0, lastAt: 0 };
      if (Date.now() - d.lastAt < 90000) return;
      if (d.attempts >= 3) {
        if (!d.escalated)
          yield* sync('Message.escalate', () => {
            this.s.store.put('swarm-doorbell', t.id, { ...d, escalated: true });
            this.s.store.event(
              t.projectId,
              'swarm.attention',
              'Worker has not acknowledged a pending instruction; inspect its session',
              t.id,
              { outcomeId: t.outcomeId, messageId },
            );
          });
        return;
      }
      yield* Effect.gen({ self: this }, function* () {
        const p = this.s.project(t.projectId);
        const h = this.s.port(p);
        const a: AgentInfo = (yield* herdrCall(h, 'agent.get', { target: r.paneId })).agent;
        if (
          !a ||
          a.workspace_id !== p.workspaceId ||
          a.pane_id !== r.paneId ||
          a.terminal_id !== r.terminalId ||
          a.agent !== r.kind ||
          (r.nativeSession ? a.agent_session?.value !== r.nativeSession : a.name !== r.agentName)
        )
          return;
        if (!settled.has(a.agent_status) || a.launch_pending || this.reportedBusy(t)) return;
        const current = this.s.task(t.id);
        if (
          current.runId !== r.id ||
          current.revision !== t.revision ||
          terminal.has(current.status) ||
          current.status !== 'running' ||
          this.s.cleanup.active(t.id)
        )
          return;
        if (!this.s.swarm.messages(t.id).some((m) => m.id === messageId && !m.acknowledgedAt))
          return;
        if (
          this.s.store
            .all<{ taskId: string; phase: string }>('operation')
            .some((o) => o.taskId === t.id && !['done', 'failed'].includes(o.phase))
        )
          return;
        yield* sync('Message.reserve', () => {
          this.s.orchestration.reserveTurn(current);
          this.s.store.put('swarm-doorbell', t.id, {
            ...d,
            lastAt: Date.now(),
            attempts: d.attempts + 1,
          });
          this.s.store.event(
            t.projectId,
            'swarm.notification',
            'Reserved an instruction notification turn',
            t.id,
            { outcomeId: t.outcomeId, runId: r.id, messageId },
          );
        });
        // Only the notification repeats. The payload and acknowledgement stay durable and addressed.
        yield* herdrCall(h, 'agent.prompt', {
          target: r.paneId,
          text: 'Marionette has pending instructions. Use worker_inspect, read instructions in order, and acknowledge each with worker_call action message.ack and its messageId. Do not repeat an instruction already acknowledged. Continue only within the current assignment and writable paths.',
        });
      }).pipe(
        Effect.catch((error) =>
          sync('Message.delivery', () => {
            this.s.store.put('swarm-doorbell', t.id, {
              ...d,
              lastAt: Date.now(),
              attempts: d.attempts + 1,
            });
            this.s.store.event(
              t.projectId,
              'swarm.attention',
              `Instruction notification unconfirmed: ${String(error)}`,
              t.id,
              { outcomeId: t.outcomeId, messageId },
            );
          }),
        ),
      );
    },
  );
}
