import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
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

export interface DeliveryPort {
  checkReady(input: {
    readonly project: { readonly id: string; readonly hostId: string };
    readonly recipient: BoardRecipient;
  }): Promise<DeliveryReadiness>;
  deliver(input: {
    readonly deliveryIds: readonly string[];
    readonly highWaterMark: string;
    readonly project: { readonly id: string; readonly hostId: string };
    readonly recipient: BoardRecipient;
    readonly message: string;
  }): Promise<DeliverySubmission>;
}
export interface OwnerLivenessPort {
  confirmAbsent(input: {
    readonly project: { readonly id: string; readonly hostId: string };
    readonly processIdentity: string;
  }): Promise<boolean>;
}
export interface WatcherOptions {
  readonly store: Store;
  readonly deliveryPort: DeliveryPort;
  readonly livenessPort: OwnerLivenessPort;
  readonly processIdentity: string;
  readonly maxDigestSize?: number;
  readonly busyBackoffMs?: number;
  readonly maxBusyBackoffMs?: number;
}

const WakeRowSchema = z.object({
  id: z.string().uuid(),
  recipient_kind: z.enum(['desktop', 'session', 'user']),
  recipient_id: z.string().min(1),
  recipient_generation: z.number().int().nonnegative(),
  wake_revision: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
});
type WakeRow = z.infer<typeof WakeRowSchema>;
const WatcherOwnerSchema = z.object({
  generation: z.string().uuid(),
  process_identity: z.string().min(1),
  settled_at: z.string().datetime().nullable(),
});
const DEFAULT_MAX_DIGEST_SIZE = 10;
const DEFAULT_BUSY_BACKOFF_MS = 5_000;
const DEFAULT_MAX_BUSY_BACKOFF_MS = 60_000;
const now = () => new Date().toISOString();

function recipientFromRow(row: WakeRow): BoardRecipient {
  return row.recipient_kind === 'session'
    ? { kind: row.recipient_kind, id: row.recipient_id, generation: row.recipient_generation }
    : { kind: row.recipient_kind, id: row.recipient_id };
}

export class Watcher {
  readonly #store: Store;
  readonly #deliveryPort: DeliveryPort;
  readonly #livenessPort: OwnerLivenessPort;
  readonly #processIdentity: string;
  readonly #maxDigestSize: number;
  readonly #busyBackoffMs: number;
  readonly #maxBusyBackoffMs: number;
  #generation: string | null = null;
  #polling = false;

