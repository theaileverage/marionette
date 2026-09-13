import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { z } from 'zod';

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
import { ArtifactFiles, registerArtifact } from '../../src/v1/artifacts.js';
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
    stateDirectory: join(directory, 'state'),
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
  executionRole = 'implementation',
): AgentSession {
  return fixtureValue.store.registerSession({
    id: AgentSessionIdSchema.parse(name),
    generation: 1,
    workspaceId: fixtureValue.workspaceId,
    role: 'worker',
    executionRole,
    tokenHash: tokenHash(`${name}-token`),
    parentWorkflowId,
    attemptId: null,
    nativeKind: null,
    nativeServerGeneration: null,
    nativeLocator: null,
  });
}

function admitRunningAttempt(
  current: Fixture,
  input: { jobKey: string; admissionKey: string; launchKey: string; observationKey: string },
) {
  const job = current.store.createJob(
    directJobInput(current, input.jobKey, `create-${input.jobKey}`),
  );
  const admission = current.store.admitAttempt({
    actor: current.controller,
    jobId: job.id,
    session: current.worker,
    resourceKey: `workspace:${input.jobKey}`,
    inputResultIds: [],
    expectedBriefRevision: 1,
    workflow: { kind: 'direct' },
    idempotencyKey: input.admissionKey,
  });
  current.store.claimAttemptLaunch({
    actor: current.controller,
    attemptId: admission.attempt.id,
    expectedBriefRevision: 1,
    expectedControlRevision: null,
    idempotencyKey: input.launchKey,
  });
  current.store.observeAttemptRunning({
    actor: current.controller,
    attemptId: admission.attempt.id,
    nativeKind: 'herdr-pane',
    nativeServerGeneration: 'server-1',
    nativeLocator: `pane-${input.jobKey}`,
    idempotencyKey: input.observationKey,
  });
  return admission.attempt;
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

test('rejects results whose file or command evidence has no durable artifact', (t) => {
  const current = fixture(t);
  const attempt = admitRunningAttempt(current, {
    jobKey: 'unverified-evidence',
    admissionKey: 'admit-unverified-evidence',
    launchKey: 'launch-unverified-evidence',
    observationKey: 'observe-unverified-evidence',
  });
  const missingLog = EvidenceSchema.parse({
    kind: 'command',
    argv: ['bun', 'test'],
    exitCode: 0,
    log: oneDigest,
  });

  assert.throws(
    () =>
      current.store.recordResult({
        actor: current.worker,
        attemptId: attempt.id,
        content: { kind: 'report', body: 'Tests passed.', artifactDigests: [] },
        inputDigest: zeroDigest,
        workspaceDigest: oneDigest,
        evidenceClaims: ['tests-pass'],
        evidence: [missingLog],
        verification: { kind: 'passed', checks: [missingLog] },
        upstreamResultIds: [],
        idempotencyKey: 'record-unverified-evidence',
      }),
    hasCode('not-found'),
  );
  const missingFile = EvidenceSchema.parse({ kind: 'file', path: 'report.md', digest: zeroDigest });
  assert.throws(
    () =>
      current.store.recordResult({
        actor: current.worker,
        attemptId: attempt.id,
        content: { kind: 'report', body: 'Verified report.', artifactDigests: [] },
        inputDigest: zeroDigest,
        workspaceDigest: oneDigest,
        evidenceClaims: ['report-present'],
        evidence: [],
        verification: { kind: 'passed', checks: [missingFile] },
        upstreamResultIds: [],
        idempotencyKey: 'record-unverified-check',
      }),
    hasCode('not-found'),
  );
});

test('rejects results whose evidence catalog bytes fail integrity verification', (t) => {
  const current = fixture(t);
  const attempt = admitRunningAttempt(current, {
    jobKey: 'damaged-evidence',
    admissionKey: 'admit-damaged-evidence',
    launchKey: 'launch-damaged-evidence',
    observationKey: 'observe-damaged-evidence',
  });
  const files = new ArtifactFiles(current.project.stateDirectory);
  const artifact = files.put(Buffer.from('original test log'));
  const digest = DigestSchema.parse(artifact.digest);
  registerArtifact(current.store, files, artifact);
  chmodSync(files.path(artifact), 0o600);
  writeFileSync(files.path(artifact), 'tampered log');
  const damagedLog = EvidenceSchema.parse({
    kind: 'command',
    argv: ['bun', 'test'],
    exitCode: 0,
    log: digest,
  });

  assert.throws(
    () =>
      current.store.recordResult({
        actor: current.worker,
        attemptId: attempt.id,
        content: { kind: 'report', body: 'Tests passed.', artifactDigests: [] },
        inputDigest: zeroDigest,
        workspaceDigest: oneDigest,
        evidenceClaims: ['tests-pass'],
        evidence: [damagedLog],
        verification: { kind: 'not-requested' },
        upstreamResultIds: [],
        idempotencyKey: 'record-damaged-evidence',
      }),
    hasCode('invalid-state'),
  );
});

test('retains evidence-only artifacts and rejects damage before first acceptance', (t) => {
  const current = fixture(t);
  const attempt = admitRunningAttempt(current, {
    jobKey: 'evidence-retention',
    admissionKey: 'admit-evidence-retention',
    launchKey: 'launch-evidence-retention',
    observationKey: 'observe-evidence-retention',
  });
  const files = new ArtifactFiles(current.project.stateDirectory);
  const artifact = files.put(Buffer.from('original command log'));
  const digest = DigestSchema.parse(artifact.digest);
  registerArtifact(current.store, files, artifact);
  const evidence = EvidenceSchema.parse({
    kind: 'command',
    argv: ['bun', 'test'],
    exitCode: 0,
    log: digest,
  });
  const recorded = current.store.recordResult({
    actor: current.worker,
    attemptId: attempt.id,
    content: { kind: 'report', body: 'Tests passed.', artifactDigests: [] },
    inputDigest: zeroDigest,
    workspaceDigest: oneDigest,
    evidenceClaims: ['tests-pass'],
    evidence: [evidence],
    verification: { kind: 'passed', checks: [evidence] },
    upstreamResultIds: [],
    idempotencyKey: 'record-evidence-retention',
  });
  chmodSync(files.path(artifact), 0o600);
  writeFileSync(files.path(artifact), 'tampered command log');

  assert.throws(
    () =>
      current.store.decideResult({
        actor: current.controller,
        resultId: recorded.id,
        expectedBriefRevision: 1,
        decision: { kind: 'accepted' },
        idempotencyKey: 'accept-damaged-evidence',
      }),
    hasCode('invalid-state'),
  );
  assert.deepEqual(
    current.store.read((database) =>
      database
        .prepare(
          `SELECT a.digest FROM result_artifacts ra
           JOIN artifacts a ON a.id = ra.artifact_id
           WHERE ra.result_id = ?`,
        )
        .all(recorded.id)
        .map((row) => ({ digest: z.object({ digest: DigestSchema }).parse(row).digest })),
    ),
    [{ digest }],
  );
});

test('rejects new worker results after settlement but replays an already recorded result', (t) => {
  const current = fixture(t);
  const attempt = admitRunningAttempt(current, {
    jobKey: 'settled-result',
    admissionKey: 'admit-settled-result',
    launchKey: 'launch-settled-result',
    observationKey: 'observe-settled-result',
  });
  const command = {
    actor: current.worker,
    attemptId: attempt.id,
    content: { kind: 'report' as const, body: 'Recorded while running.', artifactDigests: [] },
    inputDigest: zeroDigest,
    workspaceDigest: oneDigest,
    evidenceClaims: [],
    evidence: [],
    verification: { kind: 'not-requested' as const },
    upstreamResultIds: [],
    idempotencyKey: 'record-before-settlement',
  };
  const recorded = current.store.recordResult(command);
  current.store.settleAttempt({
    actor: current.controller,
    attemptId: attempt.id,
    observation: { kind: 'settled', outcome: 'succeeded', reason: 'Native process exited' },
    idempotencyKey: 'settle-recorded-result',
  });

  assert.equal(current.store.recordResult(command).id, recorded.id);
  assert.throws(
    () => current.store.recordResult({ ...command, idempotencyKey: 'record-after-settlement' }),
    hasCode('permission-denied'),
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
  const files = new ArtifactFiles(current.project.stateDirectory);
  const artifact = files.put(Buffer.from('verified command output'));
  const artifactDigest = DigestSchema.parse(artifact.digest);
  registerArtifact(current.store, files, artifact);
  const evidence = EvidenceSchema.parse({
    kind: 'command',
    argv: ['bun', 'test'],
    exitCode: 0,
    log: artifactDigest,
  });
  const result = current.store.recordResult({
    actor: current.worker,
    attemptId: admission.attempt.id,
    content: {
      kind: 'report',
      body: 'Implementation completed.',
      artifactDigests: [artifactDigest],
    },
    inputDigest: zeroDigest,
    workspaceDigest: artifactDigest,
    evidenceClaims: ['tests-pass'],
    evidence: [evidence],
    verification: { kind: 'passed', checks: [evidence] },
    upstreamResultIds: [],
    idempotencyKey: 'record-result',
  });
  assert.deepEqual(current.store.getResult(result.id), result);
  assert.equal(
    current.store.read(
      (database) =>
        database
          .prepare('SELECT count(*) AS count FROM result_artifacts WHERE result_id = ?')
          .get(result.id)?.count,
    ),
    1,
  );
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
  const acceptance = current.store.decideResult({
    actor: current.controller,
    resultId: result.id,
    expectedBriefRevision: 1,
    decision: { kind: 'accepted' },
    idempotencyKey: 'accept-result',
  });
  assert.equal(acceptance.decision, 'accepted');
  chmodSync(files.path(artifact), 0o600);
  writeFileSync(files.path(artifact), 'tampered command output');
  assert.equal(
    current.store.decideResult({
      actor: current.controller,
      resultId: result.id,
      expectedBriefRevision: 1,
      decision: { kind: 'accepted' },
      idempotencyKey: 'accept-result',
    }).id,
    acceptance.id,
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
  current.store.close();
  const reopened = Store.open({
    databasePath: current.store.databasePath,
    project: current.project,
  });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.getResult(result.id).content, {
    kind: 'report',
    body: 'Implementation completed.',
    artifactDigests: [artifactDigest],
  });
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
    entryStep: 'implement',
    steps: [
      {
        name: 'not-the-entry',
        phase: 'design',
        resources: [],
        outputContract: 'Unused test step',
        permittedMethods: ['direct'],
        requiredEvidence: [],
        requiresDistinctRole: false,
      },
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
  assert.equal(current.store.getStepRun(workflow.currentStepRunId).stepName, 'implement');
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
  const parallelWorker = registerWorker(current, 'parallel-worker', workflow.id);
  assert.throws(
    () =>
      current.store.admitAttempt({
        actor: current.controller,
        jobId: workflow.rootJobId,
        session: parallelWorker,
        resourceKey: 'workflow:parallel',
        inputResultIds: [],
        expectedBriefRevision: 1,
        workflow: {
          kind: 'managed',
          workflowId: workflow.id,
          stepRunId: workflow.currentStepRunId,
          expectedWorkflowRevision: 2,
          expectedControlRevision: 1,
        },
        idempotencyKey: 'parallel-managed-admission',
      }),
    hasCode('limit-exhausted'),
  );
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
    content: { kind: 'report', body: 'Implementation result.', artifactDigests: [] },
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

test('requires review sessions to have a distinct identity and execution role', (t) => {
  const current = fixture(t);
  const workflowPackage = WorkflowPackageSnapshotSchema.parse({
    name: 'separated-review',
    version: '1',
    digest: DigestSchema.parse('2'.repeat(64)),
    sourceDigests: [],
    entryStep: 'implement',
    steps: [
      {
        name: 'implement',
        phase: 'implementation',
        resources: ['workspace'],
        outputContract: 'Implementation result',
        permittedMethods: ['direct'],
        requiredEvidence: [],
        requiresDistinctRole: false,
      },
      {
        name: 'review',
        phase: 'review',
        resources: ['workspace'],
        outputContract: 'Review result',
        permittedMethods: ['direct'],
        requiredEvidence: [],
        requiresDistinctRole: true,
      },
    ],
    transitions: [
      { kind: 'advance', from: 'implement', to: 'review' },
      { kind: 'finish', from: 'review' },
    ],
    limits: {
      maxAttempts: 3,
      maxRepeats: 1,
      deadlineMs: 60_000,
      parallelism: 1,
      innerLoopDeadlineMs: 30_000,
    },
  });
  const workflow = current.store.createWorkflow({
    actor: current.controller,
    stableKey: 'separated-review',
    package: workflowPackage,
    request,
    brief,
    workspaceId: current.workspaceId,
    delivery: 'report',
    boundary: 'all',
    idempotencyKey: 'create-separated-review',
  });
  const implementer = registerWorker(current, 'separation-implementer', workflow.id);
  const implementation = current.store.admitAttempt({
    actor: current.controller,
    jobId: workflow.rootJobId,
    session: implementer,
    resourceKey: 'separation:implementation',
    inputResultIds: [],
    expectedBriefRevision: 1,
    workflow: {
      kind: 'managed',
      workflowId: workflow.id,
      stepRunId: workflow.currentStepRunId,
      expectedWorkflowRevision: 1,
      expectedControlRevision: 1,
    },
    idempotencyKey: 'admit-separation-implementation',
  });
  current.store.settleAttempt({
    actor: current.controller,
    attemptId: implementation.attempt.id,
    observation: { kind: 'settled', outcome: 'succeeded', reason: 'Implementation complete' },
    idempotencyKey: 'settle-separation-implementation',
  });

  const reviewStepId = 'step_review';
  current.store.transaction((database) => {
    const now = new Date().toISOString();
    database
      .prepare("UPDATE step_runs SET phase = 'succeeded', updated_at = ? WHERE id = ?")
      .run(now, workflow.currentStepRunId);
    database
      .prepare(
        `INSERT INTO step_runs
           (id, project_id, workflow_id, job_id, step_name, step_phase, ordinal,
            phase, input_workflow_revision, input_brief_revision,
            source_transition_request_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'review', 'review', 2, 'pending', 3, 1, NULL, ?, ?)`,
      )
      .run(reviewStepId, current.project.id, workflow.id, workflow.rootJobId, now, now);
    database
      .prepare('UPDATE workflow_runs SET current_step_run_id = ?, revision = 3 WHERE id = ?')
      .run(reviewStepId, workflow.id);
  });

  const sameRoleReviewer = registerWorker(
    current,
    'same-role-reviewer',
    workflow.id,
    'implementation',
  );
  const reviewAdmission = (session: AgentSession, idempotencyKey: string) =>
    current.store.admitAttempt({
      actor: current.controller,
      jobId: workflow.rootJobId,
      session,
      resourceKey: 'separation:review',
      inputResultIds: [],
      expectedBriefRevision: 1,
      workflow: {
        kind: 'managed',
        workflowId: workflow.id,
        stepRunId: current.store.getWorkflow(workflow.id).currentStepRunId,
        expectedWorkflowRevision: 3,
        expectedControlRevision: 1,
      },
      idempotencyKey,
    });
  assert.throws(
    () => reviewAdmission(sameRoleReviewer, 'reject-same-role-reviewer'),
    hasCode('permission-denied'),
  );
  const distinctReviewer = registerWorker(current, 'distinct-reviewer', workflow.id, 'review');
  assert.equal(reviewAdmission(distinctReviewer, 'admit-distinct-reviewer').workflowRevision, 4);
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
