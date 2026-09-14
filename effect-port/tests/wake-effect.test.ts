import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Effect, Schema } from 'effect';
import { composeHerdrAdapter } from '../src/v1/adapters/herdr.js';
import { Board } from '../src/v1/board.js';
import { Marionette } from '../src/v1/client.js';
import { createBinding, localSessionContext, writeSessionContext } from '../src/v1/context.js';
import {
  AgentSessionIdSchema,
  DigestSchema,
  ProjectBindingSchema,
  WorkspaceIdSchema,
} from '../src/v1/model.js';
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
} from '../src/v1/native.js';
import { Runtime } from '../src/v1/runtime.js';
import { Settings, profileSchema } from '../src/v1/settings.js';
import { Store } from '../src/v1/store.js';
import {
  MAX_WAKE_PAYLOAD_BYTES,
  MAX_WAKE_SOCKET_PATH_BYTES,
  WakeListener,
  pokeWatcher,
  pokeWatcherEffect,
  wakeSocketPath,
  wakeSocketPathFits,
} from '../src/v1/wake.js';

const decode = <S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  value: unknown,
): S['Type'] => Schema.decodeUnknownSync(schema)(value);

/**
 * These tests own a project of their own, so an inherited managed context would
 * only bind them to somebody else's. Detach it for the whole file.
 */
const inheritedContext = process.env.MARIONETTE_CONTEXT;
delete process.env.MARIONETTE_CONTEXT;
test.after(() => {
  if (inheritedContext !== undefined) process.env.MARIONETTE_CONTEXT = inheritedContext;
});

function stateDirectory(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'mw-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Marionette creates project state directories 0700; mirror that, because the
  // endpoint refuses a directory other users can reach.
  const directory = join(root, 'projects', 'project-a');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

async function listener(t: TestContext, directory: string, projectId = 'project-a') {
  const bound = await WakeListener.listen({ stateDirectory: directory, projectId });
  t.after(() => bound.close());
  return bound;
}

/** Sends a raw payload the public sender would refuse, to exercise receiver limits. */
function sendRaw(path: string, payload: string | Buffer): Promise<void> {
  return new Promise<void>((resolve) => {
    const socket = connect(path);
    socket.once('connect', () => socket.end(payload));
    socket.once('close', () => resolve());
    socket.once('error', () => resolve());
  });
}

/** Binds the endpoint from another process so SIGKILL can strand the socket file. */
async function strandedOwner(t: TestContext, directory: string) {
  const path = wakeSocketPath(directory, 'project-a');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const child = spawn(
    process.execPath,
    [
      '-e',
      `require('node:net').createServer().listen(${JSON.stringify(path)},()=>console.log('bound'))`,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  t.after(() => child.kill('SIGKILL'));
  await new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => resolve());
    child.once('error', reject);
    child.once('exit', () => reject(new Error('the stranded owner exited before it bound')));
  });
  return { path, child };
}

test('a poke sent after a committed change wakes a waiting listener', async (t) => {
  const directory = stateDirectory(t);
  const bound = await listener(t, directory);
  assert.equal(bound.unavailable, null);
  const waiting = Effect.runPromise(bound.waitEffect({ timeoutMs: 5_000 }));
  assert.equal(
    await Effect.runPromise(
      pokeWatcherEffect({ stateDirectory: directory, projectId: 'project-a' }),
    ),
    true,
  );
  assert.equal(await waiting, 'poked');
  assert.equal(bound.take(), true);
  assert.equal(bound.take(), false);
  assert.equal(bound.accepted, 1);
});

test('a poke that lands before the wait is not lost', async (t) => {
  const directory = stateDirectory(t);
  const bound = await listener(t, directory);
  assert.equal(await pokeWatcher({ stateDirectory: directory, projectId: 'project-a' }), true);
  assert.equal(await Effect.runPromise(bound.waitEffect({ timeoutMs: 5_000 })), 'poked');
  assert.equal(bound.take(), true);
});

