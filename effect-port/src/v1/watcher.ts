import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Context, Effect, Layer, Schema } from 'effect';
import type { BoardRecipient } from './board.js';
import type { Store } from './store.js';

export type DeliveryReadiness = { readonly kind: 'ready' } | { readonly kind: 'busy' } | { readonly kind: 'unconfirmed'; readonly reason: string } | { readonly kind: 'unsupported'; readonly reason: string };
export type DeliverySubmission = { readonly kind: 'submitted' } | { readonly kind: 'unconfirmed'; readonly reason: string } | { readonly kind: 'unsupported'; readonly reason: string };
type ReadinessInput = { readonly project: { readonly id: string; readonly hostId: string }; readonly recipient: BoardRecipient };
type DeliveryInput = { readonly deliveryIds: ReadonlyArray<string>; readonly project: { readonly id: string; readonly hostId: string }; readonly recipient: BoardRecipient; readonly message: string };
type LivenessInput = { readonly project: { readonly id: string; readonly hostId: string }; readonly processIdentity: string };
export interface DeliveryPromisePort {
  checkReady(input: ReadinessInput): Promise<DeliveryReadiness>;
  deliver(input: DeliveryInput): Promise<DeliverySubmission>;
}
export interface DeliveryEffectPort {
  checkReadyEffect(input: ReadinessInput): Effect.Effect<DeliveryReadiness, WatcherError, never>;
  deliverEffect(input: DeliveryInput): Effect.Effect<DeliverySubmission, WatcherError, never>;
}
export type DeliveryPort = DeliveryPromisePort | DeliveryEffectPort | (DeliveryPromisePort & DeliveryEffectPort);
export interface OwnerLivenessPromisePort { confirmAbsent(input: LivenessInput): Promise<boolean> }
export interface OwnerLivenessEffectPort { confirmAbsentEffect(input: LivenessInput): Effect.Effect<boolean, WatcherError, never> }
export type OwnerLivenessPort = OwnerLivenessPromisePort | OwnerLivenessEffectPort | (OwnerLivenessPromisePort & OwnerLivenessEffectPort);
export interface WatcherOptions { readonly store: Store; readonly deliveryPort: DeliveryPort; readonly livenessPort: OwnerLivenessPort; readonly processIdentity: string; readonly maxDigestSize?: number }

const nonEmpty = Schema.String.check(Schema.isMinLength(1));
const positiveInteger = Schema.Finite.check(Schema.makeFilter((value) => Number.isInteger(value) && value > 0, { expected: 'a positive integer' }));
const uuid = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i));
const DeliveryRowSchema = Schema.Struct({ id: uuid, recipient_kind: Schema.Literals(['desktop', 'session', 'user']), recipient_id: nonEmpty, recipient_generation: Schema.NullOr(positiveInteger), payload_json: Schema.String });
type DeliveryRow = typeof DeliveryRowSchema.Type;
const WatcherOwnerSchema = Schema.Struct({ generation: uuid, process_identity: nonEmpty, settled_at: Schema.NullOr(Schema.String) });
const DeliveryPayloadSchema = Schema.Struct({ threadId: uuid, postId: uuid, sequence: positiveInteger });
const decode = <S extends Schema.ConstraintDecoder<unknown, never>>(schema: S, value: unknown): S['Type'] => Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })(value);
const now = () => new Date().toISOString();
const DEFAULT_MAX_DIGEST_SIZE = 10;

export class WatcherError extends Schema.TaggedError<WatcherError>()('WatcherError', { operation: nonEmpty, message: nonEmpty, cause: Schema.Defect() }) {}
const watcherError = (operation: string, cause: unknown) => new WatcherError({ operation, message: cause instanceof Error ? cause.message : String(cause), cause });
const sync = <A>(operation: string, evaluate: () => A) => Effect.try({ try: evaluate, catch: (cause) => watcherError(operation, cause) });
const promise = <A>(operation: string, evaluate: () => Promise<A>) => Effect.tryPromise({ try: evaluate, catch: (cause) => watcherError(operation, cause) });

