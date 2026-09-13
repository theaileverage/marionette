import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Store } from '../../src/v1/store.js';
import {
  AgentSessionIdSchema,
  ProjectIdSchema,
  HostIdSchema,
  WorkspaceIdSchema,
  DigestSchema,
  ResultIdSchema,
  WorkflowPackageSnapshotSchema,
} from '../../src/v1/model.js';
import { dueSchedules } from '../../src/v1/workflows/scheduler.js';

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-control-'));
  const store = Store.open({
    databasePath: join(dir, 'db.sqlite'),
    project: {
      id: ProjectIdSchema.parse('p'),
      hostId: HostIdSchema.parse('h'),
      repositoryRoot: dir,
      stateDirectory: dir,
    },
  });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const actor = store.registerSession({
    id: AgentSessionIdSchema.parse('user'),
    generation: 1,
    workspaceId: null,
    role: 'user',
    executionRole: 'user',
    tokenHash: 'a'.repeat(64),
    parentWorkflowId: null,
    attemptId: null,
    nativeKind: null,
    nativeServerGeneration: null,
    nativeLocator: null,
  });
  const workspaceId = WorkspaceIdSchema.parse('ws');
  store.registerWorkspace({
    actor,
    id: workspaceId,
    kind: 'isolated',
    path: dir,
    repositoryRoot: dir,
    baseCommit: 'base',
    access: 'write',
    writes: ['**'],
    idempotencyKey: 'ws',
  });
  const brief = {
    objective: 'Work',
    scope: ['**'],
    ownership: ['**'],
    constraints: [],
    standingOrders: [],
    inputSnapshots: [],
  };
  const step = (name: string) => ({
    name,
    phase: 'analysis',
    resources: [],
    outputContract: 'report',
    permittedMethods: ['direct'],
    requiredEvidence: [],
    requiresDistinctRole: false,
  });
  const pkg = WorkflowPackageSnapshotSchema.parse({
    name: 'flow',
    version: '1',
    digest: '0'.repeat(64),
    sourceDigests: [],
    entryStep: 'one',
    steps: [step('one'), step('two')],
    transitions: [
      { kind: 'advance', from: 'one', to: 'two' },
      { kind: 'repeat', from: 'one', to: 'one' },
      { kind: 'block', from: 'one' },
      { kind: 'finish', from: 'one' },
    ],
    limits: {
      maxAttempts: 3,
      maxRepeats: 2,
      parallelism: 1,
      deadlineMs: 600000,
      innerLoopDeadlineMs: 30000,
    },
  });
  const workflow = store.createWorkflow({
    actor,
    stableKey: 'flow',
    package: pkg,
    request: { text: 'Work', digest: DigestSchema.parse('0'.repeat(64)), inputSnapshots: [] },
    brief,
    workspaceId,
    delivery: 'report',
    boundary: 'all',
    idempotencyKey: 'create',
  });
  return { store, actor, workflow, brief, workspaceId };
}
test('legacy workflows require explicit activation; pause/resume fences schedules and replay', (t) => {
  const { store, actor, workflow: w } = fixture(t);
  assert.equal(dueSchedules(store).length, 0);
  const activation = {
    actor,
    workflowId: w.id,
    expectedWorkflowRevision: 1,
    expectedBriefRevision: 1,
    expectedControlRevision: 1,
    idempotencyKey: 'activate',
  };
  store.activateWorkflow(activation);
  store.activateWorkflow(activation);
  assert.equal(dueSchedules(store).length, 1);
  const control = {
    actor,
    workflowId: w.id,
    expectedWorkflowRevision: 1,
    expectedControlRevision: 1,
    operation: { kind: 'pause' as const, mode: 'drain' as const },
    idempotencyKey: 'pause',
  };
  const paused = store.controlWorkflow(control);
  assert.equal(store.controlWorkflow(control).id, paused.id);
  assert.equal(store.getWorkflow(w.id).phase, 'paused');
  assert.equal(dueSchedules(store).length, 0);
  assert.throws(
    () => store.resumeWorkflow({ ...activation, decision: null, idempotencyKey: 'stale' }),
    /revisions changed/,
  );
  store.resumeWorkflow({
    ...activation,
    expectedWorkflowRevision: 2,
    expectedControlRevision: 2,
    decision: null,
    idempotencyKey: 'resume',
  });
  assert.equal(dueSchedules(store).length, 1);
});
test('cancellation is terminal and limit extension checks exact monotonic revision', (t) => {
  const { store, actor, workflow: w } = fixture(t);
  store.extendLimits({
    actor,
    workflowId: w.id,
    expectedLimitsRevision: 1,
    limits: { ...w.limits, maxAttempts: 4 },
    deadlineAt: w.deadlineAt,
    reason: 'More capacity',
    idempotencyKey: 'limits',
  });
  assert.throws(
    () =>
      store.extendLimits({
        actor,
        workflowId: w.id,
        expectedLimitsRevision: 1,
        limits: w.limits,
        deadlineAt: w.deadlineAt,
        reason: 'stale',
        idempotencyKey: 'old',
      }),
    /revision changed/,
  );
  store.controlWorkflow({
    actor,
    workflowId: w.id,
    expectedWorkflowRevision: 2,
    expectedControlRevision: 1,
    operation: { kind: 'cancel' },
    idempotencyKey: 'cancel',
  });
  assert.equal(store.getWorkflow(w.id).phase, 'cancelled');
  assert.throws(
    () =>
      store.resumeWorkflow({
        actor,
        workflowId: w.id,
        expectedWorkflowRevision: 3,
        expectedBriefRevision: 1,
        expectedControlRevision: 2,
        decision: null,
        idempotencyKey: 'resume',
      }),
    /confirmed paused/,
  );
});
test('brief revisions invalidate old schedule and transition request; block commits durable receipt', (t) => {
  const { store, actor, workflow: w, brief } = fixture(t);
  store.activateWorkflow({
    actor,
    workflowId: w.id,
    expectedWorkflowRevision: 1,
    expectedBriefRevision: 1,
    expectedControlRevision: 1,
    idempotencyKey: 'activate',
  });
  store.reviseBrief({
    actor,
    jobId: w.rootJobId,
    expectedBriefRevision: 1,
    brief: { ...brief, objective: 'New' },
    changeReason: 'Changed requirement',
    idempotencyKey: 'revise',
  });
  assert.equal(store.getWorkflow(w.id).briefRevision, 2);
  assert.equal(dueSchedules(store)[0]?.brief_revision, 2);
  const request = {
    workflowId: w.id,
    sourceStepRunId: w.currentStepRunId,
    kind: 'block' as const,
    resolutionCondition: 'Need input',
    reason: 'Missing input',
    evidenceResultIds: [],
    expectedWorkflowRevision: 1,
    expectedBriefRevision: 1,
    expectedControlRevision: 1,
    idempotencyKey: 'block',
  };
  assert.throws(() => store.requestTransition({ actor, request }), /revisions changed/);
  const current = { ...request, expectedWorkflowRevision: 2, expectedBriefRevision: 2 };
  const first = store.requestTransition({ actor, request: current });
  const replay = store.requestTransition({ actor, request: current });
  assert.equal(first.requestId, replay.requestId);
  assert.equal(replay.replayed, true);
  assert.equal(dueSchedules(store).length, 0);
});

