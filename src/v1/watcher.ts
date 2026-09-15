import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Context, Effect, Layer, Schema } from 'effect';
import type { BoardRecipient } from './board.js';
import type { Store } from './store.js';

export type DeliveryReadiness =
  | { readonly kind: 'ready'; readonly briefChanged?: boolean }
  | { readonly kind: 'busy' }
  | { readonly kind: 'unconfirmed'; readonly reason: string }
  | { readonly kind: 'unsupported'; readonly reason: string };

export type DeliverySubmission =
  | { readonly kind: 'submitted' }
  | { readonly kind: 'unconfirmed'; readonly reason: string }
  | { readonly kind: 'unsupported'; readonly reason: string };

type ReadinessInput = {
  readonly project: { readonly id: string; readonly hostId: string };
  readonly recipient: BoardRecipient;
};

type DeliveryInput = {
  readonly deliveryIds: ReadonlyArray<string>;
  readonly highWaterMark: string;
  readonly project: { readonly id: string; readonly hostId: string };
  readonly recipient: BoardRecipient;
  readonly message: string;
};

type LivenessInput = {
  readonly project: { readonly id: string; readonly hostId: string };
  readonly processIdentity: string;
};

export interface DeliveryPromisePort {
  checkReady(input: ReadinessInput): Promise<DeliveryReadiness>;
  deliver(input: DeliveryInput): Promise<DeliverySubmission>;
}

export interface DeliveryEffectPort {
  checkReadyEffect(input: ReadinessInput): Effect.Effect<DeliveryReadiness, WatcherError, never>;
  deliverEffect(input: DeliveryInput): Effect.Effect<DeliverySubmission, WatcherError, never>;
}

export type DeliveryPort =
  DeliveryPromisePort | DeliveryEffectPort | (DeliveryPromisePort & DeliveryEffectPort);

export interface OwnerLivenessPromisePort {
  confirmAbsent(input: LivenessInput): Promise<boolean>;
}

export interface OwnerLivenessEffectPort {
  confirmAbsentEffect(input: LivenessInput): Effect.Effect<boolean, WatcherError, never>;
}

export type OwnerLivenessPort =
  | OwnerLivenessPromisePort
  | OwnerLivenessEffectPort
  | (OwnerLivenessPromisePort & OwnerLivenessEffectPort);

export interface WatcherOptions {
  readonly store: Store;
  readonly deliveryPort: DeliveryPort;
  readonly livenessPort: OwnerLivenessPort;
  readonly processIdentity: string;
  readonly maxDigestSize?: number;
  readonly busyBackoffMs?: number;
  readonly maxBusyBackoffMs?: number;
}

const nonEmpty = Schema.String.check(Schema.isMinLength(1));

const uuid = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
);

const natural = Schema.Finite.check(
  Schema.makeFilter((value) => Number.isInteger(value) && value >= 0, {
    expected: 'a non-negative integer',
  }),
);

const WakeRowSchema = Schema.Struct({
  id: uuid,
  recipient_kind: Schema.Literals(['desktop', 'session', 'user']),
  recipient_id: nonEmpty,
  recipient_generation: natural,
  wake_revision: natural,
  attempts: natural,
});

type WakeRow = typeof WakeRowSchema.Type;

const WatcherOwnerSchema = Schema.Struct({
  generation: uuid,
  process_identity: nonEmpty,
  settled_at: Schema.NullOr(Schema.String),
});

const decode = <S extends Schema.ConstraintDecoder<unknown, never>, Value>(
  schema: S,
  value: Value,
): S['Type'] => Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })(value);

const now = () => new Date().toISOString();

const DEFAULT_MAX_DIGEST_SIZE = 10;

const DEFAULT_BUSY_BACKOFF_MS = 5_000;

const DEFAULT_MAX_BUSY_BACKOFF_MS = 60_000;

export class WatcherError extends Schema.TaggedError<WatcherError>()('WatcherError', {
  operation: nonEmpty,
  message: nonEmpty,
  cause: Schema.Defect(),
}) {}

