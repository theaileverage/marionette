import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Store } from '../../src/v1/store.js';
import {
  AgentSessionIdSchema,
  DigestSchema,
  HostIdSchema,
  ProjectIdSchema,
  WorkspaceIdSchema,
  WorkflowPackageSnapshotSchema,
} from '../../src/v1/model.js';
import { HumanDecisions } from '../../src/v1/decisions/human-decisions.js';
import { NativeApprovals } from '../../src/v1/decisions/native-approvals.js';
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'decisions-'));
  const store = Store.open({
    databasePath: join(directory, 'db'),
    project: {
      id: ProjectIdSchema.parse('p'),
      hostId: HostIdSchema.parse('h'),
      repositoryRoot: '/repo',
      stateDirectory: directory,
    },
  });
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const actor = store.registerSession({
    id: AgentSessionIdSchema.parse('user'),
    generation: 1,
    role: 'user',
    executionRole: 'user',
    workspaceId: null,
    parentWorkflowId: null,
    attemptId: null,
    nativeKind: null,
    nativeServerGeneration: null,
    nativeLocator: null,
    tokenHash: 'a'.repeat(64),
  });
  const workspaceId = WorkspaceIdSchema.parse('w');
  store.registerWorkspace({
    actor,
    id: workspaceId,
    kind: 'isolated',
    path: '/repo/w',
    repositoryRoot: '/repo',
    baseCommit: 'base',
    access: 'write',
    writes: ['src/**'],
    idempotencyKey: 'w',
  });
  const workflow = store.createWorkflow({
    actor,
    stableKey: 'wf',
    package: WorkflowPackageSnapshotSchema.parse({
      name: 'decision',
      version: '1',
      digest: '0'.repeat(64),
      sourceDigests: [],
      entryStep: 'work',
      steps: [
        {
          name: 'work',
          phase: 'implementation',
          resources: ['workspace'],
          outputContract: 'report',
          permittedMethods: ['direct'],
          requiredEvidence: [],
          requiresDistinctRole: false,
        },
      ],
      transitions: [{ kind: 'block', from: 'work' }],
      limits: {
        maxAttempts: 3,
        maxRepeats: 2,
        deadlineMs: 600000,
        parallelism: 1,
        innerLoopDeadlineMs: 300000,
      },
    }),
    request: { text: 'work', digest: DigestSchema.parse('0'.repeat(64)), inputSnapshots: [] },
    brief: {
      objective: 'work',
      scope: ['src/**'],
      ownership: ['src/**'],
      constraints: [],
      standingOrders: [],
      inputSnapshots: [],
    },
    workspaceId,
    delivery: 'report',
    boundary: 'all',
    idempotencyKey: 'wf',
  });
  const expected = { workflow: 1, brief: 1, control: 1, authority: 1, budget: 1 };
  const decisions = new HumanDecisions(store, actor),
    approvals = new NativeApprovals(store, actor);
  const request = () =>
    decisions.request({
      workflowId: workflow.id,
      question: 'Block?',
      options: [
        {
          id: 'block',
          label: 'Block until fixed',
          effects: {
            kind: 'workflow-transition',
            request: {
              kind: 'block',
              workflowId: workflow.id,
              sourceStepRunId: workflow.currentStepRunId,
              expectedWorkflowRevision: 1,
              expectedBriefRevision: 1,
              expectedControlRevision: 1,
              evidenceResultIds: [],
              reason: 'User chose block',
              resolutionCondition: 'Fix issue',
              idempotencyKey: 'option',
            },
          },
        },
      ],
      expected,
      idempotencyKey: 'ask',
    }).value;
  const worker = store.registerSession({
    id: AgentSessionIdSchema.parse('worker'),
    generation: 1,
    role: 'worker',
    executionRole: 'implementation',
    workspaceId,
    parentWorkflowId: workflow.id,
    attemptId: null,
    nativeKind: null,
    nativeServerGeneration: null,
    nativeLocator: null,
    tokenHash: 'b'.repeat(64),
  });
  function approval() {
    const attempt = store.admitAttempt({
      actor,
      jobId: workflow.rootJobId,
      session: worker,
      resourceKey: 'worker',
      inputResultIds: [],
      expectedBriefRevision: 1,
      workflow: {
        kind: 'managed',
        workflowId: workflow.id,
        stepRunId: workflow.currentStepRunId,
        expectedWorkflowRevision: 1,
        expectedControlRevision: 1,
      },
      idempotencyKey: 'attempt',
    }).attempt;
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
      nativeKind: 'herdr-pane',
      nativeServerGeneration: 'server',
      nativeLocator: 'pane',
      idempotencyKey: 'running',
    });
    expected.workflow = store.getWorkflow(workflow.id).revision;
    const identity = {
      operationId: 'op',
      operationFingerprint: 'f'.repeat(64),
      serverGeneration: 'server',
      sessionId: worker.id,
      sessionGeneration: 1,
    };
    return {
      id: approvals.request({
        attemptId: attempt.id,
        identity,
        display: { tool: 'shell', summary: 'Run check' },
        expected,
        idempotencyKey: 'approval',
      }).value,
      identity,
    };
  }
  return { store, actor, workflow, expected, decisions, approvals, request, approval };
}
test('human choice executes transition and immutable receipt exactly once', (t) => {
  const f = fixture(t),
    id = f.request();
  const input = {
    decisionId: id,
    optionId: 'block',
    expected: f.expected,
    idempotencyKey: 'resolve',
  };
  const first = f.decisions.resolve(input);
  assert.equal(first.value.state, 'resolved');
  assert.equal(f.store.getWorkflow(f.workflow.id).revision, 2);
  assert.equal(f.store.getStepRun(f.workflow.currentStepRunId).phase, 'blocked');
  assert.deepEqual(f.decisions.resolve(input).value, first.value);
  assert.equal(f.store.getWorkflow(f.workflow.id).revision, 2);
  assert.throws(
    () => f.store.transaction((db) => db.prepare('DELETE FROM human_decision_resolutions').run()),
    /immutable/,
  );
});
test('human choice racing a pause becomes obsolete without transition', (t) => {
  const f = fixture(t),
    id = f.request();
  f.store.transaction((db) =>
    db
      .prepare("UPDATE workflow_runs SET phase='paused',control_revision=2 WHERE id=?")
      .run(f.workflow.id),
  );
  assert.equal(
    f.decisions.resolve({
      decisionId: id,
      optionId: 'block',
      expected: f.expected,
      idempotencyKey: 'resolve',
    }).value.state,
    'obsolete',
  );
  assert.equal(f.store.getWorkflow(f.workflow.id).revision, 1);
});
test('unsupported approval stays manual-required', async (t) => {
  const f = fixture(t),
    a = f.approval();
  assert.equal(
    (
      await f.approvals.resolve({
        approvalId: a.id,
        action: 'approve',
        expected: f.expected,
        idempotencyKey: 'resolve',
      })
    )?.state,
    'manual-required',
  );
});
test('ambiguous approval is never forwarded twice, then exact reconciliation settles', async (t) => {
  const f = fixture(t),
    a = f.approval();
  let calls = 0;
  const capability = {
    forward: async () => {
      calls++;
      throw new Error('lost response');
    },
  };
  const input = {
    approvalId: a.id,
    action: 'approve' as const,
    expected: f.expected,
    idempotencyKey: 'resolve',
  };
  assert.equal((await f.approvals.resolve(input, capability))?.state, 'unconfirmed');
  await f.approvals.resolve(input, capability);
  assert.equal(calls, 1);
  await assert.rejects(
    f.approvals.resolve({ ...input, idempotencyKey: 'retry' }, capability),
    /reconcile/,
  );
  f.approvals.reconcile({
    approvalId: a.id,
    identity: a.identity,
    outcome: 'resolved',
    evidence: 'Native operator observed exact operation completed',
    idempotencyKey: 'reconcile',
  });
  assert.equal(f.approvals.get(a.id)?.state, 'resolved');
});
test('approval pause race is rejected before native invocation', async (t) => {
  const f = fixture(t),
    a = f.approval();
  f.store.transaction((db) =>
    db
      .prepare("UPDATE workflow_runs SET phase='pausing',control_revision=2 WHERE id=?")
      .run(f.workflow.id),
  );
  let calls = 0;
  const row = await f.approvals.resolve(
    { approvalId: a.id, action: 'approve', expected: f.expected, idempotencyKey: 'resolve' },
    {
      forward: async () => {
        calls++;
        throw new Error('must not invoke');
      },
    },
  );
  assert.equal(row?.state, 'obsolete');
  assert.equal(calls, 0);
});

