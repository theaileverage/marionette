import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { Schema } from 'effect';

import { z } from 'zod';

import {
  applyMigrations,
  canonicalJson,
  MigrationError,
  openDatabase,
  payloadDigest,
} from '../../src/v1/database.js';
import { ProjectIdSchema } from '../../src/v1/model.js';
import { migrations } from '../../src/v1/migrations/index.js';
import { nativeSessionReferencesSql } from '../../src/v1/migrations/007_native_session_references.js';

const projectId = Schema.decodeUnknownSync(ProjectIdSchema)('project_migrations');

type MigrationFixture = { directory: string; databasePath: string };

function fixture(): MigrationFixture {
  const directory = mkdtempSync(join(tmpdir(), 'marionette-v1-migrations-'));
  return { directory, databasePath: join(directory, 'state.sqlite') };
}

function schemaVersion(database: DatabaseSync): number {
  return z
    .number()
    .int()
    .nonnegative()
    .parse(database.prepare('PRAGMA user_version').get()?.user_version);
}

function waitForWorker(worker: Worker): Promise<void> {
  return new Promise((resolve, reject) => {
    worker.once('message', (message) => {
      const parsed = z.literal('opened').safeParse(message);
      if (parsed.success) resolve();
      else reject(new Error(`Unexpected worker result ${String(message)}`));
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Migration worker exited with code ${code}`));
    });
  });
}

if (!isMainThread) {
  const input = z.object({ databasePath: z.string() }).parse(workerData);
  const database = openDatabase({ path: input.databasePath, projectId });
  database.close();
  if (parentPort === null) throw new Error('Migration worker has no parent port');
  parentPort.postMessage('opened');
} else {
  test('read-only opens reject pending migrations and cannot write current state', () => {
    const { directory, databasePath } = fixture();
    try {
      openDatabase({
        path: databasePath,
        projectId,
        migrationSet: migrations.slice(0, -1),
      }).close();
      const previous = readFileSync(databasePath);
      assert.throws(
        () => openDatabase({ path: databasePath, projectId, readOnly: true }),
        /current schema/,
      );
      assert.deepEqual(readFileSync(databasePath), previous);
      openDatabase({ path: databasePath, projectId }).close();
      const current = readFileSync(databasePath);
      const preview = openDatabase({ path: databasePath, projectId, readOnly: true });
      try {
        assert.equal(schemaVersion(preview), migrations.length);
        assert.throws(() => preview.exec('CREATE TABLE forbidden (id TEXT)'), /readonly/i);
      } finally {
        preview.close();
      }
      assert.deepEqual(readFileSync(databasePath), current);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test('applies numbered migrations once on a real database file', () => {
    const { directory, databasePath } = fixture();
    try {
      const first = openDatabase({ path: databasePath, projectId });
      assert.equal(schemaVersion(first), migrations.length);
      assert.deepEqual(
        first
          .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
          .all()
          .map((row) => [row.version, row.name]),
        [
          [1, '001_core'],
          [2, '002_workflows'],
          [3, '003_collaboration_handoff'],
          [4, '004_native_runtime'],
          [5, '005_artifact_media_type'],
          [6, '006_board_inbox'],
          [7, '007_native_session_references'],
        ],
      );
      first.close();

      const second = openDatabase({ path: databasePath, projectId });
      assert.equal(schemaVersion(second), migrations.length);
      assert.equal(
        second.prepare('SELECT count(*) AS count FROM schema_migrations').get()?.count,
        migrations.length,
      );
      second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('adds artifact media type without rewriting existing artifact records', () => {
    const { directory, databasePath } = fixture();
    try {
      const previous = openDatabase({
        path: databasePath,
        projectId,
        migrationSet: migrations.slice(0, 4),
      });
      previous.prepare('INSERT INTO hosts VALUES (?,?)').run('host', 'now');
      previous
        .prepare('INSERT INTO projects VALUES (?,?,?,?,?)')
        .run(projectId, 'host', directory, directory, 'now');
      previous
        .prepare('INSERT INTO artifacts VALUES (?,?,?,?,?,?,?)')
        .run('artifact', projectId, 'host', 'a'.repeat(64), '/durable/path', 7, 'now');
      previous.close();
      const current = openDatabase({ path: databasePath, projectId });
      try {
        const artifact = current
          .prepare('SELECT digest,path,byte_length,media_type FROM artifacts WHERE id=?')
          .get('artifact');
        assert.equal(artifact?.digest, 'a'.repeat(64));
        assert.equal(artifact?.path, '/durable/path');
        assert.equal(artifact?.byte_length, 7);
        assert.equal(artifact?.media_type, 'application/octet-stream');
      } finally {
        current.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('retains legacy notification history while seeding coalesced inbox state', () => {
    const { directory, databasePath } = fixture();
    try {
      const legacy = openDatabase({
        path: databasePath,
        projectId,
        migrationSet: migrations.slice(0, 5),
      });
      const timestamp = '2026-09-14T00:00:00.000Z';
      legacy.prepare('INSERT INTO hosts VALUES (?,?)').run('host', timestamp);
      legacy
        .prepare('INSERT INTO projects VALUES (?,?,?,?,?)')
        .run(projectId, 'host', directory, directory, timestamp);
      legacy
        .prepare('INSERT INTO board_threads VALUES (?,?,?,?,?,?,?,?,?)')
        .run(
          '00000000-0000-4000-8000-000000000001',
          projectId,
          null,
          'Legacy',
          'system',
          'controller',
          null,
          'thread',
          timestamp,
        );
      legacy
        .prepare('INSERT INTO board_posts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(
          '00000000-0000-4000-8000-000000000002',
          projectId,
          '00000000-0000-4000-8000-000000000001',
          1,
          'system',
          'controller',
          null,
          'question',
          'legacy post',
          null,
          null,
          'post',
          timestamp,
        );
      legacy
        .prepare('INSERT INTO board_subscriptions VALUES (?,?,?,?,?,?,?,?,?)')
        .run(
          '00000000-0000-4000-8000-000000000003',
          projectId,
          'desktop',
          'lead',
          null,
          '00000000-0000-4000-8000-000000000001',
          '["question"]',
          timestamp,
          null,
        );
      legacy
        .prepare('INSERT INTO notification_events VALUES (?,?,?,?,?,?)')
        .run(
          '00000000-0000-4000-8000-000000000004',
          projectId,
          '00000000-0000-4000-8000-000000000002',
          '00000000-0000-4000-8000-000000000003',
          'post',
          timestamp,
        );
      legacy
        .prepare(
          'INSERT INTO notification_deliveries(id,event_id,project_id,recipient_kind,recipient_id,recipient_generation,state,payload_json) VALUES(?,?,?,?,?,?,?,?)',
        )
        .run(
          '00000000-0000-4000-8000-000000000005',
          '00000000-0000-4000-8000-000000000004',
          projectId,
          'desktop',
          'lead',
          null,
          'pending',
          '{}',
        );
      for (const [suffix, recipientId, state] of [
        ['6', 'claimed-recipient', 'claimed'],
        ['7', 'unconfirmed-recipient', 'unconfirmed'],
        ['8', 'acknowledged-recipient', 'acknowledged'],
      ] as const) {
        const subscriptionId = `00000000-0000-4000-8000-0000000000${suffix}`;
        const eventId = `10000000-0000-4000-8000-0000000000${suffix}`;
        legacy
          .prepare('INSERT INTO board_subscriptions VALUES (?,?,?,?,?,?,?,?,?)')
          .run(
            subscriptionId,
            projectId,
            'desktop',
            recipientId,
            null,
            '00000000-0000-4000-8000-000000000001',
            '["question"]',
            timestamp,
            null,
          );
        legacy
          .prepare('INSERT INTO notification_events VALUES (?,?,?,?,?,?)')
          .run(
            eventId,
            projectId,
            '00000000-0000-4000-8000-000000000002',
            subscriptionId,
            `event-${state}`,
            timestamp,
          );
        legacy
          .prepare(
            'INSERT INTO notification_deliveries(id,event_id,project_id,recipient_kind,recipient_id,recipient_generation,state,payload_json) VALUES(?,?,?,?,?,?,?,?)',
          )
          .run(
            `20000000-0000-4000-8000-0000000000${suffix}`,
            eventId,
            projectId,
            'desktop',
            recipientId,
            null,
            state,
            '{}',
          );
      }
      legacy.close();

      const current = openDatabase({ path: databasePath, projectId });
      try {
        assert.equal(
          current.prepare('SELECT COUNT(*) AS count FROM notification_events').get()?.count,
          4,
        );
        assert.equal(
          current.prepare('SELECT COUNT(*) AS count FROM notification_deliveries').get()?.count,
          4,
        );
        const wake = current
          .prepare('SELECT state,wake_revision FROM board_subscription_wakes')
          .get();
        assert.equal(wake?.state, 'pending');
        assert.equal(wake?.wake_revision, 1);
        assert.deepEqual(
          current
            .prepare(
              "SELECT recipient_id,state FROM board_subscription_wakes WHERE recipient_id<>'lead' ORDER BY recipient_id",
            )
            .all()
            .map((row) => ({ ...row })),
          [
            { recipient_id: 'acknowledged-recipient', state: 'submitted' },
            { recipient_id: 'claimed-recipient', state: 'unconfirmed' },
            { recipient_id: 'unconfirmed-recipient', state: 'unconfirmed' },
          ],
        );
      } finally {
        current.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('migration 007 preserves legacy nativeSession bytes without inventing provenance', () => {
    const database = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
    try {
      database.exec(`
        CREATE TABLE projects(id TEXT PRIMARY KEY) STRICT;
        CREATE TABLE hosts(id TEXT PRIMARY KEY) STRICT;
        CREATE TABLE agent_sessions(id TEXT NOT NULL,generation INTEGER NOT NULL,PRIMARY KEY(id,generation)) STRICT;
        CREATE TABLE attempts(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,session_id TEXT NOT NULL,session_generation INTEGER NOT NULL,host_id TEXT NOT NULL,native_kind TEXT,native_server_generation TEXT,FOREIGN KEY(project_id) REFERENCES projects(id),FOREIGN KEY(host_id) REFERENCES hosts(id),FOREIGN KEY(session_id,session_generation) REFERENCES agent_sessions(id,generation)) STRICT;
        CREATE TABLE native_attempts(project_id TEXT NOT NULL,attempt_id TEXT NOT NULL,identity_json TEXT,updated_at TEXT NOT NULL) STRICT;
      `);
      database.prepare('INSERT INTO projects VALUES (?)').run('project');
      database.prepare('INSERT INTO hosts VALUES (?)').run('host');
      database.prepare('INSERT INTO agent_sessions VALUES (?,?)').run('session', 1);
      database
        .prepare('INSERT INTO attempts VALUES (?,?,?,?,?,?,?)')
        .run('attempt', 'project', 'session', 1, 'host', 'agy', 'server');
      database
        .prepare('INSERT INTO native_attempts VALUES (?,?,?,?)')
        .run(
          'project',
          'attempt',
          JSON.stringify({
            binding: { workspaceId: 'native-workspace' },
            tabId: 'tab',
            paneId: 'pane',
            terminalId: 'terminal',
            identityRevision: 3,
            nativeSession: '/exact/legacy/bytes',
          }),
          '2026-09-13T00:00:00.000Z',
        );
      database.exec(nativeSessionReferencesSql);
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(
            database
              .prepare(
                'SELECT harness,reference_kind,reference_value,source,status FROM native_session_reference_observations',
              )
              .get() ?? {},
          ),
        ),
        {
          harness: 'unknown',
          reference_kind: 'legacy',
          reference_value: '/exact/legacy/bytes',
          source: 'legacy-nativeSession',
          status: 'legacy-untyped',
        },
      );
    } finally {
      database.close();
    }
  });

  test('refuses a database created by a newer schema', () => {
    const { directory, databasePath } = fixture();
    try {
      const database = new DatabaseSync(databasePath);
      database.exec(`PRAGMA user_version = ${migrations.length + 1}`);
      database.close();

      assert.throws(
        () => openDatabase({ path: databasePath, projectId }),
        (error) => error instanceof MigrationError && error.code === 'newer-schema',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('refuses checksum drift in an applied migration', () => {
    const { directory, databasePath } = fixture();
    try {
      const database = openDatabase({ path: databasePath, projectId });
      database
        .prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 2')
        .run('0'.repeat(64));
      database.close();

      assert.throws(
        () => openDatabase({ path: databasePath, projectId }),
        (error) => error instanceof MigrationError && error.code === 'migration-history',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('rolls back a failed migration without advancing its journal', () => {
    const { directory, databasePath } = fixture();
    try {
      const database = openDatabase({ path: databasePath, projectId });
      const brokenMigrations = [
        ...migrations,
        {
          version: migrations.length + 1,
          name: `${String(migrations.length + 1).padStart(3, '0')}_broken`,
          sql: 'CREATE TABLE should_rollback (id TEXT PRIMARY KEY) STRICT; SELECT * FROM missing_table;',
        },
      ];
      assert.throws(
        () => applyMigrations(database, brokenMigrations),
        (error) => error instanceof MigrationError && error.code === 'migration-failed',
      );
      assert.equal(schemaVersion(database), migrations.length);
      assert.equal(
        database
          .prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'should_rollback'")
          .get()?.count,
        0,
      );
      assert.equal(
        database.prepare('SELECT count(*) AS count FROM schema_migrations').get()?.count,
        migrations.length,
      );
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('serializes concurrent first opens and records each migration once', async () => {
    const { directory, databasePath } = fixture();
    try {
      const workers = [
        new Worker(new URL(import.meta.url), { workerData: { databasePath } }),
        new Worker(new URL(import.meta.url), { workerData: { databasePath } }),
      ];
      await Promise.all(workers.map(waitForWorker));

      const database = openDatabase({ path: databasePath, projectId });
      assert.equal(schemaVersion(database), migrations.length);
      assert.equal(
        database.prepare('SELECT count(*) AS count FROM schema_migrations').get()?.count,
        migrations.length,
      );
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('canonical payloads ignore object key order and reject unsupported values', () => {
    assert.equal(canonicalJson({ beta: 2, alpha: 1 }), '{"alpha":1,"beta":2}');
    assert.equal(payloadDigest({ alpha: 1, beta: 2 }), payloadDigest({ beta: 2, alpha: 1 }));
    assert.throws(() => canonicalJson({ value: undefined }), TypeError);
  });
}