test('a burst of pokes coalesces into one signal', async (t) => {
  const directory = stateDirectory(t);
  const bound = await listener(t, directory);
  const burst = 25;
  const delivered = await Effect.runPromise(
    Effect.forEach(
      Array.from({ length: burst }, () => 0),
      () =>
        // A generous timeout: under load a poke may legitimately give up, and
        // the point here is what the accepted ones cost, not how many land.
        pokeWatcherEffect({
          stateDirectory: directory,
          projectId: 'project-a',
          timeoutMs: 5_000,
        }),
      { concurrency: burst },
    ),
  );
  const landed = delivered.filter(Boolean).length;
  assert.ok(landed > 1, `the burst needs several pokes to coalesce (landed=${landed})`);
  assert.equal(bound.accepted, landed, 'every poke the sender confirmed was received');
  assert.equal(bound.take(), true, 'the burst leaves exactly one signal');
  assert.equal(bound.take(), false, 'and the signal is consumed once');
});

test('the receiver refuses foreign, malformed and oversized payloads', async (t) => {
  const directory = stateDirectory(t);
  const bound = await listener(t, directory);
  await sendRaw(bound.path, JSON.stringify({ v: 1, projectId: 'project-b' }));
  await sendRaw(bound.path, 'not json\n');
  await sendRaw(bound.path, JSON.stringify({ v: 2, projectId: 'project-a' }));
  await sendRaw(bound.path, Buffer.alloc(MAX_WAKE_PAYLOAD_BYTES + 1, 0x61));
  assert.equal(bound.take(), false, 'none of those may wake this project');
  assert.equal(bound.accepted, 0);
  assert.equal(bound.refused, 4);
  assert.equal(await pokeWatcher({ stateDirectory: directory, projectId: 'project-a' }), true);
  assert.equal(bound.take(), true);
});

test('a missed poke costs latency only: the wait falls back on its own timer', async (t) => {
  const directory = stateDirectory(t);
  const bound = await listener(t, directory);
  assert.equal(await Effect.runPromise(bound.waitEffect({ timeoutMs: 120 })), 'timeout');
  assert.equal(bound.take(), false);
});

test('interrupting a wait releases it without consuming a signal', async (t) => {
  const directory = stateDirectory(t);
  const bound = await listener(t, directory);
  const interrupted = await Effect.runPromise(
    Effect.exit(Effect.timeout(bound.waitEffect({ timeoutMs: 60_000 }), '60 millis')),
  );
  assert.equal(interrupted._tag, 'Failure', 'the wait is interruptible');
  assert.equal(await pokeWatcher({ stateDirectory: directory, projectId: 'project-a' }), true);
  assert.equal(bound.take(), true, 'and the listener still receives afterwards');
});

test('scoped cleanup removes the endpoint', async (t) => {
  const directory = stateDirectory(t);
  const path = wakeSocketPath(directory, 'project-a');
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          WakeListener.listenEffect({ stateDirectory: directory, projectId: 'project-a' }),
          (bound) => Effect.sync(() => bound.close()),
        );
        assert.ok(existsSync(path), 'the endpoint exists inside the scope');
      }),
    ),
  );
  assert.equal(existsSync(path), false, 'and is gone once the scope closes');
});

test('the endpoint is private to its owner', async (t) => {
  const directory = stateDirectory(t);
  const bound = await listener(t, directory);
  assert.equal(statSync(bound.path).mode & 0o777, 0o600);
});

test('a restart rebinds over the socket a killed owner left behind', async (t) => {
  const directory = stateDirectory(t);
  const owner = await strandedOwner(t, directory);
  owner.child.kill('SIGKILL');
  await new Promise<void>((resolve) => owner.child.once('exit', () => resolve()));
  assert.ok(existsSync(owner.path), 'SIGKILL strands the endpoint file');
  const restarted = await listener(t, directory);
  assert.equal(restarted.unavailable, null);
  assert.equal(await pokeWatcher({ stateDirectory: directory, projectId: 'project-a' }), true);
  assert.equal(restarted.take(), true);
});

