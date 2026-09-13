import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { composeHerdrAdapter, type HerdrAdapterFactory } from '../../src/v1/adapters/herdr.js';
import { createBinding, localSessionContext } from '../../src/v1/context.js';
import {
  AgentSessionIdSchema,
  DigestSchema,
  ProjectBindingSchema,
  WorkflowPackageSnapshotSchema,
  WorkspaceIdSchema,
} from '../../src/v1/model.js';
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
} from '../../src/v1/native.js';
import { Runtime } from '../../src/v1/runtime.js';
import { ServiceControls } from '../../src/v1/service/controls.js';
import { ServiceOwnership } from '../../src/v1/service/ownership.js';
import { Settings, profileSchema } from '../../src/v1/settings.js';
import { Store } from '../../src/v1/store.js';

type ObservationMode = 'working' | 'settled' | 'manual-required';
type InterruptMode = 'submitted' | 'unsupported' | 'lost-response';

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'marionette-service-controls-'));
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
  const workspaceId = WorkspaceIdSchema.parse('service-controls-workspace');
  store.registerWorkspace({
    actor,
    id: workspaceId,
    kind: 'existing',
    path: repo,
    repositoryRoot: repo,
    baseCommit: null,
    access: 'inspect',
    writes: [],
    idempotencyKey: 'workspace',
  });
  const workflow = store.createWorkflow({
    actor,
    stableKey: 'service-controls',
    package: WorkflowPackageSnapshotSchema.parse({
      name: 'service-controls',
      version: '1',
      digest: '0'.repeat(64),
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
        maxRepeats: 2,
        parallelism: 1,
        deadlineMs: 600_000,
        innerLoopDeadlineMs: 30_000,
      },
    }),
    request: {
      text: 'Exercise durable service controls',
      digest: DigestSchema.parse(createHash('sha256').update('service controls').digest('hex')),
      inputSnapshots: [],
    },
    brief: {
      objective: 'Exercise durable service controls',
      scope: [],
      ownership: [],
      constraints: [],
      standingOrders: [],
      inputSnapshots: [],
    },
    workspaceId,
    delivery: 'report',
    boundary: 'all',
    idempotencyKey: 'workflow',
  });
  const settings = new Settings(store, actor);
  settings.set({
    key: 'profile/test',
    value: {
      name: 'test',
      kind: 'agy',
      model: 'fixture-model',
      args: ['--model', 'fixture-model'],
    },
    schema: profileSchema,
    expectedRevision: 0,
    idempotencyKey: 'profile',
  });
  const binding: NativeBinding = {
    hostId: store.project.hostId,
    socketPath: '/fixture/herdr.sock',
    workspaceId: 'fixture-workspace',
    endpoint: {
      device: 1,
      inode: 2,
      birthtimeMs: 3,
      serverStartToken: 'fixture-server',
      protocol: 22,
    },
  };
  settings.set({
    key: 'native/fixture-workspace',
    value: binding,
    schema: NativeBindingSchema,
    expectedRevision: 0,
    idempotencyKey: 'native',
  });

  let observation: ObservationMode = 'working';
  let interruptMode: InterruptMode = 'submitted';
  let interrupts = 0;
  let claimedBeforeInterrupt = false;
  const identity: NativeIdentity = {
    binding,
    tabId: 'fixture-workspace:tab',
    paneId: 'fixture-workspace:pane',
    terminalId: 'fixture-terminal',
    agentKind: 'agy',
    agentName: 'fixture-agent',
    nativeSession: 'fixture-native-session',
    identityRevision: 1,
    ownedTabId: 'fixture-workspace:tab',
  };
  const adapterFor: HerdrAdapterFactory = (journal) => {
    class Adapter extends HerdrNativeAdapter {
      constructor(effects: NativeJournal) {
        super(effects);
      }
      override async launch(
        _binding: NativeBinding,
        _request: LaunchRequest,
      ): Promise<LaunchResult> {
        const prepared = await journal.prepare({
          kind: 'create-tab',
          workspaceId: binding.workspaceId,
        });
        assert.equal(prepared.kind, 'prepared');
        return { kind: 'launched', identity };
      }
      override async prompt(
        nativeIdentity: NativeIdentity,
        text: string,
      ): Promise<NativeSubmission> {
        const prepared = await journal.prepare({
          kind: 'prompt',
          paneId: nativeIdentity.paneId,
          textDigest: createHash('sha256').update(text).digest('hex'),
        });
        assert.equal(prepared.kind, 'prepared');
        return { kind: 'submitted', operationId: prepared.operationId };
      }
      override async observe(nativeIdentity: NativeIdentity): Promise<NativeObservation> {
        if (observation === 'settled')
          return { kind: 'settled', identity: nativeIdentity, slotReady: true };
        if (observation === 'manual-required')
          return {
            kind: 'manual-required',
            identity: nativeIdentity,
            reason: 'Fixture cannot safely checkpoint before interruption',
          };
        return { kind: 'working', identity: nativeIdentity };
      }
      override async interrupt(nativeIdentity: NativeIdentity): Promise<NativeSubmission> {
        const prepared = await journal.prepare({
          kind: 'interrupt',
          paneId: nativeIdentity.paneId,
        });
        if (prepared.kind === 'rejected') return { kind: 'unsupported', reason: prepared.reason };
        claimedBeforeInterrupt = store.read((db) =>
          Boolean(db.prepare('SELECT 1 FROM native_effects WHERE id=?').get(prepared.operationId)),
        );
        interrupts++;
        if (interruptMode === 'lost-response') throw new Error('fixture interrupt response lost');
        if (interruptMode === 'unsupported')
          return { kind: 'unsupported', reason: 'Fixture interrupt is unsupported' };
        return { kind: 'submitted', operationId: prepared.operationId };
      }
    }
    return composeHerdrAdapter(new Adapter(journal));
  };
  const runtime = new Runtime(store, actor, context, adapterFor);
  const attemptId = runtime.admit({
    jobId: workflow.rootJobId,
    profile: 'test',
    nativeWorkspaceId: 'fixture-workspace',
    inputResultIds: [],
    expectedBriefRevision: 1,
    idempotencyKey: 'admit',
  });
  await runtime.start(attemptId);
  const owner = await ServiceOwnership.acquire({
    store,
    processIdentity: JSON.stringify({ pid: 8675, startToken: 'fixture-service' }),
    livenessPort: {
      async confirmAbsent() {
        return false;
      },
    },
  });
  t.after(() => {
    const status = ServiceOwnership.status(store);
    if (status?.generation === owner.generation && status.stopped_at === null) owner.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    store,
    actor,
    workflowId: workflow.id,
    attemptId,
    controls: new ServiceControls(owner, actor, adapterFor),
    setObservation(value: ObservationMode) {
      observation = value;
    },
    setInterruptMode(value: InterruptMode) {
      interruptMode = value;
    },
    evidence() {
      return { interrupts, claimedBeforeInterrupt };
    },
  };
}

