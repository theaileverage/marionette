import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Effect, Schema } from 'effect';

import {
  ArtifactFiles,
  artifactSchema,
  registerArtifact,
  type Artifact,
} from '../src/v1/artifacts.js';
import { captureGitState, exportCommit, gitStateSchema, type GitState } from '../src/v1/git.js';
import { Handoffs, type Handoff } from '../src/v1/handoff.js';
import {
  AgentSessionIdSchema,
  DigestSchema,
  HostIdSchema,
  ProjectBindingSchema,
  ProjectIdSchema,
  SessionGenerationSchema,
  WorkspaceIdSchema,
  type AttemptId,
  type ResultId,
  type WorkspaceId,
} from '../src/v1/model.js';
import { Store, type AgentSession, type SessionIdentity } from '../src/v1/store.js';
import { previewWorkspaceRetirement } from '../src/v1/retirement.js';
import { previewRuntimeWorkspaceRetirement } from '../src/v1/runtime-retirement.js';

const decode = <S extends Schema.ConstraintDecoder<unknown, never>, Value>(
  schema: S,
  value: Value,
): S['Type'] => Schema.decodeUnknownSync(schema)(value);

const inputDigest = decode(DigestSchema, '0'.repeat(64));

const reservationStateSchema = Schema.Literals(['held', 'released', 'unconfirmed']);

const completedCheckSchema = Schema.Struct({
  kind: Schema.Literals(['passed', 'failed']),
  target: gitStateSchema,
  log: artifactSchema,
});

type Fixture = {
  repositoryRoot: string;
  sourcePath: string;
  targetWorkspaceId: WorkspaceId;
  controller: SessionIdentity;
  sourceAttemptId: AttemptId;
  targetAttemptId: AttemptId;
  resultId: ResultId;
  exportedPatch: Artifact;
  expectedTarget: GitState;
  store: Store;
  artifacts: ArtifactFiles;
  handoffs: Handoffs;
};

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });

  assert.equal(result.status, 0, result.stderr);

  return result.stdout.trim();
}

function registerWorker(store: Store, id: string, workspaceId: WorkspaceId): AgentSession {
  return store.registerSession({
    id: decode(AgentSessionIdSchema, id),
    generation: decode(SessionGenerationSchema, 1),
    workspaceId,
    role: 'worker',
    executionRole: 'implementation',
    tokenHash: createHash('sha256').update(id).digest('hex'),
    parentWorkflowId: null,
    attemptId: null,
    nativeKind: null,
    nativeServerGeneration: null,
    nativeLocator: null,
  });
}

function runningAttempt(options: {
  store: Store;
  controller: SessionIdentity;
  worker: AgentSession;
  workspaceId: WorkspaceId;
  name: string;
  delivery: 'report' | 'commit';
}) {
  const job = options.store.createJob({
    actor: options.controller,
    stableKey: `${options.name}-job`,
    request: {
      text: `${options.name} request`,
      digest: inputDigest,
      inputSnapshots: [],
    },
    brief: {
      objective: `${options.name} objective`,
      scope: ['tracked.txt'],
      ownership: ['tracked.txt'],
      constraints: [],
      standingOrders: [],
      inputSnapshots: [],
    },
    workspaceId: options.workspaceId,
    delivery: options.delivery,
    origin: { kind: 'direct' },
    dependencies: [],
    idempotencyKey: `create-${options.name}-job`,
  });

  const admitted = options.store.admitAttempt({
    actor: options.controller,
    jobId: job.id,
    session: options.worker,
    resourceKey: `${options.name}:workspace`,
    inputResultIds: [],
    expectedBriefRevision: 1,
    workflow: { kind: 'direct' },
    idempotencyKey: `admit-${options.name}-attempt`,
  });

  options.store.claimAttemptLaunch({
    actor: options.controller,
    attemptId: admitted.attempt.id,
    expectedBriefRevision: 1,
    expectedControlRevision: null,
    idempotencyKey: `claim-${options.name}-launch`,
  });
  options.store.observeAttemptRunning({
    actor: options.controller,
    attemptId: admitted.attempt.id,
    nativeKind: 'fixture',
    nativeServerGeneration: 'fixture-server-1',
    nativeLocator: `${options.name}-locator`,
    idempotencyKey: `observe-${options.name}-running`,
  });

  return { job, attempt: options.store.getAttempt(admitted.attempt.id) };
}

