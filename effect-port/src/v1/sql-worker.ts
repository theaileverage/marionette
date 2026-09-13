import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { Schema } from "effect";

const finiteNumber = Schema.Number.check(Schema.isFinite());
const integer = Schema.Finite.check(
  Schema.makeFilter(Number.isInteger, { expected: "an integer" }),
);
const nonEmptyString = Schema.String.check(Schema.isMinLength(1));
const SqlValueSchema = Schema.Union([Schema.String, finiteNumber, Schema.Null]);
export type SqlValue = typeof SqlValueSchema.Type;
const SqlRowSchema = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, finiteNumber, Schema.Boolean, Schema.Null]),
);
export type SqlRow = typeof SqlRowSchema.Type;

const SqlRequestSchema = Schema.Struct({
  databasePath: nonEmptyString,
  projectId: nonEmptyString,
  sql: nonEmptyString,
  parameters: Schema.Record(Schema.String, SqlValueSchema),
  maxRows: integer.check(Schema.isGreaterThan(0)),
  maxBytes: integer.check(Schema.isGreaterThan(0)),
});
type SqlRequest = typeof SqlRequestSchema.Type;

const BoardPostKindSchema = Schema.Literals([
  "question",
  "blocker",
  "result",
  "finding",
  "decision",
  "progress",
]);
const BoardReferenceSchema = Schema.Struct({
  kind: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  value: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
});
const nullableUuid = Schema.Union([Schema.String.check(Schema.isUUID()), Schema.Null]);
export const ValidatedContributionSchema = Schema.Struct({
  body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536)),
  kind: BoardPostKindSchema,
  references: Schema.mutable(
    Schema.Array(BoardReferenceSchema).check(Schema.isMaxLength(50)),
  ),
  replyToPostId: nullableUuid,
  replacesPostId: nullableUuid,
});
export type ValidatedContribution = typeof ValidatedContributionSchema.Type;
const SqlContributionRequestSchema = Schema.Struct({
  sql: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384)),
  parameters: Schema.Record(Schema.String, SqlValueSchema).check(
    Schema.makeFilter(
      (parameters) => Object.keys(parameters).length <= 100,
      { expected: "at most 100 parameters" },
    ),
  ),
});
type SqlContributionRequest = typeof SqlContributionRequestSchema.Type;

const WorkerRequestSchema = Schema.Union([
  Schema.Struct({ ...SqlRequestSchema.fields, mode: Schema.Literal("read") }),
  Schema.Struct({ ...SqlContributionRequestSchema.fields, mode: Schema.Literal("contribute") }),
]);

