import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Effect, Schema } from 'effect';

import type { Marionette } from '../src/v1/client.js';
import {
  AgentSessionIdSchema,
  DigestSchema,
  HostIdSchema,
  ProjectIdSchema,
  WorkspaceIdSchema,
  type AttemptId,
} from '../src/v1/model.js';
import { execute } from '../src/v1/operations.js';
import type { OperationOutput } from '../src/v1/output-contracts.js';
import { Store, StoreError, type AgentSession, type AdmittedAttempt } from '../src/v1/store.js';

type RecoveryOutput = ReturnType<Marionette['recoverAttemptEffect']> extends Effect.Effect<
  infer Success,
  unknown,
  unknown
>
  ? Success
  : never;
const recoveryOutputMatchesReconcileContract: RecoveryOutput extends OperationOutput<'attempt.reconcile'>
  ? true
  : false = true;
void recoveryOutputMatchesReconcileContract;

type Fixture = {
  store: Store;
  controller: AgentSession;
  worker: AgentSession;
  admission: AdmittedAttempt;
};

const requestDigest = Schema.decodeUnknownSync(DigestSchema)('0'.repeat(64));

function fixture(t: TestContext, name: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), `marionette-recovery-${name}-`));
  let sequence = 0;
  const project = {
    id: Schema.decodeUnknownSync(ProjectIdSchema)(`project_${name}`),
    hostId: Schema.decodeUnknownSync(HostIdSchema)(`host_${name}`),
    repositoryRoot: '/repo',
    stateDirectory: join(root, 'state'),
  };
  const store = Store.open({
    databasePath: join(root, 'state.sqlite'),
    project,
    idFactory: (kind) => `${kind}_${++sequence}`,
  });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const controller = store.registerSession({
    id: Schema.decodeUnknownSync(AgentSessionIdSchema)(`controller_${name}`),
    generation: 1,
    workspaceId: null,
    role: 'controller',
    executionRole: 'controller',
    tokenHash: createHash('sha256').update('controller-token').digest('hex'),
    parentWorkflowId: null,
    attemptId: null,
    nativeKind: null,
    nativeServerGeneration: null,
    nativeLocator: null,
  });
  const workspaceId = Schema.decodeUnknownSync(WorkspaceIdSchema)(`workspace_${name}`);
  store.registerWorkspace({
    actor: controller,
    id: workspaceId,
    kind: 'isolated',
    path: `/repo/.worktrees/${name}`,
    repositoryRoot: '/repo',
    baseCommit: 'base',
    access: 'write',
    writes: ['src/**'],
    idempotencyKey: `workspace-${name}`,
  });
  const worker = store.registerSession({
    id: Schema.decodeUnknownSync(AgentSessionIdSchema)(`worker_${name}`),
    generation: 1,
    workspaceId,
    role: 'worker',
    executionRole: 'implementation',
    tokenHash: createHash('sha256').update('worker-token').digest('hex'),
    parentWorkflowId: null,
    attemptId: null,
    nativeKind: null,
    nativeServerGeneration: null,
    nativeLocator: null,
  });
  const job = store.createJob({
    actor: controller,
    stableKey: `job-${name}`,
    request: { text: 'Recover this attempt', digest: requestDigest, inputSnapshots: [] },
    brief: {
      objective: 'Recover this attempt',
      scope: ['src/**'],
      ownership: ['src/**'],
      constraints: ['Do not replay native work'],
      standingOrders: [],
      inputSnapshots: [],
    },
    workspaceId,
    delivery: 'report',
    origin: { kind: 'direct' },
    dependencies: [],
    idempotencyKey: `job-${name}`,
  });
  const admission = store.admitAttempt({
    actor: controller,
    jobId: job.id,
    session: worker,
    resourceKey: `workspace/${workspaceId}`,
    inputResultIds: [],
    expectedBriefRevision: 1,
    workflow: { kind: 'direct' },
    idempotencyKey: `admit-${name}`,
  });
  insertRuntime(store, admission.attempt.id, 'admitted', null);
  return { store, controller, worker, admission };
}