function createFixture(t: TestContext): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'marionette-v1-handoff-')));
  const repositoryRoot = join(root, 'repository');
  const sourcePath = join(root, 'source');
  const stateDirectory = join(root, 'state');
  mkdirSync(repositoryRoot);
  git(repositoryRoot, ['init', '-q']);
  git(repositoryRoot, ['config', 'user.name', 'Handoff Fixture']);
  git(repositoryRoot, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(repositoryRoot, 'tracked.txt'), 'base\n');
  git(repositoryRoot, ['add', 'tracked.txt']);
  git(repositoryRoot, ['commit', '-qm', 'base']);
  const expectedTarget = captureGitState(repositoryRoot);
  git(repositoryRoot, ['worktree', 'add', '-q', '-b', 'fixture-source', sourcePath, 'HEAD']);
  writeFileSync(join(sourcePath, 'tracked.txt'), 'integrated result\n');
  git(sourcePath, ['add', 'tracked.txt']);
  git(sourcePath, ['commit', '-qm', 'source result']);

  const project = decode(ProjectBindingSchema, {
    id: decode(ProjectIdSchema, 'project_handoff'),
    hostId: decode(HostIdSchema, 'host_handoff'),
    repositoryRoot,
    stateDirectory,
  });

  let nextId = 0;

  const store = Store.open({
    databasePath: join(root, 'state.sqlite'),
    project,
    clock: () => new Date('2026-09-11T00:00:00.000Z'),
    idFactory: (kind) => `${kind}_${++nextId}`,
  });

  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const artifacts = new ArtifactFiles(stateDirectory);

  const controller = {
    id: decode(AgentSessionIdSchema, 'session_controller'),
    generation: decode(SessionGenerationSchema, 1),
  };

  store.registerSession({
    ...controller,
    workspaceId: null,
    role: 'controller',
    executionRole: 'controller',
    tokenHash: 'a'.repeat(64),
    parentWorkflowId: null,
    attemptId: null,
    nativeKind: null,
    nativeServerGeneration: null,
    nativeLocator: null,
  });
  const sourceWorkspaceId = decode(WorkspaceIdSchema, 'workspace_source');
  const targetWorkspaceId = decode(WorkspaceIdSchema, 'workspace_target');
  store.registerWorkspace({
    actor: controller,
    id: sourceWorkspaceId,
    kind: 'isolated',
    path: sourcePath,
    repositoryRoot,
    baseCommit: expectedTarget.head,
    access: 'write',
    writes: ['tracked.txt'],
    idempotencyKey: 'register-source-workspace',
  });
  store.registerWorkspace({
    actor: controller,
    id: targetWorkspaceId,
    kind: 'existing',
    path: repositoryRoot,
    repositoryRoot,
    baseCommit: expectedTarget.head,
    access: 'write',
    writes: ['tracked.txt'],
    idempotencyKey: 'register-target-workspace',
  });
  const sourceWorker = registerWorker(store, 'session_source', sourceWorkspaceId);
  const targetWorker = registerWorker(store, 'session_target', targetWorkspaceId);

  const source = runningAttempt({
    store,
    controller,
    worker: sourceWorker,
    workspaceId: sourceWorkspaceId,
    name: 'source',
    delivery: 'commit',
  });

  const target = runningAttempt({
    store,
    controller,
    worker: targetWorker,
    workspaceId: targetWorkspaceId,
    name: 'target',
    delivery: 'report',
  });

  const exported = exportCommit({
    workspacePath: sourcePath,
    base: expectedTarget.head,
    commit: git(sourcePath, ['rev-parse', 'HEAD']),
    artifacts,
  });

  registerArtifact(store, artifacts, exported.patch);

  const result = store.recordResult({
    actor: sourceWorker,
    attemptId: source.attempt.id,
    content: {
      kind: 'commit',
      sourceRepository: exported.repositoryRoot,
      baseCommit: exported.base,
      resultingTree: exported.tree,
      resultingCommit: exported.commit,
      changedPaths: exported.changedPaths,
      artifactDigests: [decode(DigestSchema, exported.patch.digest)],
    },
    inputDigest,
    workspaceDigest: decode(DigestSchema, exported.tree.padEnd(64, '0')),
    evidenceClaims: ['source-commit'],
    evidence: [
      {
        kind: 'git-commit',
        commit: exported.commit,
        parent: exported.base,
        paths: exported.changedPaths,
      },
    ],
    verification: { kind: 'not-requested' },
    upstreamResultIds: [],
    idempotencyKey: 'record-source-result',
  });

  return {
    repositoryRoot,
    sourcePath,
    targetWorkspaceId,
    controller,
    sourceAttemptId: source.attempt.id,
    targetAttemptId: target.attempt.id,
    resultId: result.id,
    exportedPatch: exported.patch,
    expectedTarget,
    store,
    artifacts,
    handoffs: new Handoffs(store, artifacts),
  };
}

