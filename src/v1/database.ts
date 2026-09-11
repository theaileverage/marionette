import { createHash } from 'node:crypto';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';

import { z } from 'zod';

import type { ProjectId } from './model.js';
import { migrations, type Migration } from './migrations/index.js';

const migrationRow = {
  version: 'version',
  name: 'name',
  checksum: 'checksum',
} as const;

export class MigrationError extends Error {
  constructor(
    readonly code: 'invalid-migrations' | 'newer-schema' | 'migration-history' | 'migration-failed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

export type OpenDatabaseOptions = {
  readOnly?: boolean;
  path: string;
  projectId: ProjectId;
  busyTimeoutMs?: number;
  migrationSet?: readonly Migration[];
};

export type MigrationRecord = {
  version: number;
  name: string;
  checksum: string;
};

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- This recursive encoder is the parser for arbitrary JSON input. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('Value is not JSON serializable');
    return encoded;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JSON numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Only plain objects are JSON serializable');
    }
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entry]) => `${canonicalJson(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  throw new TypeError('Value is not JSON serializable');
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */

export function payloadDigest<T>(value: T): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function requireMigrationSet(migrationSet: readonly Migration[]): void {
  for (let index = 0; index < migrationSet.length; index += 1) {
    const migration = migrationSet[index];
    const expectedVersion = index + 1;
    if (
      migration === undefined ||
      migration.version !== expectedVersion ||
      migration.name.length === 0 ||
      migration.sql.length === 0
    ) {
      throw new MigrationError(
        'invalid-migrations',
        `Migration ${expectedVersion} is missing or invalid`,
      );
    }
  }
}

export function migrationChecksum(migration: Migration): string {
  return createHash('sha256')
    .update(migration.name)
    .update('\0')
    .update(migration.sql)
    .digest('hex');
}

function readInteger(value: SQLOutputValue | undefined, field: string): number {
  const parsed = z.number().int().nonnegative().safeParse(value);
  if (!parsed.success) {
    throw new MigrationError('migration-history', `Invalid ${field} in migration metadata`);
  }
  return parsed.data;
}

function readText(value: SQLOutputValue | undefined, field: string): string {
  const parsed = z.string().safeParse(value);
  if (!parsed.success) {
    throw new MigrationError('migration-history', `Invalid ${field} in migration metadata`);
  }
  return parsed.data;
}

function currentVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA user_version').get();
  return readInteger(row?.user_version, 'user_version');
}

function migrationHistory(database: DatabaseSync): MigrationRecord[] {
  const rows = database
    .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
    .all();
  return rows.map((row) => ({
    version: readInteger(row[migrationRow.version], 'version'),
    name: readText(row[migrationRow.name], 'name'),
    checksum: readText(row[migrationRow.checksum], 'checksum'),
  }));
}

function verifyHistory(
  database: DatabaseSync,
  migrationSet: readonly Migration[],
  version: number,
): void {
  const history = migrationHistory(database);
  if (history.length !== version) {
    throw new MigrationError(
      'migration-history',
      `Schema version ${version} has ${history.length} migration journal entries`,
    );
  }
  for (let index = 0; index < history.length; index += 1) {
    const record = history[index];
    const migration = migrationSet[index];
    if (record === undefined || migration === undefined || record.version !== migration.version) {
      throw new MigrationError(
        'migration-history',
        `Migration journal is not contiguous at ${index + 1}`,
      );
    }
    if (record.name !== migration.name || record.checksum !== migrationChecksum(migration)) {
      throw new MigrationError(
        'migration-history',
        `Migration ${record.version} does not match the installed source`,
      );
    }
  }
}

function rollback(database: DatabaseSync): void {
  if (database.isTransaction) database.exec('ROLLBACK');
}

export function applyMigrations(
  database: DatabaseSync,
  migrationSet: readonly Migration[] = migrations,
  now: () => string = () => new Date().toISOString(),
): number {
  requireMigrationSet(migrationSet);
  const newestVersion = migrationSet.length;

  while (true) {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY CHECK (version >= 1),
          name TEXT NOT NULL UNIQUE,
          checksum TEXT NOT NULL,
          applied_at TEXT NOT NULL
        ) STRICT
      `);
      const version = currentVersion(database);
      if (version > newestVersion) {
        throw new MigrationError(
          'newer-schema',
          `Database schema ${version} is newer than supported schema ${newestVersion}`,
        );
      }
      verifyHistory(database, migrationSet, version);
      if (version === newestVersion) {
        database.exec('COMMIT');
        return version;
      }

      const migration = migrationSet[version];
      if (migration === undefined) {
        throw new MigrationError('invalid-migrations', `Migration ${version + 1} is missing`);
      }
      try {
        database.exec(migration.sql);
      } catch (error) {
        throw new MigrationError(
          'migration-failed',
          `Migration ${migration.version} (${migration.name}) failed`,
          { cause: error },
        );
      }
      database
        .prepare(
          `INSERT INTO schema_migrations (version, name, checksum, applied_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(migration.version, migration.name, migrationChecksum(migration), now());
      database.exec(`PRAGMA user_version = ${migration.version}`);
      database.exec('COMMIT');
    } catch (error) {
      rollback(database);
      throw error;
    }
  }
}

export function openDatabase(options: OpenDatabaseOptions): DatabaseSync {
  const database = new DatabaseSync(options.path, {
    readOnly: options.readOnly ?? false,
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    timeout: options.busyTimeoutMs ?? 5_000,
  });
  try {
    database.function('marionette_project_id', { deterministic: true }, () => options.projectId);
    if (options.readOnly) {
      const migrationSet = options.migrationSet ?? migrations;
      requireMigrationSet(migrationSet);
      const version = currentVersion(database);
      if (version !== migrationSet.length)
        throw new MigrationError(
          'migration-history',
          'Preview requires the current schema; open the project normally to migrate it first.',
        );
      verifyHistory(database, migrationSet, version);
      return database;
    }
    const deadline = performance.now() + (options.busyTimeoutMs ?? 5_000);
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (;;) {
      try {
        database.exec('PRAGMA journal_mode = WAL');
        break;
      } catch (error) {
        const failure = z.object({ errcode: z.number().int() }).safeParse(error);
        if (!failure.success || (failure.data.errcode & 255) !== 5 || performance.now() >= deadline)
          throw error;
        Atomics.wait(pause, 0, 0, Math.min(10, Math.max(0, deadline - performance.now())));
      }
    }
    database.exec('PRAGMA synchronous = FULL');
    database.exec('PRAGMA foreign_keys = ON');
    applyMigrations(database, options.migrationSet ?? migrations);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