export const SqlResponseSchema = Schema.Struct({
  rows: Schema.mutable(Schema.Array(SqlRowSchema)),
  truncated: Schema.Boolean,
  bytes: integer.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type SqlResponse = typeof SqlResponseSchema.Type;

const SQLITE_OK = 0;
const SQLITE_DENY = 1;
const SQLITE_READ = 20;
const SQLITE_SELECT = 21;
const SQLITE_FUNCTION = 31;
const SQLITE_RECURSIVE = 33;
const SQLITE_INSERT = 18;

const PUBLIC_VIEWS = new Set([
  "public_board_threads",
  "public_board_posts",
  "public_agent_sessions",
  "public_jobs",
  "public_results",
  "public_notification_events",
]);

const SAFE_FUNCTIONS = new Set([
  "abs", "avg", "coalesce", "count", "group_concat", "ifnull", "instr", "length",
  "lower", "ltrim", "max", "min", "nullif", "printf", "replace", "round", "rtrim",
  "substr", "sum", "total", "trim", "typeof", "upper",
]);

type Authorizer = (
  actionCode: number,
  arg1: string | null,
  arg2: string | null,
  databaseName: string | null,
  source: string | null,
) => number;

function databaseMethod(database: DatabaseSync, name: string): (...args: ReadonlyArray<unknown>) => unknown {
  const method = Reflect.get(database, name);
  if (typeof method !== "function") {
    throw new Error("node:sqlite authorizer support is required for SQL queries");
  }
  return (...args) => Reflect.apply(method, database, args);
}

function secureDatabase(database: DatabaseSync): void {
  databaseMethod(database, "enableLoadExtension")(false);
  databaseMethod(database, "enableDefensive")(true);
}

function setAuthorizer(database: DatabaseSync, authorizer: Authorizer): void {
  databaseMethod(database, "setAuthorizer")(authorizer);
}

function installAuthorizer(database: DatabaseSync, projectId: string): void {
  secureDatabase(database);
  database.function("marionette_project_id", () => projectId);
  setAuthorizer(database, (action, arg1, arg2, _database, source) => {
    if (action === SQLITE_SELECT || action === SQLITE_RECURSIVE) return SQLITE_OK;
    if (action === SQLITE_READ) {
      if ((source !== null && PUBLIC_VIEWS.has(source)) || (arg1 !== null && PUBLIC_VIEWS.has(arg1))) {
        return SQLITE_OK;
      }
      return SQLITE_DENY;
    }
    if (action === SQLITE_FUNCTION) {
      return arg2 !== null &&
          (arg2 === "marionette_project_id" || SAFE_FUNCTIONS.has(arg2.toLowerCase()))
        ? SQLITE_OK
        : SQLITE_DENY;
    }
    return SQLITE_DENY;
  });
}

function rejectMultipleStatements(sql: string): void {
  if (sql.includes(";")) {
    throw new Error("board contribution SQL must contain exactly one statement");
  }
}

function installContributionAuthorizer(database: DatabaseSync): void {
  secureDatabase(database);
  setAuthorizer(database, (action, arg1) =>
    action === SQLITE_INSERT && arg1 === "board_contributions" ? SQLITE_OK : SQLITE_DENY,
  );
}

function installContributionReadAuthorizer(database: DatabaseSync): void {
  setAuthorizer(database, (action, arg1) => {
    if (action === SQLITE_SELECT) return SQLITE_OK;
    if (action === SQLITE_READ && arg1 === "board_contributions") return SQLITE_OK;
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
      const object = Schema.decodeUnknownSync(SqlRowSchema)(row);
      const rowBytes = Buffer.byteLength(JSON.stringify(object), "utf8");
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

const ContributionRowSchema = Schema.Struct({
  body: Schema.String,
  kind: BoardPostKindSchema,
  references_json: Schema.String,
  reply_to_post_id: nullableUuid,
  replaces_post_id: nullableUuid,
});

export function executeContributionRequest(
  request: SqlContributionRequest,
): ValidatedContribution {
  rejectMultipleStatements(request.sql);
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
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
    if (Number(result.changes) !== 1) {
      throw new Error("board contribution SQL must insert exactly one row");
    }
    installContributionReadAuthorizer(database);
    const row = database
      .prepare(
        "SELECT body,kind,references_json,reply_to_post_id,replaces_post_id FROM board_contributions",
      )
      .get();
    const contribution = Schema.decodeUnknownSync(ContributionRowSchema)(row);
    return Schema.decodeSync(ValidatedContributionSchema)({
      body: contribution.body,
      kind: contribution.kind,
      references: Schema.decodeUnknownSync(
        Schema.mutable(Schema.Array(BoardReferenceSchema).check(Schema.isMaxLength(50))),
      )(JSON.parse(contribution.references_json)),
      replyToPostId: contribution.reply_to_post_id,
      replacesPostId: contribution.replaces_post_id,
    });
  } finally {
    database.close();
  }
}

function main(): void {
  try {
    const request = Schema.decodeUnknownSync(WorkerRequestSchema)(
      JSON.parse(readFileSync(0, "utf8")),
    );
    const response = request.mode === "read"
      ? { kind: "read", result: executeSqlRequest(request) }
      : { kind: "contribution", result: executeContributionRequest(request) };
    process.stdout.write(JSON.stringify({ ok: true, response }));
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    process.exitCode = 1;
  }
}

if (process.argv.includes("--marionette-sql-worker")) main();
