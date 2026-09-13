import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Schema } from 'effect';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ArtifactFiles } from '../../src/v1/artifacts.js';
import {
  AgentSessionIdSchema,
  HostIdSchema,
  ProjectBindingSchema,
  ProjectIdSchema,
  SessionGenerationSchema,
  WorkspaceIdSchema,
} from '../../src/v1/model.js';
import type { NativeIdentity } from '../../src/v1/native.js';
import {
  nativeLocatorForRetirement,
  NativeWorkspaceRetirementGit,
  retireWorkspace,
  type NativeRetirementAdapter,
  type WorkspaceRetirementGit,
} from '../../src/v1/retirement.js';
import { Store, type SessionIdentity } from '../../src/v1/store.js';

type Fixture = {
  root: string;
  repositoryRoot: string;
  workspacePath: string;
  stateDirectory: string;
  workspaceId: typeof WorkspaceIdSchema.Type;
  actor: SessionIdentity;
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'marionette-v1-retirement-')));
  const repositoryRoot = join(root, 'repository');
  const workspacePath = join(root, 'workspace');
  const stateDirectory = join(root, 'state');
  mkdirSync(repositoryRoot);
  git(repositoryRoot, ['init', '-q']);
  git(repositoryRoot, ['config', 'user.name', 'Retirement Fixture']);
  git(repositoryRoot, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(repositoryRoot, 'tracked.txt'), 'base\n');
  git(repositoryRoot, ['add', 'tracked.txt']);
  git(repositoryRoot, ['commit', '-qm', 'base']);
  git(repositoryRoot, ['worktree', 'add', '-q', '-b', 'fixture-workspace', workspacePath, 'HEAD']);

  const project = Schema.decodeUnknownSync(ProjectBindingSchema)({
    id: Schema.decodeUnknownSync(ProjectIdSchema)('project_retirement'),
    hostId: Schema.decodeUnknownSync(HostIdSchema)('host_retirement'),
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
  const workspaceId = Schema.decodeUnknownSync(WorkspaceIdSchema)('workspace_retirement');
  store.registerWorkspace({
    actor,
    id: workspaceId,
    kind: 'isolated',
    path: workspacePath,
    repositoryRoot,
    baseCommit: git(repositoryRoot, ['rev-parse', 'HEAD']),
    access: 'write',
    writes: [],
    idempotencyKey: 'register-retirement-workspace',
  });
  return { root, repositoryRoot, workspacePath, stateDirectory, workspaceId, actor, store };
}

function dispose(fixture: Fixture): void {
  fixture.store.close();
  rmSync(fixture.root, { recursive: true, force: true });
}

function isRegistered(fixture: Fixture): boolean {
  return git(fixture.repositoryRoot, ['worktree', 'list', '--porcelain']).includes(
    `worktree ${fixture.workspacePath}`,
  );
}

test('preserves a dirty registered worktree and its untracked bytes', async () => {
  const fixture = createFixture();
  try {
    const untracked = join(fixture.workspacePath, 'keep-me.txt');
    writeFileSync(untracked, 'do not delete');

    const retired = await retireWorkspace({
      store: fixture.store,
      actor: fixture.actor,
      workspaceId: fixture.workspaceId,
      idempotencyKey: 'retire-dirty',
    });

    assert.equal(retired.kind, 'blocked');
    assert.match(retired.reason, /tracked or untracked changes/);
    assert.equal(readFileSync(untracked, 'utf8'), 'do not delete');
    assert.equal(isRegistered(fixture), true);
    assert.equal(fixture.store.getWorkspace(fixture.workspaceId).retiredAt, null);
  } finally {
    dispose(fixture);
  }
});

test('keeps the worktree while another registered session consumes it', async () => {
  const fixture = createFixture();
  try {
    const consumer = {
      id: Schema.decodeUnknownSync(AgentSessionIdSchema)('session_consumer'),
      generation: Schema.decodeUnknownSync(SessionGenerationSchema)(1),
    };
    fixture.store.registerSession({
      ...consumer,
      workspaceId: fixture.workspaceId,
      role: 'worker',
      executionRole: 'implementer',
      tokenHash: 'b'.repeat(64),
      parentWorkflowId: null,
      attemptId: null,
      nativeKind: null,
      nativeServerGeneration: null,
      nativeLocator: null,
    });

    const retired = await retireWorkspace({
      store: fixture.store,
      actor: fixture.actor,
      workspaceId: fixture.workspaceId,
      idempotencyKey: 'retire-consumed',
    });

    assert.equal(retired.kind, 'blocked');
    assert.match(retired.reason, /still a consumer/);
    assert.equal(existsSync(fixture.workspacePath), true);
    assert.equal(isRegistered(fixture), true);
  } finally {
    dispose(fixture);
  }
});

test('reconciles the same intent after Git removed the worktree before completion was recorded', async () => {
  const fixture = createFixture();
  try {
    const nativeGit = new NativeWorkspaceRetirementGit();
    const crashAfterRemove: WorkspaceRetirementGit = {
      observe: (workspace) => nativeGit.observe(workspace),
      remove: (workspace) => {
        nativeGit.remove(workspace);
        throw new Error('simulated crash after Git removal');
      },
    };
    const input = {
      store: fixture.store,
      actor: fixture.actor,
      workspaceId: fixture.workspaceId,
      idempotencyKey: 'retire-after-crash',
    };

    const interrupted = await retireWorkspace({ ...input, git: crashAfterRemove });
    assert.equal(interrupted.kind, 'unconfirmed');
    assert.match(interrupted.reason, /simulated crash/);
    assert.equal(existsSync(fixture.workspacePath), false);
    assert.equal(isRegistered(fixture), false);
    assert.equal(fixture.store.getWorkspace(fixture.workspaceId).retiredAt, null);

    const reconciled = await retireWorkspace(input);
    assert.equal(reconciled.kind, 'completed');
    assert.equal(reconciled.retirementId, interrupted.retirementId);
    assert.notEqual(fixture.store.getWorkspace(fixture.workspaceId).retiredAt, null);
    assert.deepEqual(await retireWorkspace(input), reconciled);
  } finally {
    dispose(fixture);
  }
});

test('requires the exact registered native identity before closing an owned tab', async () => {
  const fixture = createFixture();
  try {
    const session = {
      id: Schema.decodeUnknownSync(AgentSessionIdSchema)('session_native'),
      generation: Schema.decodeUnknownSync(SessionGenerationSchema)(1),
    };
    const identity: NativeIdentity = {
      binding: {
        hostId: fixture.store.project.hostId,
        socketPath: join(fixture.root, 'herdr.sock'),
        workspaceId: fixture.workspaceId,
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
      agentKind: 'codex',
      agentName: 'worker',
      foregroundProcess: { pid: 42, startToken: 'process-start-1' },
      identityRevision: 1,
      ownedTabId: 'tab-1',
    };
    fixture.store.registerSession({
      ...session,
      workspaceId: fixture.workspaceId,
      role: 'worker',
      executionRole: 'implementer',
      tokenHash: 'c'.repeat(64),
      parentWorkflowId: null,
      attemptId: null,
      nativeKind: identity.agentKind,
      nativeServerGeneration: identity.binding.endpoint.serverStartToken,
      nativeLocator: nativeLocatorForRetirement(identity),
    });
    const calls: string[] = [];
    const nativeAdapter: NativeRetirementAdapter = {
      async observe(observedIdentity) {
        calls.push(`observe:${observedIdentity.paneId}`);
        return { kind: 'settled', identity: observedIdentity, slotReady: true };
      },
      async cleanup(cleanedIdentity, authorized) {
        calls.push(`cleanup:${cleanedIdentity.ownedTabId}:${authorized}`);
        return { kind: 'cleaned', operationId: 'cleanup-1' };
      },
    };

    const retired = await retireWorkspace({
      store: fixture.store,
      actor: fixture.actor,
      workspaceId: fixture.workspaceId,
      idempotencyKey: 'retire-native',
      nativeTargets: [{ session, identity }],
      nativeAdapter,
    });

    assert.equal(retired.kind, 'completed');
    assert.deepEqual(calls, ['observe:pane-1', 'cleanup:tab-1:true']);
    assert.equal(
      fixture.store.read(
        (database) =>
          database
            .prepare('SELECT state FROM agent_sessions WHERE id = ? AND generation = ?')
            .get(session.id, session.generation)?.state,
      ),
      'settled',
    );
    assert.equal(existsSync(fixture.workspacePath), false);
  } finally {
    dispose(fixture);
  }
});

test('preserves a worktree when a required verification log is not durable', async () => {
  const fixture = createFixture();
  try {
    const artifacts = new ArtifactFiles(fixture.stateDirectory);
    const artifact = artifacts.put(Buffer.from('verified command output'));
    const timestamp = '2026-09-11T00:00:00.000Z';
    fixture.store.transaction((database) => {
      database
        .prepare(
          `INSERT INTO job_requests (id, project_id, request_digest, request_json, created_at)
           VALUES ('request_artifact', ?, ?, '{}', ?)`,
        )
        .run(fixture.store.project.id, artifact.digest, timestamp);
      database
        .prepare(
          `INSERT INTO jobs
             (id, project_id, stable_key, request_id, current_brief_id,
              current_brief_revision, workspace_id, delivery_kind, origin_kind,
              state, created_at, updated_at)
           VALUES ('job_artifact', ?, 'artifact-job', 'request_artifact', 'brief_artifact',
                   1, ?, 'report', 'direct', 'finished', ?, ?)`,
        )
        .run(fixture.store.project.id, fixture.workspaceId, timestamp, timestamp);
      database
        .prepare(
          `INSERT INTO brief_revisions
             (id, project_id, job_id, revision, content_json, change_reason, created_at)
           VALUES ('brief_artifact', ?, 'job_artifact', 1, '{}', 'fixture', ?)`,
        )
        .run(fixture.store.project.id, timestamp);
      database
        .prepare(
          `INSERT INTO attempts
             (id, project_id, job_id, brief_id, brief_revision, host_id, workspace_id,
              session_id, session_generation, phase, created_at, settled_at)
           VALUES ('attempt_artifact', ?, 'job_artifact', 'brief_artifact', 1, ?, ?,
                   ?, ?, 'settled', ?, ?)`,
        )
        .run(
          fixture.store.project.id,
          fixture.store.project.hostId,
          fixture.workspaceId,
          fixture.actor.id,
          fixture.actor.generation,
          timestamp,
          timestamp,
        );
      database
        .prepare(
          `INSERT INTO results
             (id, project_id, job_id, attempt_id, brief_id, brief_revision, host_id,
              workspace_id, result_kind, input_digest, workspace_digest, changed_paths_json,
              artifact_digests_json, evidence_claims_json, evidence_json,
              verification_json, created_at, report_text)
           VALUES ('result_artifact', ?, 'job_artifact', 'attempt_artifact', 'brief_artifact',
                   1, ?, ?, 'report', ?, ?, '[]', '[]', '[]', '[]', ?, ?, 'Verification report')`,
        )
        .run(
          fixture.store.project.id,
          fixture.store.project.hostId,
          fixture.workspaceId,
          artifact.digest,
          artifact.digest,
          JSON.stringify({
            kind: 'passed',
            checks: [{ kind: 'command', argv: ['test'], exitCode: 0, log: artifact.digest }],
          }),
          timestamp,
        );
      database
        .prepare(
          `INSERT INTO artifacts
             (id, project_id, host_id, digest, path, byte_length, created_at)
           VALUES ('artifact_log', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          fixture.store.project.id,
          fixture.store.project.hostId,
          artifact.digest,
          artifacts.path(artifact),
          artifact.byteLength,
          timestamp,
        );
    });
    chmodSync(artifacts.path(artifact), 0o600);
    writeFileSync(artifacts.path(artifact), 'damaged');

    const retired = await retireWorkspace({
      store: fixture.store,
      actor: fixture.actor,
      workspaceId: fixture.workspaceId,
      idempotencyKey: 'retire-damaged-artifact',
    });

    assert.equal(retired.kind, 'blocked');
    assert.match(retired.reason, /integrity check/);
    assert.equal(existsSync(fixture.workspacePath), true);
    assert.equal(isRegistered(fixture), true);
  } finally {
    dispose(fixture);
  }
});