test('interrupt claim precedes mutation and a lost response never causes a second interrupt', async (t) => {
  const f = await fixture(t);
  const workflow = f.store.getWorkflow(f.workflowId);
  f.store.controlWorkflow({
    actor: f.actor,
    workflowId: f.workflowId,
    expectedWorkflowRevision: workflow.revision,
    expectedControlRevision: workflow.controlRevision,
    operation: { kind: 'pause', mode: 'now' },
    idempotencyKey: 'pause-now',
  });
  f.setInterruptMode('lost-response');
  await assert.rejects(f.controls.scan(), {
    code: 'execution-failed',
    phase: 'after-invocation',
  });
  assert.deepEqual(f.evidence(), { interrupts: 1, claimedBeforeInterrupt: true });
  const intent = f.store.read((db) =>
    db.prepare('SELECT id,state FROM attempt_control_intents WHERE attempt_id=?').get(f.attemptId),
  );
  assert.equal(intent?.state, 'unconfirmed');
  assert.equal(
    f.store.read(
      (db) =>
        db
          .prepare(
            "SELECT count(*) AS count FROM native_effects WHERE attempt_id=? AND effect_kind LIKE 'control/%'",
          )
          .get(f.attemptId)?.count,
    ),
    1,
  );
  await f.controls.scan();
  assert.deepEqual(f.evidence(), { interrupts: 1, claimedBeforeInterrupt: true });
  assert.equal(
    f.store.read(
      (db) =>
        db.prepare('SELECT state FROM attempt_control_intents WHERE id=?').get(intent?.id)?.state,
    ),
    'unconfirmed',
  );
});