test('accepted result advances atomically and admission debits durable budget once', (t) => {
  const { store, actor, workflow: w, workspaceId } = fixture(t);
  store.activateWorkflow({
    actor,
    workflowId: w.id,
    expectedWorkflowRevision: 1,
    expectedBriefRevision: 1,
    expectedControlRevision: 1,
    idempotencyKey: 'activate',
  });
  const worker = store.registerSession({
    id: AgentSessionIdSchema.parse('worker'),
    generation: 1,
    workspaceId,
    role: 'worker',
    executionRole: 'analysis',
    tokenHash: 'b'.repeat(64),
    parentWorkflowId: w.id,
    attemptId: null,
    nativeKind: null,
    nativeServerGeneration: null,
    nativeLocator: null,
  });
  const admission = {
    actor,
    jobId: w.rootJobId,
    session: worker,
    resourceKey: 'ws',
    inputResultIds: [],
    expectedBriefRevision: 1,
    workflow: {
      kind: 'managed' as const,
      workflowId: w.id,
      stepRunId: w.currentStepRunId,
      expectedWorkflowRevision: 1,
      expectedControlRevision: 1,
    },
    idempotencyKey: 'admit',
  };
  const attempt = store.admitAttempt(admission).attempt;
  store.admitAttempt(admission);
  assert.equal(
    store.read((db) => db.prepare('SELECT count(*) n FROM workflow_budget_ledger').get()?.n),
    1,
  );
  store.claimAttemptLaunch({
    actor,
    attemptId: attempt.id,
    expectedBriefRevision: 1,
    expectedControlRevision: 1,
    idempotencyKey: 'claim',
  });
  store.observeAttemptRunning({
    actor,
    attemptId: attempt.id,
    nativeKind: 'fixture',
    nativeServerGeneration: 'one',
    nativeLocator: 'worker',
    idempotencyKey: 'running',
  });
  const result = store.recordResult({
    actor: worker,
    attemptId: attempt.id,
    content: { kind: 'report', body: 'Result', artifactDigests: [] },
    inputDigest: DigestSchema.parse('0'.repeat(64)),
    workspaceDigest: DigestSchema.parse('0'.repeat(64)),
    evidenceClaims: [],
    evidence: [],
    verification: { kind: 'not-requested' },
    upstreamResultIds: [],
    idempotencyKey: 'result',
  });
  store.decideResult({
    actor,
    resultId: result.id,
    expectedBriefRevision: 1,
    decision: { kind: 'accepted' },
    idempotencyKey: 'accept',
  });
  const request = {
    workflowId: w.id,
    sourceStepRunId: w.currentStepRunId,
    kind: 'advance' as const,
    targetStep: 'two',
    reason: 'Accepted',
    evidenceResultIds: [result.id],
    expectedWorkflowRevision: 2,
    expectedBriefRevision: 1,
    expectedControlRevision: 1,
    idempotencyKey: 'advance',
  };
  assert.throws(() => store.requestTransition({ actor, request }), /Unsettled/);
  store.settleAttempt({
    actor,
    attemptId: attempt.id,
    observation: { kind: 'settled', outcome: 'succeeded', reason: 'Fixture exit' },
    idempotencyKey: 'settle',
  });
  const advanced = store.requestTransition({ actor, request });
  assert.equal(advanced.createdStepRun?.stepName, 'two');
  assert.equal(dueSchedules(store).length, 1);
  assert.equal(store.requestTransition({ actor, request }).requestId, advanced.requestId);
});

