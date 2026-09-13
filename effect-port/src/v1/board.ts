import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Schema } from 'effect';
import type { Store } from './store.js';
import { TimestampSchema } from './model.js';

const integer = Schema.Number.check(
  Schema.makeFilter(Number.isInteger, { expected: 'an integer' }),
);
const positiveInteger = integer.check(Schema.isGreaterThan(0));
const nonEmptyString = Schema.String.check(Schema.isMinLength(1));
const uuid = Schema.String.check(Schema.isUUID());
const nullable = <S extends Schema.ConstraintDecoder<unknown, never>>(schema: S) =>
  Schema.NullOr(schema);
const optional = <S extends Schema.ConstraintDecoder<unknown, never>>(schema: S) =>
  Schema.optional(schema);

function decode<S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  value: unknown,
): S['Type'] {
  return Schema.decodeUnknownSync(schema)(value);
}

const BoardAuthorSchema = Schema.Struct({
  kind: Schema.Literals(['session', 'system', 'user']),
  id: nonEmptyString,
  generation: optional(positiveInteger),
});
export type BoardAuthor = typeof BoardAuthorSchema.Type;

const BoardRecipientSchema = Schema.Struct({
  kind: Schema.Literals(['desktop', 'session', 'user']),
  id: nonEmptyString,
  generation: optional(positiveInteger),
});
export type BoardRecipient = typeof BoardRecipientSchema.Type;

export const BoardReferenceSchema = Schema.Struct({ kind: nonEmptyString, value: nonEmptyString });
export type BoardReference = typeof BoardReferenceSchema.Type;
export const BoardPostKindSchema = Schema.Literals([
  'question',
  'blocker',
  'result',
  'finding',
  'decision',
  'progress',
]);
export type BoardPostKind = typeof BoardPostKindSchema.Type;
const DefaultSubscriptionEventKinds = [
  'question',
  'blocker',
  'result',
] as const satisfies readonly BoardPostKind[];

export interface BoardThread {
  readonly id: string;
  readonly title: string;
  readonly jobId: string | null;
  readonly author: BoardAuthor;
  readonly createdAt: string;
}

export interface BoardPost {
  readonly id: string;
  readonly threadId: string;
  readonly sequence: number;
  readonly body: string;
  readonly kind: BoardPostKind;
  readonly author: BoardAuthor;
  readonly replyToPostId: string | null;
  readonly replacesPostId: string | null;
  readonly references: readonly BoardReference[];
  readonly createdAt: string;
}

export interface Page<T> {
  readonly entries: readonly T[];
  readonly nextCursor: string | null;
}

export interface BoardSubscription {
  readonly id: string;
  readonly subscriber: BoardRecipient;
  readonly threadId: string | null;
  readonly eventKinds: readonly BoardPostKind[];
  readonly createdAt: string;
}

export interface BoardOptions {
  readonly store: Store;
}

const ThreadCursorSchema = Schema.Struct({
  kind: Schema.Literal('threads'),
  projectId: nonEmptyString,
  createdAt: TimestampSchema,
  id: uuid,
});
const PostCursorSchema = Schema.Struct({
  kind: Schema.Literal('posts'),
  projectId: nonEmptyString,
  threadId: uuid,
  sequence: positiveInteger,
});
const SearchCursorSchema = Schema.Struct({
  kind: Schema.Literal('search'),
  projectId: nonEmptyString,
  query: nonEmptyString,
  createdAt: TimestampSchema,
  id: uuid,
});
const CursorSchema = Schema.Union([ThreadCursorSchema, PostCursorSchema, SearchCursorSchema]);
type Cursor = typeof CursorSchema.Type;