test('a regular file occupying the endpoint is preserved, never removed', async (t) => {
  const directory = stateDirectory(t);
  const path = wakeSocketPath(directory, 'project-a');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, 'not a socket');
  const bound = await listener(t, directory);
  assert.match(String(bound.unavailable), /not a socket/);
  assert.equal(readFileSync(path, 'utf8'), 'not a socket');
});

test('an endpoint that cannot be probed conclusively is left in place', async (t) => {
  const directory = stateDirectory(t);
  const owner = await strandedOwner(t, directory);
  owner.child.kill('SIGKILL');
  await new Promise<void>((resolve) => owner.child.once('exit', () => resolve()));
  // The socket is genuinely stale, but an unreadable one cannot prove that:
  // EACCES is not ECONNREFUSED, so absence is not established.
  chmodSync(owner.path, 0o000);
  const bound = await listener(t, directory);
  assert.ok(bound.unavailable, 'the listener degrades rather than guessing');
  assert.ok(existsSync(owner.path), 'and leaves the endpoint it could not classify');
});

test('an endpoint directory reached through a symbolic link is refused', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mw-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const real = join(root, 'projects', 'real-a');
  mkdirSync(real, { recursive: true, mode: 0o700 });
  // The state directory itself is the link, so the endpoint would be bound
  // somewhere this process never verified.
  const directory = join(root, 'projects', 'project-a');
  symlinkSync(real, directory);
  const bound = await listener(t, directory);
  assert.match(String(bound.unavailable), /symbolic link/);
  assert.equal(existsSync(join(real, 'wake.sock')), false, 'nothing was bound through the link');
});

test('an endpoint directory other users can reach is refused', async (t) => {
  const directory = stateDirectory(t);
  const path = wakeSocketPath(directory, 'project-a');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o755);
  const bound = await listener(t, directory);
  assert.match(String(bound.unavailable), /other users/);
  assert.equal(existsSync(path), false);
});

test('a live owner is never displaced by a second listener', async (t) => {
  const directory = stateDirectory(t);
  const first = await listener(t, directory);
  const second = await listener(t, directory);
  assert.equal(first.unavailable, null);
  assert.ok(second.unavailable, 'the second listener reports why it cannot receive');
  assert.equal(await pokeWatcher({ stateDirectory: directory, projectId: 'project-a' }), true);
  assert.equal(first.take(), true);
  assert.equal(second.take(), false);
});

test('poking an absent watcher is a quiet no-op', async (t) => {
  const directory = stateDirectory(t);
  assert.equal(await pokeWatcher({ stateDirectory: directory, projectId: 'project-a' }), false);
});

test('a state directory the platform cannot address degrades to the fallback timer', async (t) => {
  const root = stateDirectory(t);
  const deep = join(root, 'd'.repeat(MAX_WAKE_SOCKET_PATH_BYTES), 'projects', 'project-a');
  mkdirSync(deep, { recursive: true, mode: 0o700 });
  assert.equal(wakeSocketPathFits(wakeSocketPath(deep, 'project-a')), false);
  const bound = await listener(t, deep);
  assert.ok(bound.unavailable);
  assert.equal(await pokeWatcher({ stateDirectory: deep, projectId: 'project-a' }), false);
  assert.equal(await Effect.runPromise(bound.waitEffect({ timeoutMs: 60 })), 'timeout');
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

function observer(t: TestContext, context: ReturnType<Marionette['context']>) {
  const store = Store.open({
    databasePath: join(context.project.stateDirectory, 'project.sqlite'),
    project: decode(ProjectBindingSchema, context.project),
  });
  t.after(() => store.close());
  return { store, board: Board.create({ store }) };
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
      hasPendingWorkEffect: () =>
        Effect.sync(() => {
          passes += 1;
          return false;
        }),
    },
  };
}

