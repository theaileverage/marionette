import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { Deferred, Effect, Fiber } from 'effect';

import {
  applyMigrations as applyBaselineMigrations,
  canonicalJson as baselineCanonicalJson,
  MigrationError as BaselineMigrationError,
  migrationChecksum as baselineMigrationChecksum,
  openDatabase as openBaselineDatabase,
  payloadDigest as baselinePayloadDigest,
} from '../../src/v1/database.js';
import { ProjectIdSchema } from '../../src/v1/model.js';
import { migrations as baselineMigrations } from '../../src/v1/migrations/index.js';
import {
  applyMigrations,
  canonicalJson,
  DatabaseOperationError,
  layer,
  MigrationError,
  migrationChecksum,
  openDatabase,
  payloadDigest,
  Service,
} from '../src/v1/database.js';
import { migrations } from '../src/v1/migrations/index.js';

const projectId = 'project_database_parity';
const baselineProjectId = ProjectIdSchema.parse(projectId);

type Fixture = {
  readonly directory: string;
  readonly baselinePath: string;
  readonly portPath: string;
};

function fixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'marionette-effect-database-'));
  return {
    directory,
    baselinePath: join(directory, 'baseline.sqlite'),
    portPath: join(directory, 'port.sqlite'),
  };
}

function journal(database: DatabaseSync): readonly unknown[] {
  return database
    .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
    .all();
}

function databaseState(database: DatabaseSync) {
  return {
    version: database.prepare('PRAGMA user_version').get()?.user_version,
    journalMode: database.prepare('PRAGMA journal_mode').get()?.journal_mode,
    synchronous: database.prepare('PRAGMA synchronous').get()?.synchronous,
    foreignKeys: database.prepare('PRAGMA foreign_keys').get()?.foreign_keys,
    journal: journal(database),
  };
}

/**
 * The port adds migration 007 (native-session references) beyond the legacy
 * baseline's 006_board_inbox. Parity means the port's schema history retains
 * the baseline prefix unchanged and only extends past it, not byte-identity.
 */
function assertAdditiveMigrationParity(port: DatabaseSync, baseline: DatabaseSync): void {
  const portState = databaseState(port);
  const baselineState = databaseState(baseline);
  assert.deepEqual(
    {
      ...portState,
      version: baselineState.version,
      journal: portState.journal.slice(0, baselineState.journal.length),
    },
    baselineState,
  );
  assert.equal(portState.version, migrations.length);
  assert.equal(portState.journal.length, migrations.length);
}

