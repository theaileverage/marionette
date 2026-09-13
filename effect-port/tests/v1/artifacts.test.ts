import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ArtifactFiles } from '../../src/v1/artifacts.js';

test('input snapshots survive source edits and detect damaged durable bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-v1-artifacts-'));
  try {
    const source = join(root, 'brief.md');
    writeFileSync(source, 'original instructions');
    const files = new ArtifactFiles(root);
    const artifact = files.snapshot(source, { mediaType: 'text/markdown' });
    writeFileSync(source, 'changed instructions');
    assert.equal(files.read(artifact).toString(), 'original instructions');
    assert.deepEqual(files.put(Buffer.from('original instructions'), 'text/markdown'), artifact);
    chmodSync(files.path(artifact), 0o600);
    writeFileSync(files.path(artifact), 'damaged');
    assert.throws(() => files.read(artifact), /integrity check failed/);
    assert.throws(() => files.put(Buffer.from('original instructions')), /integrity check failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
