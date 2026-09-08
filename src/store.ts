import { Effect, Schema } from 'effect';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import { types } from 'node:util';
import { now, type Event } from './types.js';

/** SQLite transactions are synchronous: never await inside a transaction. */
export class Store {
  db: Database;
  private transactionDepth = 0;
  constructor(public path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { strict: true });
    try {
      const version = Schema.decodeUnknownSync(Schema.Struct({ user_version: Schema.Finite }))(
        this.db.prepare('PRAGMA user_version').get(),
      ).user_version;
      if (version > 2) {
        throw new Error('State was written by a newer Marionette version; refusing to downgrade');
      }
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_project ON events(project_id,id);
      PRAGMA user_version=2;`);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind, id);
    return row
      ? JSON.parse(Schema.decodeUnknownSync(Schema.Struct({ data: Schema.String }))(row).data)
      : undefined;
  }
  all<T>(kind: string): T[] {
    return Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ data: Schema.String })))(
      this.db.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid').all(kind),
    ).map((r) => JSON.parse(r.data));
  }
  put<T>(kind: string, id: string, data: T) {
    this.db
      .prepare(
        'INSERT INTO records(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data',
      )
      .run(kind, id, JSON.stringify(data));
  }
  transaction<T>(fn: () => T): T {
    const depth = this.transactionDepth++;
    const savepoint = `nested_${depth}`;
    try {
      this.db.exec(depth ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
      const v = fn();
      if (types.isPromise(v) || Effect.isEffect(v))
        throw new TypeError('SQLite transactions require a synchronous result');
      this.db.exec(depth ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
      return v;
    } catch (e) {
      this.db.exec(depth ? `ROLLBACK TO SAVEPOINT ${savepoint}` : 'ROLLBACK');
      if (depth) this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      throw e;
    } finally {
      this.transactionDepth--;
    }
  }
  event<T>(projectId: string, type: string, message: string, taskId?: string, data?: T) {
    const event = { projectId, type, message, taskId, data, createdAt: now() };
    const r = this.db
      .prepare('INSERT INTO events(project_id,data) VALUES(?,?)')
      .run(projectId, JSON.stringify(event));
    return { ...event, id: Number(r.lastInsertRowid) };
  }
  events(projectId: string, after = 0, limit = 200): Event[] {
    return Schema.decodeUnknownSync(
      Schema.Array(Schema.Struct({ id: Schema.Finite, data: Schema.String })),
    )(
      this.db
        .prepare('SELECT id,data FROM events WHERE project_id=? AND id>? ORDER BY id LIMIT ?')
        .all(projectId, after, limit),
    ).map((r) => ({ ...JSON.parse(r.data), id: r.id }));
  }
  close() {
    this.db.close();
  }
}
