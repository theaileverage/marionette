import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  AgentSessionIdSchema,
  DigestSchema,
  EvidenceSchema,
  HostIdSchema,
  ProjectIdSchema,
  WorkspaceIdSchema,
  WorkflowPackageSnapshotSchema,
  type ProjectBinding,
} from '../../src/v1/model.js';
import { Store, StoreError, type AgentSession, type SessionIdentity } from '../../src/v1/store.js';

const zeroDigest = DigestSchema.parse('0'.repeat(64));
const oneDigest = DigestSchema.parse('1'.repeat(64));

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function hasCode(code: StoreError['code']): (error: Error) => boolean {
  return (error) => error instanceof StoreError && error.code === code;
}

type Fixture = {
  store: Store;
  project: ProjectBinding;
  controller: AgentSession;
  worker: AgentSession;
  workspaceId: ReturnType<typeof WorkspaceIdSchema.parse>;
};

function fixture(t: TestContext): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'marionette-v1-store-'));
  let sequence = 0;
  const project = {
    id: ProjectIdSchema.parse('project_store'),
    hostId: HostIdSchema.parse('host_store'),
    repositoryRoot: '/repo',
    stateDirectory: '/repo/.marionette',
  };
  const store = Store.open({
    databasePath: join(directory, 'state.sqlite'),
    project,
    idFactory: (kind) => `${kind}_${++sequence}`,
  });
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const controller = store.registerSession({
    id: AgentSessionIdSchema.parse('controller'),
    generation: 1,
    workspaceId: null,
    role: 'controller',
    executionRole: 'controller',
    tokenHash: tokenHash('controller-token'),
    parentWorkflowId: null,
    attemptId: null,
    nativeKind: null,
    nativeServerGeneration: null,
    nativeLocator: null,
  });
  const workspaceId = WorkspaceIdSchema.parse('workspace_main');
  store.registerWorkspace({
    actor: controller,
    id: workspaceId,
    kind: 'isolated',
    path: '/repo/.worktrees/main',
    repositoryRoot: '/repo',
    baseCommit: 'base',
    access: 'write',
    writes: ['src/**'],
    idempotencyKey: 'workspace-main',
  });
  const worker = store.registerSession({
    id: AgentSessionIdSchema.parse('worker'),
    generation: 1,
    workspaceId,
    role: 'worker',
    executionRole: 'implementation',
    tokenHash: tokenHash('worker-token'),
    parentWorkflowId: null,
    attemptId: null,
    nativeKind: null,
    nativeServerGeneration: null,
    nativeLocator: null,
  });
  return { store, project, controller, worker, workspaceId };
}

const request = {
  text: 'Implement the requested change',
  digest: zeroDigest,
  inputSnapshots: [],
};

const brief = {
  objective: 'Implement the requested change',
  scope: ['src/**'],
  ownership: ['src/**'],
  constraints: ['Keep results immutable'],
  standingOrders: [],
  inputSnapshots: [],
};

function directJobInput(fixtureValue: Fixture, stableKey: string, idempotencyKey: string) {
  return {
    actor: fixtureValue.controller,
    stableKey,
    request,
    brief,
    workspaceId: fixtureValue.workspaceId,
    delivery: 'report' as const,
    origin: { kind: 'direct' as const },
    dependencies: [],
    idempotencyKey,
  };
}

function registerWorker(
  fixtureValue: Fixture,
  name: string,
  parentWorkflowId: AgentSession['parentWorkflowId'] = null,
): AgentSession {
  return fixtureValue.store.registerSession({
    id: AgentSessionIdSchema.parse(name),
    generation: 1,
    workspaceId: fixtureValue.workspaceId,
    role: 'worker',
    executionRole: 'implementation',
    tokenHash: tokenHash(`${name}-token`),
    parentWorkflowId,
    attemptId: null,
    nativeKind: null,
    nativeServerGeneration: null,
    nativeLocator: null,
  });
}