test('issue-bound repair cycles stop at finite repeat limit and retain receipts', (t) => {
  const { store, actor, workflow: initial, workspaceId } = fixture(t);
  for (let cycle = 0; cycle < 3; cycle++) {
    const w = store.getWorkflow(initial.id);
    const step = store.getStepRun(w.currentStepRunId);
    const worker = store.registerSession({
      id: AgentSessionIdSchema.parse(`repair-worker-${cycle}`),
      generation: 1,
      workspaceId,
      role: 'worker',
      executionRole: 'analysis',
      tokenHash: 'b'.repeat(64),
      parentWorkflowId: w.id,
      attemptId: null,
      nativeKind: null,
      nativeServerGeneration: null,
      nativeLocator: null,
    });
    const attempt = store.admitAttempt({
      actor,
      jobId: step.jobId,
      session: worker,
      resourceKey: `repair-${cycle}`,
      inputResultIds: store.read((db) =>
        db
          .prepare(
            'SELECT result_id FROM step_run_inputs WHERE step_run_id=? AND result_id IS NOT NULL',
          )
          .all(step.id)
          .map((row) => ResultIdSchema.parse(row.result_id)),
      ),
      expectedBriefRevision: 1,
      workflow: {
        kind: 'managed',
        workflowId: w.id,
        stepRunId: step.id,
        expectedWorkflowRevision: w.revision,
        expectedControlRevision: 1,
      },
      idempotencyKey: `admit-${cycle}`,
    }).attempt;
    store.claimAttemptLaunch({
      actor,
      attemptId: attempt.id,
      expectedBriefRevision: 1,
      expectedControlRevision: 1,
      idempotencyKey: `claim-${cycle}`,
    });
    store.observeAttemptRunning({
      actor,
      attemptId: attempt.id,
      nativeKind: 'fixture',
      nativeServerGeneration: 'one',
      nativeLocator: `worker-${cycle}`,
      idempotencyKey: `running-${cycle}`,
    });
    const result = store.recordResult({
      actor: worker,
      attemptId: attempt.id,
      content: { kind: 'report', body: 'Issues found', artifactDigests: [] },
      inputDigest: DigestSchema.parse('0'.repeat(64)),
      workspaceDigest: DigestSchema.parse('0'.repeat(64)),
      evidenceClaims: [],
      evidence: [],
      verification: { kind: 'not-requested' },
      upstreamResultIds: [],
      idempotencyKey: `result-${cycle}`,
    });
    store.decideResult({
      actor,
      resultId: result.id,
      expectedBriefRevision: 1,
      decision: { kind: 'rejected', issues: ['Missing requirement'], retainedObservations: [] },
      idempotencyKey: `reject-${cycle}`,
    });
    store.settleAttempt({
      actor,
      attemptId: attempt.id,
      observation: { kind: 'settled', outcome: 'succeeded', reason: 'Fixture exit' },
      idempotencyKey: `settle-${cycle}`,
    });
    const request = {
      workflowId: w.id,
      sourceStepRunId: step.id,
      kind: 'repeat' as const,
      targetStep: 'one',
      reason: 'Repair missing requirement',
      evidenceResultIds: [result.id],
      expectedWorkflowRevision: w.revision + 1,
      expectedBriefRevision: 1,
      expectedControlRevision: 1,
      idempotencyKey: `repeat-${cycle}`,
    };
    if (cycle < 2) store.requestTransition({ actor, request });
    else assert.throws(() => store.requestTransition({ actor, request }), /repair limit/);
  }
  assert.equal(
    store.read((db) => db.prepare('SELECT count(*) n FROM workflow_repair_cycles').get()?.n),
    2,
  );
});

