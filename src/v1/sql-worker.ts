import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const SqlValueSchema = z.union([z.string(), z.number().finite(), z.null()]);
export type SqlValue = z.infer<typeof SqlValueSchema>;
const SqlRowSchema = z.record(z.union([z.string(), z.number().finite(), z.boolean(), z.null()]));
export type SqlRow = z.infer<typeof SqlRowSchema>;

const SqlRequestSchema = z.object({
  databasePath: z.string().min(1),
  projectId: z.string().min(1),
  sql: z.string().min(1),
  parameters: z.record(SqlValueSchema),
  maxRows: z.number().int().positive(),
  maxBytes: z.number().int().positive(),
});
type SqlRequest = z.infer<typeof SqlRequestSchema>;

export const SqlResponseSchema = z.object({
  rows: z.array(SqlRowSchema),
  truncated: z.boolean(),
  bytes: z.number().int().nonnegative(),
});
export type SqlResponse = z.infer<typeof SqlResponseSchema>;

interface AuthorizableDatabase extends DatabaseSync {
  setAuthorizer(
    callback: (
      actionCode: number,
      arg1: string | null,
      arg2: string | null,
      databaseName: string | null,
      source: string | null,
    ) => number,
  ): void;
  enableDefensive(enabled: boolean): void;
  enableLoadExtension(enabled: boolean): void;
}

const SQLITE_OK = 0;
const SQLITE_DENY = 1;
const SQLITE_READ = 20;
const SQLITE_SELECT = 21;
const SQLITE_FUNCTION = 31;
const SQLITE_RECURSIVE = 33;

const PUBLIC_VIEWS = new Set([
  'public_board_threads',
  'public_board_posts',
  'public_agent_sessions',
  'public_jobs',
  'public_results',
  'public_notification_events',
]);

const SAFE_FUNCTIONS = new Set([
  'abs',
  'avg',
  'coalesce',
  'count',
  'group_concat',
  'ifnull',
  'instr',
  'length',
  'lower',
  'ltrim',
  'max',
  'min',
  'nullif',
  'printf',
  'replace',
  'round',
  'rtrim',
  'substr',
  'sum',
  'total',
  'trim',
  'typeof',
  'upper',
]);

function parseRequest(input: string): SqlRequest {
  return SqlRequestSchema.parse(JSON.parse(input));
}

function installAuthorizer(database: DatabaseSync, projectId: string) {
  if (!('setAuthorizer' in database) || !('enableDefensive' in database))
    throw new Error('node:sqlite authorizer support is required for SQL queries');
  // SAFETY: Node 24.10 exposes these methods, but the installed Node type declarations lag that runtime API.
  const authorizable = database as AuthorizableDatabase;
  authorizable.enableLoadExtension(false);
  authorizable.enableDefensive(true);
  authorizable.function('marionette_project_id', () => projectId);
  authorizable.setAuthorizer((action, arg1, arg2, _database, source) => {
    if (action === SQLITE_SELECT || action === SQLITE_RECURSIVE) return SQLITE_OK;
    if (action === SQLITE_READ) {
      if (
        (source !== null && PUBLIC_VIEWS.has(source)) ||
        (arg1 !== null && PUBLIC_VIEWS.has(arg1))
      )
        return SQLITE_OK;
      return SQLITE_DENY;
    }
    if (action === SQLITE_FUNCTION) {
      return arg2 !== null &&
        (arg2 === 'marionette_project_id' || SAFE_FUNCTIONS.has(arg2.toLowerCase()))
        ? SQLITE_OK
        : SQLITE_DENY;
    }
    return SQLITE_DENY;
  });
}

export function executeSqlRequest(request: SqlRequest): SqlResponse {
  const database = new DatabaseSync(request.databasePath, {
    readOnly: true,
    enableForeignKeyConstraints: true,
  });
  try {
    installAuthorizer(database, request.projectId);
    const statement = database.prepare(request.sql);
    statement.setAllowBareNamedParameters(true);
    const rows: SqlRow[] = [];
    let bytes = 0;
    let truncated = false;
    for (const row of statement.iterate(request.parameters)) {
      const object = SqlRowSchema.parse(row);
      const rowBytes = Buffer.byteLength(JSON.stringify(object), 'utf8');
      if (rows.length === request.maxRows || bytes + rowBytes > request.maxBytes) {
        truncated = true;
        break;
      }
      rows.push(object);
      bytes += rowBytes;
    }
    return { rows, truncated, bytes };
  } finally {
    database.close();
  }
}

function main() {
  try {
    const response = executeSqlRequest(parseRequest(readFileSync(0, 'utf8')));
    process.stdout.write(JSON.stringify({ ok: true, response }));
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    process.exitCode = 1;
  }
}

if (process.argv.includes('--marionette-sql-worker')) main();