test('binds a database to one project and authenticates immutable session generations', (t) => {
  const current = fixture(t);
  assert.equal(
    current.store.authenticateSession({
      id: current.controller.id,
      generation: current.controller.generation,
      token: 'controller-token',
    }).role,
    'controller',
  );
  assert.throws(
    () =>
      current.store.authenticateSession({
        id: current.controller.id,
        generation: current.controller.generation,
        token: 'wrong-token',
      }),
    hasCode('identity-mismatch'),
  );
  assert.throws(
    () =>
      current.store.registerSession({
        id: current.controller.id,
        generation: current.controller.generation,
        workspaceId: null,
        role: 'user',
        executionRole: 'controller',
        tokenHash: tokenHash('controller-token'),
        parentWorkflowId: null,
        attemptId: null,
        nativeKind: null,
        nativeServerGeneration: null,
        nativeLocator: null,
      }),
    hasCode('identity-mismatch'),
  );
  assert.throws(
    () =>
      Store.open({
        databasePath: current.store.databasePath,
        project: { ...current.project, id: ProjectIdSchema.parse('another_project') },
      }),
    hasCode('binding-mismatch'),
  );
});

test('creates jobs idempotently and fences active workspace retirement', (t) => {
  const current = fixture(t);
  const input = directJobInput(current, 'job-one', 'create-job-one');
  const created = current.store.createJob(input);
  assert.equal(current.store.createJob(input).id, created.id);
  assert.throws(
    () => current.store.createJob({ ...input, stableKey: 'changed-job' }),
    hasCode('idempotency-conflict'),
  );

  current.store.transaction((database) => {
    const workspace = current.store.getWorkspace(current.workspaceId);
    database
      .prepare(
        `INSERT INTO workspace_retirements
           (id, project_id, workspace_id, expected_host_id, expected_path,
            expected_workspace_created_at, idempotency_key, state, revision,
            created_at, updated_at, completed_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?, NULL, NULL)`,
      )
      .run(
        'retirement_1',
        current.project.id,
        current.workspaceId,
        current.project.hostId,
        workspace.path,
        workspace.createdAt,
        'retire-main',
        workspace.createdAt,
        workspace.createdAt,
      );
  });
  assert.throws(
    () => current.store.createJob(directJobInput(current, 'job-two', 'create-job-two')),
    hasCode('resource-busy'),
  );
  assert.throws(() => registerWorker(current, 'late-worker'), hasCode('resource-busy'));

  current.store.transaction((database) => {
    const retiredAt = new Date().toISOString();
    database
      .prepare(
        `UPDATE workspace_retirements
         SET state = 'completed', revision = 2, updated_at = ?, completed_at = ?
         WHERE id = 'retirement_1'`,
      )
      .run(retiredAt, retiredAt);
    database
      .prepare('UPDATE workspaces SET retired_at = ? WHERE id = ?')
      .run(retiredAt, current.workspaceId);
  });
  assert.throws(
    () => current.store.createJob(directJobInput(current, 'job-two', 'create-job-two')),
    hasCode('invalid-state'),
  );
});