const watcherError = (operation: string, cause: unknown) =>
  new WatcherError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

const sync = <A>(operation: string, evaluate: () => A) =>
  Effect.try({ try: evaluate, catch: (cause) => watcherError(operation, cause) });

const promise = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: (cause) => watcherError(operation, cause) });

function recipientFromRow(row: WakeRow): BoardRecipient {
  return row.recipient_kind === 'session'
    ? { kind: row.recipient_kind, id: row.recipient_id, generation: row.recipient_generation }
    : { kind: row.recipient_kind, id: row.recipient_id };
}

export class Watcher {
  readonly #store: Store;
  readonly #deliveryPort: DeliveryEffectPort;
  readonly #livenessPort: OwnerLivenessEffectPort;
  readonly #processIdentity: string;
  readonly #maxDigestSize: number;
  readonly #busyBackoffMs: number;
  readonly #maxBusyBackoffMs: number;
  #generation: string | null = null;
  #polling = false;

  private constructor(options: WatcherOptions) {
    this.#store = options.store;
    const deliveryPort = options.deliveryPort;
    const livenessPort = options.livenessPort;

    this.#deliveryPort =
      'checkReadyEffect' in deliveryPort
        ? deliveryPort
        : {
            checkReadyEffect: (input) =>
              promise('Watcher.checkReady', () =>
                deliveryPort.checkReady(input),
              ),
            deliverEffect: (input) =>
              promise('Watcher.deliver', () =>
                deliveryPort.deliver(input),
              ),
          };
    this.#livenessPort =
      'confirmAbsentEffect' in livenessPort
        ? livenessPort
        : {
            confirmAbsentEffect: (input) =>
              promise('Watcher.confirmAbsent', () =>
                livenessPort.confirmAbsent(input),
              ),
          };

    if (options.processIdentity.trim().length === 0)
      throw new Error('process identity must not be empty');
    this.#processIdentity = options.processIdentity;
    const maxDigestSize = options.maxDigestSize ?? DEFAULT_MAX_DIGEST_SIZE;

    if (!Number.isInteger(maxDigestSize) || maxDigestSize < 1 || maxDigestSize > 100)
      throw new Error('maxDigestSize must be an integer from 1 through 100');
    this.#maxDigestSize = maxDigestSize;
    this.#busyBackoffMs = options.busyBackoffMs ?? DEFAULT_BUSY_BACKOFF_MS;
    this.#maxBusyBackoffMs = options.maxBusyBackoffMs ?? DEFAULT_MAX_BUSY_BACKOFF_MS;

    if (this.#busyBackoffMs < 1 || this.#maxBusyBackoffMs < this.#busyBackoffMs)
      throw new Error('busy backoff bounds are invalid');
  }

  static readonly startEffect = Effect.fn('Watcher.start')((options: WatcherOptions) =>
    Effect.gen(function* () {
      const watcher = yield* sync('Watcher.construct', () => new Watcher(options));
      yield* watcher.claimOwnershipEffect();

      return watcher;
    }),
  );
  static start(options: WatcherOptions) {
    return Effect.runPromise(Watcher.startEffect(options));
  }

  get generation() {
    if (this.#generation === null) throw new Error('watcher has not claimed ownership');

    return this.#generation;
  }
  private get project() {
    return this.#store.project;
  }

  private liveness(input: LivenessInput) {
    return this.#livenessPort.confirmAbsentEffect(input);
  }
  private readiness(input: ReadinessInput) {
    return this.#deliveryPort.checkReadyEffect(input);
  }
  private delivery(input: DeliveryInput) {
    return this.#deliveryPort.deliverEffect(input);
  }

  private readonly claimOwnershipEffect = Effect.fn('Watcher.claimOwnership')(
    function* (this: Watcher) {
      const prior = yield* sync('Watcher.claimOwnership.read', () =>
        this.#store.read((db) => {
          const row = db
            .prepare(
              'SELECT generation,process_identity,settled_at FROM watcher_owners WHERE project_id=?',
            )
            .get(this.project.id);

          return row === undefined ? undefined : decode(WatcherOwnerSchema, row);
        }),
      );

      let absentGeneration: string | null = null;

      if (
        prior !== undefined &&
        prior.process_identity !== this.#processIdentity &&
        prior.settled_at === null
      ) {
        const absent = yield* this.liveness({
          project: this.project,
          processIdentity: prior.process_identity,
        });

        if (!absent)
          return yield* watcherError(
            'Watcher.claimOwnership',
            new Error('watcher takeover requires confirmed former process absence'),
          );
        absentGeneration = prior.generation;
      }

      const absent = absentGeneration;
      this.#generation = yield* sync('Watcher.claimOwnership.commit', () =>
        this.#store.transaction((db) => {
          const raw = db
            .prepare(
              'SELECT generation,process_identity,settled_at FROM watcher_owners WHERE project_id=?',
            )
            .get(this.project.id);

          const current = raw === undefined ? undefined : decode(WatcherOwnerSchema, raw);

          if (current === undefined) {
            const generation = randomUUID();
            db.prepare(
              'INSERT INTO watcher_owners(project_id,generation,process_identity,claimed_at,settled_at) VALUES(?,?,?,?,NULL)',
            ).run(this.project.id, generation, this.#processIdentity, now());

            return generation;
          }

          if (current.process_identity === this.#processIdentity && current.settled_at === null)
            return current.generation;

          if (
            current.settled_at === null &&
            (current.generation !== absent || current.process_identity !== prior?.process_identity)
          )
            throw new Error('watcher owner changed before takeover could be claimed');
          const nextGeneration = randomUUID();
          db.prepare(
            'UPDATE watcher_owners SET generation=?,process_identity=?,claimed_at=?,settled_at=NULL WHERE project_id=? AND generation=?',
          ).run(nextGeneration, this.#processIdentity, now(), this.project.id, current.generation);
          db.prepare(
            "UPDATE board_subscription_wakes SET state='unconfirmed',unconfirmed_at=?,last_error=?,owner_generation=NULL,next_attempt_at=NULL WHERE project_id=? AND state='claimed' AND owner_generation=?",
          ).run(
            now(),
            'former watcher stopped after a durable wake claim; the uncertain prompt will not be replayed',
            this.project.id,
            current.generation,
          );

          return nextGeneration;
        }),
      );
    }.bind(this),
  );