function recipientFromRow(row: DeliveryRow): BoardRecipient {
  return row.recipient_generation === null ? { kind: row.recipient_kind, id: row.recipient_id } : { kind: row.recipient_kind, id: row.recipient_id, generation: row.recipient_generation };
}
const parsePayload = (input: string) => decode(DeliveryPayloadSchema, JSON.parse(input));

export class Watcher {
  readonly #store: Store;
  readonly #deliveryPort: DeliveryEffectPort;
  readonly #livenessPort: OwnerLivenessEffectPort;
  readonly #processIdentity: string;
  readonly #maxDigestSize: number;
  #generation: string | null = null;
  #polling = false;

  private constructor(options: WatcherOptions) {
    this.#store = options.store;
    this.#deliveryPort = 'checkReadyEffect' in options.deliveryPort && 'deliverEffect' in options.deliveryPort
      ? options.deliveryPort
      : {
        checkReadyEffect: (input) => promise('Watcher.checkReady', () => (options.deliveryPort as DeliveryPromisePort).checkReady(input)),
        deliverEffect: (input) => promise('Watcher.deliver', () => (options.deliveryPort as DeliveryPromisePort).deliver(input)),
      };
    this.#livenessPort = 'confirmAbsentEffect' in options.livenessPort
      ? options.livenessPort
      : { confirmAbsentEffect: (input) => promise('Watcher.confirmAbsent', () => (options.livenessPort as OwnerLivenessPromisePort).confirmAbsent(input)) };
    if (options.processIdentity.trim().length === 0) throw new Error('process identity must not be empty');
    this.#processIdentity = options.processIdentity;
    const maxDigestSize = options.maxDigestSize ?? DEFAULT_MAX_DIGEST_SIZE;
    if (!Number.isInteger(maxDigestSize) || maxDigestSize < 1 || maxDigestSize > 100) throw new Error('maxDigestSize must be an integer from 1 through 100');
    this.#maxDigestSize = maxDigestSize;
  }

  static readonly startEffect = Effect.fn('Watcher.start')((options: WatcherOptions) => Effect.gen(function* () {
    const watcher = yield* sync('Watcher.construct', () => new Watcher(options));
    yield* watcher.claimOwnershipEffect();
    return watcher;
  }));
  static start(options: WatcherOptions) { return Effect.runPromise(Watcher.startEffect(options)); }

