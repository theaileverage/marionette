import { Database } from 'bun:sqlite';
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

test('Bun SQLite opens the existing version 2 records and preserves rollback across restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-bun-store-'));
  const path = join(root, 'state.sqlite');
  // This is the pre-migration on-disk contract, created independently of Store initialization.
  const original = new Database(path);
  original.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    CREATE TABLE records (kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT NOT NULL,data TEXT NOT NULL);
    CREATE INDEX events_project ON events(project_id,id);
    PRAGMA user_version=2;
  `);
  original
    .prepare('INSERT INTO records(kind,id,data) VALUES(?,?,?)')
    .run('lease', 'project', JSON.stringify({ epoch: 7, tokenHash: 'retained-private-hash' }));
  original
    .prepare('INSERT INTO events(project_id,data) VALUES(?,?)')
    .run('project', JSON.stringify({ type: 'original', message: 'Pre-migration event' }));
  original.close();
  try {
    const first = new Store(path);
    try {
      assert.ok(first.db instanceof Database);
      assert.deepEqual(first.get('lease', 'project'), {
        epoch: 7,
        tokenHash: 'retained-private-hash',
      });
      assert.deepEqual(first.db.prepare('PRAGMA user_version').get(), { user_version: 2 });
      assert.deepEqual(first.db.prepare('PRAGMA journal_mode').get(), { journal_mode: 'wal' });
      assert.deepEqual(first.db.prepare('PRAGMA synchronous').get(), { synchronous: 2 });
      assert.throws(
        () =>
          first.transaction(() => {
            first.put('lease', 'project', { epoch: 8, tokenHash: 'must-rollback' });
            first.event('project', 'rollback', 'Must not persist');
            throw new Error('abort transaction');
          }),
        /abort transaction/,
      );
      first.transaction(() => first.put('receipt', 'worker', { revision: 4, summary: 'retained' }));
      assert.equal(first.event('project', 'committed', 'Monotonic cursor').id, 2);
    } finally {
      first.close();
    }
    const restarted = new Store(path);
    try {
      assert.deepEqual(restarted.get('lease', 'project'), {
        epoch: 7,
        tokenHash: 'retained-private-hash',
      });
      assert.deepEqual(restarted.get('receipt', 'worker'), { revision: 4, summary: 'retained' });
      assert.deepEqual(
        restarted.events('project').map((event) => event.type),
        ['original', 'committed'],
      );
    } finally {
      restarted.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Bun SQLite refuses a future state version without changing its contents', () => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-bun-version-'));
  const path = join(root, 'state.sqlite');
  const original = new Database(path);
  original.exec(
    "PRAGMA user_version=3; CREATE TABLE future (value TEXT); INSERT INTO future VALUES ('retained');",
  );
  original.close();
  try {
    assert.throws(() => new Store(path), /newer Marionette version/);
    const reopened = new Database(path);
    try {
      assert.deepEqual(reopened.prepare('PRAGMA user_version').get(), { user_version: 3 });
      assert.deepEqual(reopened.prepare('SELECT value FROM future').get(), { value: 'retained' });
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
