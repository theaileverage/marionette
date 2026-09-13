import { composeHerdrAdapter } from '../../src/v1/adapters/herdr.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import { createBinding, localSessionContext } from '../../src/v1/context.js';
import {
  AgentSessionIdSchema,
  DigestSchema,
  ProjectBindingSchema,
  WorkspaceIdSchema,
  WorkflowPackageSnapshotSchema,
} from '../../src/v1/model.js';
import {
  HerdrNativeAdapter,
  NativeBindingSchema,
  type NativeBinding,
  type NativeIdentity,
  type NativeJournal,
  type LaunchResult,
  type LaunchRequest,
  type NativeSubmission,
  type NativeObservation,
} from '../../src/v1/native.js';
import { Settings, profileSchema } from '../../src/v1/settings.js';
import { Store } from '../../src/v1/store.js';
import { Runtime } from '../../src/v1/runtime.js';
import { parseOperationOutput } from '../../src/v1/output-contracts.js';

function fixture(
  t: TestContext,
  crashAt: 'launch' | 'prompt' | 'interrupt' | null = null,
  managed = false,
) {
  const root = mkdtempSync(join(tmpdir(), 'marionette-v1-runtime-'));
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
    nativeLocator: null,
    nativeServerGeneration: null,
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
  const job = store.createJob({
    actor,
    stableKey: 'job',
    request: {
      text: 'Read-only check',
      digest: DigestSchema.parse(createHash('sha256').update('Read-only check').digest('hex')),
      inputSnapshots: [],
    },
    brief: {
      objective: 'Read-only check',
      scope: [],
      ownership: [],
      constraints: ['No file edits'],
      standingOrders: [],
      inputSnapshots: [],
    },
    workspaceId: workspace.id,
    delivery: 'report',
    origin: { kind: 'direct' },
    dependencies: [],
    idempotencyKey: 'job',
  });
  const workflow = managed
    ? store.createWorkflow({
        actor,
        stableKey: 'workflow',
        request: {
          text: 'Read-only check',
          digest: DigestSchema.parse('0'.repeat(64)),
          inputSnapshots: [],
        },
        brief: store.getBrief(job.id).content,
        workspaceId: workspace.id,
        delivery: 'report',
        boundary: 'all',
        idempotencyKey: 'workflow',
        package: WorkflowPackageSnapshotSchema.parse({
          name: 'fixture',
          version: '1',
          digest: '1'.repeat(64),
          sourceDigests: [],
          entryStep: 'work',
          steps: [
            {
              name: 'work',
              phase: 'analysis',
              resources: [],
              outputContract: 'report',
              permittedMethods: ['direct'],
              requiredEvidence: [],
              requiresDistinctRole: false,
            },
          ],
          transitions: [{ kind: 'finish', from: 'work' }],
          limits: {
            maxAttempts: 3,
            maxRepeats: 1,
            deadlineMs: 60000,
            parallelism: 1,
            innerLoopDeadlineMs: 30000,
          },
        }),
      })
    : null;
  const settings = new Settings(store, actor);
  settings.set({
    key: 'profile/test',
    value: {
      name: 'test',
      kind: 'agy',
      model: 'configured-model',
      args: ['--model', 'configured-model'],
    },
    schema: profileSchema,
    expectedRevision: 0,
    idempotencyKey: 'profile',
  });
  const binding: NativeBinding = {
    hostId: store.project.hostId,
    socketPath: '/fixture/herdr.sock',
    workspaceId: 'w1',
    endpoint: {
      device: 1,
      inode: 2,
      birthtimeMs: 3,
      serverStartToken: 'server-instance',
      protocol: 22,
    },
  };
  settings.set({
    key: 'native/w1',
    value: binding,
    schema: NativeBindingSchema,
    expectedRevision: 0,
    idempotencyKey: 'native',
  });
  let launches = 0;
  let prompts = 0;
  let interrupts = 0;
  let duringLaunch: (() => void) | undefined;
  let nativeSettled = false;
  let ambiguous = false;
  let referenceAfterPrompt = false;
  class Adapter extends HerdrNativeAdapter {
    constructor(private readonly effects: NativeJournal) {
      super(effects);
    }
    override async launch(_binding: NativeBinding, request: LaunchRequest): Promise<LaunchResult> {
      assert.match(request.agentName, /^[a-z][a-z0-9_-]{0,31}$/);
      launches++;
      const prepared = await this.effects.prepare({ kind: 'create-tab', workspaceId: 'w1' });
      assert.equal(prepared.kind, 'prepared');
      duringLaunch?.();
      if (crashAt === 'launch') throw new Error('Simulated process loss after durable claim');
      return {
        kind: 'launched',
        identity: {
          binding,
          tabId: 'w1:t2',
          paneId: 'w1:p2',
          terminalId: 'terminal-test',
          agentKind: 'agy',
          agentName: 'fixture-agent',
          foregroundProcess: { pid: 31415, startToken: 'process-instance' },
          identityRevision: 1,
          ownedTabId: 'w1:t2',
        },
      };
    }
    override async prompt(identity: NativeIdentity, text: string): Promise<NativeSubmission> {
      prompts++;
      assert.match(text, /Adopt brief revision 1/);
      const prepared = await this.effects.prepare({
        kind: 'prompt',
        paneId: identity.paneId,
        textDigest: createHash('sha256').update(text).digest('hex'),
      });
      if (prepared.kind === 'rejected') throw new Error(prepared.reason);
      if (crashAt === 'prompt') throw new Error('Simulated process loss after durable claim');
      referenceAfterPrompt = true;
      return { kind: 'submitted', operationId: prepared.operationId };
    }
    override async interrupt(identity: NativeIdentity): Promise<NativeSubmission> {
      const prepared = await this.effects.prepare({ kind: 'interrupt', paneId: identity.paneId });
      if (prepared.kind === 'rejected') return { kind: 'unsupported', reason: prepared.reason };
      interrupts++;
      if (crashAt === 'interrupt') throw new Error('Simulated interrupt process loss');
      return { kind: 'submitted', operationId: prepared.operationId };
    }
    override async observe(identity: NativeIdentity): Promise<NativeObservation> {
      if (ambiguous) return { kind: 'unconfirmed', reason: 'Fixture could not confirm identity' };
      const refreshed = referenceAfterPrompt
        ? {
            ...identity,
            sessionReference: {
              harness: 'agy',
              kind: 'id' as const,
              value: 'agy-conversation-1',
              source: 'herdr:antigravity_cli',
            },
            identityRevision: 2,
          }
        : identity;
      return nativeSettled
        ? { kind: 'settled', identity: refreshed, slotReady: true }
        : { kind: 'working', identity: refreshed };
    }
  }
  const runtime = new Runtime(store, actor, context, (journal) =>
    composeHerdrAdapter(new Adapter(journal)),
  );
  const input = {
    jobId: workflow?.rootJobId ?? job.id,
    profile: 'test',
    nativeWorkspaceId: 'w1',
    inputResultIds: [],
    expectedBriefRevision: 1,
    idempotencyKey: 'admit',
  };
  return {
    runtime,
    workflow,
    interruptCount: () => interrupts,
    onLaunch: (callback: () => void) => {
      duringLaunch = callback;
    },
    store,
    input,
    actor,
    settleNative: () => {
      nativeSettled = true;
    },
    makeObservationAmbiguous: () => {
      ambiguous = true;
    },
    makeObservationExact: () => {
      ambiguous = false;
    },
    counts: () => ({ launches, prompts }),
  };
}