function createHandoff(fixture: Fixture, suffix: string): Handoff {
  return fixture.handoffs.create({
    resultId: fixture.resultId,
    consumer: { kind: 'user', id: 'integration-lead' },
    targetWorkspaceId: fixture.targetWorkspaceId,
    expectedTarget: captureGitState(fixture.repositoryRoot),
    idempotencyKey: `create-handoff-${suffix}`,
  });
}

function acceptSourceResult(fixture: Fixture): void {
  fixture.store.decideResult({
    actor: fixture.controller,
    resultId: fixture.resultId,
    expectedBriefRevision: 1,
    decision: { kind: 'accepted' },
    idempotencyKey: 'accept-source-result',
  });
}

function supersedeSourceBrief(fixture: Fixture): () => void {
  const sourceResult = fixture.store.getResult(fixture.resultId);
  const supersedingBriefId = 'brief_superseding_fixture';
  fixture.store.transaction((database) => {
    database
      .prepare(
        `INSERT INTO brief_revisions
           (id, project_id, job_id, revision, prior_brief_id, content_json, change_reason, created_at)
         SELECT ?, project_id, job_id, 2, id, content_json, 'Fixture supersession', ?
         FROM brief_revisions WHERE id = ?`,
      )
      .run(supersedingBriefId, new Date().toISOString(), sourceResult.briefId);
    database
      .prepare('UPDATE jobs SET current_brief_id = ?, current_brief_revision = 2 WHERE id = ?')
      .run(supersedingBriefId, sourceResult.jobId);
  });

  return () => {
    fixture.store.transaction((database) => {
      database
        .prepare('UPDATE jobs SET current_brief_id = ?, current_brief_revision = 1 WHERE id = ?')
        .run(sourceResult.briefId, sourceResult.jobId);
    });
  };
}

function reservationState(fixture: Fixture, handoffId: string): typeof reservationStateSchema.Type {
  return decode(
    reservationStateSchema,
    fixture.store.read(
      (database) =>
        database
          .prepare('SELECT state FROM writer_reservations WHERE handoff_id = ?')
          .get(handoffId)?.state,
    ),
  );
}

test('claims only an accepted current result through an attempt on the target write workspace', (t) => {
  const fixture = createFixture(t);
  const handoff = createHandoff(fixture, 'claim');
  assert.throws(
    () =>
      fixture.handoffs.claim({
        handoffId: handoff.id,
        attemptId: fixture.targetAttemptId,
        expectedClaimRevision: 0,
        idempotencyKey: 'claim-unaccepted-result',
      }),
    /accepted for the current brief/,
  );
  acceptSourceResult(fixture);
  const restoreSourceBrief = supersedeSourceBrief(fixture);
  assert.throws(
    () =>
      fixture.handoffs.claim({
        handoffId: handoff.id,
        attemptId: fixture.targetAttemptId,
        expectedClaimRevision: 0,
        idempotencyKey: 'claim-accepted-stale-result',
      }),
    /accepted for the current brief/,
  );
  restoreSourceBrief();
  assert.throws(
    () =>
      fixture.handoffs.claim({
        handoffId: handoff.id,
        attemptId: fixture.sourceAttemptId,
        expectedClaimRevision: 0,
        idempotencyKey: 'claim-from-source-workspace',
      }),
    /target write workspace/,
  );
  fixture.store.transaction((database) => {
    database
      .prepare("UPDATE workspaces SET access = 'inspect' WHERE id = ?")
      .run(fixture.targetWorkspaceId);
  });
  assert.throws(
    () =>
      fixture.handoffs.claim({
        handoffId: handoff.id,
        attemptId: fixture.targetAttemptId,
        expectedClaimRevision: 0,
        idempotencyKey: 'claim-without-write-access',
      }),
    /target write workspace/,
  );
  fixture.store.transaction((database) => {
    database
      .prepare("UPDATE workspaces SET access = 'write' WHERE id = ?")
      .run(fixture.targetWorkspaceId);
  });
  fixture.store.transaction((database) => {
    database
      .prepare('UPDATE workspaces SET retired_at = ? WHERE id = ?')
      .run(new Date().toISOString(), fixture.targetWorkspaceId);
  });
  assert.throws(
    () =>
      fixture.handoffs.claim({
        handoffId: handoff.id,
        attemptId: fixture.targetAttemptId,
        expectedClaimRevision: 0,
        idempotencyKey: 'claim-retired-target',
      }),
    /target write workspace/,
  );
  fixture.store.transaction((database) => {
    database
      .prepare('UPDATE workspaces SET retired_at = NULL WHERE id = ?')
      .run(fixture.targetWorkspaceId);
  });

  const claimed = fixture.handoffs.claim({
    handoffId: handoff.id,
    attemptId: fixture.targetAttemptId,
    expectedClaimRevision: 0,
    idempotencyKey: 'claim-target-workspace',
  });

  assert.equal(claimed.state, 'integrating');
  assert.equal(claimed.claim_revision, 1);
  assert.equal(claimed.claimed_attempt_id, fixture.targetAttemptId);
  assert.equal(reservationState(fixture, handoff.id), 'held');
});