test('safe pause without exact native evidence remains unconfirmed after service scan', async (t) => {
  const { store, actor, workflow: w, workspaceId } = fixture(t);
  const { ServiceOwnership } = await import('../../src/v1/service/ownership.js');
  const { ServiceControls } = await import('../../src/v1/service/controls.js');
  const owner = await ServiceOwnership.acquire({
    store,
    processIdentity: JSON.stringify({ pid: 777, startToken: 'fixture' }),
    livenessPort: {
      async confirmAbsent() {
        return false;
      },
    },
  });
  const worker = store.registerSession({
    id: AgentSessionIdSchema.parse('safe-worker'),
    generation: 1,
    workspaceId,
    role: 'worker',
    executionRole: 'analysis',
    tokenHash: 'b'.repeat(64),
    parentWorkflowId: w.id,
    attemptId: null,
    nativeKind: null,
    nativeServerGeneration: null,
    nativeLocator: null,
  });
  const attempt = store.admitAttempt({
    actor,
    jobId: w.rootJobId,
    session: worker,
    resourceKey: 'safe',
    inputResultIds: [],
    expectedBriefRevision: 1,
    workflow: {
      kind: 'managed',
      workflowId: w.id,
      stepRunId: w.currentStepRunId,
      expectedWorkflowRevision: 1,
      expectedControlRevision: 1,
    },
    idempotencyKey: 'admit-safe',
  }).attempt;
  store.claimAttemptLaunch({
    actor,
    attemptId: attempt.id,
    expectedBriefRevision: 1,
    expectedControlRevision: 1,
    idempotencyKey: 'launch-safe',
  });
  store.controlWorkflow({
    actor,
    workflowId: w.id,
    expectedWorkflowRevision: 2,
    expectedControlRevision: 1,
    operation: { kind: 'pause', mode: 'safe' },
    idempotencyKey: 'pause-safe',
  });
  await new ServiceControls(owner, actor).scan();
  assert.equal(store.getWorkflow(w.id).phase, 'pausing');
  assert.equal(
    store.read(
      (db) =>
        db.prepare('SELECT state FROM attempt_control_intents WHERE attempt_id=?').get(attempt.id)
          ?.state,
    ),
    'unconfirmed',
  );
  assert.equal(store.getAttempt(attempt.id).phase, 'launching');
  owner.stop();
});

test('core mutation events commit with state, replay once, and roll back together', (t) => {
  const { store, actor, workflow: w, brief } = fixture(t);
  const count = () =>
    Number(store.read((db) => db.prepare('SELECT count(*) n FROM domain_events').get()?.n));
  const baseline = count();
  assert.throws(
    () =>
      store.transaction(() => {
        store.reviseBrief({
          actor,
          jobId: w.rootJobId,
          expectedBriefRevision: 1,
          brief,
          changeReason: 'Rollback',
          idempotencyKey: 'rollback',
        });
        throw new Error('crash before commit');
      }),
    /crash before commit/,
  );
  assert.equal(store.getWorkflow(w.id).briefRevision, 1);
  assert.equal(count(), baseline);
  const input = {
    actor,
    jobId: w.rootJobId,
    expectedBriefRevision: 1,
    brief,
    changeReason: 'Commit',
    idempotencyKey: 'commit',
  };
  store.reviseBrief(input);
  const committed = count();
  assert.ok(committed > baseline);
  store.reviseBrief(input);
  assert.equal(count(), committed);
});