  private assertOwner(db: DatabaseSync): void {
    const raw = db
      .prepare(
        'SELECT generation,process_identity,settled_at FROM watcher_owners WHERE project_id=?',
      )
      .get(this.project.id);

    const owner = raw === undefined ? undefined : decode(WatcherOwnerSchema, raw);

    if (
      owner === undefined ||
      owner.generation !== this.generation ||
      owner.process_identity !== this.#processIdentity ||
      owner.settled_at !== null
    )
      throw new Error('watcher no longer owns this project');
  }
  private claimDigest(): ReadonlyArray<WakeRow> {
    return this.#store.transaction((db) => {
      this.assertOwner(db);
      const timestamp = now();

      const rawFirst = db
        .prepare(
          "SELECT subscription_id AS id,recipient_kind,recipient_id,recipient_generation,wake_revision,attempts FROM board_subscription_wakes WHERE project_id=? AND state='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY COALESCE(next_attempt_at,dirty_at),COALESCE(attempted_at,''),subscription_id LIMIT 1",
        )
        .get(this.project.id, timestamp);

      const first = rawFirst === undefined ? undefined : decode(WakeRowSchema, rawFirst);

      if (first === undefined) return [];

      const rows = db
        .prepare(
          "SELECT subscription_id AS id,recipient_kind,recipient_id,recipient_generation,wake_revision,attempts FROM board_subscription_wakes WHERE project_id=? AND state='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?) AND recipient_kind=? AND recipient_id=? AND recipient_generation=? ORDER BY COALESCE(next_attempt_at,dirty_at),subscription_id LIMIT ?",
        )
        .all(
          this.project.id,
          timestamp,
          first.recipient_kind,
          first.recipient_id,
          first.recipient_generation,
          this.#maxDigestSize,
        )
        .map((row) => decode(WakeRowSchema, row));

      for (const row of rows) {
        const claimed = db
          .prepare(
            "UPDATE board_subscription_wakes SET state='claimed',owner_generation=?,claimed_revision=wake_revision,attempts=attempts+1,claimed_at=?,attempted_at=? WHERE subscription_id=? AND project_id=? AND state='pending'",
          )
          .run(this.generation, timestamp, timestamp, row.id, this.project.id);

        if (Number(claimed.changes) !== 1)
          throw new Error('wake changed while its digest was being claimed');
      }

      return rows;
    });
  }
  private releaseBusy(rows: ReadonlyArray<WakeRow>): void {
    const timestamp = Date.now();
    this.#store.transaction((db) => {
      this.assertOwner(db);

      for (const row of rows) {
        const delay = Math.min(
          this.#maxBusyBackoffMs,
          this.#busyBackoffMs * 2 ** Math.min(row.attempts, 10),
        );

        db.prepare(
          "UPDATE board_subscription_wakes SET state='pending',owner_generation=NULL,claimed_revision=NULL,claimed_at=NULL,next_attempt_at=? WHERE subscription_id=? AND project_id=? AND state='claimed' AND owner_generation=?",
        ).run(new Date(timestamp + delay).toISOString(), row.id, this.project.id, this.generation);
      }
    });
  }
  private settle(
    rows: ReadonlyArray<WakeRow>,
    state: 'submitted' | 'unconfirmed' | 'undeliverable',
    reason?: string,
  ): void {
    const timestamp = now();
    this.#store.transaction((db) => {
      this.assertOwner(db);

      for (const row of rows) {
        const advanced = db
          .prepare(
            'SELECT wake_revision>COALESCE(claimed_revision,-1) AS advanced FROM board_subscription_wakes WHERE subscription_id=?',
          )
          .get(row.id)?.advanced;

        const finalState = Number(advanced) === 1 && state === 'submitted' ? 'pending' : state;
        db.prepare(
          "UPDATE board_subscription_wakes SET state=?,owner_generation=NULL,claimed_revision=NULL,claimed_at=NULL,next_attempt_at=?,submitted_at=CASE WHEN ?='submitted' THEN ? ELSE submitted_at END,unconfirmed_at=CASE WHEN ?='unconfirmed' THEN ? ELSE unconfirmed_at END,undeliverable_at=CASE WHEN ?='undeliverable' THEN ? ELSE undeliverable_at END,last_error=? WHERE subscription_id=? AND project_id=? AND state='claimed' AND owner_generation=?",
        ).run(
          finalState,
          finalState === 'pending' ? timestamp : null,
          state,
          timestamp,
          state,
          timestamp,
          state,
          timestamp,
          reason ?? null,
          row.id,
          this.project.id,
          this.generation,
        );
      }
    });
  }

  readonly hasPendingWorkEffect = Effect.fn('Watcher.hasPendingWork')(
    function* (this: Watcher) {
      return yield* sync('Watcher.hasPendingWork', () =>
        this.#store.read(
          (db) =>
            db
              .prepare(
                "SELECT 1 FROM board_subscription_wakes WHERE project_id=? AND state IN ('pending','claimed') LIMIT 1",
              )
              .get(this.project.id) !== undefined,
        ),
      );
    }.bind(this),
  );
  hasPendingWork() {
    return Effect.runPromise(this.hasPendingWorkEffect());
  }

  readonly pollOnceEffect = Effect.fn('Watcher.pollOnce')(
    function* (this: Watcher) {

      if (this.#polling || this.#generation === null) return 0;
      this.#polling = true;

      return yield* Effect.gen(function* (this: Watcher) {
        const rows = yield* sync('Watcher.claimDigest', () => this.claimDigest());

        if (rows.length === 0) return 0;
        const recipient = recipientFromRow(rows[0]);

        const readinessResult = yield* Effect.matchEffect(
          this.readiness({ project: this.project, recipient }),
          {
            onFailure: (error) =>
              sync('Watcher.readinessFailed', () =>
                this.settle(rows, 'unconfirmed', `readiness check failed: ${error.message}`),
              ).pipe(Effect.as({ kind: 'failed' as const })),
            onSuccess: (readiness) => Effect.succeed({ kind: 'succeeded' as const, readiness }),
          },
        );

        if (readinessResult.kind === 'failed') return 0;
        const readiness = readinessResult.readiness;

        if (readiness.kind === 'busy') {
          yield* sync('Watcher.releaseBusy', () => this.releaseBusy(rows));

          return 0;
        }

        if (readiness.kind === 'unconfirmed') {
          yield* sync('Watcher.readinessUnconfirmed', () =>
            this.settle(rows, 'unconfirmed', readiness.reason),
          );

          return 0;
        }

        if (readiness.kind === 'unsupported') {
          yield* sync('Watcher.readinessUndeliverable', () =>
            this.settle(rows, 'undeliverable', readiness.reason),
          );

          return 0;
        }

        const message = readiness.briefChanged
          ? 'Your execution brief changed. Re-read the latest brief and acknowledge it before doing any further work; do not execute stale instructions.'
          : 'Unread board updates are available. Run `marionette board inbox` and advance each thread cursor after reading.';

        const delivery = Effect.matchEffect(
          this
            .delivery({
              deliveryIds: rows.map((row) => row.id),
              highWaterMark: rows
                .map((row) => `${row.id}:${row.wake_revision}`)
                .sort()
                .join(','),
              project: this.project,
              recipient,
              message,
            })
            .pipe(
              Effect.onInterrupt(() =>
                sync('Watcher.interrupted', () =>
                  this.settle(
                    rows,
                    'unconfirmed',
                    'watcher interrupted after durable delivery claim',
                  ),
                ),
              ),
            ),
          {
            onFailure: (error) =>
              sync('Watcher.deliveryUnconfirmed', () => {
                this.settle(rows, 'unconfirmed', error.message);

                return { kind: 'unconfirmed', reason: error.message } satisfies DeliverySubmission;
              }),
            onSuccess: Effect.succeed,
          },
        );

        const result = yield* delivery;
        yield* sync('Watcher.settleDelivery', () => {
          if (result.kind === 'submitted') this.settle(rows, 'submitted');
          else if (result.kind === 'unsupported') this.settle(rows, 'undeliverable', result.reason);
          else this.settle(rows, 'unconfirmed', result.reason);
        });

        return result.kind === 'submitted' ? rows.length : 0;
      }.bind(this)).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            this.#polling = false;
          }),
        ),
      );
    }.bind(this),
  );
  pollOnce() {
    return Effect.runPromise(this.pollOnceEffect());
  }

  stop(): void {
    if (this.#generation === null) return;
    this.#store.transaction((db) => {
      const result = db
        .prepare(
          'UPDATE watcher_owners SET settled_at=? WHERE project_id=? AND generation=? AND process_identity=? AND settled_at IS NULL',
        )
        .run(now(), this.project.id, this.generation, this.#processIdentity);

      if (Number(result.changes) !== 1)
        throw new Error('watcher ownership changed before it could stop');
    });
    this.#generation = null;
  }
}

export interface WatcherServiceContract {
  readonly watcher: Watcher;
  readonly pollOnce: Effect.Effect<number, WatcherError, never>;
  readonly hasPendingWork: Effect.Effect<boolean, WatcherError, never>;
}

export class WatcherService extends Context.Service<WatcherService, WatcherServiceContract>()(
  '@marionette/v1/Watcher',
) {}

export const watcherLayer = (options: WatcherOptions) =>
  Layer.effect(
    WatcherService,
    Effect.acquireRelease(Watcher.startEffect(options), (watcher) =>
      Effect.sync(() => watcher.stop()),
    ).pipe(
      Effect.map((watcher) =>
        WatcherService.of({
          watcher,
          pollOnce: watcher.pollOnceEffect(),
          hasPendingWork: watcher.hasPendingWorkEffect(),
        }),
      ),
    ),
  );