function deliveryState(store: Store, projectId: string): string | undefined {
  const row = store.read((db) =>
    db
      .prepare('SELECT state FROM board_subscription_wakes WHERE project_id=? LIMIT 1')
      .get(projectId),
  );
  return row === undefined ? undefined : decode(Schema.Struct({ state: Schema.String }), row).state;
}

async function until(predicate: () => boolean, deadlineMs: number): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    if (predicate()) return Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`condition did not hold within ${deadlineMs}ms`);
}

test('a committed post wakes the watcher over its socket well inside the fallback', async (t) => {
  const fixture = project(t);
  const watched = observer(t, fixture.context);
  const thread = fixture.client.createThread({ title: 'Wake', idempotencyKey: 'wake-thread' });
  watched.board.subscribe({ subscriber: { kind: 'desktop', id: 'lead' }, threadId: thread.id });
  const abort = new AbortController();
  t.after(() => abort.abort());
  const fallbackIntervalMs = 60_000;
  const counter = passCounter();
  const running = fixture.client.watch({
    signal: abort.signal,
    idleTimeoutMs: 60_000,
    fallbackIntervalMs,
    pendingWork: counter.port,
  });
  const endpoint = wakeSocketPath(
    fixture.context.project.stateDirectory,
    fixture.context.project.id,
  );
  // Let the watcher finish a pass and go to sleep before anything is committed.
  await until(() => counter.passes() >= 1, 5_000);
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
  assert.ok(Date.now() - committed < fallbackIntervalMs);
  assert.ok(stopped.wakes >= 1, `the loop recorded a poke (wakes=${stopped.wakes})`);
  assert.equal(stopped.wakeEndpoint, endpoint);
  t.diagnostic(`commit-to-act latency: ${latencyMs}ms over a real local socket`);
});

