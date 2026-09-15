import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Schema } from 'effect';

import {
  AgentSessionIdSchema,
  HostIdSchema,
  ProjectBindingSchema,
  ProjectIdSchema,
  SessionGenerationSchema,
  WorkspaceIdSchema,
} from '../../src/v1/model.js';
import type { NativeIdentity } from '../../src/v1/native.js';
import { nativeLocatorForRetirement, previewWorkspaceRetirement } from '../../src/v1/retirement.js';
import { previewRuntimeWorkspaceRetirement } from '../../src/v1/runtime-retirement.js';
import { Store, type SessionIdentity } from '../../src/v1/store.js';

type Fixture = {
  root: string;
  repositoryRoot: string;
  workspacePath: string;
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'marionette-v1-retirement-preview-')));
  const repositoryRoot = join(root, 'repository');
  const workspacePath = join(root, 'workspace');
  const stateDirectory = join(root, 'state');
  mkdirSync(repositoryRoot);
  git(repositoryRoot, ['init', '-q']);
  git(repositoryRoot, ['config', 'user.name', 'Retirement Preview Fixture']);
  git(repositoryRoot, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(repositoryRoot, 'tracked.txt'), 'base\n');
  git(repositoryRoot, ['add', 'tracked.txt']);
  git(repositoryRoot, ['commit', '-qm', 'base']);
  git(repositoryRoot, ['worktree', 'add', '-q', '-b', 'fixture-preview', workspacePath, 'HEAD']);

  const store = Store.open({
    databasePath: join(root, 'state.sqlite'),
    project: Schema.decodeUnknownSync(ProjectBindingSchema)({
      id: Schema.decodeUnknownSync(ProjectIdSchema)('project_retirement_preview'),
      hostId: Schema.decodeUnknownSync(HostIdSchema)('host_retirement_preview'),
      repositoryRoot,
      stateDirectory,
    }),
    clock: () => new Date('2026-09-11T00:00:00.000Z'),
    idFactory: (kind) => `${kind}_fixture`,
  });

  const actor = {
    id: Schema.decodeUnknownSync(AgentSessionIdSchema)('session_preview_actor'),
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
  const workspaceId = Schema.decodeUnknownSync(WorkspaceIdSchema)('workspace_retirement_preview');
  store.registerWorkspace({
    actor,
    id: workspaceId,
    kind: 'isolated',
    path: workspacePath,
    repositoryRoot,
    baseCommit: git(repositoryRoot, ['rev-parse', 'HEAD']),
    access: 'write',
    writes: [],
    idempotencyKey: 'register-preview-workspace',
  });

  return { root, repositoryRoot, workspacePath, workspaceId, actor, store };
}

function dispose(fixture: Fixture): void {
  fixture.store.close();
  rmSync(fixture.root, { recursive: true, force: true });
}

function retirementCount(fixture: Fixture): number {
  return fixture.store.read((database) =>
    Number(
      database.prepare('SELECT count(*) AS count FROM workspace_retirements').get()?.count ?? NaN,
    ),
  );
}

test('plans a clean worktree retirement without recording an intent or removing its worktree', () => {
  const fixture = createFixture();

  try {
    const preview = previewWorkspaceRetirement({
      store: fixture.store,
      actor: fixture.actor,
      workspaceId: fixture.workspaceId,
      idempotencyKey: 'preview-clean',
    });

    assert.equal(preview.kind, 'ready');
    assert.deepEqual(preview.effects, [
      { kind: 'remove-worktree', path: fixture.workspacePath },
      { kind: 'mark-workspace-retired', workspaceId: fixture.workspaceId },
    ]);
    assert.deepEqual(
      preview.skippedChecks.map((check) => check.kind),
      ['post-worktree-removal'],
    );
    assert.equal(retirementCount(fixture), 0);
    assert.equal(fixture.store.getWorkspace(fixture.workspaceId).retiredAt, null);
    assert.equal(existsSync(fixture.workspacePath), true);
    assert.match(git(fixture.repositoryRoot, ['worktree', 'list', '--porcelain']), /worktree /);
  } finally {
    dispose(fixture);
  }
});