test('native runtime admits idempotently and concurrent starts claim each external effect once', async (t) => {
  const f = fixture(t);
  const id = f.runtime.admit(f.input);
  assert.equal(f.runtime.admit(f.input), id);
  await Promise.all([f.runtime.start(id), f.runtime.start(id)]);
  assert.deepEqual(f.counts(), { launches: 1, prompts: 1 });
  assert.equal(f.store.getAttempt(id).phase, 'running');
  const effects = f.store.read((db) =>
    db
      .prepare('SELECT effect_kind FROM native_effects WHERE attempt_id=? ORDER BY effect_kind')
      .all(id),
  );
  assert.deepEqual(
    effects.map((row) => row.effect_kind),
    ['create-tab', 'prompt'],
  );
  assert.deepEqual(
    f.store.listNativeSessionReferences(id).map(({ harness, value, status }) => ({
      harness,
      value,
      status,
    })),
    [{ harness: 'agy', value: 'agy-conversation-1', status: 'confirmed' }],
  );
  const retained = await f.runtime.inspectRetainedWork(id);
  assert.equal(retained.history.kind, 'unsupported');
  assert.deepEqual(parseOperationOutput('attempt.retained-work', retained), retained);
  assert.deepEqual(f.counts(), { launches: 1, prompts: 1 });
});

