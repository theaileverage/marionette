import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { BoardRecipient } from './board.js';
import type { Store } from './store.js';

export type DeliveryReadiness =
  | { readonly kind: 'ready' }
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
  readonly pollIntervalMs?: number;
  readonly maxDigestSize?: number;
}

const DeliveryRowSchema = z.object({
  id: z.string().uuid(),
  recipient_kind: z.enum(['desktop', 'session', 'user']),
  recipient_id: z.string().min(1),
  recipient_generation: z.number().int().positive().nullable(),
  payload_json: z.string(),
});
type DeliveryRow = z.infer<typeof DeliveryRowSchema>;

const WatcherOwnerSchema = z.object({
  generation: z.string().uuid(),
  process_identity: z.string().min(1),
  settled_at: z.string().datetime().nullable(),
});
const DeliveryPayloadSchema = z.object({
  threadId: z.string().uuid(),
  postId: z.string().uuid(),
  sequence: z.number().int().positive(),
});

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_MAX_DIGEST_SIZE = 10;

function now() {
  return new Date().toISOString();
}

function requireText(name: string, value: string) {
  if (value.trim().length === 0) throw new Error(`${name} must not be empty`);
  return value;
}

function recipientFromRow(row: DeliveryRow): BoardRecipient {
  return row.recipient_generation === null
    ? { kind: row.recipient_kind, id: row.recipient_id }
    : { kind: row.recipient_kind, id: row.recipient_id, generation: row.recipient_generation };
}

function parsePayload(input: string) {
  return DeliveryPayloadSchema.parse(JSON.parse(input));
}

export class Watcher {
  readonly #store: Store;
  readonly #deliveryPort: DeliveryPort;
  readonly #livenessPort: OwnerLivenessPort;
  readonly #processIdentity: string;
  readonly #maxDigestSize: number;
  #generation: string | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #polling = false;

  private constructor(options: WatcherOptions) {
    this.#store = options.store;
    this.#deliveryPort = options.deliveryPort;
    this.#livenessPort = options.livenessPort;
    this.#processIdentity = requireText('process identity', options.processIdentity);
    const maxDigestSize = options.maxDigestSize ?? DEFAULT_MAX_DIGEST_SIZE;
    if (!Number.isInteger(maxDigestSize) || maxDigestSize < 1 || maxDigestSize > 100)
      throw new Error('maxDigestSize must be an integer from 1 through 100');
    this.#maxDigestSize = maxDigestSize;
  }

