import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { z } from 'zod';
import { composeHerdrAdapter } from '../../src/v1/adapters/herdr.js';
import { Board } from '../../src/v1/board.js';
import { Marionette } from '../../src/v1/client.js';
import { createBinding, localSessionContext, writeSessionContext } from '../../src/v1/context.js';
import {
  AgentSessionIdSchema,
  DigestSchema,
  ProjectBindingSchema,
  WorkspaceIdSchema,
} from '../../src/v1/model.js';
import {
  HerdrNativeAdapter,
  NativeBindingSchema,
  type LaunchRequest,
  type LaunchResult,
  type NativeBinding,
  type NativeIdentity,
  type NativeJournal,
  type NativeObservation,
  type NativeSubmission,
} from '../../src/v1/native.js';
import { Runtime } from '../../src/v1/runtime.js';
import { Settings, profileSchema } from '../../src/v1/settings.js';
import { Store } from '../../src/v1/store.js';
import { WakeListener, pokeWatcher, wakeSocketPath } from '../../src/v1/wake.js';

/**
 * These tests own a project of their own, so an inherited managed context would
 * only bind them to somebody else's. Detach it for the whole file.
 */
const inheritedContext = process.env.MARIONETTE_CONTEXT;
delete process.env.MARIONETTE_CONTEXT;
test.after(() => {
  if (inheritedContext !== undefined) process.env.MARIONETTE_CONTEXT = inheritedContext;
});

function project(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'mw-'));
  const repositoryRoot = join(root, 'repo');
  const stateHome = join(root, 'state');
  mkdirSync(repositoryRoot);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const client = Marionette.init({ repositoryRoot, stateHome });
  t.after(() => client.close());
  return { root, repositoryRoot, stateHome, client, context: client.context() };
}

/** Opens a second handle on the same database, to act as somebody other than the client. */
function observer(t: TestContext, context: ReturnType<Marionette['context']>) {
  const store = Store.open({
    databasePath: join(context.project.stateDirectory, 'project.sqlite'),
    project: ProjectBindingSchema.parse(context.project),
  });
  t.after(() => store.close());
  return { store, board: Board.create({ store }) };
}

function deliveryState(store: Store, projectId: string): string | undefined {
  const row = store.read((db) =>
    db
      .prepare('SELECT state FROM notification_deliveries WHERE project_id=? LIMIT 1')
      .get(projectId),
  );
  return row === undefined ? undefined : z.object({ state: z.string() }).parse(row).state;
}

async function until(predicate: () => boolean, deadlineMs: number): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    if (predicate()) return Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`condition did not hold within ${deadlineMs}ms`);
}

/**
 * Counts delivery passes while reporting no durable work.
 *
 * The loop consults this once per delivery pass, which makes it the only
 * deterministic way to know the watcher has finished its first pass and is
 * asleep. Without that, a post can be picked up by a pass that was already
 * running, and a wake gets credited to a poke that had nothing to do with it.
 */
function passCounter() {
  let passes = 0;
  return {
    passes: () => passes,
    port: {
      hasPendingWork: async () => {
        passes += 1;
        return false;
      },
    },
  };
}

/** Creates a thread with a desktop subscriber, so a client post produces a delivery. */
function subscribedThread(client: Marionette, board: Board) {
  const thread = client.createThread({ title: 'Wake', idempotencyKey: 'wake-thread' });
  board.subscribe({ subscriber: { kind: 'desktop', id: 'lead' }, threadId: thread.id });
  return thread;
}