test('fences attempt launch, persists immutable results, and releases settled resources', (t) => {
  const current = fixture(t);
  const job = current.store.createJob(directJobInput(current, 'job-result', 'create-result-job'));
  const admission = current.store.admitAttempt({
    actor: current.controller,
    jobId: job.id,
    session: current.worker,
    resourceKey: 'workspace:main',
    inputResultIds: [],
    expectedBriefRevision: 1,
    workflow: { kind: 'direct' },
    idempotencyKey: 'admit-result-attempt',
  });
  assert.equal(admission.replayed, false);
  assert.equal(
    current.store.admitAttempt({
      actor: current.controller,
      jobId: job.id,
      session: current.worker,
      resourceKey: 'workspace:main',
      inputResultIds: [],
      expectedBriefRevision: 1,
      workflow: { kind: 'direct' },
      idempotencyKey: 'admit-result-attempt',
    }).replayed,
    true,
  );
  assert.throws(
    () =>
      current.store.claimAttemptLaunch({
        actor: current.controller,
        attemptId: admission.attempt.id,
        expectedBriefRevision: 2,
        expectedControlRevision: null,
        idempotencyKey: 'stale-launch',
      }),
    hasCode('stale-revision'),
  );
  current.store.acknowledgeBrief({
    actor: current.worker,
    attemptId: admission.attempt.id,
    briefRevision: 1,
    idempotencyKey: 'ack-result-brief',
  });
  current.store.claimAttemptLaunch({
    actor: current.controller,
    attemptId: admission.attempt.id,
    expectedBriefRevision: 1,
    expectedControlRevision: null,
    idempotencyKey: 'launch-result-attempt',
  });
  current.store.observeAttemptRunning({
    actor: current.controller,
    attemptId: admission.attempt.id,
    nativeKind: 'herdr-pane',
    nativeServerGeneration: 'server-1',
    nativeLocator: 'pane-1',
    idempotencyKey: 'observe-result-attempt',
  });
  const evidence = EvidenceSchema.parse({
    kind: 'command',
    argv: ['bun', 'test'],
    exitCode: 0,
    log: oneDigest,
  });
  const result = current.store.recordResult({
    actor: current.worker,
    attemptId: admission.attempt.id,
    content: { kind: 'report' },
    inputDigest: zeroDigest,
    workspaceDigest: oneDigest,
    evidenceClaims: ['tests-pass'],
    evidence: [evidence],
    verification: { kind: 'passed', checks: [evidence] },
    upstreamResultIds: [],
    idempotencyKey: 'record-result',
  });
  assert.deepEqual(current.store.getResult(result.id), result);
  const nextWorker = registerWorker(current, 'next-worker');
  const nextJob = current.store.createJob(directJobInput(current, 'next-job', 'create-next-job'));
  const admitNext = () =>
    current.store.admitAttempt({
      actor: current.controller,
      jobId: nextJob.id,
      session: nextWorker,
      resourceKey: 'workspace:main',
      inputResultIds: [result.id],
      expectedBriefRevision: 1,
      workflow: { kind: 'direct' },
      idempotencyKey: 'admit-next-attempt',
    });
  assert.throws(admitNext, hasCode('invalid-state'));
  assert.equal(
    current.store.decideResult({
      actor: current.controller,
      resultId: result.id,
      expectedBriefRevision: 1,
      decision: { kind: 'accepted' },
      idempotencyKey: 'accept-result',
    }).decision,
    'accepted',
  );
  assert.throws(() => {
    current.store.transaction((database) => {
      database
        .prepare('UPDATE results SET workspace_digest = ? WHERE id = ?')
        .run(zeroDigest, result.id);
    });
  }, /results are immutable/);

  current.store.settleAttempt({
    actor: current.controller,
    attemptId: admission.attempt.id,
    observation: { kind: 'settled', outcome: 'succeeded', reason: 'Native process exited' },
    idempotencyKey: 'settle-result-attempt',
  });
  assert.doesNotThrow(admitNext);
});

test('keeps uncertain resources reserved until later native settlement', (t) => {
  const current = fixture(t);
  const firstJob = current.store.createJob(
    directJobInput(current, 'uncertain-one', 'uncertain-one'),
  );
  const first = current.store.admitAttempt({
    actor: current.controller,
    jobId: firstJob.id,
    session: current.worker,
    resourceKey: 'workspace:uncertain',
    inputResultIds: [],
    expectedBriefRevision: 1,
    workflow: { kind: 'direct' },
    idempotencyKey: 'admit-uncertain-one',
  });
  current.store.settleAttempt({
    actor: current.controller,
    attemptId: first.attempt.id,
    observation: { kind: 'unconfirmed', reason: 'Backend disconnected' },
    idempotencyKey: 'mark-unconfirmed',
  });

  const nextWorker = registerWorker(current, 'uncertain-worker');
  const nextJob = current.store.createJob(
    directJobInput(current, 'uncertain-two', 'uncertain-two'),
  );
  const admitNext = () =>
    current.store.admitAttempt({
      actor: current.controller,
      jobId: nextJob.id,
      session: nextWorker,
      resourceKey: 'workspace:uncertain',
      inputResultIds: [],
      expectedBriefRevision: 1,
      workflow: { kind: 'direct' },
      idempotencyKey: 'admit-uncertain-two',
    });
  assert.throws(admitNext, hasCode('resource-busy'));
  current.store.settleAttempt({
    actor: current.controller,
    attemptId: first.attempt.id,
    observation: { kind: 'settled', outcome: 'interrupted', reason: 'Exit observed' },
    idempotencyKey: 'confirm-settlement',
  });
  assert.doesNotThrow(admitNext);
});