for (const operation of [
  { name: 'pause', value: { kind: 'pause', mode: 'now' } as const },
  { name: 'cancel', value: { kind: 'cancel' } as const },
]) {
  test(`${operation.name} interrupt is fenced by the exact workflow control revision`, async (t) => {
    const f = await fixture(t);
    const workflow = f.store.getWorkflow(f.workflowId);
    f.store.controlWorkflow({
      actor: f.actor,
      workflowId: f.workflowId,
      expectedWorkflowRevision: workflow.revision,
      expectedControlRevision: workflow.controlRevision,
      operation: operation.value,
      idempotencyKey: `${operation.name}-control`,
    });
    f.store.transaction((db) =>
      db
        .prepare('UPDATE workflow_runs SET control_revision=control_revision+1 WHERE id=?')
        .run(f.workflowId),
    );
    await f.controls.scan();
    assert.equal(f.evidence().interrupts, 0);
    assert.equal(
      f.store.read(
        (db) =>
          db
            .prepare(
              "SELECT count(*) AS count FROM native_effects WHERE attempt_id=? AND effect_kind LIKE 'control/%'",
            )
            .get(f.attemptId)?.count,
      ),
      0,
    );
    assert.equal(
      f.store.read(
        (db) =>
          db
            .prepare('SELECT state FROM attempt_control_intents WHERE attempt_id=?')
            .get(f.attemptId)?.state,
      ),
      'unconfirmed',
    );
  });
}

test('safe pause with no supported checkpoint remains unconfirmed without interrupting', async (t) => {
  const f = await fixture(t);
  const workflow = f.store.getWorkflow(f.workflowId);
  f.store.controlWorkflow({
    actor: f.actor,
    workflowId: f.workflowId,
    expectedWorkflowRevision: workflow.revision,
    expectedControlRevision: workflow.controlRevision,
    operation: { kind: 'pause', mode: 'safe' },
    idempotencyKey: 'pause-safe',
  });
  f.setObservation('manual-required');
  f.setInterruptMode('unsupported');
  await f.controls.scan();
  assert.equal(f.evidence().interrupts, 0);
  assert.equal(f.store.getAttempt(f.attemptId).phase, 'running');
  assert.equal(f.store.getWorkflow(f.workflowId).phase, 'pausing');
  assert.equal(
    f.store.read(
      (db) =>
        db.prepare('SELECT state FROM attempt_control_intents WHERE attempt_id=?').get(f.attemptId)
          ?.state,
    ),
    'unconfirmed',
  );
});

test('exact observed settlement confirms the control and closes the workflow transition', async (t) => {
  const f = await fixture(t);
  const workflow = f.store.getWorkflow(f.workflowId);
  f.store.controlWorkflow({
    actor: f.actor,
    workflowId: f.workflowId,
    expectedWorkflowRevision: workflow.revision,
    expectedControlRevision: workflow.controlRevision,
    operation: { kind: 'pause', mode: 'now' },
    idempotencyKey: 'pause-settled',
  });
  f.setObservation('settled');
  await f.controls.scan();
  assert.equal(f.evidence().interrupts, 0);
  assert.equal(f.store.getAttempt(f.attemptId).phase, 'settled');
  assert.equal(f.store.getWorkflow(f.workflowId).phase, 'paused');
  const rows = f.store.read((db) => ({
    control: db
      .prepare('SELECT state,settled_at FROM attempt_control_intents WHERE attempt_id=?')
      .get(f.attemptId),
    native: db.prepare('SELECT phase FROM native_attempts WHERE attempt_id=?').get(f.attemptId),
    reservation: db
      .prepare('SELECT state FROM execution_reservations WHERE attempt_id=?')
      .get(f.attemptId),
  }));
  assert.equal(rows.control?.state, 'confirmed');
  assert.ok(rows.control?.settled_at);
  assert.equal(rows.native?.phase, 'settled');
  assert.equal(rows.reservation?.state, 'released');
});