test('a committed post wakes the watcher over its socket well inside the fallback interval', async (t) => {
  const fixture = project(t);
  const watched = observer(t, fixture.context);
  const thread = subscribedThread(fixture.client, watched.board);
  const abort = new AbortController();
  t.after(() => abort.abort());
  // A fallback this long cannot explain any wake: only the poke can.
  const fallbackIntervalMs = 60_000;
  const running = fixture.client.watch({
    signal: abort.signal,
    idleTimeoutMs: 60_000,
    fallbackIntervalMs,
  });
  await until(
    () =>
      existsSync(
        wakeSocketPath(fixture.context.project.stateDirectory, fixture.context.project.id),
      ),
    5_000,
  );

  fixture.client.post({
    threadId: thread.id,
    body: 'Ready for review',
    kind: 'question',
    idempotencyKey: 'p1',
  });
  assert.equal(deliveryState(watched.store, fixture.context.project.id), 'pending');
  const committed = Date.now();
  await fixture.client.ensureWatcher();
  const latencyMs = await until(
    () => deliveryState(watched.store, fixture.context.project.id) !== 'pending',
    5_000,
  );
  abort.abort();
  const stopped = await running;
  assert.ok(
    Date.now() - committed < fallbackIntervalMs,
    'the wake must not have waited for the fallback interval',
  );
  assert.ok(stopped.wakes >= 1, `the loop recorded a poke (wakes=${stopped.wakes})`);
  assert.ok(
    stopped.deliveryPasses >= 2,
    `the poke drove an extra delivery pass (${stopped.deliveryPasses})`,
  );
  assert.equal(
    stopped.wakeEndpoint,
    wakeSocketPath(fixture.context.project.stateDirectory, fixture.context.project.id),
  );
  // Reported, not asserted against a target: the number is this host's, today.
  t.diagnostic(`commit-to-act latency: ${latencyMs}ms over a real local socket`);
});

test('a post whose poke is never sent still reaches the watcher on its fallback interval', async (t) => {
  const fixture = project(t);
  const watched = observer(t, fixture.context);
  const thread = subscribedThread(fixture.client, watched.board);
  const abort = new AbortController();
  t.after(() => abort.abort());
  const running = fixture.client.watch({
    signal: abort.signal,
    idleTimeoutMs: 60_000,
    fallbackIntervalMs: 150,
  });
  await until(
    () =>
      existsSync(
        wakeSocketPath(fixture.context.project.stateDirectory, fixture.context.project.id),
      ),
    5_000,
  );
  // Commit without ever calling ensureWatcher: this is the lost-poke path.
  fixture.client.post({
    threadId: thread.id,
    body: 'No poke follows this',
    kind: 'question',
    idempotencyKey: 'p1',
  });
  const latencyMs = await until(
    () => deliveryState(watched.store, fixture.context.project.id) !== 'pending',
    5_000,
  );
  abort.abort();
  const stopped = await running;
  assert.equal(stopped.wakes, 0, 'no poke was ever delivered');
  t.diagnostic(`missed-poke recovery latency: ${latencyMs}ms on a 150ms fallback`);
});

// Strict coalescing is proven against the listener in wake.test.ts, where
// nothing consumes the signal between pokes. Here the minimum pass interval is
// what collapses a burst: signals that land inside one interval cost one pass.
test('a burst of pokes collapses into a bounded number of passes', async (t) => {
  const fixture = project(t);
  const abort = new AbortController();
  t.after(() => abort.abort());
  const counter = passCounter();
  const running = fixture.client.watch({
    signal: abort.signal,
    idleTimeoutMs: 60_000,
    fallbackIntervalMs: 60_000,
    pendingWork: counter.port,
  });
  // Let the watcher finish a pass and go to sleep before the burst arrives.
  await until(() => counter.passes() >= 1, 5_000);
  const settled = counter.passes();
  const burst = 50;
  const delivered = await Promise.all(
    Array.from({ length: burst }, () =>
      pokeWatcher({
        stateDirectory: fixture.context.project.stateDirectory,
        projectId: fixture.context.project.id,
      }),
    ),
  );
  assert.equal(delivered.filter(Boolean).length, burst, 'every poke reached the listener');
  // Let the burst actually reach the loop before measuring what it cost.
  await until(() => counter.passes() > settled, 5_000);
  abort.abort();
  const stopped = await running;
  assert.ok(stopped.wakes >= 1, 'the burst was received');
  assert.ok(
    stopped.deliveryPasses < burst,
    `${burst} pokes collapsed into ${stopped.deliveryPasses} passes`,
  );
  assert.equal(stopped.deliveries, 0, 'a poke alone never manufactures delivery work');
  assert.equal(stopped.reconciliations, 0, 'nor a native observation');
  t.diagnostic(
    `${burst} pokes produced ${stopped.deliveryPasses} delivery passes and ${stopped.wakes} recorded wakes`,
  );
});