const authorRowFields = {
  source_author_kind: Schema.Literals(['session', 'system', 'user']),
  source_author_id: nonEmptyString,
  source_author_generation: nullable(positiveInteger),
};
const AuthorRowSchema = Schema.Struct(authorRowFields);
const ThreadRowSchema = Schema.Struct({
  ...authorRowFields,
  id: uuid,
  title: nonEmptyString,
  job_id: nullable(nonEmptyString),
  created_at: TimestampSchema,
  idempotency_key: nonEmptyString,
});
const PostRowSchema = Schema.Struct({
  ...authorRowFields,
  id: uuid,
  thread_id: uuid,
  sequence: positiveInteger,
  body: nonEmptyString,
  kind: BoardPostKindSchema,
  reply_to_post_id: nullable(uuid),
  replaces_post_id: nullable(uuid),
  created_at: TimestampSchema,
});
const ReferenceRowSchema = Schema.Struct({ ref_kind: nonEmptyString, ref_value: nonEmptyString });
const NextSequenceRowSchema = Schema.Struct({ sequence: positiveInteger });
const SubscriptionRowSchema = Schema.Struct({
  id: uuid,
  subscriber_kind: Schema.Literals(['desktop', 'session', 'user']),
  subscriber_id: nonEmptyString,
  subscriber_generation: nullable(positiveInteger),
  event_kinds_json: Schema.String,
  created_at: TimestampSchema,
});
const EventKindsSchema = Schema.mutable(Schema.NonEmptyArray(BoardPostKindSchema)).check(
  Schema.makeFilter((kinds) => new Set(kinds).size === kinds.length, {
    expected: 'subscription event kinds must be unique',
  }),
);

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 30;

function requireText(name: string, value: string) {
  if (value.trim().length === 0) throw new Error(`${name} must not be empty`);
  return value;
}

function boundedLimit(limit: number | undefined) {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new Error(`limit must be an integer from 1 through ${MAX_PAGE_SIZE}`);
  }
  return limit;
}

function now() {
  return new Date().toISOString();
}

