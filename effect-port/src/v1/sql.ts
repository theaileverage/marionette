import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Effect, Schema } from "effect";

import type { Board, BoardAuthor, BoardPost, BoardPostKind } from "./board.js";

const finiteNumber = Schema.Number.check(Schema.isFinite());
const integer = Schema.Finite.check(
  Schema.makeFilter(Number.isInteger, { expected: "an integer" }),
);
const SqlValueSchema = Schema.Union([Schema.String, finiteNumber, Schema.Null]);
export type SqlValue = typeof SqlValueSchema.Type;
const SqlRowSchema = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, finiteNumber, Schema.Boolean, Schema.Null]),
);
export type SqlRow = typeof SqlRowSchema.Type;

export interface SqlRead {
  readonly sql: string;
  readonly parameters?: Readonly<Record<string, SqlValue>>;
  readonly timeoutMs?: number;
  readonly maxRows?: number;
  readonly maxBytes?: number;
}

export interface SqlReadResult {
  readonly rows: readonly SqlRow[];
  readonly truncated: boolean;
  readonly bytes: number;
}

export interface SqlBoardContribution {
  readonly threadId: string;
  readonly author: BoardAuthor;
  readonly kind: BoardPostKind;
  readonly idempotencyKey: string;
  readonly sql: string;
  readonly parameters?: Readonly<Record<string, SqlValue>>;
  readonly timeoutMs?: number;
}

export interface SqlQueryServiceOptions {
  readonly board: Board;
  readonly workerPath?: string;
}

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_ROWS = 100;
const DEFAULT_MAX_BYTES = 256 * 1024;
const MAX_TIMEOUT_MS = 10_000;
const MAX_ROWS = 1_000;
const MAX_BYTES = 1_000_000;
const MAX_PROTOCOL_BYTES = 2_000_000;

function bounded(name: string, value: number | undefined, fallback: number, maximum: number) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1 || result > maximum) {
    throw new Error(`${name} must be an integer from 1 through ${maximum}`);
  }
  return result;
}

function defaultWorkerPath() {
  return fileURLToPath(
    new URL(import.meta.url.endsWith(".ts") ? "./sql-worker.ts" : "./sql-worker.js", import.meta.url),
  );
}

function nodeRuntime() {
  if (process.versions.bun !== undefined) {
    throw new Error("SQL queries require the Node runtime with node:sqlite");
  }
  const [major = 0, minor = 0, patch = 0] = process.versions.node.split(".").map(Number);
  if (!(major > 26 || (major === 26 && (minor > 8 || (minor === 8 && patch >= 1))))) {
    throw new Error("SQL queries require Node 26.8.1 or newer");
  }
  return process.execPath;
}

const BoardReferenceSchema = Schema.Struct({
  kind: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  value: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
});
const BoardPostKindSchema = Schema.Literals([
  "question", "blocker", "result", "finding", "decision", "progress",
]);
const nullableUuid = Schema.Union([Schema.String.check(Schema.isUUID()), Schema.Null]);
const ContributionResultSchema = Schema.Struct({
  body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536)),
  kind: BoardPostKindSchema,
  references: Schema.mutable(
    Schema.Array(BoardReferenceSchema).check(Schema.isMaxLength(50)),
  ),
  replyToPostId: nullableUuid,
  replacesPostId: nullableUuid,
});
const WorkerResponseSchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    response: Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("read"),
        result: Schema.Struct({
          rows: Schema.mutable(Schema.Array(SqlRowSchema)),
          truncated: Schema.Boolean,
          bytes: integer.check(Schema.isGreaterThanOrEqualTo(0)),
        }),
      }),
      Schema.Struct({ kind: Schema.Literal("contribution"), result: ContributionResultSchema }),
    ]),
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String.check(Schema.isMinLength(1)) }),
]);
type WorkerEnvelope = typeof WorkerResponseSchema.Type;
type WorkerResponse = Extract<WorkerEnvelope, { readonly ok: true }>["response"];

