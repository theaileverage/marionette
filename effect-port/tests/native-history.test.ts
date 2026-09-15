import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Schema } from 'effect';

import { readNativeHistory } from '../src/v1/native-history.js';
import { NativeSessionReferenceSchema } from '../src/v1/native-session.js';

function reference(path: string) {
  return Schema.decodeUnknownSync(NativeSessionReferenceSchema)({
    id: 'reference-1',
    attemptId: 'attempt-1',
    sessionId: 'session-1',
    sessionGeneration: 1,
    hostId: 'host-1',
    nativeKind: 'pi',
    nativeServerGeneration: 'server-1',
    harness: 'pi',
    kind: 'path',
    value: path,
    source: 'herdr:pi',
    status: 'confirmed',
    observedAt: '2026-09-13T00:00:00.000Z',
    binding: {
      workspaceId: 'native-workspace-1',
      tabId: 'tab-1',
      paneId: 'pane-1',
      terminalId: 'terminal-1',
      identityRevision: 1,
    },
    rejectionReason: null,
  });
}

test('native JSONL history is bounded, paginated, and read-only', (t) => {
  const created = mkdtempSync(join(tmpdir(), 'marionette-history-'));
  const root = realpathSync(created);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'session.jsonl');
  writeFileSync(path, '{"n":1}\n{"n":2}\n{"n":3}\n', { mode: 0o600 });
  const first = readNativeHistory(reference(path), 'host-1', { limit: 2, maxBytes: 1024 });
  assert.equal(first.kind, 'available');

  if (first.kind !== 'available') return;
  assert.deepEqual(
    first.entries.map((entry) => entry.value),
    [{ n: 1 }, { n: 2 }],
  );
  assert.equal(first.truncated, true);
  assert.ok(first.nextCursor);

  const second = readNativeHistory(reference(path), 'host-1', {
    cursor: first.nextCursor ?? 0,
    limit: 2,
    maxBytes: 1024,
  });

  assert.equal(second.kind, 'available');

  if (second.kind === 'available') {
    assert.deepEqual(
      second.entries.map((entry) => entry.value),
      [{ n: 3 }],
    );
    assert.equal(second.nextCursor, null);
  }
});

test('native history rejects host mismatch, identifiers, links, and non-boundary cursors', (t) => {
  const created = mkdtempSync(join(tmpdir(), 'marionette-history-'));
  const root = realpathSync(created);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'session.jsonl');
  writeFileSync(path, '{"secret":true}\n', { mode: 0o600 });
  assert.equal(readNativeHistory(reference(path), 'host-2').kind, 'identity-unconfirmed');
  assert.equal(
    readNativeHistory(
      Schema.decodeUnknownSync(NativeSessionReferenceSchema)({ ...reference(path), kind: 'id' }),
      'host-1',
    ).kind,
    'unsupported',
  );
  assert.equal(readNativeHistory(reference(path), 'host-1', { cursor: 2 }).kind, 'unsafe-path');
  const linked = join(root, 'linked.jsonl');
  symlinkSync(path, linked);
  assert.equal(readNativeHistory(reference(linked), 'host-1').kind, 'unsafe-path');
  const malformed = join(root, 'malformed.jsonl');
  writeFileSync(malformed, '{not-json}\n', { mode: 0o600 });
  assert.deepEqual(readNativeHistory(reference(malformed), 'host-1'), {
    kind: 'malformed-history',
    reason: 'The native history contains an invalid JSONL record',
    offset: 0,
  });
});
