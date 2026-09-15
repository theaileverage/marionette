import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Schema } from 'effect';

import { ArtifactFiles, registerArtifact } from '../src/v1/artifacts.js';
import {
  AgentSessionIdSchema,
  DigestSchema,
  HostIdSchema,
  ProjectIdSchema,
  WorkspaceIdSchema,
} from '../src/v1/model.js';
import { Store } from '../src/v1/store.js';

test('reopen retains native references and result artifact provenance', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'marionette-native-persistence-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'state.sqlite');

  const project = {
    id: Schema.decodeUnknownSync(ProjectIdSchema)('native_persistence'),
    hostId: Schema.decodeUnknownSync(HostIdSchema)('host_persistence'),
    repositoryRoot: join(directory, 'repo'),
    stateDirectory: join(directory, 'state'),
  };

  let store = Store.open({ databasePath, project });

  const controller = store.registerSession({
    id: Schema.decodeUnknownSync(AgentSessionIdSchema)('controller-persistence'),
    generation: 1,
    workspaceId: null,
    role: 'controller',
    executionRole: 'controller',
    tokenHash: createHash('sha256').update('controller').digest('hex'),
    parentWorkflowId: null,
    attemptId: null,
    nativeKind: null,
    nativeServerGeneration: null,
    nativeLocator: null,
  });

  const workspaceId = Schema.decodeUnknownSync(WorkspaceIdSchema)('workspace-persistence');
  store.registerWorkspace({
    actor: controller,
    id: workspaceId,
    kind: 'existing',
    path: project.repositoryRoot,
    repositoryRoot: project.repositoryRoot,
    baseCommit: null,
    access: 'inspect',
    writes: [],
    idempotencyKey: 'workspace',
  });

  const worker = store.registerSession({
    id: Schema.decodeUnknownSync(AgentSessionIdSchema)('worker-persistence'),
    generation: 1,
    workspaceId,
    role: 'worker',
    executionRole: 'fixture',
    tokenHash: createHash('sha256').update('worker').digest('hex'),
    parentWorkflowId: null,
    attemptId: null,
    nativeKind: null,
    nativeServerGeneration: null,
    nativeLocator: null,
  });

  const job = store.createJob({
    actor: controller,
    stableKey: 'persistence-job',
    request: {
      text: 'Retain work',
      digest: Schema.decodeUnknownSync(DigestSchema)('0'.repeat(64)),
      inputSnapshots: [],
    },
    brief: {
      objective: 'Retain work',
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

  const attempt = store.admitAttempt({
    actor: controller,
    jobId: job.id,
    session: worker,
    resourceKey: 'session:worker-persistence',
    inputResultIds: [],
    expectedBriefRevision: 1,
    workflow: { kind: 'direct' },
    idempotencyKey: 'admit',
  }).attempt;

  store.claimAttemptLaunch({
    actor: controller,
    attemptId: attempt.id,
    expectedBriefRevision: 1,
    expectedControlRevision: null,
    idempotencyKey: 'launch',
  });
  store.observeAttemptRunning({
    actor: controller,
    attemptId: attempt.id,
    nativeKind: 'agy',
    nativeServerGeneration: 'server-instance',
    nativeLocator: 'transport-only-locator',
    idempotencyKey: 'running',
  });

  const reference = store.recordNativeSessionReference({
    actor: controller,
    attemptId: attempt.id,
    nativeKind: 'agy',
    nativeServerGeneration: 'server-instance',
    reference: {
      harness: 'agy',
      kind: 'id',
      value: 'conversation-persistence',
      source: 'herdr:antigravity_cli',
    },
    status: 'confirmed',
    binding: {
      workspaceId: 'herdr-workspace',
      tabId: 'tab',
      paneId: 'pane',
      terminalId: 'terminal',
      identityRevision: 2,
    },
  });

  const files = new ArtifactFiles(project.stateDirectory);
  const artifact = files.put(Buffer.from('checkpoint bytes'), 'application/json');
  registerArtifact(store, files, artifact);

  const result = store.recordResult({
    actor: controller,
    attemptId: attempt.id,
    content: {
      kind: 'report',
      body: 'Retained result',
      artifactDigests: [Schema.decodeUnknownSync(DigestSchema)(artifact.digest)],
    },
    inputDigest: Schema.decodeUnknownSync(DigestSchema)('1'.repeat(64)),
    workspaceDigest: Schema.decodeUnknownSync(DigestSchema)('2'.repeat(64)),
    evidenceClaims: [],
    evidence: [],
    verification: { kind: 'not-requested' },
    upstreamResultIds: [],
    idempotencyKey: 'result',
  });

  store.close();

  store = Store.open({ databasePath, project });

  try {
    assert.deepEqual(store.listNativeSessionReferences(attempt.id), [reference]);
    const retained = store.retainedWork(attempt.id);
    assert.deepEqual(
      retained.results.map(({ id }) => id),
      [result.id],
    );
    assert.deepEqual(
      retained.artifacts.map(({ digest }) => digest),
      [artifact.digest],
    );
  } finally {
    store.close();
  }
});