test('an idle watcher does bounded work and observes nothing natively', async (t) => {
  const fixture = project(t);
  const abort = new AbortController();
  const fallbackIntervalMs = 100;
  const runFor = 600;
  setTimeout(() => abort.abort(), runFor);
  const stopped = await fixture.client.watch({
    signal: abort.signal,
    idleTimeoutMs: 60_000,
    fallbackIntervalMs,
  });
  assert.equal(stopped.reconciliations, 0, 'no attempts means no native observation');
  assert.equal(stopped.deliveries, 0);
  const bound = Math.ceil(runFor / fallbackIntervalMs) + 2;
  assert.ok(
    stopped.deliveryPasses <= bound && stopped.reconcilePasses <= bound,
    `idle passes stay bounded by the fallback interval (${stopped.deliveryPasses} delivery, ${stopped.reconcilePasses} reconcile)`,
  );
  t.diagnostic(
    `${stopped.deliveryPasses} delivery and ${stopped.reconcilePasses} reconcile passes in ${runFor}ms at a ${fallbackIntervalMs}ms fallback`,
  );
});

test('a slow delivery schedule does not hold up native reconciliation', async (t) => {
  const fixture = project(t);
  let deliveryPasses = 0;
  const pendingWork = {
    hasPendingWork: async () => {
      deliveryPasses += 1;
      await new Promise((resolve) => setTimeout(resolve, 300));
      return true;
    },
  };
  const abort = new AbortController();
  const runFor = 900;
  setTimeout(() => abort.abort(), runFor);
  const stopped = await fixture.client.watch({
    signal: abort.signal,
    idleTimeoutMs: 60_000,
    fallbackIntervalMs: 30,
    reconcileIntervalMs: 30,
    pendingWork,
  });
  assert.ok(
    deliveryPasses <= 4,
    `delivery really was slow (${deliveryPasses} passes in ${runFor}ms)`,
  );
  assert.ok(
    stopped.reconcilePasses > deliveryPasses * 2,
    `reconciliation kept its own cadence (${stopped.reconcilePasses} reconcile vs ${deliveryPasses} delivery)`,
  );
  t.diagnostic(
    `${runFor}ms with a 300ms delivery pass: ${deliveryPasses} delivery, ${stopped.reconcilePasses} reconcile`,
  );
});

test('an aborted watch releases its endpoint and settles its ownership', async (t) => {
  const fixture = project(t);
  const watched = observer(t, fixture.context);
  const abort = new AbortController();
  const running = fixture.client.watch({ signal: abort.signal, fallbackIntervalMs: 60_000 });
  const path = wakeSocketPath(fixture.context.project.stateDirectory, fixture.context.project.id);
  await until(() => existsSync(path), 5_000);
  abort.abort();
  const stopped = await running;
  assert.equal(stopped.stopped, true);
  assert.equal(existsSync(path), false, 'scoped cleanup removed the endpoint');
  const owner = watched.store.read((db) =>
    db
      .prepare('SELECT generation,settled_at FROM watcher_owners WHERE project_id=?')
      .get(fixture.context.project.id),
  );
  const parsed = z
    .object({ generation: z.string(), settled_at: z.string().datetime() })
    .parse(owner);
  assert.equal(parsed.generation, stopped.generation);
});

test('a watcher that loses ownership fails closed instead of continuing to deliver', async (t) => {
  const fixture = project(t);
  const watched = observer(t, fixture.context);
  const abort = new AbortController();
  t.after(() => abort.abort());
  const running = fixture.client.watch({
    signal: abort.signal,
    idleTimeoutMs: 60_000,
    fallbackIntervalMs: 50,
  });
  await until(
    () =>
      existsSync(
        wakeSocketPath(fixture.context.project.stateDirectory, fixture.context.project.id),
      ),
    5_000,
  );
  // Another generation takes the project, as a restart after a stale owner would.
  watched.store.transaction((db) =>
    db
      .prepare('UPDATE watcher_owners SET generation=?,process_identity=? WHERE project_id=?')
      .run(randomUUID(), 'another-watcher', fixture.context.project.id),
  );
  await assert.rejects(running, /watcher (no longer owns this project|ownership changed)/);
});

