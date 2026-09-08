import { Deferred, Effect, Exit, Fiber } from 'effect';
import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { ScopedTasks } from '../src/scoped-tasks.js';

test('scoped finite jobs drain, reject new scheduling, and close idempotently', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const tasks = new ScopedTasks();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let written = false;
      tasks.run(
        'held',
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          written = true;
        }),
      );
      yield* Deferred.await(entered);
      const closing = yield* Effect.forkChild(tasks.close());
      yield* Effect.yieldNow;
      assert.equal(written, false);
      assert.equal(tasks.run('late', Effect.void), undefined);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(closing);
      assert.equal(written, true);
      yield* tasks.close();
    }),
  );
});

test('explicit cancellation interrupts jobs and awaits their finalizers', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const tasks = new ScopedTasks();
      const entered = yield* Deferred.make<void>();
      let finalized = false;
      const job = tasks.run(
        'held',
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          return yield* Effect.never;
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              finalized = true;
            }),
          ),
        ),
      );
      assert.ok(job);
      yield* Deferred.await(entered);
      yield* tasks.cancel();
      assert.equal(finalized, true);
      assert.ok(Exit.isFailure(yield* Fiber.await(job)));
      yield* tasks.close();
    }),
  );
});

test('SQLite rejects asynchronous transaction results and rolls back nested failures', async () => {
  const { Store } = await import('../src/store.js');
  const store = new Store(':memory:');
  try {
    assert.throws(
      () =>
        store.transaction(() => {
          store.put('test', 'async', 'should rollback');
          return Promise.resolve('invalid');
        }),
      /synchronous/,
    );
    assert.equal(store.get('test', 'async'), undefined);
    assert.throws(() => store.transaction(() => Effect.void), /synchronous/);
    store.transaction(() => {
      store.put('test', 'outer', 'retained');
      assert.throws(
        () =>
          store.transaction(() => {
            store.put('test', 'inner', 'rolled back');
            throw new Error('nested failure');
          }),
        /nested failure/,
      );
      store.put('test', 'after', 'retained');
    });
    assert.deepEqual(store.all('test'), ['retained', 'retained']);
  } finally {
    store.close();
  }
});

test('interrupting a Herdr effect closes its actual socket', async () => {
  const net = await import('node:net');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { HerdrClient } = await import('../src/herdr-sdk.js');
  const { sdk } = await import('../src/effect-runtime.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'effect-socket-'));
  const socketPath = path.join(root, 'rpc.sock');
  const entered = Deferred.makeUnsafe<void>();
  const closed = Deferred.makeUnsafe<void>();
  const server = net.createServer((socket) => {
    socket.once('data', () => Effect.runSync(Deferred.succeed(entered, undefined)));
    socket.once('close', () => Effect.runSync(Deferred.succeed(closed, undefined)));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    const client = new HerdrClient(socketPath);
    const pending = Effect.runFork(
      sdk('test.socket', (signal) =>
        client.call('agent.prompt', { target: 'worker', text: 'held' }, 30000, signal),
      ),
    );
    await Effect.runPromise(Deferred.await(entered));
    await Effect.runPromise(Fiber.interrupt(pending));
    await Effect.runPromise(Deferred.await(closed).pipe(Effect.timeout(3000)));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('interrupting a command kills descendants in its process group', async () => {
  const net = await import('node:net');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { processEffect } = await import('../src/process.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'effect-process-'));
  const socketPath = path.join(root, 'child.sock');
  const entered = Deferred.makeUnsafe<void>();
  const closed = Deferred.makeUnsafe<void>();
  const server = net.createServer((socket) => {
    socket.once('data', () => Effect.runSync(Deferred.succeed(entered, undefined)));
    socket.once('close', () => Effect.runSync(Deferred.succeed(closed, undefined)));
  });
  const descendant = `const net = require('node:net'); const s = net.createConnection(${JSON.stringify(socketPath)}, () => s.write('ready')); setInterval(() => {}, 1000);`;
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'inherit' }); setInterval(() => {}, 1000);`;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    const pending = Effect.runFork(
      processEffect(process.execPath, ['-e', parent], { timeout: 5000 }),
    );
    try {
      await Effect.runPromise(Deferred.await(entered).pipe(Effect.timeout(3000)));
      await Effect.runPromise(Fiber.interrupt(pending));
      await Effect.runPromise(Deferred.await(closed).pipe(Effect.timeout(3000)));
    } finally {
      await Effect.runPromise(Fiber.interrupt(pending));
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