function insertRuntime(
  store: Store,
  attemptId: AttemptId,
  phase: 'admitted' | 'active',
  observation: object | null,
): void {
  const now = new Date().toISOString();
  store.transaction((database) =>
    database
      .prepare(
        `INSERT INTO native_attempts
           (attempt_id, project_id, binding_json, profile_json, context_path,
            expected_control_revision, phase, identity_json, launch_result_json,
            observed_working, last_observation_json, created_at, updated_at)
         VALUES (?, ?, '{}', '{}', '/context', NULL, ?, ?, NULL, ?, ?, ?, ?)`,
      )
      .run(
        attemptId,
        store.project.id,
        phase,
        phase === 'active' ? '{}' : null,
        observation !== null && 'kind' in observation && observation.kind === 'working' ? 1 : 0,
        observation === null ? null : JSON.stringify(observation),
        now,
        now,
      ),
  );
}

function recovery(current: Fixture, idempotencyKey: string) {
  return current.store.recoverAttempt({
    actor: current.controller,
    attemptId: current.admission.attempt.id,
    expectedBriefRevision: 1,
    outcome: 'failed',
    reason: 'Controller confirmed the attempt is abandoned',
    idempotencyKey,
  });
}

function reservationState(current: Fixture): string | undefined {
  return current.store.read(
    (database) =>
      database
        .prepare('SELECT state FROM execution_reservations WHERE id = ?')
        .get(current.admission.reservationId)?.state as string | undefined,
  );
}

test('recovery is controller-authorized', (t) => {
  const current = fixture(t, 'authorization');
  assert.throws(
    () =>
      current.store.recoverAttempt({
        actor: current.worker,
        attemptId: current.admission.attempt.id,
        expectedBriefRevision: 1,
        outcome: 'failed',
        reason: 'Worker must not settle itself',
        idempotencyKey: 'worker-recovery',
      }),
    (error: unknown) => error instanceof StoreError && error.code === 'permission-denied',
  );
  assert.equal(reservationState(current), 'held');
});

test('never-started recovery is idempotent, releases the reservation, and creates no native effect', (t) => {
  const current = fixture(t, 'never-started');
  assert.throws(
    () =>
      current.store.recoverAttempt({
        actor: current.controller,
        attemptId: current.admission.attempt.id,
        expectedBriefRevision: 2,
        outcome: 'failed',
        reason: 'Stale recovery request',
        idempotencyKey: 'stale-recovery',
      }),
    (error: unknown) => error instanceof StoreError && error.code === 'stale-revision',
  );
  assert.equal(reservationState(current), 'held');

  const first = recovery(current, 'recover-never-started');
  const second = recovery(current, 'recover-never-started');

  assert.equal(first.attempt.phase, 'settled');
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(reservationState(current), 'released');
  assert.equal(
    current.store.read(
      (database) =>
        database
          .prepare('SELECT count(*) AS count FROM native_effects WHERE attempt_id = ?')
          .get(current.admission.attempt.id)?.count,
    ),
    0,
  );
  assert.throws(
    () =>
      current.store.recoverAttempt({
        actor: current.controller,
        attemptId: current.admission.attempt.id,
        expectedBriefRevision: 1,
        outcome: 'interrupted',
        reason: 'Conflicting retry',
        idempotencyKey: 'recover-never-started',
      }),
    (error: unknown) => error instanceof StoreError && error.code === 'idempotency-conflict',
  );
});

test('recovery refuses a persisted working native observation', (t) => {
  const current = fixture(t, 'working');
  current.store.claimAttemptLaunch({
    actor: current.controller,
    attemptId: current.admission.attempt.id,
    expectedBriefRevision: 1,
    expectedControlRevision: null,
    idempotencyKey: 'launch-working',
  });
  current.store.observeAttemptRunning({
    actor: current.controller,
    attemptId: current.admission.attempt.id,
    nativeKind: 'herdr',
    nativeServerGeneration: 'server-1',
    nativeLocator: 'pane-1',
    idempotencyKey: 'observe-working',
  });
  current.store.transaction((database) =>
    database
      .prepare(
        `UPDATE native_attempts
         SET phase = 'active', identity_json = '{}', observed_working = 1,
             last_observation_json = '{"kind":"working"}'
         WHERE attempt_id = ?`,
      )
      .run(current.admission.attempt.id),
  );

  assert.throws(
    () => recovery(current, 'recover-working'),
    (error: unknown) => error instanceof StoreError && error.code === 'invalid-state',
  );
  assert.equal(current.store.getAttempt(current.admission.attempt.id).phase, 'running');
  assert.equal(reservationState(current), 'held');
});

