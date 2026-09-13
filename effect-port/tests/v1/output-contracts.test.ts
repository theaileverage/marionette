import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import test from 'node:test';
import { Marionette } from '../../src/v1/client.js';
import { operationSchema, execute } from '../../src/v1/operations.js';
import {
  operationOutputSchemas,
  outputContractVersion,
  parseOperationOutput,
} from '../../src/v1/output-contracts.js';

test('v1 output contracts cover every operation and retain the version boundary', () => {
  assert.equal(outputContractVersion, 'v1');
  assert.deepEqual(
    Object.keys(operationOutputSchemas).sort(),
    operationSchema.members.map((member) => member.fields.operation.literal).sort(),
  );
});

test('v1 output contracts parse real board operation results', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-v1-output-contracts-'));
  const repositoryRoot = join(root, 'repo');
  mkdirSync(repositoryRoot);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const client = Marionette.init({ repositoryRoot, stateHome: join(root, 'state') });
  t.after(() => client.close());
  const created = parseOperationOutput(
    'board.create',
    await execute(client, {
      operation: 'board.create',
      title: 'Public output contract',
      idempotencyKey: 'create-contract-thread',
    }),
  );
  const posted = parseOperationOutput(
    'board.post',
    await execute(client, {
      operation: 'board.post',
      threadId: created.id,
      body: 'The board result has its public fields.',
      kind: 'finding',
      idempotencyKey: 'post-contract-output',
    }),
  );
  const read = await execute(client, { operation: 'board.read', threadId: created.id });
  const parsed = parseOperationOutput('board.read', read);
  assert.equal(parsed.entries[0]?.id, posted.id);
  assert.equal(parsed.nextCursor, null);
});

test('v1 output contracts accept the native observation and submission states', () => {
  const timestamp = '2026-09-11T00:00:00.000Z';
  const attempt = {
    id: 'attempt-1',
    jobId: 'job-1',
    workflowId: null,
    stepRunId: null,
    briefId: 'brief-1',
    briefRevision: 1,
    hostId: 'host-1',
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    sessionGeneration: 1,
    phase: 'running',
    nativeKind: 'herdr',
    nativeServerGeneration: 'server-1',
    nativeLocator: 'locator',
    createdAt: timestamp,
    settledAt: null,
  };
  const identity = {
    binding: {
      hostId: 'host-1',
      socketPath: '/tmp/herdr.sock',
      workspaceId: 'workspace-1',
      endpoint: {
        device: 1,
        inode: 2,
        birthtimeMs: 3,
        serverStartToken: 'server-1',
        protocol: 1,
      },
    },
    tabId: 'tab-1',
    paneId: 'pane-1',
    terminalId: 'terminal-1',
    agentKind: 'herdr',
    agentName: 'agent-1',
    nativeSession: 'native-1',
    identityRevision: 1,
    ownedTabId: 'tab-1',
  };
  const native = [
    { kind: 'working', identity },
    { kind: 'blocked', identity, reason: 'Waiting for input' },
    { kind: 'manual-required', identity, reason: 'Needs a human' },
    { kind: 'settled', identity, slotReady: true },
    { kind: 'unconfirmed', reason: 'The agent cannot be observed' },
    { kind: 'unsupported', reason: 'The adapter cannot submit work' },
    { kind: 'submitted', operationId: 'operation-1' },
  ] as const;

  for (const state of native) parseOperationOutput('attempt.inspect', { attempt, native: state });
});
