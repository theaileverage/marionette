import { composeHerdrAdapter } from '../../src/v1/adapters/herdr.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { Schema } from 'effect';

import {
  AgentSessionIdSchema,
  DigestSchema,
  HostIdSchema,
  ProjectBindingSchema,
  ProjectIdSchema,
  SessionGenerationSchema,
  WorkspaceIdSchema,
} from '../../src/v1/model.js';
import {
  HerdrNativeAdapter,
  type CleanupResult,
  type NativeIdentity,
  type NativeJournal,
  type NativeObservation,
} from '../../src/v1/native.js';
import { nativeLocatorForRetirement } from '../../src/v1/retirement.js';
import { RuntimeRetirementError, retireRuntimeWorkspace } from '../../src/v1/runtime-retirement.js';
import { Store, type SessionIdentity } from '../../src/v1/store.js';

type Fixture = {
  root: string;
  repositoryRoot: string;
  workspacePath: string;
  workspaceId: typeof WorkspaceIdSchema.Type;
  actor: SessionIdentity;
  identity: NativeIdentity;
  attemptId: string;
  store: Store;
};

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });

  assert.equal(result.status, 0, result.stderr);

  return result.stdout.trim();
}

function createFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'marionette-v1-runtime-retirement-')));
  const repositoryRoot = join(root, 'repository');
  const workspacePath = join(root, 'workspace');
  mkdirSync(repositoryRoot);
  git(repositoryRoot, ['init', '-q']);
  git(repositoryRoot, ['config', 'user.name', 'Runtime Retirement Fixture']);
  git(repositoryRoot, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(repositoryRoot, 'tracked.txt'), 'base\n');
  git(repositoryRoot, ['add', 'tracked.txt']);
  git(repositoryRoot, ['commit', '-qm', 'base']);
  git(repositoryRoot, [
    'worktree',
    'add',
    '-q',
    '-b',
    'fixture-runtime-retirement',
    workspacePath,
    'HEAD',
  ]);

  const store = Store.open({
    databasePath: join(root, 'state.sqlite'),
    project: Schema.decodeUnknownSync(ProjectBindingSchema)({
      id: Schema.decodeUnknownSync(ProjectIdSchema)('project_runtime_retirement'),
      hostId: Schema.decodeUnknownSync(HostIdSchema)('host_runtime_retirement'),
      repositoryRoot,
      stateDirectory: join(root, 'state'),
    }),
    clock: () => new Date('2026-09-11T00:00:00.000Z'),
  });

  const actor = {
    id: Schema.decodeUnknownSync(AgentSessionIdSchema)('session_actor'),
    generation: Schema.decodeUnknownSync(SessionGenerationSchema)(1),
  };

  store.registerSession({
    ...actor,
    workspaceId: null,
    role: 'user',
    executionRole: 'lead',
    tokenHash: 'a'.repeat(64),
    parentWorkflowId: null,
    attemptId: null,
    nativeKind: null,
    nativeServerGeneration: null,
    nativeLocator: null,
  });
  const workspaceId = Schema.decodeUnknownSync(WorkspaceIdSchema)('workspace_runtime_retirement');
  store.registerWorkspace({
    actor,
    id: workspaceId,
    kind: 'isolated',
    path: workspacePath,
    repositoryRoot,
    baseCommit: git(repositoryRoot, ['rev-parse', 'HEAD']),
    access: 'write',
    writes: [],
    idempotencyKey: 'workspace',
  });

  const job = store.createJob({
    actor,
    stableKey: 'runtime-retirement',
    request: {
      text: 'Retire a settled runtime workspace',
      digest: Schema.decodeUnknownSync(DigestSchema)(createHash('sha256').update('runtime retirement').digest('hex')),
      inputSnapshots: [],
    },
    brief: {
      objective: 'Retire a settled runtime workspace',
      scope: [],
      ownership: [],
      constraints: [],
      standingOrders: [],
      inputSnapshots: [],
    },
    workspaceId,
    delivery: 'report',
    origin: { kind: 'direct' },
    dependencies: [],
    idempotencyKey: 'job',
  });

  const identity: NativeIdentity = {
    binding: {
      hostId: store.project.hostId,
      socketPath: join(root, 'herdr.sock'),
      workspaceId,
      endpoint: {
        device: 1,
        inode: 2,
        birthtimeMs: 3,
        serverStartToken: 'server-generation-1',
        protocol: 1,
      },
    },
    tabId: 'tab-1',
    paneId: 'pane-1',
    terminalId: 'terminal-1',
    agentKind: 'agy',
    agentName: 'worker',
    nativeSession: 'native-session-1',
    identityRevision: 1,
    ownedTabId: 'tab-1',
  };

  const session = {
    id: Schema.decodeUnknownSync(AgentSessionIdSchema)('session_worker'),
    generation: Schema.decodeUnknownSync(SessionGenerationSchema)(1),
  };

  store.registerSession({
    ...session,
    workspaceId,
    role: 'worker',
    executionRole: 'implementer',
    tokenHash: 'b'.repeat(64),
    parentWorkflowId: null,
    attemptId: null,
    nativeKind: identity.agentKind,
    nativeServerGeneration: identity.binding.endpoint.serverStartToken,
    nativeLocator: nativeLocatorForRetirement(identity),
  });

  const admitted = store.admitAttempt({
    actor,
    jobId: job.id,
    session,
    resourceKey: `workspace/${workspaceId}`,
    inputResultIds: [],
    expectedBriefRevision: 1,
    workflow: { kind: 'direct' },
    idempotencyKey: 'attempt',
  });

  store.settleAttempt({
    actor,
    attemptId: admitted.attempt.id,
    observation: { kind: 'settled', outcome: 'succeeded', reason: 'fixture settlement' },
    idempotencyKey: 'settle',
  });
  store.transaction((database) => {
    database
      .prepare(`UPDATE jobs SET state = 'finished' WHERE project_id = ? AND id = ?`)
      .run(store.project.id, job.id);
    database
      .prepare(
        `UPDATE attempts
         SET native_kind = ?, native_server_generation = ?, native_locator = ?
         WHERE project_id = ? AND id = ?`,
      )
      .run(
        identity.agentKind,
        identity.binding.endpoint.serverStartToken,
        nativeLocatorForRetirement(identity),
        store.project.id,
        admitted.attempt.id,
      );
    database
      .prepare(
        `UPDATE agent_sessions SET state = 'active', settled_at = NULL
         WHERE project_id = ? AND id = ? AND generation = ?`,
      )
      .run(store.project.id, session.id, session.generation);
    database
      .prepare(
        `INSERT INTO native_attempts
           (attempt_id, project_id, binding_json, profile_json, context_path,
            expected_control_revision, phase, identity_json, created_at, updated_at)
         VALUES (?, ?, ?, '{}', ?, NULL, 'settled', ?, ?, ?)`,
      )
      .run(
        admitted.attempt.id,
        store.project.id,
        JSON.stringify(identity.binding),
        join(root, 'context.json'),
        JSON.stringify(identity),
        '2026-09-11T00:00:00.000Z',
        '2026-09-11T00:00:00.000Z',
      );
  });

  return {
    root,
    repositoryRoot,
    workspacePath,
    workspaceId,
    actor,
    identity,
    attemptId: admitted.attempt.id,
    store,
  };
}