  get generation() { if (this.#generation === null) throw new Error('watcher has not claimed ownership'); return this.#generation; }
  private get project() { return this.#store.project; }

  private liveness(input: LivenessInput) { return this.#livenessPort.confirmAbsentEffect(input); }
  private readiness(input: ReadinessInput) { return this.#deliveryPort.checkReadyEffect(input); }
  private delivery(input: DeliveryInput) { return this.#deliveryPort.deliverEffect(input); }

  private readonly claimOwnershipEffect = Effect.fn('Watcher.claimOwnership')(function* (this: Watcher) {
    const prior = yield* sync('Watcher.claimOwnership.read', () => this.#store.read((db) => {
      const row = db.prepare('SELECT generation,process_identity,settled_at FROM watcher_owners WHERE project_id=?').get(this.project.id);
      return row === undefined ? undefined : decode(WatcherOwnerSchema, row);
    }));
    let absentGeneration: string | null = null;
    if (prior !== undefined && prior.process_identity !== this.#processIdentity && prior.settled_at === null) {
      const absent = yield* this.liveness({ project: this.project, processIdentity: prior.process_identity });
      if (!absent) return yield* watcherError('Watcher.claimOwnership', new Error('watcher takeover requires confirmed former process absence'));
      absentGeneration = prior.generation;
    }
    const absent = absentGeneration;
    this.#generation = yield* sync('Watcher.claimOwnership.commit', () => this.#store.transaction((db) => {
      const raw = db.prepare('SELECT generation,process_identity,settled_at FROM watcher_owners WHERE project_id=?').get(this.project.id);
      const current = raw === undefined ? undefined : decode(WatcherOwnerSchema, raw);
      if (current === undefined) {
        const generation = randomUUID();
        db.prepare('INSERT INTO watcher_owners(project_id,generation,process_identity,claimed_at,settled_at) VALUES(?,?,?,?,NULL)').run(this.project.id, generation, this.#processIdentity, now());
        return generation;
      }
      if (current.process_identity === this.#processIdentity && current.settled_at === null) return current.generation;
      if (current.settled_at === null && (current.generation !== absent || current.process_identity !== prior?.process_identity)) throw new Error('watcher owner changed before takeover could be claimed');
      const nextGeneration = randomUUID();
      db.prepare('UPDATE watcher_owners SET generation=?,process_identity=?,claimed_at=?,settled_at=NULL WHERE project_id=? AND generation=?').run(nextGeneration, this.#processIdentity, now(), this.project.id, current.generation);
      db.prepare("UPDATE notification_deliveries SET state='unconfirmed',unconfirmed_at=?,last_error=? WHERE project_id=? AND state='claimed' AND owner_generation=?").run(now(), 'former watcher stopped before delivery acknowledgement could be reconciled', this.project.id, current.generation);
      return nextGeneration;
    }));
  }.bind(this));

  private assertOwner(db: DatabaseSync): void {
    const raw = db.prepare('SELECT generation,process_identity,settled_at FROM watcher_owners WHERE project_id=?').get(this.project.id);
    const owner = raw === undefined ? undefined : decode(WatcherOwnerSchema, raw);
    if (owner === undefined || owner.generation !== this.generation || owner.process_identity !== this.#processIdentity || owner.settled_at !== null) throw new Error('watcher no longer owns this project');
  }
  private claimDigest(): ReadonlyArray<DeliveryRow> {
    return this.#store.transaction((db) => {
      this.assertOwner(db);
      const rawFirst = db.prepare("SELECT id,recipient_kind,recipient_id,recipient_generation,payload_json FROM notification_deliveries WHERE project_id=? AND state='pending' ORDER BY rowid LIMIT 1").get(this.project.id);
      const first = rawFirst === undefined ? undefined : decode(DeliveryRowSchema, rawFirst);
      if (first === undefined) return [];
      const rows = db.prepare("SELECT id,recipient_kind,recipient_id,recipient_generation,payload_json FROM notification_deliveries WHERE project_id=? AND state='pending' AND recipient_kind=? AND recipient_id=? AND recipient_generation IS ? ORDER BY rowid LIMIT ?").all(this.project.id, first.recipient_kind, first.recipient_id, first.recipient_generation, this.#maxDigestSize).map((row) => decode(DeliveryRowSchema, row));
      for (const row of rows) {
        const claimed = db.prepare("UPDATE notification_deliveries SET state='claimed',owner_generation=?,claim_revision=claim_revision+1,claimed_at=? WHERE id=? AND project_id=? AND state='pending'").run(this.generation, now(), row.id, this.project.id);
        if (Number(claimed.changes) !== 1) throw new Error('delivery changed while its digest was being claimed');
      }
      return rows;
    });
  }
  private releaseBusy(rows: ReadonlyArray<DeliveryRow>): void {
    this.#store.transaction((db) => { this.assertOwner(db); for (const row of rows) db.prepare("UPDATE notification_deliveries SET state='pending',owner_generation=NULL,claimed_at=NULL WHERE id=? AND project_id=? AND state='claimed' AND owner_generation=?").run(row.id, this.project.id, this.generation); });
  }
  private settle(rows: ReadonlyArray<DeliveryRow>, state: 'acknowledged' | 'unconfirmed', reason?: string): void {
    const timestamp = now();
    this.#store.transaction((db) => {
      this.assertOwner(db);
      for (const row of rows) {
        if (state === 'acknowledged') db.prepare("UPDATE notification_deliveries SET state='acknowledged',attempted_at=?,acknowledged_at=?,last_error=NULL WHERE id=? AND project_id=? AND state='claimed' AND owner_generation=?").run(timestamp, timestamp, row.id, this.project.id, this.generation);
        else db.prepare("UPDATE notification_deliveries SET state='unconfirmed',attempted_at=?,unconfirmed_at=?,last_error=? WHERE id=? AND project_id=? AND state='claimed' AND owner_generation=?").run(timestamp, timestamp, reason ?? 'delivery outcome was not confirmed', row.id, this.project.id, this.generation);
      }
    });
  }

  readonly pollOnceEffect = Effect.fn('Watcher.pollOnce')(function* (this: Watcher) {
    const self = this;
    if (self.#polling || self.#generation === null) return 0;
    self.#polling = true;
    return yield* Effect.gen(function* () {
      const rows = yield* sync('Watcher.claimDigest', () => self.claimDigest());
      if (rows.length === 0) return 0;
      const recipient = recipientFromRow(rows[0]);
      const readiness = yield* self.readiness({ project: self.project, recipient });
      if (readiness.kind === 'busy') {
        yield* sync('Watcher.releaseBusy', () => self.releaseBusy(rows));
        return 0;
      }
      if (readiness.kind !== 'ready') {
        yield* sync('Watcher.readinessUnconfirmed', () => self.settle(rows, 'unconfirmed', readiness.reason));
        return 0;
      }
      const posts = rows.map((row) => parsePayload(row.payload_json));
      const delivery = Effect.matchEffect(
        self.delivery({ deliveryIds: rows.map((row) => row.id), project: self.project, recipient, message: `Board updates are available: ${posts.map((post) => `thread ${post.threadId}, post ${post.postId}`).join('; ')}` }).pipe(
          Effect.onInterrupt(() => sync('Watcher.interrupted', () => self.settle(rows, 'unconfirmed', 'watcher interrupted after durable delivery claim'))),
        ),
        {
          onFailure: (error) => sync('Watcher.deliveryUnconfirmed', () => { self.settle(rows, 'unconfirmed', error.message); return { kind: 'unconfirmed', reason: error.message } as DeliverySubmission; }),
          onSuccess: Effect.succeed,
        },
      );
      const result = yield* delivery;
      yield* sync('Watcher.settleDelivery', () => result.kind === 'submitted' ? self.settle(rows, 'acknowledged') : self.settle(rows, 'unconfirmed', result.reason));
      return result.kind === 'submitted' ? rows.length : 0;
    }).pipe(Effect.ensuring(Effect.sync(() => { self.#polling = false; })));
  }.bind(this));
  pollOnce() { return Effect.runPromise(this.pollOnceEffect()); }

  stop(): void {
    if (this.#generation === null) return;
    this.#store.transaction((db) => {
      const result = db.prepare('UPDATE watcher_owners SET settled_at=? WHERE project_id=? AND generation=? AND process_identity=? AND settled_at IS NULL').run(now(), this.project.id, this.generation, this.#processIdentity);
      if (Number(result.changes) !== 1) throw new Error('watcher ownership changed before it could stop');
    });
    this.#generation = null;
  }
}

export interface WatcherServiceShape { readonly watcher: Watcher; readonly pollOnce: Effect.Effect<number, WatcherError, never> }
export class WatcherService extends Context.Service<WatcherService, WatcherServiceShape>()('@marionette/v1/Watcher') {}
export const watcherLayer = (options: WatcherOptions) => Layer.effect(WatcherService, Effect.acquireRelease(
  Watcher.startEffect(options),
  (watcher) => Effect.sync(() => watcher.stop()),
).pipe(Effect.map((watcher) => WatcherService.of({ watcher, pollOnce: watcher.pollOnceEffect() }))));
