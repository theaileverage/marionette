import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { Effect, Schema } from 'effect';

import { Board } from '../src/v1/board.js';
import {
  AgentSessionIdSchema,
  DigestSchema,
  ProjectBindingSchema,
  WorkspaceIdSchema,
} from '../src/v1/model.js';
import { Store, StoreError, type AgentSession, type SessionIdentity } from '../src/v1/store.js';
import { Settings, profileSchema } from '../src/v1/settings.js';

const zeroDigest = Schema.decodeSync(DigestSchema)('0'.repeat(64));

const oneDigest = Schema.decodeSync(DigestSchema)('1'.repeat(64));

function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function hasCode(code: StoreError['code']) {
  return (cause: unknown) => cause instanceof StoreError && cause.code === code;
}

type Fixture = {
  readonly root: string;
  readonly store: Store;
  readonly controller: SessionIdentity;
  readonly worker: AgentSession;
  readonly workspaceId: typeof WorkspaceIdSchema.Type;
};

function fixture(t: TestContext): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'marionette-effect-authority-'));

  const project = Schema.decodeSync(ProjectBindingSchema)({
    id: 'project-effect',
    hostId: 'host-effect',
    repositoryRoot: root,
    stateDirectory: root,
  });

  const store = Store.open({ databasePath: join(root, 'project.sqlite'), project });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  const controller = {
    id: Schema.decodeSync(AgentSessionIdSchema)('controller-effect'),
    generation: 1,
  };

  store.registerSession({
    ...controller,
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
  const workspaceId = Schema.decodeSync(WorkspaceIdSchema)('workspace-effect');
  store.registerWorkspace({
    actor: controller,
    id: workspaceId,
    kind: 'existing',
    path: root,
    repositoryRoot: root,
    baseCommit: null,
    access: 'write',
    writes: ['**'],
    idempotencyKey: 'workspace-effect',
  });

  const worker = store.registerSession({
    id: Schema.decodeSync(AgentSessionIdSchema)('worker-effect'),
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

  return { root, store, controller, worker, workspaceId };
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

test('nested rollback preserves the outer transaction and rejects async transaction values', (t) => {
  const current = fixture(t);
  current.store.transaction((database) => {
    database
      .prepare(
        'INSERT INTO project_settings(project_id,key,revision,value_json,updated_at) VALUES(?,?,?,?,?)',
      )
      .run(current.store.project.id, 'outer-before', 1, '{}', new Date().toISOString());
    assert.throws(() =>
      current.store.transaction((nested) => {
        nested
          .prepare(
            'INSERT INTO project_settings(project_id,key,revision,value_json,updated_at) VALUES(?,?,?,?,?)',
          )
          .run(current.store.project.id, 'inner-rolled-back', 1, '{}', new Date().toISOString());
        throw new Error('rollback nested savepoint');
      }),
    );
    database
      .prepare(
        'INSERT INTO project_settings(project_id,key,revision,value_json,updated_at) VALUES(?,?,?,?,?)',
      )
      .run(current.store.project.id, 'outer-after', 1, '{}', new Date().toISOString());
  });
  assert.deepEqual(
    current.store.read((database) =>
      database
        .prepare('SELECT key FROM project_settings WHERE project_id=? ORDER BY key')
        .all(current.store.project.id)
        .map((row) => row.key),
    ),
    ['outer-after', 'outer-before'],
  );

  assert.throws(
    () =>
      current.store.transaction(async (database) => {
        database
          .prepare(
            'INSERT INTO project_settings(project_id,key,revision,value_json,updated_at) VALUES(?,?,?,?,?)',
          )
          .run(current.store.project.id, 'async-rolled-back', 1, '{}', new Date().toISOString());

        return 1;
      }),
    hasCode('invalid-state'),
  );
  assert.throws(() => current.store.transaction(() => Effect.succeed(1)), hasCode('invalid-state'));
  assert.equal(
    current.store.read(
      (database) =>
        database
          .prepare('SELECT count(*) AS count FROM project_settings WHERE project_id=? AND key=?')
          .get(current.store.project.id, 'async-rolled-back')?.count,
    ),
    0,
  );
});

test('job idempotency, retirement fencing, result recording and acceptance retain authority parity', (t) => {
  const current = fixture(t);

  const input = {
    actor: current.controller,
    stableKey: 'authority-job',
    request,
    brief,
    workspaceId: current.workspaceId,
    delivery: 'report' as const,
    origin: { kind: 'direct' as const },
    dependencies: [],
    idempotencyKey: 'create-authority-job',
  };

  const job = current.store.createJob(input);
  assert.equal(current.store.createJob(input).id, job.id);
  assert.throws(
    () => current.store.createJob({ ...input, stableKey: 'changed-authority-job' }),
    hasCode('idempotency-conflict'),
  );

  const admission = current.store.admitAttempt({
    actor: current.controller,
    jobId: job.id,
    session: current.worker,
    resourceKey: 'workspace:effect',
    inputResultIds: [],
    expectedBriefRevision: 1,
    workflow: { kind: 'direct' },
    idempotencyKey: 'admit-authority-job',
  });

  assert.throws(
    () =>
      current.store.claimAttemptLaunch({
        actor: current.controller,
        attemptId: admission.attempt.id,
        expectedBriefRevision: 2,
        expectedControlRevision: null,
        idempotencyKey: 'stale-authority-launch',
      }),
    hasCode('stale-revision'),
  );
  current.store.acknowledgeBrief({
    actor: current.worker,
    attemptId: admission.attempt.id,
    briefRevision: 1,
    idempotencyKey: 'ack-authority-brief',
  });
  current.store.claimAttemptLaunch({
    actor: current.controller,
    attemptId: admission.attempt.id,
    expectedBriefRevision: 1,
    expectedControlRevision: null,
    idempotencyKey: 'launch-authority-job',
  });
  current.store.observeAttemptRunning({
    actor: current.controller,
    attemptId: admission.attempt.id,
    nativeKind: 'herdr-pane',
    nativeServerGeneration: 'server-effect',
    nativeLocator: 'pane-effect',
    idempotencyKey: 'observe-authority-job',
  });

  const result = current.store.recordResult({
    actor: current.worker,
    attemptId: admission.attempt.id,
    content: { kind: 'report', body: 'Effect authority port complete.', artifactDigests: [] },
    inputDigest: zeroDigest,
    workspaceDigest: oneDigest,
    evidenceClaims: [],
    evidence: [],
    verification: { kind: 'not-requested' },
    upstreamResultIds: [],
    idempotencyKey: 'record-authority-result',
  });

  const decision = current.store.decideResult({
    actor: current.controller,
    resultId: result.id,
    expectedBriefRevision: 1,
    decision: { kind: 'accepted' },
    idempotencyKey: 'accept-authority-result',
  });

  assert.equal(decision.decision, 'accepted');
  assert.equal(
    current.store.decideResult({
      actor: current.controller,
      resultId: result.id,
      expectedBriefRevision: 1,
      decision: { kind: 'accepted' },
      idempotencyKey: 'accept-authority-result',
    }).id,
    decision.id,
  );
  assert.deepEqual(current.store.getResult(result.id), result);

  current.store.transaction((database) => {
    const workspace = current.store.getWorkspace(current.workspaceId);
    database
      .prepare(
        `INSERT INTO workspace_retirements
           (id,project_id,workspace_id,expected_host_id,expected_path,
            expected_workspace_created_at,idempotency_key,state,revision,
            created_at,updated_at,completed_at,last_error)
         VALUES(?,?,?,?,?,?,?,'pending',1,?,?,NULL,NULL)`,
      )
      .run(
        'retirement-effect',
        current.store.project.id,
        current.workspaceId,
        current.store.project.hostId,
        workspace.path,
        workspace.createdAt,
        'retire-effect',
        workspace.createdAt,
        workspace.createdAt,
      );
  });
  assert.throws(
    () =>
      current.store.createJob({
        ...input,
        stableKey: 'fenced-job',
        idempotencyKey: 'create-fenced-job',
      }),
    hasCode('resource-busy'),
  );
});

test('board and settings retain immutable idempotent writes with native schemas', (t) => {
  const current = fixture(t);
  const board = Board.create({ store: current.store });

  const author = {
    kind: 'session' as const,
    id: current.controller.id,
    generation: current.controller.generation,
  };

  const thread = board.createThread({
    title: 'Authority parity',
    author,
    idempotencyKey: 'authority-thread',
  });

  const post = board.post({
    threadId: thread.id,
    author,
    body: 'The Effect Schema port owns this write.',
    kind: 'finding',
    references: [{ kind: 'file', value: 'effect-port/src/v1/store.ts' }],
    idempotencyKey: 'authority-post',
  });

  assert.deepEqual(
    board.post({
      threadId: thread.id,
      author,
      body: 'The Effect Schema port owns this write.',
      kind: 'finding',
      references: [{ kind: 'file', value: 'effect-port/src/v1/store.ts' }],
      idempotencyKey: 'authority-post',
    }),
    post,
  );
  assert.throws(
    () =>
      board.post({
        threadId: thread.id,
        author,
        body: 'Changed content',
        kind: 'finding',
        idempotencyKey: 'authority-post',
      }),
    /idempotency key was already used/,
  );
  const settings = new Settings(current.store, current.controller);

  const profile = {
    name: 'codex',
    kind: 'agy',
    model: 'gpt-5.6-terra',
    args: ['--model=gpt-5.6-terra'],
  };

  assert.deepEqual(
    settings.set({
      key: 'profile/codex',
      expectedRevision: 0,
      value: profile,
      schema: profileSchema,
      idempotencyKey: 'profile-codex',
    }),
    { revision: 1, value: profile },
  );
  assert.deepEqual(settings.profile('codex'), profile);
  assert.throws(() =>
    settings.set({
      key: 'profile/invalid',
      expectedRevision: 0,
      value: { ...profile, name: 'invalid', args: ['--model=another'] },
      schema: profileSchema,
      idempotencyKey: 'profile-invalid',
    }),
  );
  assert.throws(
    () =>
      settings.set({
        key: 'profile/codex',
        expectedRevision: 0,
        value: profile,
        schema: profileSchema,
        idempotencyKey: 'profile-stale',
      }),
    /revision is stale/,
  );
});

test('board optional identities accept explicit undefined and preserve omission', (t) => {
  const current = fixture(t);
  const board = Board.create({ store: current.store });

  const explicitUndefined = {
    kind: 'user' as const,
    id: 'local-user-explicit-undefined',
    generation: undefined,
  };

  const explicitThread = board.createThread({
    title: 'Explicit undefined generation',
    author: explicitUndefined,
    idempotencyKey: 'explicit-undefined-thread',
  });

  assert.equal(explicitThread.author.generation, undefined);
  assert.equal(Object.hasOwn(explicitThread.author, 'generation'), true);

  const omittedThread = board.createThread({
    title: 'Omitted generation',
    author: { kind: 'user', id: 'local-user-omitted' },
    idempotencyKey: 'omitted-generation-thread',
  });

  assert.equal(omittedThread.author.generation, undefined);
  assert.equal(Object.hasOwn(omittedThread.author, 'generation'), false);

  const subscription = board.subscribe({
    subscriber: { kind: 'desktop', id: 'desktop-explicit-undefined', generation: undefined },
  });

  assert.equal(subscription.subscriber.generation, undefined);
  assert.equal(Object.hasOwn(subscription.subscriber, 'generation'), true);
});