function persistUnconfirmedObservation(
  current: Fixture,
  kind: 'blocked' | 'manual-required' | 'settled',
): void {
  current.store.claimAttemptLaunch({
    actor: current.controller,
    attemptId: current.admission.attempt.id,
    expectedBriefRevision: 1,
    expectedControlRevision: null,
    idempotencyKey: `launch-${kind}`,
  });
  current.store.observeAttemptRunning({
    actor: current.controller,
    attemptId: current.admission.attempt.id,
    nativeKind: 'herdr',
    nativeServerGeneration: 'server-1',
    nativeLocator: 'pane-1',
    idempotencyKey: `observe-${kind}`,
  });
  current.store.transaction((database) =>
    database
      .prepare(
        `UPDATE native_attempts
         SET phase = 'unconfirmed', identity_json = '{}',
             last_observation_json = ?
         WHERE attempt_id = ?`,
      )
      .run(JSON.stringify({ kind }), current.admission.attempt.id),
  );
}

test('recovery refuses a persisted blocked native observation', (t) => {
  const current = fixture(t, 'blocked');
  persistUnconfirmedObservation(current, 'blocked');

  assert.throws(
    () => recovery(current, 'recover-blocked'),
    (error: unknown) => error instanceof StoreError && error.code === 'invalid-state',
  );
  assert.equal(current.store.getAttempt(current.admission.attempt.id).phase, 'running');
  assert.equal(reservationState(current), 'held');
});

test('recovery refuses a persisted manual-required native observation', (t) => {
  const current = fixture(t, 'manual-required');
  persistUnconfirmedObservation(current, 'manual-required');

  assert.throws(
    () => recovery(current, 'recover-manual-required'),
    (error: unknown) => error instanceof StoreError && error.code === 'invalid-state',
  );
  assert.equal(current.store.getAttempt(current.admission.attempt.id).phase, 'running');
  assert.equal(reservationState(current), 'held');
});

test('recovery settles an attempt with a persisted settled native observation', (t) => {
  const current = fixture(t, 'settled-observation');
  persistUnconfirmedObservation(current, 'settled');

  const result = recovery(current, 'recover-settled-observation');
  assert.equal(result.attempt.phase, 'settled');
  assert.equal(reservationState(current), 'released');
  assert.equal(
    current.store.read(
      (database) =>
        database
          .prepare('SELECT state FROM agent_sessions WHERE id = ? AND generation = ?')
          .get(current.worker.id, current.worker.generation)?.state,
    ),
    'settled',
  );
});

test('attempt.reconcile dispatches an explicit recovery payload without replaying reconciliation', async () => {
  let recovered = 0;
  let reconciled = 0;
  const client = {
    recoverAttemptEffect: (input: object) => {
      recovered += 1;
      return Effect.succeed({ input, replayed: false });
    },
    reconcileAttemptEffect: () => {
      reconciled += 1;
      return Effect.die('unexpected reconciliation');
    },
  } as unknown as Marionette;

  const result = await execute(client, {
    operation: 'attempt.reconcile',
    id: 'attempt-dispatch',
    recovery: {
      expectedBriefRevision: 1,
      outcome: 'failed',
      reason: 'Controller recovery',
      idempotencyKey: 'dispatch-recovery',
    },
  });
  assert.equal(recovered, 1);
  assert.equal(reconciled, 0);
  assert.deepEqual(result, {
    input: {
      attemptId: 'attempt-dispatch',
      expectedBriefRevision: 1,
      outcome: 'failed',
      reason: 'Controller recovery',
      idempotencyKey: 'dispatch-recovery',
    },
    replayed: false,
  });
});