  private constructor(options: WatcherOptions) {
    this.#store = options.store;
    this.#deliveryPort = options.deliveryPort;
    this.#livenessPort = options.livenessPort;
    if (options.processIdentity.trim().length === 0)
      throw new Error('process identity must not be empty');
    this.#processIdentity = options.processIdentity;
    this.#maxDigestSize = options.maxDigestSize ?? DEFAULT_MAX_DIGEST_SIZE;
    this.#busyBackoffMs = options.busyBackoffMs ?? DEFAULT_BUSY_BACKOFF_MS;
    this.#maxBusyBackoffMs = options.maxBusyBackoffMs ?? DEFAULT_MAX_BUSY_BACKOFF_MS;
    if (
      !Number.isInteger(this.#maxDigestSize) ||
      this.#maxDigestSize < 1 ||
      this.#maxDigestSize > 100
    )
      throw new Error('maxDigestSize must be an integer from 1 through 100');
    if (this.#busyBackoffMs < 1 || this.#maxBusyBackoffMs < this.#busyBackoffMs)
      throw new Error('busy backoff bounds are invalid');
  }

  static async start(options: WatcherOptions) {
    const watcher = new Watcher(options);
    await watcher.claimOwnership();
    return watcher;
  }
  get generation() {
    if (this.#generation === null) throw new Error('watcher has not claimed ownership');
    return this.#generation;
  }
  private get project() {
    return this.#store.project;
  }

  private async claimOwnership() {
    const prior = this.#store.read((db) => {
      const row = db
        .prepare(
          'SELECT generation,process_identity,settled_at FROM watcher_owners WHERE project_id=?',
        )
        .get(this.project.id);
      return row === undefined ? undefined : WatcherOwnerSchema.parse(row);
    });
    let absentGeneration: string | null = null;
    if (
      prior !== undefined &&
      prior.process_identity !== this.#processIdentity &&
      prior.settled_at === null
    ) {
      const absent = await this.#livenessPort.confirmAbsent({
        project: this.project,
        processIdentity: prior.process_identity,
      });
      if (!absent) throw new Error('watcher takeover requires confirmed former process absence');
      absentGeneration = prior.generation;
    }
    this.#generation = this.#store.transaction((db) => {
      const raw = db
        .prepare(
          'SELECT generation,process_identity,settled_at FROM watcher_owners WHERE project_id=?',
        )
        .get(this.project.id);
      const current = raw === undefined ? undefined : WatcherOwnerSchema.parse(raw);
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
        (current.generation !== absentGeneration ||
          current.process_identity !== prior?.process_identity)
      )
        throw new Error('watcher owner changed before takeover could be claimed');
      const generation = randomUUID();
      db.prepare(
        'UPDATE watcher_owners SET generation=?,process_identity=?,claimed_at=?,settled_at=NULL WHERE project_id=? AND generation=?',
      ).run(generation, this.#processIdentity, now(), this.project.id, current.generation);
      db.prepare(
        `UPDATE board_subscription_wakes SET state='unconfirmed',unconfirmed_at=?,last_error=?,owner_generation=NULL,next_attempt_at=NULL WHERE project_id=? AND state='claimed' AND owner_generation=?`,
      ).run(
        now(),
        'former watcher stopped after a durable wake claim; the uncertain prompt will not be replayed',
        this.project.id,
        current.generation,
      );
      return generation;
    });
  }

  private assertOwner(db: DatabaseSync) {
    const raw = db
      .prepare(
        'SELECT generation,process_identity,settled_at FROM watcher_owners WHERE project_id=?',
      )
      .get(this.project.id);
    const owner = raw === undefined ? undefined : WatcherOwnerSchema.parse(raw);
    if (
      owner === undefined ||
      owner.generation !== this.generation ||
      owner.process_identity !== this.#processIdentity ||
      owner.settled_at !== null
    )
      throw new Error('watcher no longer owns this project');
  }

  private claimDigest(): readonly WakeRow[] {
    return this.#store.transaction((db) => {
      this.assertOwner(db);
      const timestamp = now();
      const rawFirst = db
        .prepare(
          `SELECT subscription_id AS id,recipient_kind,recipient_id,recipient_generation,wake_revision,attempts FROM board_subscription_wakes WHERE project_id=? AND state='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY COALESCE(next_attempt_at,dirty_at),COALESCE(attempted_at,''),subscription_id LIMIT 1`,
        )
        .get(this.project.id, timestamp);
      const first = rawFirst === undefined ? undefined : WakeRowSchema.parse(rawFirst);
      if (first === undefined) return [];
      const rows = db
        .prepare(
          `SELECT subscription_id AS id,recipient_kind,recipient_id,recipient_generation,wake_revision,attempts FROM board_subscription_wakes WHERE project_id=? AND state='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?) AND recipient_kind=? AND recipient_id=? AND recipient_generation=? ORDER BY COALESCE(next_attempt_at,dirty_at),subscription_id LIMIT ?`,
        )
        .all(
          this.project.id,
          timestamp,
          first.recipient_kind,
          first.recipient_id,
          first.recipient_generation,
          this.#maxDigestSize,
        )
        .map((row) => WakeRowSchema.parse(row));
      for (const row of rows) {
        const claimed = db
          .prepare(
            `UPDATE board_subscription_wakes SET state='claimed',owner_generation=?,claimed_revision=wake_revision,attempts=attempts+1,claimed_at=?,attempted_at=? WHERE subscription_id=? AND project_id=? AND state='pending'`,
          )
          .run(this.generation, timestamp, timestamp, row.id, this.project.id);
        if (Number(claimed.changes) !== 1)
          throw new Error('wake changed while its digest was being claimed');
      }
      return rows;
    });
  }

  private releaseBusy(rows: readonly WakeRow[]) {
    const timestamp = Date.now();
    this.#store.transaction((db) => {
      this.assertOwner(db);
      for (const row of rows) {
        const delay = Math.min(
          this.#maxBusyBackoffMs,
          this.#busyBackoffMs * 2 ** Math.min(row.attempts, 10),
        );
        db.prepare(
          `UPDATE board_subscription_wakes SET state='pending',owner_generation=NULL,claimed_revision=NULL,claimed_at=NULL,next_attempt_at=? WHERE subscription_id=? AND project_id=? AND state='claimed' AND owner_generation=?`,
        ).run(new Date(timestamp + delay).toISOString(), row.id, this.project.id, this.generation);
      }
    });
  }

  private settle(
    rows: readonly WakeRow[],
    state: 'submitted' | 'unconfirmed' | 'undeliverable',
    reason?: string,
  ) {
    const timestamp = now();
    this.#store.transaction((db) => {
      this.assertOwner(db);
      for (const row of rows) {
        const advanced = db
          .prepare(
            `SELECT wake_revision>COALESCE(claimed_revision,-1) AS advanced FROM board_subscription_wakes WHERE subscription_id=?`,
          )
          .get(row.id)?.advanced;
        const finalState = Number(advanced) === 1 && state === 'submitted' ? 'pending' : state;
        db.prepare(
          `UPDATE board_subscription_wakes SET state=?,owner_generation=NULL,claimed_revision=NULL,claimed_at=NULL,next_attempt_at=?,submitted_at=CASE WHEN ?='submitted' THEN ? ELSE submitted_at END,unconfirmed_at=CASE WHEN ?='unconfirmed' THEN ? ELSE unconfirmed_at END,undeliverable_at=CASE WHEN ?='undeliverable' THEN ? ELSE undeliverable_at END,last_error=? WHERE subscription_id=? AND project_id=? AND state='claimed' AND owner_generation=?`,
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

  async hasPendingWork() {
    return this.#store.read(
      (db) =>
        db
          .prepare(
            "SELECT 1 FROM board_subscription_wakes WHERE project_id=? AND state IN ('pending','claimed') LIMIT 1",
          )
          .get(this.project.id) !== undefined,
    );
  }

  async pollOnce() {
    if (this.#polling || this.#generation === null) return 0;
    this.#polling = true;
    try {
      const rows = this.claimDigest();
      if (rows.length === 0) return 0;
      const recipient = recipientFromRow(rows[0]);
      let readiness: DeliveryReadiness;
      try {
        readiness = await this.#deliveryPort.checkReady({
          project: this.project,
          recipient,
        });
      } catch (error) {
        this.settle(
          rows,
          'unconfirmed',
          error instanceof Error
            ? `readiness check failed: ${error.message}`
            : 'readiness check failed before a prompt decision',
        );
        return 0;
      }
      if (readiness.kind === 'busy') {
        this.releaseBusy(rows);
        return 0;
      }
      if (readiness.kind === 'unconfirmed') {
        this.settle(rows, 'unconfirmed', readiness.reason);
        return 0;
      }
      if (readiness.kind === 'unsupported') {
        this.settle(rows, 'undeliverable', readiness.reason);
        return 0;
      }
      const message = readiness.briefChanged
        ? 'Your execution brief changed. Re-read the latest brief and acknowledge it before doing any further work; do not execute stale instructions.'
        : 'Unread board updates are available. Run `marionette board inbox` and advance each thread cursor after reading.';
      let result: DeliverySubmission;
      try {
        result = await this.#deliveryPort.deliver({
          deliveryIds: rows.map((row) => row.id),
          highWaterMark: rows
            .map((row) => `${row.id}:${row.wake_revision}`)
            .sort()
            .join(','),
          project: this.project,
          recipient,
          message,
        });
      } catch (error) {
        this.settle(
          rows,
          'unconfirmed',
          error instanceof Error ? error.message : 'wake submission outcome is unknown',
        );
        return 0;
      }
      if (result.kind === 'submitted') this.settle(rows, 'submitted');
      else if (result.kind === 'unsupported') this.settle(rows, 'undeliverable', result.reason);
      else this.settle(rows, 'unconfirmed', result.reason);
      return result.kind === 'submitted' ? rows.length : 0;
    } finally {
      this.#polling = false;
    }
  }

  stop() {
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