function dispose(fixture: Fixture): void {
  fixture.store.close();
  rmSync(fixture.root, { recursive: true, force: true });
}

class FixtureAdapter extends HerdrNativeAdapter {
  cleanupCalls = 0;

  constructor(private readonly effects: NativeJournal) {
    super(effects);
  }

  override async observe(identity: NativeIdentity): Promise<NativeObservation> {
    return { kind: 'settled', identity, slotReady: true };
  }

  override async cleanup(identity: NativeIdentity, authorized: boolean): Promise<CleanupResult> {
    assert.equal(authorized, true);
    const prepared = await this.effects.prepare({ kind: 'cleanup', tabId: identity.ownedTabId });

    if (prepared.kind === 'rejected') return { kind: 'unsupported', reason: prepared.reason };
    this.cleanupCalls += 1;

    return { kind: 'cleaned', operationId: prepared.operationId };
  }
}

test('runtime retirement cleans only its persisted identity with a settled attempt', async () => {
  const fixture = createFixture();

  try {
    let adapter: FixtureAdapter | undefined;

    const retired = await retireRuntimeWorkspace({
      store: fixture.store,
      actor: fixture.actor,
      workspaceId: fixture.workspaceId,
      idempotencyKey: 'retire-runtime',
      adapterFor: (journal) => composeHerdrAdapter((adapter = new FixtureAdapter(journal))),
    });

    assert.equal(retired.kind, 'completed');
    assert.equal(adapter?.cleanupCalls, 1);
    assert.equal(
      fixture.store.read(
        (database) =>
          database
            .prepare(
              `SELECT effect_kind FROM native_effects WHERE project_id = ? AND attempt_id = ?`,
            )
            .get(fixture.store.project.id, fixture.attemptId)?.effect_kind,
      ),
      'cleanup',
    );
    assert.equal(fixture.store.getWorkspace(fixture.workspaceId).retiredAt === null, false);
  } finally {
    dispose(fixture);
  }
});

test('runtime retirement does not resend a cleanup already claimed before its outcome', async () => {
  const fixture = createFixture();

  try {
    fixture.store.transaction((database) => {
      database
        .prepare(
          `INSERT INTO native_effects
             (id, project_id, attempt_id, effect_kind, effect_json, created_at)
           VALUES ('prior-cleanup', ?, ?, 'cleanup', ?, ?)`,
        )
        .run(
          fixture.store.project.id,
          fixture.attemptId,
          JSON.stringify({ kind: 'cleanup', tabId: fixture.identity.ownedTabId }),
          '2026-09-11T00:00:00.000Z',
        );
    });
    let adapter: FixtureAdapter | undefined;

    const retired = await retireRuntimeWorkspace({
      store: fixture.store,
      actor: fixture.actor,
      workspaceId: fixture.workspaceId,
      idempotencyKey: 'retire-preclaimed-cleanup',
      adapterFor: (journal) => composeHerdrAdapter((adapter = new FixtureAdapter(journal))),
    });

    assert.equal(retired.kind, 'blocked');
    assert.match(retired.reason, /already claimed/);
    assert.equal(adapter?.cleanupCalls, 0);
    assert.equal(fixture.store.getWorkspace(fixture.workspaceId).retiredAt, null);
  } finally {
    dispose(fixture);
  }
});

test('runtime retirement rejects a native identity whose session binding changed', async () => {
  const fixture = createFixture();

  try {
    fixture.store.transaction((database) => {
      database
        .prepare(
          `UPDATE agent_sessions SET native_locator = ?
           WHERE project_id = ? AND id = 'session_worker' AND generation = 1`,
        )
        .run('{}', fixture.store.project.id);
    });
    await assert.rejects(
      retireRuntimeWorkspace({
        store: fixture.store,
        actor: fixture.actor,
        workspaceId: fixture.workspaceId,
        idempotencyKey: 'retire-mutated-binding',
      }),
      RuntimeRetirementError,
    );
    assert.equal(fixture.store.getWorkspace(fixture.workspaceId).retiredAt, null);
  } finally {
    dispose(fixture);
  }
});