export class SqlQueryError extends Schema.TaggedError<SqlQueryError>()("SqlQueryError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const sqlError = (message: string): SqlQueryError => new SqlQueryError({ message });

function parseResponse(raw: string): WorkerResponse {
  const value = Schema.decodeUnknownSync(WorkerResponseSchema)(JSON.parse(raw));
  if (!value.ok) throw sqlError(value.error);
  return value.response;
}

function errorFromUnknown(error: unknown): SqlQueryError {
  if (error instanceof SqlQueryError) return error;
  return error instanceof Error
    ? new SqlQueryError({ message: error.message, cause: error })
    : new SqlQueryError({ message: String(error), cause: error });
}

function stopChild(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

const awaitWorker = Effect.fn("SqlQueryService.awaitWorker")(
  function*(child: ChildProcessWithoutNullStreams, timeoutMs: number) {
    return yield* Effect.callback<WorkerResponse, SqlQueryError>((resume) => {
      let stdout = "";
      let stderr = "";
      let settled = false;

      const cleanup = () => {
        clearTimeout(deadline);
        child.stdout.off("data", onStdout);
        child.stderr.off("data", onStderr);
        child.off("error", onError);
        child.off("close", onClose);
      };
      const finish = (effect: Effect.Effect<WorkerResponse, SqlQueryError>) => {
        if (settled) return;
        settled = true;
        cleanup();
        resume(effect);
      };
      const onStdout = (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (Buffer.byteLength(stdout, "utf8") > MAX_PROTOCOL_BYTES) {
          stopChild(child);
          finish(Effect.fail(sqlError("SQL worker exceeded the protocol output limit")));
        }
      };
      const onStderr = (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      };
      const onError = (error: Error) => finish(Effect.fail(errorFromUnknown(error)));
      const onClose = (code: number | null) => {
        if (code !== 0) {
          try {
            parseResponse(stdout);
            finish(Effect.fail(sqlError(stderr || `SQL worker exited with ${code}`)));
          } catch (error) {
            finish(Effect.fail(errorFromUnknown(error)));
          }
          return;
        }
        try {
          finish(Effect.succeed(parseResponse(stdout)));
        } catch (error) {
          finish(Effect.fail(errorFromUnknown(error)));
        }
      };
      const deadline = setTimeout(() => {
        stopChild(child);
        finish(Effect.fail(sqlError(`SQL query exceeded ${timeoutMs}ms`)));
      }, timeoutMs);

      child.stdout.on("data", onStdout);
      child.stderr.on("data", onStderr);
      child.on("error", onError);
      child.on("close", onClose);

      return Effect.sync(() => {
        settled = true;
        cleanup();
      });
    });
  },
);

const runWorkerEffect = Effect.fn("SqlQueryService.runWorker")(
  function*(workerPath: string, request: string, timeoutMs: number) {
    const child = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          spawn(
            nodeRuntime(),
            ["--experimental-strip-types", workerPath, "--marionette-sql-worker"],
            { stdio: ["pipe", "pipe", "pipe"] },
          ),
        catch: errorFromUnknown,
      }),
      (processHandle) => Effect.sync(() => stopChild(processHandle)),
    );
    yield* Effect.sync(() => child.stdin.end(request));
    return yield* awaitWorker(child, timeoutMs);
  },
);

export class SqlQueryService {
  readonly #board: Board;
  readonly #workerPath: string;

  constructor(options: SqlQueryServiceOptions) {
    this.#board = options.board;
    this.#workerPath = options.workerPath ?? defaultWorkerPath();
  }

  readEffect(input: SqlRead): Effect.Effect<SqlReadResult, SqlQueryError> {
    const timeoutMs = bounded("timeoutMs", input.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const maxRows = bounded("maxRows", input.maxRows, DEFAULT_MAX_ROWS, MAX_ROWS);
    const maxBytes = bounded("maxBytes", input.maxBytes, DEFAULT_MAX_BYTES, MAX_BYTES);
    if (input.sql.trim().length === 0) throw new Error("sql must not be empty");
    const request = JSON.stringify({
      mode: "read",
      databasePath: this.#board.databasePath,
      projectId: this.#board.project.id,
      sql: input.sql,
      parameters: input.parameters ?? {},
      maxRows,
      maxBytes,
    });
    return Effect.scoped(runWorkerEffect(this.#workerPath, request, timeoutMs)).pipe(
      Effect.flatMap((response) =>
        response.kind === "read"
          ? Effect.succeed(response.result)
          : Effect.fail(sqlError("SQL worker returned a contribution for a read request")),
      ),
    );
  }

  read(input: SqlRead): Promise<SqlReadResult> {
    return Effect.runPromise(this.readEffect(input));
  }

  contributeEffect(input: SqlBoardContribution): Effect.Effect<BoardPost, SqlQueryError> {
    const timeoutMs = bounded("timeoutMs", input.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    if (input.sql.trim().length === 0) throw new Error("contribution SQL must not be empty");
    if (Buffer.byteLength(input.sql, "utf8") > 16_384) {
      throw new Error("contribution SQL exceeds 16384 bytes");
    }
    const request = JSON.stringify({
      mode: "contribute",
      sql: input.sql,
      parameters: input.parameters ?? {},
    });
    return Effect.scoped(runWorkerEffect(this.#workerPath, request, timeoutMs)).pipe(
      Effect.flatMap((response) => {
        if (response.kind !== "contribution") {
          return Effect.fail(sqlError("SQL worker returned a read for a contribution request"));
        }
        const contribution = response.result;
        if (contribution.kind !== input.kind) {
          return Effect.fail(sqlError("contribution kind does not match the parent request"));
        }
        return Effect.try({
          try: () =>
            this.#board.post({
              threadId: input.threadId,
              author: input.author,
              body: contribution.body,
              kind: contribution.kind,
              idempotencyKey: input.idempotencyKey,
              references: contribution.references,
              replyToPostId: contribution.replyToPostId ?? undefined,
              replacesPostId: contribution.replacesPostId ?? undefined,
            }),
          catch: errorFromUnknown,
        });
      }),
    );
  }

  contribute(input: SqlBoardContribution): Promise<BoardPost> {
    return Effect.runPromise(this.contributeEffect(input));
  }
}
