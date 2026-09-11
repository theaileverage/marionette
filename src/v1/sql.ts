import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Board, BoardAuthor, BoardPost } from './board.js';
import { z } from 'zod';

const SqlValueSchema = z.union([z.string(), z.number().finite(), z.null()]);
export type SqlValue = z.infer<typeof SqlValueSchema>;
const SqlRowSchema = z.record(z.union([z.string(), z.number().finite(), z.boolean(), z.null()]));
export type SqlRow = z.infer<typeof SqlRowSchema>;

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
  readonly kind: import('./board.js').BoardPostKind;
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
  if (!Number.isInteger(result) || result < 1 || result > maximum)
    throw new Error(`${name} must be an integer from 1 through ${maximum}`);
  return result;
}

function workerPath() {
  return fileURLToPath(
    new URL(
      import.meta.url.endsWith('.ts') ? './sql-worker.ts' : './sql-worker.js',
      import.meta.url,
    ),
  );
}

function nodeRuntime() {
  if (process.versions.bun !== undefined)
    throw new Error('SQL queries require the Node runtime with node:sqlite');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (
    !Number.isInteger(major) ||
    !Number.isInteger(minor) ||
    major < 24 ||
    (major === 24 && minor < 10)
  )
    throw new Error('SQL queries require Node 24.10.0 or newer');
  return process.execPath;
}

const ContributionResultSchema = z.object({
  body: z.string().min(1).max(65_536),
  kind: z.enum(['question', 'blocker', 'result', 'finding', 'decision', 'progress']),
  references: z
    .array(z.object({ kind: z.string().min(1).max(255), value: z.string().min(1).max(4_096) }))
    .max(50),
  replyToPostId: z.string().uuid().nullable(),
  replacesPostId: z.string().uuid().nullable(),
});
const WorkerResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    response: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('read'),
        result: z.object({
          rows: z.array(SqlRowSchema),
          truncated: z.boolean(),
          bytes: z.number().int().nonnegative(),
        }),
      }),
      z.object({ kind: z.literal('contribution'), result: ContributionResultSchema }),
    ]),
  }),
  z.object({ ok: z.literal(false), error: z.string().min(1) }),
]);
type WorkerResponse = Extract<z.infer<typeof WorkerResponseSchema>, { ok: true }>['response'];

function parseResponse(raw: string): WorkerResponse {
  const value = WorkerResponseSchema.parse(JSON.parse(raw));
  if (!value.ok) throw new Error(value.error);
  return value.response;
}

export class SqlQueryService {
  readonly #board: Board;
  readonly #workerPath: string;

  constructor(options: SqlQueryServiceOptions) {
    this.#board = options.board;
    this.#workerPath = options.workerPath ?? workerPath();
  }

  read(input: SqlRead): Promise<SqlReadResult> {
    const timeoutMs = bounded('timeoutMs', input.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const maxRows = bounded('maxRows', input.maxRows, DEFAULT_MAX_ROWS, MAX_ROWS);
    const maxBytes = bounded('maxBytes', input.maxBytes, DEFAULT_MAX_BYTES, MAX_BYTES);
    if (input.sql.trim().length === 0) throw new Error('sql must not be empty');
    return this.#runWorker(
      JSON.stringify({
        mode: 'read',
        databasePath: this.#board.databasePath,
        projectId: this.#board.project.id,
        sql: input.sql,
        parameters: input.parameters ?? {},
        maxRows,
        maxBytes,
      }),
      timeoutMs,
    ).then((response) => {
      if (response.kind !== 'read')
        throw new Error('SQL worker returned a contribution for a read request');
      return response.result;
    });
  }

  contribute(input: SqlBoardContribution): Promise<BoardPost> {
    const timeoutMs = bounded('timeoutMs', input.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    if (input.sql.trim().length === 0) throw new Error('contribution SQL must not be empty');
    if (Buffer.byteLength(input.sql, 'utf8') > 16_384)
      throw new Error('contribution SQL exceeds 16384 bytes');
    return this.#runWorker(
      JSON.stringify({
        mode: 'contribute',
        sql: input.sql,
        parameters: input.parameters ?? {},
      }),
      timeoutMs,
    ).then((response) => {
      if (response.kind !== 'contribution')
        throw new Error('SQL worker returned a read for a contribution request');
      const contribution = response.result;
      if (contribution.kind !== input.kind)
        throw new Error('contribution kind does not match the parent request');
      return this.#board.post({
        threadId: input.threadId,
        author: input.author,
        body: contribution.body,
        kind: contribution.kind,
        idempotencyKey: input.idempotencyKey,
        references: contribution.references,
        replyToPostId: contribution.replyToPostId ?? undefined,
        replacesPostId: contribution.replacesPostId ?? undefined,
      });
    });
  }

  #runWorker(request: string, timeoutMs: number): Promise<WorkerResponse> {
    return new Promise<WorkerResponse>((resolve, reject) => {
      const child = spawn(
        nodeRuntime(),
        ['--experimental-strip-types', this.#workerPath, '--marionette-sql-worker'],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (result: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        result();
      };
      const deadline = setTimeout(() => {
        child.kill('SIGKILL');
        finish(() => reject(new Error(`SQL query exceeded ${timeoutMs}ms`)));
      }, timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        if (Buffer.byteLength(stdout, 'utf8') > MAX_PROTOCOL_BYTES) {
          child.kill('SIGKILL');
          finish(() => reject(new Error('SQL worker exceeded the protocol output limit')));
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => finish(() => reject(error)));
      child.on('close', (code) => {
        finish(() => {
          if (code !== 0) {
            try {
              reject(parseResponse(stdout));
            } catch (error) {
              reject(
                error instanceof Error
                  ? error
                  : new Error(stderr || `SQL worker exited with ${code}`),
              );
            }
            return;
          }
          try {
            resolve(parseResponse(stdout));
          } catch (error) {
            reject(
              error instanceof Error ? error : new Error('SQL worker returned an invalid response'),
            );
          }
        });
      });
      child.stdin.end(request);
    });
  }
}