test('crash after a claimed launch becomes unconfirmed without replaying launch or prompt', async (t) => {
  const f = fixture(t, 'launch');
  const id = f.runtime.admit(f.input);
  await assert.rejects(f.runtime.start(id), {
    code: 'execution-failed',
    phase: 'after-invocation',
  });
  assert.deepEqual(f.runtime.activeAttempts(), [id]);
  await f.runtime.reconcile(id);
  assert.deepEqual(f.counts(), { launches: 1, prompts: 0 });
  assert.equal(f.store.getAttempt(id).phase, 'unconfirmed');
  const native = f.store.read((db) =>
    db.prepare('SELECT phase FROM native_attempts WHERE attempt_id=?').get(id),
  );
  assert.equal(native?.phase, 'unconfirmed');
  const reservation = f.store.read((db) =>
    db.prepare('SELECT state FROM execution_reservations WHERE attempt_id=?').get(id),
  );
  assert.equal(reservation?.state, 'unconfirmed');
});

test('a working prompt claim recovers as active without resending the prompt', async (t) => {
  const f = fixture(t, 'prompt');
  const id = f.runtime.admit(f.input);
  await assert.rejects(f.runtime.start(id), {
    code: 'execution-failed',
    phase: 'after-invocation',
  });
  assert.deepEqual(f.runtime.activeAttempts(), [id]);
  await f.runtime.reconcile(id);
  assert.deepEqual(f.counts(), { launches: 1, prompts: 1 });
  assert.equal(f.store.getAttempt(id).phase, 'running');
  const native = f.store.read((db) =>
    db.prepare('SELECT phase FROM native_attempts WHERE attempt_id=?').get(id),
  );
  assert.equal(native?.phase, 'active');
  const attempt = f.store.getAttempt(id);
  assert.doesNotThrow(() =>
    f.store.recordResult({
      actor: { id: attempt.sessionId, generation: attempt.sessionGeneration },
      attemptId: id,
      content: { kind: 'report', body: 'Worker can still report', artifactDigests: [] },
      inputDigest: DigestSchema.parse('0'.repeat(64)),
      workspaceDigest: DigestSchema.parse('1'.repeat(64)),
      evidenceClaims: [],
      evidence: [],
      verification: { kind: 'not-requested' },
      upstreamResultIds: [],
      idempotencyKey: 'worker-result',
    }),
  );
});

test('an ambiguous observation can later settle with a durable result without replaying effects', async (t) => {
  const f = fixture(t);
  const id = f.runtime.admit(f.input);
  await f.runtime.start(id);
  f.store.recordResult({
    actor: f.actor,
    attemptId: id,
    content: { kind: 'report', body: 'Controller verified the report', artifactDigests: [] },
    inputDigest: DigestSchema.parse('0'.repeat(64)),
    workspaceDigest: DigestSchema.parse('1'.repeat(64)),
    evidenceClaims: [],
    evidence: [],
    verification: { kind: 'not-requested' },
    upstreamResultIds: [],
    idempotencyKey: 'result-before-ambiguity',
  });
  f.makeObservationAmbiguous();
  await f.runtime.reconcile(id);
  await f.runtime.reconcile(id);
  assert.deepEqual(f.counts(), { launches: 1, prompts: 1 });
  assert.equal(f.store.getAttempt(id).phase, 'unconfirmed');
  const native = f.store.read((db) =>
    db.prepare('SELECT phase FROM native_attempts WHERE attempt_id=?').get(id),
  );
  assert.equal(native?.phase, 'unconfirmed');
  const reservation = f.store.read((db) =>
    db.prepare('SELECT state FROM execution_reservations WHERE attempt_id=?').get(id),
  );
  assert.equal(reservation?.state, 'unconfirmed');

  f.makeObservationExact();
  f.settleNative();
  await f.runtime.reconcile(id);
  assert.deepEqual(f.counts(), { launches: 1, prompts: 1 });
  assert.equal(f.store.getAttempt(id).phase, 'settled');
  const settledNative = f.store.read((db) =>
    db.prepare('SELECT phase FROM native_attempts WHERE attempt_id=?').get(id),
  );
  assert.equal(settledNative?.phase, 'settled');
  const settledReservation = f.store.read((db) =>
    db.prepare('SELECT state FROM execution_reservations WHERE attempt_id=?').get(id),
  );
  assert.equal(settledReservation?.state, 'released');
});