test('a worker may poke an existing watcher but may never own or spawn one', async (t) => {
  const fixture = project(t);
  const watched = observer(t, fixture.context);
  const token = randomBytes(32).toString('hex');
  const sessionId = `worker-${randomUUID()}`;
  watched.store.registerSession({
    id: AgentSessionIdSchema.parse(sessionId),
    generation: 1,
    workspaceId: null,
    role: 'worker',
    executionRole: 'direct',
    tokenHash: createHash('sha256').update(token).digest('hex'),
    parentWorkflowId: null,
    attemptId: null,
    nativeKind: null,
    nativeServerGeneration: null,
    nativeLocator: null,
  });
  const contextPath = writeSessionContext({
    stateDirectory: fixture.context.project.stateDirectory,
    context: {
      version: 1,
      bindingPath: fixture.context.bindingPath,
      projectId: fixture.context.project.id,
      hostId: fixture.context.project.hostId,
      sessionId,
      generation: 1,
      token,
    },
  });
  const worker = Marionette.connect({
    cwd: fixture.repositoryRoot,
    env: { MARIONETTE_STATE_HOME: fixture.stateHome, MARIONETTE_CONTEXT: contextPath },
  });
  t.after(() => worker.close());
  assert.equal(worker.context().session.role, 'worker');

  // Stand in for a watcher that already owns the project by generation.
  const listener = await WakeListener.listen({
    stateDirectory: fixture.context.project.stateDirectory,
    projectId: fixture.context.project.id,
  });
  t.after(() => listener.close());
  await worker.ensureWatcher();
  assert.equal(listener.accepted, 1, 'the worker woke the existing watcher');
  assert.equal(listener.take(), true);
  assert.equal(
    existsSync(join(fixture.context.project.stateDirectory, 'watcher.log')),
    false,
    'the worker never spawned a watcher of its own',
  );
  assert.equal(
    watched.store.read((db) =>
      db.prepare('SELECT 1 FROM watcher_owners WHERE project_id=?').get(fixture.context.project.id),
    ),
    undefined,
    'and never claimed watcher ownership',
  );
  await assert.rejects(
    worker.watch({ signal: new AbortController().signal }),
    /Workers cannot own the project watcher/,
  );
});

test('the idle timer defers to the watcher pending-work predicate', async (t) => {
  const fixture = project(t);
  // The shape Watcher.hasPendingWork() fills: a cheap, side-effect-free boolean.
  let queued = true;
  let asked = 0;
  const pendingWork = {
    hasPendingWork: async () => {
      asked += 1;
      return queued;
    },
  };
  const abort = new AbortController();
  t.after(() => abort.abort());
  const running = fixture.client.watch({
    signal: abort.signal,
    idleTimeoutMs: 60,
    fallbackIntervalMs: 20,
    pendingWork,
  });
  // While the predicate reports work, the watcher must not idle out.
  await until(() => asked > 1, 5_000);
  assert.equal(
    await Promise.race([running.then(() => 'exited'), Promise.resolve('running')]),
    'running',
    'a watcher with pending work never idles out',
  );
  queued = false;
  const stopped = await running;
  assert.equal(stopped.stopped, true, 'and idles out once the predicate goes quiet');
});