test('native response from another operation is ambiguous and cannot approve replacement', async (t) => {
  const f = fixture(t),
    a = f.approval();
  const result = await f.approvals.resolve(
    { approvalId: a.id, action: 'approve', expected: f.expected, idempotencyKey: 'resolve' },
    {
      forward: async () => ({
        identity: { ...a.identity, operationId: 'replacement' },
        receiptId: 'native-receipt',
        outcome: 'resolved',
      }),
    },
  );
  assert.equal(result?.state, 'unconfirmed');
  assert.throws(
    () =>
      f.approvals.reconcile({
        approvalId: a.id,
        identity: { ...a.identity, operationId: 'replacement' },
        outcome: 'resolved',
        evidence: 'different operation',
        idempotencyKey: 'reconcile',
      }),
    /exact approval/,
  );
});
test('budget revision and native server generation fence approval before claim', async (t) => {
  const f = fixture(t),
    a = f.approval();
  f.store.transaction((db) =>
    db.prepare('UPDATE workflow_runs SET limits_revision=2 WHERE id=?').run(f.workflow.id),
  );
  let calls = 0;
  const result = await f.approvals.resolve(
    { approvalId: a.id, action: 'approve', expected: f.expected, idempotencyKey: 'resolve' },
    {
      forward: async () => {
        calls++;
        return { identity: a.identity, receiptId: 'r', outcome: 'forwarded' };
      },
    },
  );
  assert.equal(result?.state, 'obsolete');
  assert.equal(calls, 0);
});
test('forwarding claim exists before adapter call and survives pause during invocation', async (t) => {
  const f = fixture(t),
    a = f.approval();
  const result = await f.approvals.resolve(
    { approvalId: a.id, action: 'approve', expected: f.expected, idempotencyKey: 'resolve' },
    {
      forward: async ({ claimId }) => {
        assert.equal(f.approvals.get(a.id)?.claim_id, claimId);
        assert.equal(f.approvals.get(a.id)?.state, 'forwarding');
        f.store.transaction((db) =>
          db
            .prepare("UPDATE workflow_runs SET phase='pausing',control_revision=2 WHERE id=?")
            .run(f.workflow.id),
        );
        return { identity: a.identity, receiptId: 'r', outcome: 'forwarded' };
      },
    },
  );
  assert.equal(result?.state, 'forwarded');
  assert.equal(f.store.getWorkflow(f.workflow.id).phase, 'pausing');
});