test('native idle releases execution only after a durable result exists', async (t) => {
  const f = fixture(t);
  const id = f.runtime.admit(f.input);
  await f.runtime.start(id);
  f.settleNative();
  await f.runtime.reconcile(id);
  assert.equal(f.store.getAttempt(id).phase, 'running');
  f.store.recordResult({
    actor: f.actor,
    attemptId: id,
    content: { kind: 'report', body: 'Verified report', artifactDigests: [] },
    inputDigest: DigestSchema.parse('0'.repeat(64)),
    workspaceDigest: DigestSchema.parse('1'.repeat(64)),
    evidenceClaims: [],
    evidence: [],
    verification: { kind: 'not-requested' },
    upstreamResultIds: [],
    idempotencyKey: 'result',
  });
  await f.runtime.reconcile(id);
  assert.equal(f.store.getAttempt(id).phase, 'settled');
  const reservation = f.store.read((db) =>
    db.prepare('SELECT state FROM execution_reservations WHERE attempt_id=?').get(id),
  );
  assert.equal(reservation?.state, 'released');
});

function stop(
  f: ReturnType<typeof fixture>,
  operation: { kind: 'cancel' } | { kind: 'pause'; mode: 'now' | 'drain' | 'safe' } = {
    kind: 'pause',
    mode: 'now',
  },
) {
  const workflow = f.store.getWorkflow(f.workflow!.id);
  return f.store.controlWorkflow({
    actor: f.actor,
    workflowId: workflow.id,
    expectedWorkflowRevision: workflow.revision,
    expectedControlRevision: workflow.controlRevision,
    operation,
    idempotencyKey: 'stop',
  });
}

test('control closes pending launches and returns an immutable replayable receipt', async (t) => {
  const f = fixture(t, null, true);
  const id = f.runtime.admit(f.input);
  const w = f.store.getWorkflow(f.workflow!.id);
  const input = {
    actor: f.actor,
    workflowId: w.id,
    expectedWorkflowRevision: w.revision,
    expectedControlRevision: w.controlRevision,
    operation: { kind: 'pause' as const, mode: 'now' as const },
    idempotencyKey: 'stop',
  };
  const receipt = f.store.controlWorkflow(input);
  assert.deepEqual(f.store.controlWorkflow(input), receipt);
  assert.equal(f.store.getWorkflow(w.id).phase, 'paused');
  await f.runtime.start(id);
  assert.equal(f.counts().launches, 0);
  assert.equal(f.store.getAttempt(id).phase, 'settled');
  assert.throws(
    () => f.runtime.admit({ ...f.input, idempotencyKey: 'new' }),
    /not running|admit|Workflow/i,
  );
  assert.throws(
    () => f.store.controlWorkflow({ ...input, idempotencyKey: 'stale' }),
    /revision changed/,
  );
});

test('immediate pause interrupts once and waits for positive settlement without a result', async (t) => {
  const f = fixture(t, null, true);
  const id = f.runtime.admit(f.input);
  await f.runtime.start(id);
  stop(f);
  assert.equal(f.store.getWorkflow(f.workflow!.id).phase, 'pausing');
  await Promise.all([f.runtime.reconcile(id), f.runtime.reconcile(id)]);
  assert.equal(f.interruptCount(), 1);
  assert.equal(f.store.getWorkflow(f.workflow!.id).phase, 'pausing');
  f.settleNative();
  await f.runtime.reconcile(id);
  assert.equal(f.store.getWorkflow(f.workflow!.id).phase, 'paused');
});