test('reports planned native cleanup without observing, claiming, or settling the session', () => {
  const fixture = createFixture();

  try {
    const session = {
      id: Schema.decodeUnknownSync(AgentSessionIdSchema)('session_preview_native'),
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
          serverStartToken: 'server-preview',
          protocol: 1,
        },
      },
      tabId: 'tab-preview',
      paneId: 'pane-preview',
      terminalId: 'terminal-preview',
      agentKind: 'codex',
      agentName: 'worker',
      foregroundProcess: { pid: 42, startToken: 'process-preview' },
      identityRevision: 1,
      ownedTabId: 'tab-preview',
    };

    fixture.store.registerSession({
      ...session,
      workspaceId: fixture.workspaceId,
      role: 'worker',
      executionRole: 'implementer',
      tokenHash: 'b'.repeat(64),
      parentWorkflowId: null,
      attemptId: null,
      nativeKind: identity.agentKind,
      nativeServerGeneration: identity.binding.endpoint.serverStartToken,
      nativeLocator: nativeLocatorForRetirement(identity),
    });

    const preview = previewWorkspaceRetirement({
      store: fixture.store,
      actor: fixture.actor,
      workspaceId: fixture.workspaceId,
      idempotencyKey: 'preview-native',
      nativeTargets: [{ session, identity }],
    });

    assert.equal(preview.kind, 'ready');
    assert.deepEqual(preview.nativeTargets, [{ session, identity }]);
    assert.deepEqual(preview.effects.at(0), { kind: 'cleanup-native-tab', session, identity });
    assert.deepEqual(
      preview.skippedChecks.slice(0, 3).map((check) => check.kind),
      ['native-observation', 'native-cleanup', 'post-native-cleanup-state'],
    );
    assert.equal(
      fixture.store.read(
        (database) =>
          database
            .prepare('SELECT state FROM agent_sessions WHERE id = ? AND generation = ?')
            .get(session.id, session.generation)?.state ?? null,
      ),
      'active',
    );
    assert.equal(retirementCount(fixture), 0);
    assert.equal(existsSync(fixture.workspacePath), true);
  } finally {
    dispose(fixture);
  }
});

test('blocks on an active workspace consumer without recording retirement state', () => {
  const fixture = createFixture();

  try {
    fixture.store.registerSession({
      id: Schema.decodeUnknownSync(AgentSessionIdSchema)('session_preview_consumer'),
      generation: Schema.decodeUnknownSync(SessionGenerationSchema)(1),
      workspaceId: fixture.workspaceId,
      role: 'worker',
      executionRole: 'implementer',
      tokenHash: 'c'.repeat(64),
      parentWorkflowId: null,
      attemptId: null,
      nativeKind: null,
      nativeServerGeneration: null,
      nativeLocator: null,
    });

    const preview = previewWorkspaceRetirement({
      store: fixture.store,
      actor: fixture.actor,
      workspaceId: fixture.workspaceId,
      idempotencyKey: 'preview-consumer',
    });

    assert.equal(preview.kind, 'blocked');
    assert.match(preview.reason ?? '', /still a consumer/);
    assert.deepEqual(preview.effects, []);
    assert.equal(retirementCount(fixture), 0);
    assert.equal(fixture.store.getWorkspace(fixture.workspaceId).retiredAt, null);
    assert.equal(existsSync(fixture.workspacePath), true);
  } finally {
    dispose(fixture);
  }
});

test('runtime preview uses only its persisted target lookup and returns the same clean plan', () => {
  const fixture = createFixture();

  try {
    const preview = previewRuntimeWorkspaceRetirement({
      store: fixture.store,
      actor: fixture.actor,
      workspaceId: fixture.workspaceId,
      idempotencyKey: 'preview-runtime',
    });

    assert.equal(preview.kind, 'ready');
    assert.deepEqual(preview.nativeTargets, []);
    assert.equal(retirementCount(fixture), 0);
    assert.equal(existsSync(fixture.workspacePath), true);
  } finally {
    dispose(fixture);
  }
});