test('completes only after the accepted source patch is present in the checked target', (t) => {
  const fixture = createFixture(t);
  acceptSourceResult(fixture);
  const handoff = createHandoff(fixture, 'source-content');
  fixture.handoffs.claim({
    handoffId: handoff.id,
    attemptId: fixture.targetAttemptId,
    expectedClaimRevision: 0,
    idempotencyKey: 'claim-source-content',
  });

  const checkedWithoutResult = fixture.handoffs.check({
    handoffId: handoff.id,
    attemptId: fixture.targetAttemptId,
    expectedClaimRevision: 1,
    argv: ['true'],
    timeoutMs: 30_000,
    idempotencyKey: 'check-without-source-content',
  });

  const emptyTargetCheck = decode(
    completedCheckSchema,
    JSON.parse(checkedWithoutResult.checks_json ?? 'null'),
  );

  assert.equal(emptyTargetCheck.kind, 'passed');
  assert.deepEqual(emptyTargetCheck.target, fixture.expectedTarget);
  assert.throws(
    () =>
      fixture.handoffs.complete({
        handoffId: handoff.id,
        attemptId: fixture.targetAttemptId,
        expectedClaimRevision: 1,
        state: 'integrated',
        reason: 'The command passed without applying the source result',
        idempotencyKey: 'reject-absent-source-content',
      }),
    /Target does not contain the accepted source patch/,
  );
  assert.equal(fixture.handoffs.get(handoff.id).state, 'integrating');
  assert.equal(reservationState(fixture, handoff.id), 'held');

  git(fixture.repositoryRoot, ['cherry-pick', git(fixture.sourcePath, ['rev-parse', 'HEAD'])]);
  const integratedTarget = captureGitState(fixture.repositoryRoot);

  const checkedWithResult = fixture.handoffs.check({
    handoffId: handoff.id,
    attemptId: fixture.targetAttemptId,
    expectedClaimRevision: 1,
    argv: ['true'],
    timeoutMs: 30_000,
    idempotencyKey: 'check-with-source-content',
  });

  const integratedCheck = decode(
    completedCheckSchema,
    JSON.parse(checkedWithResult.checks_json ?? 'null'),
  );

  assert.equal(integratedCheck.kind, 'passed');
  assert.deepEqual(integratedCheck.target, integratedTarget);

  const restoreSourceBrief = supersedeSourceBrief(fixture);
  assert.throws(
    () =>
      fixture.handoffs.complete({
        handoffId: handoff.id,
        attemptId: fixture.targetAttemptId,
        expectedClaimRevision: 1,
        state: 'integrated',
        reason: 'The accepted source revision is no longer current',
        idempotencyKey: 'reject-stale-source-acceptance',
      }),
    /accepted for the current brief/,
  );
  restoreSourceBrief();

  const completed = fixture.handoffs.complete({
    handoffId: handoff.id,
    attemptId: fixture.targetAttemptId,
    expectedClaimRevision: 1,
    state: 'integrated',
    reason: 'Accepted source patch is present and target checks passed',
    idempotencyKey: 'complete-with-source-content',
  });

  assert.equal(completed.state, 'integrated');
  assert.deepEqual(JSON.parse(completed.actual_target_state_json ?? 'null'), integratedTarget);
  assert.equal(reservationState(fixture, handoff.id), 'released');
});

