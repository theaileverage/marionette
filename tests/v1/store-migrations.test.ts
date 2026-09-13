import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

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

const projectId = ProjectIdSchema.parse('project_migrations');

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
          [6, '006_service_events_controller'],
          [7, '007_harness_catalog_profiles'],
          [8, '008_workflow_control_plane'],
          [9, '009_decisions_approvals'],
          [10, '010_project_hierarchy'],
          [11, '011_controller_authority'],
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

  test('v5 upgrade preserves workflows as inactive and performs no external-effect claims', () => {
    const { directory, databasePath } = fixture();
    try {
      const previous = openDatabase({
        path: databasePath,
        projectId,
        migrationSet: migrations.slice(0, 5),
      });
      const now = new Date().toISOString();
      previous.exec('BEGIN');
      try {
        previous.prepare('INSERT INTO hosts VALUES (?,?)').run('host', now);
        previous
          .prepare('INSERT INTO projects VALUES (?,?,?,?,?)')
          .run(projectId, 'host', directory, directory, now);
        previous.prepare('INSERT INTO store_binding VALUES (1,?,?)').run(projectId, 'host');
        previous
          .prepare('INSERT INTO workspaces VALUES (?,?,?,?,?,?,?,?,?,?,?)')
          .run(
            'main',
            projectId,
            'host',
            'existing',
            directory,
            directory,
            null,
            'write',
            '["**"]',
            now,
            null,
          );
        previous
          .prepare('INSERT INTO workflow_packages VALUES (?,?,?,?,?,?)')
          .run(projectId, 'digest', 'legacy', '1', '{}', now);
        previous
          .prepare('INSERT INTO workflow_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(
            'workflow',
            projectId,
            'digest',
            null,
            'job',
            'step',
            'running',
            null,
            'all',
            1,
            1,
            1,
            1,
            2,
            1,
            1,
            1000,
            new Date(Date.now() + 60_000).toISOString(),
            now,
            now,
          );
        previous
          .prepare('INSERT INTO job_requests VALUES (?,?,?,?,?)')
          .run('request', projectId, '0'.repeat(64), '{}', now);
        previous
          .prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(
            'job',
            projectId,
            'legacy',
            'request',
            'brief',
            1,
            'main',
            'report',
            'workflow',
            'workflow',
            'step',
            'open',
            now,
            now,
          );
        previous
          .prepare('INSERT INTO brief_revisions VALUES (?,?,?,?,?,?,?,?)')
          .run('brief', projectId, 'job', 1, null, '{}', 'legacy', now);
        previous
          .prepare('INSERT INTO step_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(
            'step',
            projectId,
            'workflow',
            'job',
            'implementation',
            'implementation',
            1,
            'pending',
            1,
            1,
            null,
            now,
            now,
          );
        previous.exec('COMMIT');
      } catch (error) {
        previous.exec('ROLLBACK');
        throw error;
      }
      previous.close();

      const current = openDatabase({ path: databasePath, projectId });
      try {
        assert.equal(current.prepare('SELECT activated FROM workflow_runs').get()?.activated, 0);
        assert.equal(
          current.prepare('SELECT count(*) AS n FROM workflow_schedule_intents').get()?.n,
          0,
        );
        assert.equal(current.prepare('SELECT count(*) AS n FROM native_effects').get()?.n, 0);
        assert.equal(current.prepare('SELECT count(*) AS n FROM service_instances').get()?.n, 0);
      } finally {
        current.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
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
