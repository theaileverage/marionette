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
} from '../../src/v1/model.js';
import {
  HerdrNativeAdapter,
  NativeBindingSchema,
  type NativeBinding,
  type NativeIdentity,
  type NativeJournal,
  type LaunchResult,
  type NativeSubmission,
  type NativeObservation,
} from '../../src/v1/native.js';
import { Settings, profileSchema } from '../../src/v1/settings.js';
import { Store } from '../../src/v1/store.js';
import { Runtime } from '../../src/v1/runtime.js';

function fixture(t: TestContext, crash: boolean) {
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
  let nativeSettled = false;
  class Adapter extends HerdrNativeAdapter {
    constructor(private readonly effects: NativeJournal) {
      super(effects);
    }
    override async launch(): Promise<LaunchResult> {
      launches++;
      const prepared = await this.effects.prepare({ kind: 'create-tab', workspaceId: 'w1' });
      assert.equal(prepared.kind, 'prepared');
      if (crash) throw new Error('Simulated process loss after durable claim');
      return {
        kind: 'launched',
        identity: {
          binding,
          tabId: 'w1:t2',
          paneId: 'w1:p2',
          terminalId: 'terminal-test',
          agentKind: 'agy',
          agentName: 'fixture-agent',
          nativeSession: 'native-session',
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
      return { kind: 'submitted', operationId: prepared.operationId };
    }
    override async observe(identity: NativeIdentity): Promise<NativeObservation> {
      return nativeSettled
        ? { kind: 'settled', identity, slotReady: true }
        : { kind: 'working', identity };
    }
  }
  const runtime = new Runtime(store, actor, context, (journal) => new Adapter(journal));
  const input = {
    jobId: job.id,
    profile: 'test',
    nativeWorkspaceId: 'w1',
    inputResultIds: [],
    expectedBriefRevision: 1,
    idempotencyKey: 'admit',
  };
  return {
    runtime,
    store,
    input,
    actor,
    settleNative: () => {
      nativeSettled = true;
    },
    counts: () => ({ launches, prompts }),
  };
}

test('native runtime admits idempotently and concurrent starts claim each external effect once', async (t) => {
  const f = fixture(t, false);
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
});

test('native runtime preserves the reservation and never relaunches after losing a claimed launch', async (t) => {
  const f = fixture(t, true);
  const id = f.runtime.admit(f.input);
  await assert.rejects(f.runtime.start(id), /Simulated process loss/);
  await f.runtime.start(id);
  assert.deepEqual(f.counts(), { launches: 1, prompts: 0 });
  assert.equal(f.store.getAttempt(id).phase, 'launching');
  const reservation = f.store.read((db) =>
    db.prepare('SELECT state FROM execution_reservations WHERE attempt_id=?').get(id),
  );
  assert.equal(reservation?.state, 'held');
});

test('native idle releases execution only after a durable result exists', async (t) => {
  const f = fixture(t, false);
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