test('runs checks on the integrated target and rejects drift during or after a passing check', async (t) => {
  const fixture = createFixture(t);
  acceptSourceResult(fixture);
  const handoff = createHandoff(fixture, 'checks');
  fixture.handoffs.claim({
    handoffId: handoff.id,
    attemptId: fixture.targetAttemptId,
    expectedClaimRevision: 0,
    idempotencyKey: 'claim-for-checks',
  });
  git(fixture.repositoryRoot, ['cherry-pick', git(fixture.sourcePath, ['rev-parse', 'HEAD'])]);
  const integratedTarget = captureGitState(fixture.repositoryRoot);
  assert.notEqual(integratedTarget.head, fixture.expectedTarget.head);

  fixture.store.transaction((database) => {
    database
      .prepare("UPDATE workspaces SET access = 'inspect' WHERE id = ?")
      .run(fixture.targetWorkspaceId);
  });
  assert.throws(
    () =>
      fixture.handoffs.check({
        handoffId: handoff.id,
        attemptId: fixture.targetAttemptId,
        expectedClaimRevision: 1,
        argv: [process.execPath, '-e', "console.log('must not run')"],
        timeoutMs: 30_000,
        idempotencyKey: 'check-without-write-access',
      }),
    /target write workspace/,
  );
  fixture.store.transaction((database) => {
    database
      .prepare("UPDATE workspaces SET access = 'write' WHERE id = ?")
      .run(fixture.targetWorkspaceId);
  });

  const failed = fixture.handoffs.check({
    handoffId: handoff.id,
    attemptId: fixture.targetAttemptId,
    expectedClaimRevision: 1,
    argv: [
      process.execPath,
      '-e',
      "require('node:fs').writeFileSync('drift-during-check.txt','unexpected'); console.log('mutated')",
    ],
    timeoutMs: 30_000,
    idempotencyKey: 'check-that-mutates-target',
  });

  const failedCheck = decode(completedCheckSchema, JSON.parse(failed.checks_json ?? 'null'));
  assert.equal(failedCheck.kind, 'failed');
  assert.deepEqual(failedCheck.target, integratedTarget);
  assert.match(fixture.artifacts.read(failedCheck.log).toString(), /mutated/);
  rmSync(join(fixture.repositoryRoot, 'drift-during-check.txt'));

  const checked = await Effect.runPromise(
    fixture.handoffs.checkEffect({
      handoffId: handoff.id,
      attemptId: fixture.targetAttemptId,
      expectedClaimRevision: 1,
      argv: [process.execPath, '-e', "console.log('target check passed')"],
      timeoutMs: 30_000,
      idempotencyKey: 'check-integrated-target',
    }),
  );

  const passedCheck = decode(completedCheckSchema, JSON.parse(checked.checks_json ?? 'null'));
  assert.equal(passedCheck.kind, 'passed');
  assert.deepEqual(passedCheck.target, integratedTarget);
  assert.match(fixture.artifacts.read(passedCheck.log).toString(), /target check passed/);

  fixture.store.transaction((database) => {
    database
      .prepare("UPDATE workspaces SET access = 'inspect' WHERE id = ?")
      .run(fixture.targetWorkspaceId);
  });
  assert.throws(
    () =>
      fixture.handoffs.complete({
        handoffId: handoff.id,
        attemptId: fixture.targetAttemptId,
        expectedClaimRevision: 1,
        state: 'integrated',
        reason: 'Target write membership was revoked',
        idempotencyKey: 'complete-without-write-access',
      }),
    /target write workspace/,
  );
  fixture.store.transaction((database) => {
    database
      .prepare("UPDATE workspaces SET access = 'write' WHERE id = ?")
      .run(fixture.targetWorkspaceId);
  });

  const unrelated = join(fixture.repositoryRoot, 'unrelated.txt');
  writeFileSync(unrelated, 'concurrent writer');
  assert.throws(
    () =>
      fixture.handoffs.complete({
        handoffId: handoff.id,
        attemptId: fixture.targetAttemptId,
        expectedClaimRevision: 1,
        state: 'integrated',
        reason: 'Integrated result passed target checks',
        idempotencyKey: 'complete-after-target-drift',
      }),
    /Target Git state changed/,
  );
  rmSync(unrelated);

  const completed = fixture.handoffs.complete({
    handoffId: handoff.id,
    attemptId: fixture.targetAttemptId,
    expectedClaimRevision: 1,
    state: 'integrated',
    reason: 'Integrated result passed target checks',
    idempotencyKey: 'complete-integrated-handoff',
  });

  assert.equal(completed.state, 'integrated');
  assert.deepEqual(JSON.parse(completed.actual_target_state_json ?? 'null'), integratedTarget);
  assert.equal(reservationState(fixture, handoff.id), 'released');

  git(fixture.repositoryRoot, ['worktree', 'remove', fixture.sourcePath]);
  assert.match(fixture.artifacts.read(fixture.exportedPatch).toString(), /\+integrated result/);
  assert.match(fixture.artifacts.read(passedCheck.log).toString(), /target check passed/);
  assert.equal(
    readFileSync(join(fixture.repositoryRoot, 'tracked.txt'), 'utf8'),
    'integrated result\n',
  );
});

