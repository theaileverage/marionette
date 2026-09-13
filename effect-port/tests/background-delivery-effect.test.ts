import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Effect, Result, Schema } from 'effect';
import {
  currentProcessIdentity,
  currentProcessIdentityEffect,
  ensureBackgroundWatcher,
  ensureBackgroundWatcherEffect,
  localOwnerLiveness,
} from '../src/v1/background.js';
import { NativeBoardDelivery } from '../src/v1/delivery.js';
import { ProjectBindingSchema } from '../src/v1/model.js';
import { Store } from '../src/v1/store.js';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'marionette-effect-background-'));
  const store = Store.open({
    databasePath: join(root, 'project.sqlite'),
    project: Schema.decodeSync(ProjectBindingSchema)({
      id: 'project-background',
      hostId: 'host-background',
      repositoryRoot: root,
      stateDirectory: root,
    }),
  });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return store;
}

test('background identity and liveness expose Effects with Promise compatibility', async () => {
  const effectIdentity = await Effect.runPromise(Effect.result(currentProcessIdentityEffect()));
  const promiseIdentity = await Effect.runPromise(
    Effect.result(Effect.tryPromise({ try: currentProcessIdentity, catch: () => 'promise-failed' as const })),
  );
  assert.equal(Result.isSuccess(effectIdentity), Result.isSuccess(promiseIdentity));
  if (Result.isSuccess(effectIdentity) && Result.isSuccess(promiseIdentity)) {
    const decoded = Schema.decodeUnknownSync(
      Schema.Struct({
        pid: Schema.Finite,
        startToken: Schema.NonEmptyString,
      }),
    )(JSON.parse(effectIdentity.success));
    assert.equal(decoded.pid, process.pid);
    assert.equal(effectIdentity.success, promiseIdentity.success);
  }
  assert.equal(
    await Effect.runPromise(
      localOwnerLiveness.confirmAbsentEffect?.({
        project: { id: 'project-background', hostId: 'host-background' },
        processIdentity: Result.isSuccess(effectIdentity)
          ? effectIdentity.success
          : JSON.stringify({ pid: process.pid, startToken: 'fixture-start-token' }),
      }) ?? Effect.succeed(true),
    ),
    false,
  );
});

test('an active watcher identity prevents a background spawn on both APIs', async (t) => {
  const store = fixture(t);
  const current = await Effect.runPromise(Effect.result(currentProcessIdentityEffect()));
  const identity = Result.isSuccess(current)
    ? current.success
    : JSON.stringify({ pid: process.pid, startToken: 'fixture-start-token' });
  store.transaction((db) => {
    db.prepare(
      'INSERT INTO watcher_owners(project_id,generation,process_identity,claimed_at,settled_at) VALUES(?,?,?,?,NULL)',
    ).run(
      store.project.id,
      '11111111-1111-4111-8111-111111111111',
      identity,
      new Date().toISOString(),
    );
  });

  await Effect.runPromise(ensureBackgroundWatcherEffect(store, '/unused/project.json'));
  await ensureBackgroundWatcher(store, '/unused/project.json');
});

test('native board delivery exposes Effects and preserves unsupported outcomes', async (t) => {
  const store = fixture(t);
  const delivery = new NativeBoardDelivery(store);
  const recipient = { kind: 'session', id: 'missing-session', generation: 1 } as const;
  const otherProject = {
    project: { id: 'other-project', hostId: store.project.hostId },
    recipient,
  };
  const localProject = {
    project: { id: store.project.id, hostId: store.project.hostId },
    recipient,
  };

  assert.deepEqual(await Effect.runPromise(delivery.checkReadyEffect(otherProject)), {
    kind: 'unsupported',
    reason: 'Notification belongs to another project or host',
  });
  assert.deepEqual(await delivery.checkReady(localProject), {
    kind: 'unsupported',
    reason:
      'No active native endpoint is registered for this recipient; read the durable board directly',
  });
  assert.deepEqual(
    await Effect.runPromise(
      delivery.deliverEffect({
        ...localProject,
        deliveryIds: ['11111111-1111-4111-8111-111111111111'],
        message: 'No native effect may be replayed.',
      }),
    ),
    { kind: 'unsupported', reason: 'Native recipient is no longer active' },
  );
});