  static async start(options: WatcherOptions) {
    const watcher = new Watcher(options);
    await watcher.claimOwnership();
    const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isInteger(interval) || interval < 10)
      throw new Error('pollIntervalMs must be an integer of at least 10');
    watcher.#timer = setInterval(() => void watcher.pollOnce(), interval);
    watcher.#timer.unref();
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
      const currentRow = db
        .prepare(
          'SELECT generation,process_identity,settled_at FROM watcher_owners WHERE project_id=?',
        )
        .get(this.project.id);
      const current = currentRow === undefined ? undefined : WatcherOwnerSchema.parse(currentRow);
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
      const nextGeneration = randomUUID();
      db.prepare(
        'UPDATE watcher_owners SET generation=?,process_identity=?,claimed_at=?,settled_at=NULL WHERE project_id=? AND generation=?',
      ).run(nextGeneration, this.#processIdentity, now(), this.project.id, current.generation);
      db.prepare(
        "UPDATE notification_deliveries SET state='unconfirmed',unconfirmed_at=?,last_error=? WHERE project_id=? AND state='claimed' AND owner_generation=?",
      ).run(
        now(),
        'former watcher stopped before delivery acknowledgement could be reconciled',
        this.project.id,
        current.generation,
      );
      return nextGeneration;
    });
  }

  private assertOwner(db: DatabaseSync) {
    const ownerRow = db
      .prepare(
        'SELECT generation,process_identity,settled_at FROM watcher_owners WHERE project_id=?',
      )
      .get(this.project.id);
    const owner = ownerRow === undefined ? undefined : WatcherOwnerSchema.parse(ownerRow);
    if (
      owner === undefined ||
      owner.generation !== this.generation ||
      owner.process_identity !== this.#processIdentity ||
      owner.settled_at !== null
    )
      throw new Error('watcher no longer owns this project');
  }

  private claimDigest(): readonly DeliveryRow[] {
    return this.#store.transaction((db) => {
      this.assertOwner(db);
      const rawFirst = db
        .prepare(
          "SELECT id,recipient_kind,recipient_id,recipient_generation,payload_json FROM notification_deliveries WHERE project_id=? AND state='pending' ORDER BY rowid LIMIT 1",
        )
        .get(this.project.id);
      const first = rawFirst === undefined ? undefined : DeliveryRowSchema.parse(rawFirst);
      if (first === undefined) return [];
      const rows = db
        .prepare(
          "SELECT id,recipient_kind,recipient_id,recipient_generation,payload_json FROM notification_deliveries WHERE project_id=? AND state='pending' AND recipient_kind=? AND recipient_id=? AND recipient_generation IS ? ORDER BY rowid LIMIT ?",
        )
        .all(
          this.project.id,
          first.recipient_kind,
          first.recipient_id,
          first.recipient_generation,
          this.#maxDigestSize,
        )
        .map((row) => DeliveryRowSchema.parse(row));
      for (const row of rows) {
        const claimed = db
          .prepare(
            "UPDATE notification_deliveries SET state='claimed',owner_generation=?,claim_revision=claim_revision+1,claimed_at=? WHERE id=? AND project_id=? AND state='pending'",
          )
          .run(this.generation, now(), row.id, this.project.id);
        if (Number(claimed.changes) !== 1)
          throw new Error('delivery changed while its digest was being claimed');
      }
      return rows;
    });
  }

  private releaseBusy(rows: readonly DeliveryRow[]) {
    this.#store.transaction((db) => {
      this.assertOwner(db);
      for (const row of rows)
        db.prepare(
          "UPDATE notification_deliveries SET state='pending',owner_generation=NULL,claimed_at=NULL WHERE id=? AND project_id=? AND state='claimed' AND owner_generation=?",
        ).run(row.id, this.project.id, this.generation);
    });
  }

  private settle(
    rows: readonly DeliveryRow[],
    state: 'acknowledged' | 'unconfirmed',
    reason?: string,
  ) {
    const timestamp = now();
    this.#store.transaction((db) => {
      this.assertOwner(db);
      for (const row of rows) {
        if (state === 'acknowledged')
          db.prepare(
            "UPDATE notification_deliveries SET state='acknowledged',attempted_at=?,acknowledged_at=?,last_error=NULL WHERE id=? AND project_id=? AND state='claimed' AND owner_generation=?",
          ).run(timestamp, timestamp, row.id, this.project.id, this.generation);
        else
          db.prepare(
            "UPDATE notification_deliveries SET state='unconfirmed',attempted_at=?,unconfirmed_at=?,last_error=? WHERE id=? AND project_id=? AND state='claimed' AND owner_generation=?",
          ).run(
            timestamp,
            timestamp,
            reason ?? 'delivery outcome was not confirmed',
            row.id,
            this.project.id,
            this.generation,
          );
      }
    });
  }

  async pollOnce() {
    if (this.#polling || this.#generation === null) return 0;
    this.#polling = true;
    try {
      const rows = this.claimDigest();
      if (rows.length === 0) return 0;
      const recipient = recipientFromRow(rows[0]);
      const readiness = await this.#deliveryPort.checkReady({ project: this.project, recipient });
      if (readiness.kind === 'busy') {
        this.releaseBusy(rows);
        return 0;
      }
      if (readiness.kind !== 'ready') {
        this.settle(rows, 'unconfirmed', readiness.reason);
        return 0;
      }
      const posts = rows.map((row) => parsePayload(row.payload_json));
      const summary = posts
        .map((post) => `thread ${post.threadId}, post ${post.postId}`)
        .join('; ');
      const result = await this.#deliveryPort.deliver({
        deliveryIds: rows.map((row) => row.id),
        project: this.project,
        recipient,
        message: `Board updates are available: ${summary}`,
      });
      if (result.kind === 'submitted') this.settle(rows, 'acknowledged');
      else this.settle(rows, 'unconfirmed', result.reason);
      return rows.length;
    } catch (error) {
      return Promise.reject(error);
    } finally {
      this.#polling = false;
    }
  }

  stop() {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
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