test('retains an unconfirmed claim until settlement and replans without losing artifacts', (t) => {
  const fixture = createFixture(t);
  acceptSourceResult(fixture);
  const handoff = createHandoff(fixture, 'unconfirmed');
  fixture.handoffs.claim({
    handoffId: handoff.id,
    attemptId: fixture.targetAttemptId,
    expectedClaimRevision: 0,
    idempotencyKey: 'claim-before-uncertainty',
  });

  const uncertain = fixture.handoffs.complete({
    handoffId: handoff.id,
    attemptId: fixture.targetAttemptId,
    expectedClaimRevision: 1,
    state: 'unconfirmed',
    reason: 'Backend disconnected after Git may have changed',
    idempotencyKey: 'mark-handoff-unconfirmed',
  });

  assert.equal(uncertain.state, 'unconfirmed');
  assert.equal(reservationState(fixture, handoff.id), 'unconfirmed');
  const currentTarget = captureGitState(fixture.repositoryRoot);

  const replan = () =>
    fixture.handoffs.replan({
      handoffId: handoff.id,
      expectedClaimRevision: 1,
      expectedTarget: currentTarget,
      reason: 'Inspected target after native settlement',
      idempotencyKey: 'replan-after-settlement',
    });

  assert.throws(replan, /Prior integrator settlement is unconfirmed/);
  assert.equal(reservationState(fixture, handoff.id), 'unconfirmed');
  fixture.store.settleAttempt({
    actor: fixture.controller,
    attemptId: fixture.targetAttemptId,
    observation: {
      kind: 'settled',
      outcome: 'interrupted',
      reason: 'Native exit observed and target inspected',
    },
    idempotencyKey: 'settle-unconfirmed-integrator',
  });
  assert.equal(reservationState(fixture, handoff.id), 'released');
  const replanned = replan();
  assert.equal(replanned.state, 'pending');
  assert.equal(replanned.claim_revision, 2);
  assert.equal(replanned.claimed_attempt_id, null);
  assert.equal(replanned.current_claim_id, null);
  assert.deepEqual(JSON.parse(replanned.expected_target_state_json), currentTarget);
  assert.match(fixture.artifacts.read(fixture.exportedPatch).toString(), /\+integrated result/);
});

test('explicit undefined retirement options retain omission semantics', (t) => {
  const fixture = createFixture(t);

  const input = {
    store: fixture.store,
    actor: fixture.controller,
    workspaceId: fixture.targetWorkspaceId,
    idempotencyKey: 'preview-optional-parity',
  };

  assert.deepEqual(
    previewWorkspaceRetirement({
      ...input,
      nativeTargets: undefined,
      git: undefined,
    }),
    previewWorkspaceRetirement(input),
  );
  assert.deepEqual(
    previewRuntimeWorkspaceRetirement({ ...input, git: undefined }),
    previewRuntimeWorkspaceRetirement(input),
  );
});