test('a post whose poke is never sent still reaches the watcher on its fallback', async (t) => {
  const fixture = project(t);
  const watched = observer(t, fixture.context);
  const thread = fixture.client.createThread({ title: 'Wake', idempotencyKey: 'wake-thread' });
  watched.board.subscribe({ subscriber: { kind: 'desktop', id: 'lead' }, threadId: thread.id });
  const abort = new AbortController();
  t.after(() => abort.abort());
  const counter = passCounter();
  const running = fixture.client.watch({
    signal: abort.signal,
    idleTimeoutMs: 60_000,
    fallbackIntervalMs: 150,
    pendingWork: counter.port,
  });
  // Let the watcher finish a pass and go to sleep, so the recovery below is the
  // fallback interval doing its job rather than a pass that was already running.
  await until(() => counter.passes() >= 1, 5_000);
  // Commit without ever calling ensureWatcher: this is the lost-poke path.
  watched.board.post({
    threadId: thread.id,
    author: { kind: 'user', id: 'external-poster' },
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

// Strict coalescing is proven against the listener above, where nothing consumes
// the signal between pokes. Here the minimum pass interval is what collapses a
// burst: signals that land inside one interval cost one pass.
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
  await until(() => counter.passes() >= 1, 5_000);
  const settled = counter.passes();
  const burst = 50;
  const delivered = await Effect.runPromise(
    Effect.forEach(
      Array.from({ length: burst }, () => 0),
      () =>
        pokeWatcherEffect({
          stateDirectory: fixture.context.project.stateDirectory,
          projectId: fixture.context.project.id,
        }),
      { concurrency: burst },
    ),
  );
  assert.equal(delivered.filter(Boolean).length, burst, 'every poke reached the listener');
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

test('a slow delivery fiber does not hold up the reconciliation fiber', async (t) => {
  const fixture = project(t);
  let deliveryPasses = 0;
  const pendingWork = {
    hasPendingWorkEffect: () =>
      Effect.gen(function* () {
        deliveryPasses += 1;
        yield* Effect.sleep('300 millis');
        return true;
      }),
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
  assert.ok(deliveryPasses <= 4, `delivery really was slow (${deliveryPasses} passes)`);
  assert.ok(
    stopped.reconcilePasses > deliveryPasses * 2,
    `reconciliation kept its own cadence (${stopped.reconcilePasses} vs ${deliveryPasses})`,
  );
  t.diagnostic(
    `${runFor}ms with a 300ms delivery pass: ${deliveryPasses} delivery, ${stopped.reconcilePasses} reconcile`,
  );
});

test('the idle timer defers to the watcher pending-work predicate', async (t) => {
  const fixture = project(t);
  let queued = true;
  let asked = 0;
  const pendingWork = {
    hasPendingWorkEffect: () =>
      Effect.sync(() => {
        asked += 1;
        return queued;
      }),
  };
  const abort = new AbortController();
  t.after(() => abort.abort());
  const running = fixture.client.watch({
    signal: abort.signal,
    idleTimeoutMs: 60,
    fallbackIntervalMs: 20,
    pendingWork,
  });
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

test('an aborted watch releases its endpoint and settles its ownership', async (t) => {
  const fixture = project(t);
  const watched = observer(t, fixture.context);
  const abort = new AbortController();
  const running = fixture.client.watch({ signal: abort.signal, fallbackIntervalMs: 60_000 });
  const endpoint = wakeSocketPath(
    fixture.context.project.stateDirectory,
    fixture.context.project.id,
  );
  await until(() => existsSync(endpoint), 5_000);
  abort.abort();
  const stopped = await running;
  assert.equal(stopped.stopped, true);
  assert.equal(existsSync(endpoint), false, 'scoped cleanup removed the endpoint');
  const owner = watched.store.read((db) =>
    db
      .prepare('SELECT generation,settled_at FROM watcher_owners WHERE project_id=?')
      .get(fixture.context.project.id),
  );
  const parsed = decode(
    Schema.Struct({ generation: Schema.String, settled_at: Schema.String }),
    owner,
  );
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
  const endpoint = wakeSocketPath(
    fixture.context.project.stateDirectory,
    fixture.context.project.id,
  );
  await until(() => existsSync(endpoint), 5_000);
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
    id: decode(AgentSessionIdSchema, sessionId),
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
  const bound = await listener(
    t,
    fixture.context.project.stateDirectory,
    fixture.context.project.id,
  );
  assert.equal(bound.unavailable, null);
  await worker.ensureWatcher();
  assert.equal(bound.accepted, 1, 'the worker woke the existing watcher');
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

/** Counts every native observation a runtime performs, to price a watcher pass. */
function countingRuntime(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'mo-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const context = createBinding({ repositoryRoot: repo, stateRoot: join(root, 'state') });
  const local = localSessionContext(context);
  const store = Store.open({
    databasePath: context.binding.databasePath,
    project: decode(ProjectBindingSchema, {
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
    id: decode(AgentSessionIdSchema, local.sessionId),
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
    id: decode(WorkspaceIdSchema, 'workspace-test'),
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
      digest: decode(DigestSchema, createHash('sha256').update(text).digest('hex')),
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
    override async prompt(identity: NativeIdentity, prompt: string): Promise<NativeSubmission> {
      const prepared = await this.effects.prepare({
        kind: 'prompt',
        paneId: identity.paneId,
        textDigest: createHash('sha256').update(prompt).digest('hex'),
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
  await Effect.runPromise(fixture.runtime.startEffect(id));
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
  await Effect.runPromise(fixture.runtime.startEffect(id));
  await Effect.runPromise(fixture.runtime.reconcileEffect(id));
  const before = fixture.observations();

  // The pass it runs now.
  fixture.reset();
  if (fixture.runtime.needsStartProgress(id))
    await Effect.runPromise(fixture.runtime.startEffect(id));
  await Effect.runPromise(fixture.runtime.reconcileEffect(id));
  const after = fixture.observations();

  assert.equal(before, 2, 'start() and reconcile() each observed the same running attempt');
  assert.equal(after, 1, 'only reconcile() observes it now');
  t.diagnostic(`native observations per pass for a running attempt: ${before} -> ${after}`);
});