test('fences managed admission by workflow and control revision', (t) => {
  const current = fixture(t);
  const workflowPackage = WorkflowPackageSnapshotSchema.parse({
    name: 'reviewed-change',
    version: '1',
    digest: oneDigest,
    sourceDigests: [zeroDigest],
    steps: [
      {
        name: 'implement',
        phase: 'implementation',
        resources: ['workspace'],
        outputContract: 'A tested result',
        permittedMethods: ['direct'],
        requiredEvidence: ['tests-pass'],
        requiresDistinctRole: false,
      },
    ],
    transitions: [{ kind: 'finish', from: 'implement' }],
    limits: {
      maxAttempts: 2,
      maxRepeats: 1,
      deadlineMs: 60_000,
      parallelism: 1,
      innerLoopDeadlineMs: 30_000,
    },
  });
  const workflow = current.store.createWorkflow({
    actor: current.controller,
    stableKey: 'managed-workflow',
    package: workflowPackage,
    request,
    brief,
    workspaceId: current.workspaceId,
    delivery: 'report',
    boundary: 'all',
    idempotencyKey: 'create-managed-workflow',
  });
  const managedWorker = registerWorker(current, 'managed-worker', workflow.id);
  assert.throws(
    () =>
      current.store.admitAttempt({
        actor: current.controller,
        jobId: workflow.rootJobId,
        session: managedWorker,
        resourceKey: 'workflow:managed',
        inputResultIds: [],
        expectedBriefRevision: 1,
        workflow: {
          kind: 'managed',
          workflowId: workflow.id,
          stepRunId: workflow.currentStepRunId,
          expectedWorkflowRevision: 2,
          expectedControlRevision: 1,
        },
        idempotencyKey: 'stale-managed-admission',
      }),
    hasCode('stale-revision'),
  );
  const admitted = current.store.admitAttempt({
    actor: current.controller,
    jobId: workflow.rootJobId,
    session: managedWorker,
    resourceKey: 'workflow:managed',
    inputResultIds: [],
    expectedBriefRevision: 1,
    workflow: {
      kind: 'managed',
      workflowId: workflow.id,
      stepRunId: workflow.currentStepRunId,
      expectedWorkflowRevision: 1,
      expectedControlRevision: 1,
    },
    idempotencyKey: 'managed-admission',
  });
  assert.equal(admitted.workflowRevision, 2);
  assert.equal(current.store.getStepRun(workflow.currentStepRunId).phase, 'active');
  assert.throws(
    () =>
      current.store.claimAttemptLaunch({
        actor: current.controller,
        attemptId: admitted.attempt.id,
        expectedBriefRevision: 1,
        expectedControlRevision: 2,
        idempotencyKey: 'stale-managed-launch',
      }),
    hasCode('stale-revision'),
  );
  current.store.claimAttemptLaunch({
    actor: current.controller,
    attemptId: admitted.attempt.id,
    expectedBriefRevision: 1,
    expectedControlRevision: 1,
    idempotencyKey: 'launch-managed-attempt',
  });
  current.store.observeAttemptRunning({
    actor: current.controller,
    attemptId: admitted.attempt.id,
    nativeKind: 'herdr-pane',
    nativeServerGeneration: 'server-1',
    nativeLocator: 'managed-pane',
    idempotencyKey: 'observe-managed-attempt',
  });
  const incompleteResult = current.store.recordResult({
    actor: managedWorker,
    attemptId: admitted.attempt.id,
    content: { kind: 'report' },
    inputDigest: zeroDigest,
    workspaceDigest: oneDigest,
    evidenceClaims: [],
    evidence: [],
    verification: { kind: 'not-requested' },
    upstreamResultIds: [],
    idempotencyKey: 'record-managed-result',
  });
  assert.throws(
    () =>
      current.store.decideResult({
        actor: current.controller,
        resultId: incompleteResult.id,
        expectedBriefRevision: 1,
        decision: { kind: 'accepted' },
        idempotencyKey: 'accept-incomplete-managed-result',
      }),
    hasCode('invalid-state'),
  );
});

test('reports gated workflow mutations as unavailable', (t) => {
  const current = fixture(t);
  const actor: SessionIdentity = current.controller;
  assert.throws(
    () =>
      current.store.reviseBrief({
        actor,
        jobId: current.store.createJob(directJobInput(current, 'stub-job', 'stub-job')).id,
        expectedBriefRevision: 1,
        brief,
        changeReason: 'Changed request',
        idempotencyKey: 'revise-stub',
      }),
    hasCode('not-implemented'),
  );
});