/** Counts every native observation a runtime performs, to price a watcher pass. */
function countingRuntime(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'mo-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const context = createBinding({ repositoryRoot: repo, stateRoot: join(root, 'state') });
  const local = localSessionContext(context);
  const store = Store.open({
    databasePath: context.binding.databasePath,
    project: ProjectBindingSchema.parse({
      id: context.binding.projectId,
      hostId: context.binding.hostId,
      repositoryRoot: repo,
      stateDirectory: context.binding.stateDirectory,
    }),
  });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const actor = store.registerSession({
    id: AgentSessionIdSchema.parse(local.sessionId),
    generation: local.generation,
    workspaceId: null,
    role: 'user',
    executionRole: 'user',
    tokenHash: createHash('sha256').update(local.token).digest('hex'),
    parentWorkflowId: null,
    attemptId: null,
    nativeKind: null,
    nativeServerGeneration: null,
    nativeLocator: null,
  });
  const workspace = store.registerWorkspace({
    actor,
    id: WorkspaceIdSchema.parse('workspace-test'),
    kind: 'existing',
    path: repo,
    repositoryRoot: repo,
    baseCommit: null,
    access: 'inspect',
    writes: [],
    idempotencyKey: 'workspace',
  });
  const text = 'Read-only check';
  const job = store.createJob({
    actor,
    stableKey: 'job',
    request: {
      text,
      digest: DigestSchema.parse(createHash('sha256').update(text).digest('hex')),
      inputSnapshots: [],
    },
    brief: {
      objective: text,
      scope: [],
      ownership: [],
      constraints: [],
      standingOrders: [],
      inputSnapshots: [],
    },
    workspaceId: workspace.id,
    delivery: 'report',
    origin: { kind: 'direct' },
    dependencies: [],
    idempotencyKey: 'job',
  });
  const settings = new Settings(store, actor);
  settings.set({
    key: 'profile/test',
    value: { name: 'test', kind: 'agy', model: 'm', args: ['--model', 'm'] },
    schema: profileSchema,
    expectedRevision: 0,
    idempotencyKey: 'profile',
  });
  const binding: NativeBinding = {
    hostId: store.project.hostId,
    socketPath: '/fixture/herdr.sock',
    workspaceId: 'w1',
    endpoint: { device: 1, inode: 2, birthtimeMs: 3, serverStartToken: 'server', protocol: 22 },
  };
  settings.set({
    key: 'native/w1',
    value: binding,
    schema: NativeBindingSchema,
    expectedRevision: 0,
    idempotencyKey: 'native',
  });
  let observations = 0;
  class Adapter extends HerdrNativeAdapter {
    constructor(private readonly effects: NativeJournal) {
      super(effects);
    }
    override async launch(_binding: NativeBinding, _request: LaunchRequest): Promise<LaunchResult> {
      const prepared = await this.effects.prepare({ kind: 'create-tab', workspaceId: 'w1' });
      assert.equal(prepared.kind, 'prepared');
      return {
        kind: 'launched',
        identity: {
          binding,
          tabId: 'w1:t2',
          paneId: 'w1:p2',
          terminalId: 'terminal-test',
          agentKind: 'agy',
          agentName: 'fixture-agent',
          nativeSession: 'native-session',
          identityRevision: 1,
          ownedTabId: 'w1:t2',
        },
      };
    }
    override async prompt(identity: NativeIdentity, text: string): Promise<NativeSubmission> {
      const prepared = await this.effects.prepare({
        kind: 'prompt',
        paneId: identity.paneId,
        textDigest: createHash('sha256').update(text).digest('hex'),
      });
      if (prepared.kind === 'rejected') throw new Error(prepared.reason);
      return { kind: 'submitted', operationId: prepared.operationId };
    }
    override async observe(identity: NativeIdentity): Promise<NativeObservation> {
      observations += 1;
      return { kind: 'working', identity };
    }
  }
  const runtime = new Runtime(store, actor, context, (journal) =>
    composeHerdrAdapter(new Adapter(journal)),
  );
  return {
    runtime,
    observations: () => observations,
    phase: (id: string, phase: string) =>
      store.transaction((db) =>
        db
          .prepare('UPDATE native_attempts SET phase=? WHERE project_id=? AND attempt_id=?')
          .run(phase, store.project.id, id),
      ),
    reset: () => {
      observations = 0;
    },
    input: {
      jobId: job.id,
      profile: 'test',
      nativeWorkspaceId: 'w1',
      inputResultIds: [],
      expectedBriefRevision: 1,
      idempotencyKey: 'admit',
    },
  };
}

test('a running attempt costs one native observation per pass instead of two', async (t) => {
  const fixture = countingRuntime(t);
  const id = fixture.runtime.admit(fixture.input);
  assert.equal(
    fixture.runtime.needsStartProgress(id),
    true,
    'an admitted attempt is owed a launch',
  );
  await fixture.runtime.start(id);
  assert.equal(
    fixture.runtime.needsStartProgress(id),
    false,
    'a running attempt is owed no start progress',
  );
  // A process lost between the launch and its prompt leaves the attempt here,
  // and it must still be offered start progress on the next pass.
  fixture.phase(id, 'launched');
  assert.equal(
    fixture.runtime.needsStartProgress(id),
    true,
    'a launched attempt is owed its prompt',
  );
  fixture.phase(id, 'active');

  // The pass the watcher used to run, unconditionally.
  fixture.reset();
  await fixture.runtime.start(id);
  await fixture.runtime.reconcile(id);
  const before = fixture.observations();

  // The pass it runs now.
  fixture.reset();
  if (fixture.runtime.needsStartProgress(id)) await fixture.runtime.start(id);
  await fixture.runtime.reconcile(id);
  const after = fixture.observations();

  assert.equal(before, 2, 'start() and reconcile() each observed the same running attempt');
  assert.equal(after, 1, 'only reconcile() observes it now');
  t.diagnostic(`native observations per pass for a running attempt: ${before} -> ${after}`);
});