function encodeCursor(cursor: Cursor) {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): Cursor {
  try {
    return decode(CursorSchema, JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw new Error('invalid board cursor');
  }
}

function assertCursor(
  cursor: string | undefined,
  expected: Cursor['kind'],
  projectId: string,
): Cursor | undefined {
  if (cursor === undefined) return undefined;
  const decoded = decodeCursor(cursor);
  if (decoded.kind !== expected || decoded.projectId !== projectId)
    throw new Error('board cursor does not match this request');
  return decoded;
}

function authorFromRow(row: typeof AuthorRowSchema.Type): BoardAuthor {
  return row.source_author_generation === null
    ? { kind: row.source_author_kind, id: row.source_author_id }
    : {
        kind: row.source_author_kind,
        id: row.source_author_id,
        generation: row.source_author_generation,
      };
}

function boardThreadFromRow(row: typeof ThreadRowSchema.Type): BoardThread {
  return {
    id: row.id,
    title: row.title,
    jobId: row.job_id,
    author: authorFromRow(row),
    createdAt: row.created_at,
  };
}

function postFromRow(
  row: typeof PostRowSchema.Type,
  references: readonly BoardReference[],
): BoardPost {
  return {
    id: row.id,
    threadId: row.thread_id,
    sequence: row.sequence,
    body: row.body,
    kind: row.kind,
    author: authorFromRow(row),
    replyToPostId: row.reply_to_post_id,
    replacesPostId: row.replaces_post_id,
    references,
    createdAt: row.created_at,
  };
}

function referencesFor(db: DatabaseSync, postId: string): readonly BoardReference[] {
  const rows = db
    .prepare('SELECT ref_kind, ref_value FROM board_post_refs WHERE post_id=? ORDER BY ordinal')
    .all(postId);
  return rows.map((raw) => {
    const row = decode(ReferenceRowSchema, raw);
    return { kind: row.ref_kind, value: row.ref_value };
  });
}

function sameAuthor(left: BoardAuthor, right: BoardAuthor) {
  return left.kind === right.kind && left.id === right.id && left.generation === right.generation;
}

function sameReferences(left: readonly BoardReference[], right: readonly BoardReference[]) {
  return (
    left.length === right.length &&
    left.every(
      (reference, index) =>
        reference.kind === right[index]?.kind && reference.value === right[index]?.value,
    )
  );
}

export class Board {
  readonly #store: Store;

  private constructor(options: BoardOptions) {
    this.#store = options.store;
  }

  static create(options: BoardOptions) {
    return new Board(options);
  }

  get project() {
    return this.#store.project;
  }

  get databasePath() {
    return this.#store.databasePath;
  }

  private get projectId() {
    return this.project.id;
  }

  private assertAuthor(db: DatabaseSync, author: BoardAuthor) {
    requireText('author id', author.id);
    if (author.kind !== 'session') return;
    if (author.generation === undefined) throw new Error('session authors require a generation');
    const session = db
      .prepare('SELECT 1 FROM agent_sessions WHERE id=? AND generation=? AND project_id=?')
      .get(author.id, author.generation, this.projectId);
    if (session === undefined)
      throw new Error('board author is not a registered session for this project');
  }

  private assertRecipient(db: DatabaseSync, recipient: BoardRecipient) {
    requireText('recipient id', recipient.id);
    if (recipient.kind !== 'session') return;
    if (recipient.generation === undefined)
      throw new Error('session recipients require a generation');
    const session = db
      .prepare('SELECT 1 FROM agent_sessions WHERE id=? AND generation=? AND project_id=?')
      .get(recipient.id, recipient.generation, this.projectId);
    if (session === undefined)
      throw new Error('board recipient is not a registered session for this project');
  }

  createThread(input: {
    readonly title: string;
    readonly author: BoardAuthor;
    readonly idempotencyKey: string;
    readonly jobId?: string;
    readonly id?: string;
  }): BoardThread {
    const title = requireText('thread title', input.title);
    const idempotencyKey = requireText('thread idempotency key', input.idempotencyKey);
    return this.#store.transaction((db) => {
      this.assertAuthor(db, input.author);
      const existing = db
        .prepare(
          'SELECT * FROM board_threads WHERE project_id=? AND source_author_kind=? AND source_author_id=? AND idempotency_key=?',
        )
        .get(this.projectId, input.author.kind, input.author.id, idempotencyKey);
      if (existing !== undefined) {
        const thread = decode(ThreadRowSchema, existing);
        if (
          thread.title !== title ||
          thread.job_id !== (input.jobId ?? null) ||
          !sameAuthor(authorFromRow(thread), input.author)
        )
          throw new Error('thread idempotency key was already used for different content');
        return boardThreadFromRow(thread);
      }
      const id = input.id ?? randomUUID();
      const createdAt = now();
      db.prepare(
        'INSERT INTO board_threads(id,project_id,job_id,title,source_author_kind,source_author_id,source_author_generation,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      ).run(
        id,
        this.projectId,
        input.jobId ?? null,
        title,
        input.author.kind,
        input.author.id,
        input.author.generation ?? null,
        idempotencyKey,
        createdAt,
      );
      return { id, title, jobId: input.jobId ?? null, author: input.author, createdAt };
    });
  }

  post(input: {
    readonly threadId: string;
    readonly author: BoardAuthor;
    readonly body: string;
    readonly kind: BoardPostKind;
    readonly idempotencyKey: string;
    readonly references?: readonly BoardReference[];
    readonly replyToPostId?: string;
    readonly replacesPostId?: string;
    readonly id?: string;
  }): BoardPost {
    const threadId = requireText('thread id', input.threadId);
    const body = requireText('post body', input.body);
    const idempotencyKey = requireText('idempotency key', input.idempotencyKey);
    decode(BoardPostKindSchema, input.kind);
    const references = input.references ?? [];
    for (const reference of references) {
      requireText('reference kind', reference.kind);
      requireText('reference value', reference.value);
    }
    return this.#store.transaction((db) => {
      this.assertAuthor(db, input.author);
      const existing = db
        .prepare(
          'SELECT * FROM board_posts WHERE project_id=? AND source_author_kind=? AND source_author_id=? AND idempotency_key=?',
        )
        .get(this.projectId, input.author.kind, input.author.id, idempotencyKey);
      if (existing !== undefined) {
        const postRow = decode(PostRowSchema, existing);
        const post = postFromRow(postRow, referencesFor(db, postRow.id));
        if (
          post.threadId !== threadId ||
          post.body !== body ||
          post.kind !== input.kind ||
          post.replyToPostId !== (input.replyToPostId ?? null) ||
          post.replacesPostId !== (input.replacesPostId ?? null) ||
          !sameReferences(post.references, references) ||
          !sameAuthor(post.author, input.author)
        )
          throw new Error('idempotency key was already used for a different post');
        return post;
      }
      const thread = db
        .prepare('SELECT id FROM board_threads WHERE id=? AND project_id=?')
        .get(threadId, this.projectId);
      if (thread === undefined) throw new Error('board thread does not exist in this project');
      if (
        input.replyToPostId !== undefined &&
        db
          .prepare('SELECT 1 FROM board_posts WHERE id=? AND project_id=? AND thread_id=?')
          .get(input.replyToPostId, this.projectId, threadId) === undefined
      )
        throw new Error('reply target does not exist in this thread');
      if (
        input.replacesPostId !== undefined &&
        db
          .prepare('SELECT 1 FROM board_posts WHERE id=? AND project_id=? AND thread_id=?')
          .get(input.replacesPostId, this.projectId, threadId) === undefined
      )
        throw new Error('replacement target does not exist in this thread');
      const next = decode(
        NextSequenceRowSchema,
        db
          .prepare(
            'SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM board_posts WHERE project_id=? AND thread_id=?',
          )
          .get(this.projectId, threadId),
      );
      const id = input.id ?? randomUUID();
      const createdAt = now();
      db.prepare(
        'INSERT INTO board_posts(id,project_id,thread_id,sequence,source_author_kind,source_author_id,source_author_generation,body,kind,reply_to_post_id,replaces_post_id,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
        id,
        this.projectId,
        threadId,
        next.sequence,
        input.author.kind,
        input.author.id,
        input.author.generation ?? null,
        body,
        input.kind,
        input.replyToPostId ?? null,
        input.replacesPostId ?? null,
        idempotencyKey,
        createdAt,
      );
      for (const [ordinal, reference] of references.entries())
        db.prepare(
          'INSERT INTO board_post_refs(post_id,ordinal,ref_kind,ref_value) VALUES(?,?,?,?)',
        ).run(id, ordinal, reference.kind, reference.value);
      const subscriptions = db
        .prepare(
          'SELECT * FROM board_subscriptions WHERE project_id=? AND deactivated_at IS NULL AND (thread_id IS NULL OR thread_id=?)',
        )
        .all(this.projectId, threadId);
      for (const rawSubscription of subscriptions) {
        const subscription = decode(SubscriptionRowSchema, rawSubscription);
        const subscriber: BoardRecipient =
          subscription.subscriber_generation === null
            ? { kind: subscription.subscriber_kind, id: subscription.subscriber_id }
            : {
                kind: subscription.subscriber_kind,
                id: subscription.subscriber_id,
                generation: subscription.subscriber_generation,
              };
        if (
          subscriber.kind === input.author.kind &&
          subscriber.id === input.author.id &&
          subscriber.generation === input.author.generation
        )
          continue;
        const eventKinds = decode(EventKindsSchema, JSON.parse(subscription.event_kinds_json));
        if (!eventKinds.includes(input.kind)) continue;
        const eventId = randomUUID();
        db.prepare(
          'INSERT INTO notification_events(id,project_id,post_id,subscription_id,event_kind,created_at) VALUES(?,?,?,?,?,?)',
        ).run(eventId, this.projectId, id, subscription.id, 'post', createdAt);
        db.prepare(
          'INSERT INTO notification_deliveries(id,event_id,project_id,recipient_kind,recipient_id,recipient_generation,state,payload_json) VALUES(?,?,?,?,?,?,?,?)',
        ).run(
          randomUUID(),
          eventId,
          this.projectId,
          subscriber.kind,
          subscriber.id,
          subscriber.generation ?? null,
          'pending',
          JSON.stringify({ threadId, postId: id, sequence: next.sequence }),
        );
      }
      return {
        id,
        threadId,
        sequence: next.sequence,
        body,
        kind: input.kind,
        author: input.author,
        replyToPostId: input.replyToPostId ?? null,
        replacesPostId: input.replacesPostId ?? null,
        references,
        createdAt,
      };
    });
  }

  listThreads(
    input: { readonly cursor?: string; readonly limit?: number } = {},
  ): Page<BoardThread> {
    const limit = boundedLimit(input.limit);
    const rawCursor = assertCursor(input.cursor, 'threads', this.projectId);
    if (rawCursor !== undefined && rawCursor.kind !== 'threads')
      throw new Error('board cursor does not match this request');
    const cursor = rawCursor;
    return this.#store.read((db) => {
      const rows = db
        .prepare(
          'SELECT * FROM board_threads WHERE project_id=? AND (? IS NULL OR created_at>? OR (created_at=? AND id>?)) ORDER BY created_at,id LIMIT ?',
        )
        .all(
          this.projectId,
          cursor?.createdAt ?? null,
          cursor?.createdAt ?? '',
          cursor?.createdAt ?? '',
          cursor?.id ?? '',
          limit + 1,
        );
      const entries = rows
        .slice(0, limit)
        .map((row) => boardThreadFromRow(decode(ThreadRowSchema, row)));
      const tail = entries.at(-1);
      return {
        entries,
        nextCursor:
          rows.length > limit && tail !== undefined
            ? encodeCursor({
                kind: 'threads',
                projectId: this.projectId,
                createdAt: decode(TimestampSchema, tail.createdAt),
                id: tail.id,
              })
            : null,
      };
    });
  }

  readThread(input: {
    readonly threadId: string;
    readonly cursor?: string;
    readonly limit?: number;
  }): Page<BoardPost> {
    const threadId = requireText('thread id', input.threadId);
    const limit = boundedLimit(input.limit);
    const rawCursor = assertCursor(input.cursor, 'posts', this.projectId);
    if (rawCursor !== undefined && rawCursor.kind !== 'posts')
      throw new Error('board cursor does not match this thread');
    const cursor = rawCursor;
    if (cursor !== undefined && cursor.threadId !== threadId)
      throw new Error('board cursor does not match this thread');
    return this.#store.read((db) => {
      if (
        db
          .prepare('SELECT 1 FROM board_threads WHERE id=? AND project_id=?')
          .get(threadId, this.projectId) === undefined
      )
        throw new Error('board thread does not exist in this project');
      const rows = db
        .prepare(
          'SELECT * FROM board_posts WHERE project_id=? AND thread_id=? AND sequence>? ORDER BY sequence LIMIT ?',
        )
        .all(this.projectId, threadId, cursor?.sequence ?? 0, limit + 1);
      const entries = rows.slice(0, limit).map((raw) => {
        const row = decode(PostRowSchema, raw);
        return postFromRow(row, referencesFor(db, row.id));
      });
      const tail = entries.at(-1);
      return {
        entries,
        nextCursor:
          rows.length > limit && tail !== undefined
            ? encodeCursor({
                kind: 'posts',
                projectId: this.projectId,
                threadId,
                sequence: tail.sequence,
              })
            : null,
      };
    });
  }

  search(input: {
    readonly query: string;
    readonly cursor?: string;
    readonly limit?: number;
  }): Page<BoardPost> {
    const query = requireText('search query', input.query);
    const limit = boundedLimit(input.limit);
    const rawCursor = assertCursor(input.cursor, 'search', this.projectId);
    if (rawCursor !== undefined && rawCursor.kind !== 'search')
      throw new Error('board cursor does not match this search');
    const cursor = rawCursor;
    if (cursor !== undefined && cursor.query !== query)
      throw new Error('board cursor does not match this search');
    return this.#store.read((db) => {
      const rows = db
        .prepare(
          'SELECT * FROM board_posts WHERE project_id=? AND instr(lower(body),lower(?))>0 AND (? IS NULL OR created_at>? OR (created_at=? AND id>?)) ORDER BY created_at,id LIMIT ?',
        )
        .all(
          this.projectId,
          query,
          cursor?.createdAt ?? null,
          cursor?.createdAt ?? '',
          cursor?.createdAt ?? '',
          cursor?.id ?? '',
          limit + 1,
        );
      const entries = rows.slice(0, limit).map((raw) => {
        const row = decode(PostRowSchema, raw);
        return postFromRow(row, referencesFor(db, row.id));
      });
      const tail = entries.at(-1);
      return {
        entries,
        nextCursor:
          rows.length > limit && tail !== undefined
            ? encodeCursor({
                kind: 'search',
                projectId: this.projectId,
                query,
                createdAt: decode(TimestampSchema, tail.createdAt),
                id: tail.id,
              })
            : null,
      };
    });
  }

  subscribe(input: {
    readonly subscriber: BoardRecipient;
    readonly threadId?: string;
    readonly eventKinds?: readonly BoardPostKind[];
    readonly id?: string;
  }): BoardSubscription {
    const createdAt = now();
    const eventKinds = decode(EventKindsSchema, input.eventKinds ?? DefaultSubscriptionEventKinds);
    return this.#store.transaction((db) => {
      this.assertRecipient(db, input.subscriber);
      const threadId = input.threadId ?? null;
      if (
        threadId !== null &&
        db
          .prepare('SELECT 1 FROM board_threads WHERE id=? AND project_id=?')
          .get(threadId, this.projectId) === undefined
      )
        throw new Error('subscription thread does not exist in this project');
      const existing = db
        .prepare(
          'SELECT * FROM board_subscriptions WHERE project_id=? AND subscriber_kind=? AND subscriber_id=? AND subscriber_generation IS ? AND thread_id IS ?',
        )
        .get(
          this.projectId,
          input.subscriber.kind,
          input.subscriber.id,
          input.subscriber.generation ?? null,
          threadId,
        );
      if (existing !== undefined) {
        const subscription = decode(SubscriptionRowSchema, existing);
        db.prepare(
          'UPDATE board_subscriptions SET deactivated_at=NULL,event_kinds_json=? WHERE id=?',
        ).run(JSON.stringify(eventKinds), subscription.id);
        return {
          id: subscription.id,
          subscriber: input.subscriber,
          threadId,
          eventKinds,
          createdAt: subscription.created_at,
        };
      }
      const id = input.id ?? randomUUID();
      db.prepare(
        'INSERT INTO board_subscriptions(id,project_id,subscriber_kind,subscriber_id,subscriber_generation,thread_id,event_kinds_json,created_at,deactivated_at) VALUES(?,?,?,?,?,?,?,?,NULL)',
      ).run(
        id,
        this.projectId,
        input.subscriber.kind,
        input.subscriber.id,
        input.subscriber.generation ?? null,
        threadId,
        JSON.stringify(eventKinds),
        createdAt,
      );
      return { id, subscriber: input.subscriber, threadId, eventKinds, createdAt };
    });
  }

  unsubscribe(input: { readonly subscriber: BoardRecipient; readonly threadId?: string }) {
    return this.#store.transaction((db) => {
      const result = db
        .prepare(
          'UPDATE board_subscriptions SET deactivated_at=? WHERE project_id=? AND subscriber_kind=? AND subscriber_id=? AND subscriber_generation IS ? AND thread_id IS ? AND deactivated_at IS NULL',
        )
        .run(
          now(),
          this.projectId,
          input.subscriber.kind,
          input.subscriber.id,
          input.subscriber.generation ?? null,
          input.threadId ?? null,
        );
      return Number(result.changes) > 0;
    });
  }

  markRead(input: {
    readonly reader: BoardRecipient;
    readonly threadId: string;
    readonly sequence: number;
  }) {
    if (!Number.isInteger(input.sequence) || input.sequence < 0)
      throw new Error('read sequence must be a non-negative integer');
    return this.#store.transaction((db) => {
      this.assertRecipient(db, input.reader);
      if (
        db
          .prepare('SELECT 1 FROM board_threads WHERE id=? AND project_id=?')
          .get(input.threadId, this.projectId) === undefined
      )
        throw new Error('board thread does not exist in this project');
      db.prepare(
        'INSERT INTO board_read_cursors(project_id,reader_kind,reader_id,reader_generation,thread_id,last_sequence,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id,reader_kind,reader_id,reader_generation,thread_id) DO UPDATE SET last_sequence=MAX(last_sequence,excluded.last_sequence),updated_at=excluded.updated_at',
      ).run(
        this.projectId,
        input.reader.kind,
        input.reader.id,
        input.reader.generation ?? null,
        input.threadId,
        input.sequence,
        now(),
      );
    });
  }
}
