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

const BoardPostKindSchema = z.enum([
  'question',
  'blocker',
  'result',
  'finding',
  'decision',
  'progress',
]);
const BoardReferenceSchema = z.object({
  kind: z.string().min(1).max(255),
  value: z.string().min(1).max(4_096),
});
export const ValidatedContributionSchema = z.object({
  body: z.string().min(1).max(65_536),
  kind: BoardPostKindSchema,
  references: z.array(BoardReferenceSchema).max(50),
  replyToPostId: z.string().uuid().nullable(),
  replacesPostId: z.string().uuid().nullable(),
});
export type ValidatedContribution = z.infer<typeof ValidatedContributionSchema>;
const SqlContributionRequestSchema = z.object({
  sql: z.string().min(1).max(16_384),
  parameters: z
    .record(SqlValueSchema)
    .refine(
      (parameters) => Object.keys(parameters).length <= 100,
      'at most 100 parameters are allowed',
    ),
});
type SqlContributionRequest = z.infer<typeof SqlContributionRequestSchema>;

const WorkerRequestSchema = z.discriminatedUnion('mode', [
  SqlRequestSchema.extend({ mode: z.literal('read') }),
  SqlContributionRequestSchema.extend({ mode: z.literal('contribute') }),
]);

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
const SQLITE_INSERT = 18;

const PUBLIC_VIEWS = new Set([
  'public_board_threads',
  'public_board_posts',
  'public_agent_sessions',
  'public_jobs',
  'public_results',
  'public_notification_events',
  'public_board_inboxes',
  'public_watcher_owners',
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

function installAuthorizer(database: DatabaseSync, projectId: string) {
  if (!('setAuthorizer' in database) || !('enableDefensive' in database))
    throw new Error('node:sqlite authorizer support is required for SQL queries');
  // SAFETY: Node 26.8.1 exposes these methods, but the installed Node type declarations lag that runtime API.
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

function rejectMultipleStatements(sql: string) {
  if (sql.includes(';'))
    throw new Error('board contribution SQL must contain exactly one statement');
}

function installContributionAuthorizer(database: DatabaseSync) {
  if (!('setAuthorizer' in database))
    throw new Error('node:sqlite authorizer support is required for board contributions');
  // SAFETY: Node 26.8.1 exposes setAuthorizer, but the installed Node type declarations lag that runtime API.
  const authorizable = database as AuthorizableDatabase;
  authorizable.enableLoadExtension(false);
  authorizable.enableDefensive(true);
  authorizable.setAuthorizer((action, arg1) =>
    action === SQLITE_INSERT && arg1 === 'board_contributions' ? SQLITE_OK : SQLITE_DENY,
  );
}

function installContributionReadAuthorizer(database: DatabaseSync) {
  // SAFETY: This follows the authorizer capability check before executing the internal read.
  const authorizable = database as AuthorizableDatabase;
  authorizable.setAuthorizer((action, arg1) => {
    if (action === SQLITE_SELECT) return SQLITE_OK;
    if (action === SQLITE_READ && arg1 === 'board_contributions') return SQLITE_OK;
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

export function executeContributionRequest(request: SqlContributionRequest): ValidatedContribution {
  rejectMultipleStatements(request.sql);
  const database = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  try {
    database.exec(`
      CREATE TABLE board_contributions (
        body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 65536),
        kind TEXT NOT NULL CHECK (kind IN ('question','blocker','result','finding','decision','progress')),
        references_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(references_json)),
        reply_to_post_id TEXT,
        replaces_post_id TEXT
      ) STRICT
    `);
    installContributionAuthorizer(database);
    const result = database.prepare(request.sql).run(request.parameters);
    if (Number(result.changes) !== 1)
      throw new Error('board contribution SQL must insert exactly one row');
    installContributionReadAuthorizer(database);
    const row = database
      .prepare(
        'SELECT body,kind,references_json,reply_to_post_id,replaces_post_id FROM board_contributions',
      )
      .get();
    const contribution = z
      .object({
        body: z.string(),
        kind: BoardPostKindSchema,
        references_json: z.string(),
        reply_to_post_id: z.string().uuid().nullable(),
        replaces_post_id: z.string().uuid().nullable(),
      })
      .parse(row);
    return ValidatedContributionSchema.parse({
      body: contribution.body,
      kind: contribution.kind,
      references: z
        .array(BoardReferenceSchema)
        .max(50)
        .parse(JSON.parse(contribution.references_json)),
      replyToPostId: contribution.reply_to_post_id,
      replacesPostId: contribution.replaces_post_id,
    });
  } finally {
    database.close();
  }
}

function main() {
  try {
    const request = WorkerRequestSchema.parse(JSON.parse(readFileSync(0, 'utf8')));
    const response =
      request.mode === 'read'
        ? { kind: 'read', result: executeSqlRequest(request) }
        : { kind: 'contribution', result: executeContributionRequest(request) };
    process.stdout.write(JSON.stringify({ ok: true, response }));
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    process.exitCode = 1;
  }
}

if (process.argv.includes('--marionette-sql-worker')) main();