function errorResult(encode: (value: unknown) => string, value: unknown): object {
  try {
    return { kind: 'success', value: encode(value) };
  } catch (error) {
    return {
      kind: 'failure',
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

test('canonical JSON and payload digests match the baseline on edge cases', () => {
  const nullPrototype = Object.assign(Object.create(null), { zeta: 1, alpha: 'first' });
  const supported: readonly unknown[] = [
    null,
    false,
    true,
    '',
    'line\nquote"',
    0,
    -0,
    1.25,
    Number.MAX_SAFE_INTEGER + 1,
    [],
    [3, { beta: 2, alpha: 1 }, null],
    { zeta: [2, 1], alpha: { nested: true } },
    nullPrototype,
  ];

  for (const value of supported) {
    assert.equal(canonicalJson(value), baselineCanonicalJson(value));
    assert.equal(payloadDigest(value), baselinePayloadDigest(value));
  }

  const unsupported: readonly unknown[] = [
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1n,
    Symbol('unsupported'),
    () => undefined,
    new Date(0),
    { nested: undefined },
  ];
  for (const value of unsupported) {
    assert.deepEqual(errorResult(canonicalJson, value), errorResult(baselineCanonicalJson, value));
  }
});

test('migration sources and checksums preserve the baseline prefix', () => {
  assert.deepEqual(migrations.slice(0, baselineMigrations.length), baselineMigrations);
  assert.deepEqual(
    migrations.slice(0, baselineMigrations.length).map(migrationChecksum),
    baselineMigrations.map(baselineMigrationChecksum),
  );
});

test('real SQLite open, migration, pragmas, close, and reopen match the baseline', () => {
  const current = fixture();
  try {
    const baseline = openBaselineDatabase({
      path: current.baselinePath,
      projectId: baselineProjectId,
    });
    const port = openDatabase({ path: current.portPath, projectId });
    assertAdditiveMigrationParity(port, baseline);
    assert.equal(port.prepare('SELECT marionette_project_id() AS id').get()?.id, projectId);
    baseline.close();
    port.close();

    const baselineReopened = openBaselineDatabase({
      path: current.baselinePath,
      projectId: baselineProjectId,
    });
    const portReopened = openDatabase({ path: current.portPath, projectId });
    assertAdditiveMigrationParity(portReopened, baselineReopened);
    baselineReopened.close();
    portReopened.close();
  } finally {
    rmSync(current.directory, { recursive: true, force: true });
  }
});

test('explicit undefined database options retain baseline omission semantics', () => {
  const current = fixture();
  try {
    const baseline = openBaselineDatabase({
      path: current.baselinePath,
      projectId: baselineProjectId,
      readOnly: undefined,
      busyTimeoutMs: undefined,
      migrationSet: undefined,
    });
    const port = openDatabase({
      path: current.portPath,
      projectId,
      readOnly: undefined,
      busyTimeoutMs: undefined,
      migrationSet: undefined,
    });
    assertAdditiveMigrationParity(port, baseline);
    baseline.close();
    port.close();
  } finally {
    rmSync(current.directory, { recursive: true, force: true });
  }
});

test('read-only current-schema checks match and do not modify the database', () => {
  const current = fixture();
  try {
    openBaselineDatabase({
      path: current.baselinePath,
      projectId: baselineProjectId,
    }).close();
    openDatabase({ path: current.portPath, projectId }).close();
    const baselineBefore = readFileSync(current.baselinePath);
    const portBefore = readFileSync(current.portPath);

    const baseline = openBaselineDatabase({
      path: current.baselinePath,
      projectId: baselineProjectId,
      readOnly: true,
    });
    const port = openDatabase({ path: current.portPath, projectId, readOnly: true });
    assert.deepEqual(journal(port).slice(0, baselineMigrations.length), journal(baseline));
    assert.equal(journal(port).length, migrations.length);
    assert.throws(() => baseline.exec('CREATE TABLE forbidden (id TEXT)'), /readonly/i);
    assert.throws(() => port.exec('CREATE TABLE forbidden (id TEXT)'), /readonly/i);
    baseline.close();
    port.close();

    assert.deepEqual(readFileSync(current.baselinePath), baselineBefore);
    assert.deepEqual(readFileSync(current.portPath), portBefore);
  } finally {
    rmSync(current.directory, { recursive: true, force: true });
  }
});

test('checksum tampering is rejected with the compatibility error API', () => {
  const current = fixture();
  try {
    const baseline = openBaselineDatabase({
      path: current.baselinePath,
      projectId: baselineProjectId,
    });
    const port = openDatabase({ path: current.portPath, projectId });
    baseline
      .prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 2')
      .run('0'.repeat(64));
    port.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 2').run('0'.repeat(64));
    baseline.close();
    port.close();

    assert.throws(
      () => openBaselineDatabase({ path: current.baselinePath, projectId: baselineProjectId }),
      (error) => error instanceof BaselineMigrationError && error.code === 'migration-history',
    );
    assert.throws(
      () => openDatabase({ path: current.portPath, projectId }),
      (error) => error instanceof MigrationError && error.code === 'migration-history',
    );
  } finally {
    rmSync(current.directory, { recursive: true, force: true });
  }
});

test('failed migrations roll back schema, version, and history, then reopen cleanly', () => {
  const current = fixture();
  try {
    const baseline = openBaselineDatabase({
      path: current.baselinePath,
      projectId: baselineProjectId,
    });
    const port = openDatabase({ path: current.portPath, projectId });
    const brokenBaselineMigrations = [
      ...baselineMigrations,
      {
        version: baselineMigrations.length + 1,
        name: '006_broken',
        sql: 'CREATE TABLE should_rollback (id TEXT PRIMARY KEY) STRICT; SELECT * FROM missing_table;',
      },
    ];
    const brokenMigrations = [
      ...migrations,
      {
        version: migrations.length + 1,
        name: '006_broken',
        sql: 'CREATE TABLE should_rollback (id TEXT PRIMARY KEY) STRICT; SELECT * FROM missing_table;',
      },
    ];

    assert.throws(
      () => applyBaselineMigrations(baseline, brokenBaselineMigrations),
      (error) => error instanceof BaselineMigrationError && error.code === 'migration-failed',
    );
    assert.throws(
      () => applyMigrations(port, brokenMigrations),
      (error) => error instanceof MigrationError && error.code === 'migration-failed',
    );
    assertAdditiveMigrationParity(port, baseline);
    assert.equal(
      port
        .prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'should_rollback'")
        .get()?.count,
      0,
    );
    baseline.close();
    port.close();

    const reopened = openDatabase({ path: current.portPath, projectId });
    assert.equal(reopened.prepare('PRAGMA user_version').get()?.user_version, migrations.length);
    assert.equal(reopened.isTransaction, false);
    reopened.close();
  } finally {
    rmSync(current.directory, { recursive: true, force: true });
  }
});

test('the scoped database layer closes on success', async () => {
  const current = fixture();
  try {
    const database = await Effect.runPromise(
      Service.use((service) => Effect.succeed(service.database)).pipe(
        Effect.provide(layer({ path: current.portPath, projectId })),
      ),
    );
    assert.equal(database.isOpen, false);
  } finally {
    rmSync(current.directory, { recursive: true, force: true });
  }
});

test('the scoped database layer closes deterministically on interruption', async () => {
  const current = fixture();
  try {
    const database = await Effect.runPromise(
      Effect.gen(function* () {
        const acquired = yield* Deferred.make<DatabaseSync>();
        const fiber = yield* Service.use((service) =>
          Deferred.succeed(acquired, service.database).pipe(Effect.andThen(Effect.never)),
        ).pipe(Effect.provide(layer({ path: current.portPath, projectId })), Effect.forkChild);
        const opened = yield* Deferred.await(acquired);
        yield* Fiber.interrupt(fiber);
        return opened;
      }),
    );
    assert.equal(database.isOpen, false);
  } finally {
    rmSync(current.directory, { recursive: true, force: true });
  }
});

test('service operations expose a named typed Effect error boundary', async () => {
  const current = fixture();
  try {
    const error = await Effect.runPromise(
      Service.use((service) =>
        service
          .execute('Database.testFailure', () => {
            throw new Error('expected test failure');
          })
          .pipe(Effect.flip),
      ).pipe(Effect.provide(layer({ path: current.portPath, projectId }))),
    );
    assert.equal(error instanceof DatabaseOperationError, true);
    assert.equal(error.operation, 'Database.testFailure');
  } finally {
    rmSync(current.directory, { recursive: true, force: true });
  }
});