test('drain sends no interrupt; cancellation is terminal after native settlement', async (t) => {
  for (const cancel of [false, true]) {
    const f = fixture(t, null, true);
    const id = f.runtime.admit(f.input);
    await f.runtime.start(id);
    stop(f, cancel ? { kind: 'cancel' } : { kind: 'pause', mode: 'drain' });
    await f.runtime.reconcile(id);
    assert.equal(f.interruptCount(), cancel ? 1 : 0);
    f.settleNative();
    await f.runtime.reconcile(id);
    assert.equal(f.store.getWorkflow(f.workflow!.id).phase, cancel ? 'cancelled' : 'paused');
  }
});

test('ambiguous interrupt survives reconciliation without replay or false settlement', async (t) => {
  const f = fixture(t, 'interrupt', true);
  const id = f.runtime.admit(f.input);
  await f.runtime.start(id);
  stop(f);
  await assert.rejects(f.runtime.reconcile(id), /Inspect the outcome/);
  f.settleNative();
  await f.runtime.reconcile(id);
  assert.equal(f.interruptCount(), 1);
  assert.equal(f.store.getAttempt(id).phase, 'unconfirmed');
  assert.equal(f.store.getWorkflow(f.workflow!.id).phase, 'pausing');
  assert.ok(f.runtime.activeAttempts().includes(id));
});

test('safe pause fails before storing intent', (t) => {
  const f = fixture(t, null, true);
  assert.throws(() => stop(f, { kind: 'pause', mode: 'safe' }), /checkpoint proof/);
  assert.equal(f.store.getWorkflow(f.workflow!.id).controlRevision, 1);
});

test('stop racing an admitted launch reconciles its identity without sending the work prompt', async (t) => {
  const f = fixture(t, null, true);
  const id = f.runtime.admit(f.input);
  f.onLaunch(() => {
    stop(f);
  });
  await f.runtime.start(id);
  assert.equal(f.counts().launches, 1);
  assert.equal(f.counts().prompts, 0);
  assert.equal(f.interruptCount(), 1);
  f.settleNative();
  await f.runtime.reconcile(id);
  assert.equal(f.store.getWorkflow(f.workflow!.id).phase, 'paused');
});

test('stop with an uncertain prompt cannot settle on idle or replay work', async (t) => {
  const f = fixture(t, 'prompt', true);
  const id = f.runtime.admit(f.input);
  await assert.rejects(f.runtime.start(id));
  stop(f);
  f.settleNative();
  await f.runtime.reconcile(id);
  assert.equal(f.store.getAttempt(id).phase, 'unconfirmed');
  assert.equal(f.store.getWorkflow(f.workflow!.id).phase, 'pausing');
  assert.equal(f.counts().prompts, 1);
});

test('control covers registered descendants and preserves an independent workflow', async (t) => {
  const f = fixture(t, null, true);
  const root = f.workflow!;
  const job = f.store.getJob(root.rootJobId);
  const make = (key: string) =>
    f.store.createWorkflow({
      actor: f.actor,
      stableKey: key,
      package: root.package,
      request: { text: key, digest: DigestSchema.parse('0'.repeat(64)), inputSnapshots: [] },
      brief: f.store.getBrief(job.id).content,
      workspaceId: job.workspaceId,
      delivery: 'report',
      boundary: 'all',
      idempotencyKey: key,
    });
  const child = make('child');
  const independent = make('independent');
  // Fixture relationship only: child admission/inheritance remains a separate blocked contract.
  f.store.transaction((db) =>
    db.prepare('UPDATE workflow_runs SET parent_workflow_id=? WHERE id=?').run(root.id, child.id),
  );
  const id = f.runtime.admit({ ...f.input, jobId: child.rootJobId });
  await f.runtime.start(id);
  const receipt = stop(f, { kind: 'cancel' });
  assert.deepEqual(new Set(receipt.workflowIds), new Set([root.id, child.id]));
  assert.equal(f.store.getWorkflow(root.id).phase, 'cancelling');
  assert.equal(f.store.getWorkflow(child.id).phase, 'cancelling');
  assert.equal(f.store.getWorkflow(independent.id).phase, 'running');
  await f.runtime.reconcile(id);
  f.settleNative();
  await f.runtime.reconcile(id);
  assert.equal(f.store.getWorkflow(root.id).phase, 'cancelled');
  assert.equal(f.store.getWorkflow(child.id).phase, 'cancelled');
});
