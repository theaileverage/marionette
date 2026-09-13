import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import type { Store } from '../store.js';
import type { SessionIdentity } from '../store.js';
import { canonicalJson, payloadDigest } from '../database.js';
import { requireControlActor } from '../controllers/controller-store.js';
export type InboxClaim = {
  id: string;
  claimRevision: number;
  controllerId: string;
  controllerGeneration: number;
  serviceGeneration: string;
};
export class ControllerInbox {
  constructor(readonly store: Store) {}
  read(controllerId: string) {
    return this.store.read((db) =>
      db
        .prepare(
          'SELECT i.*,e.kind,e.payload_json,e.sequence FROM controller_inbox_items i JOIN domain_events e ON e.id=i.event_id WHERE i.project_id=? AND i.controller_id=? ORDER BY e.sequence LIMIT 500',
        )
        .all(this.store.project.id, controllerId),
    );
  }
  claim(input: {
    controllerId: string;
    controllerGeneration: number;
    serviceGeneration: string;
    limit?: number;
  }): InboxClaim[] {
    const limit = z
      .number()
      .int()
      .min(1)
      .max(50)
      .parse(input.limit ?? 10);
    return this.store.transaction((db) => {
      this.fence(db, input);
      const rows = db
        .prepare(
          "SELECT id,claim_revision FROM controller_inbox_items WHERE project_id=? AND controller_id=? AND state='pending' AND not_before<=? ORDER BY priority,not_before,id LIMIT ?",
        )
        .all(this.store.project.id, input.controllerId, new Date().toISOString(), limit);
      return rows.map((row) => {
        db.prepare(
          "UPDATE controller_inbox_items SET state='claimed',claim_revision=claim_revision+1,service_generation=?,controller_generation=?,authority_revision=(SELECT authority_revision FROM controller_definitions WHERE id=controller_id),attempt_count=attempt_count+1 WHERE id=?",
        ).run(input.serviceGeneration, input.controllerGeneration, String(row.id));
        return { ...input, id: String(row.id), claimRevision: Number(row.claim_revision) + 1 };
      });
    });
  }
  /** Only an OS-owner record retired after confirmed absence (or clean stop) permits reclamation. */
  recoverClaims(serviceGeneration: string): number {
    return this.store.transaction((db) => {
      const current = db
        .prepare(
          "SELECT 1 FROM service_instances WHERE project_id=? AND host_id=? AND generation=? AND stopped_at IS NULL AND state IN ('starting','recovering','ready')",
        )
        .get(this.store.project.id, this.store.project.hostId, serviceGeneration);
      if (!current) throw new Error('current recovery service required');
      return Number(
        db
          .prepare(
            `UPDATE controller_inbox_items SET state=CASE WHEN attempt_count>=5 THEN 'dead-letter' ELSE 'pending' END,claim_revision=claim_revision+1,service_generation=NULL,controller_generation=NULL,last_error='Former service stopped before submission'
        WHERE project_id=? AND state='claimed' AND service_generation<>? AND EXISTS(SELECT 1 FROM service_instances s WHERE s.project_id=controller_inbox_items.project_id AND s.generation=controller_inbox_items.service_generation AND s.stopped_at IS NOT NULL)`,
          )
          .run(this.store.project.id, serviceGeneration).changes,
      );
    });
  }
  fence(
    db: DatabaseSync,
    input: { controllerId: string; controllerGeneration: number; serviceGeneration: string },
  ) {
    const service = db
      .prepare(
        "SELECT 1 FROM service_instances WHERE project_id=? AND host_id=? AND generation=? AND stopped_at IS NULL AND state IN ('ready','recovering')",
      )
      .get(this.store.project.id, this.store.project.hostId, input.serviceGeneration);
    const controller = db
      .prepare(
        "SELECT 1 FROM controller_definitions c JOIN controller_incarnations i ON i.controller_id=c.id AND i.generation=c.current_generation WHERE c.project_id=? AND c.id=? AND c.current_generation=? AND i.state='active' AND c.state IN ('idle','working')",
      )
      .get(this.store.project.id, input.controllerId, input.controllerGeneration);
    if (!service || !controller) throw new Error('stale service/controller generation');
  }
  requireClaim(db: DatabaseSync, claim: InboxClaim) {
    this.fence(db, claim);
    const row = db
      .prepare(
        'SELECT * FROM controller_inbox_items WHERE project_id=? AND id=? AND controller_id=? AND controller_generation=? AND service_generation=? AND claim_revision=?',
      )
      .get(
        this.store.project.id,
        claim.id,
        claim.controllerId,
        claim.controllerGeneration,
        claim.serviceGeneration,
        claim.claimRevision,
      );
    const authority = db
      .prepare('SELECT authority_revision FROM controller_definitions WHERE id=? AND project_id=?')
      .get(claim.controllerId, this.store.project.id)?.authority_revision;
    if (
      !row ||
      row.authority_revision !== authority ||
      !['claimed', 'submitted'].includes(String(row.state))
    )
      throw new Error('stale inbox claim');
    return row;
  }
  markSubmitted(claim: InboxClaim) {
    return this.store.transaction((db) => {
      this.requireClaim(db, claim);
      db.prepare("UPDATE controller_inbox_items SET state='submitted' WHERE id=?").run(claim.id);
    });
  }
  release(input: {
    claim: InboxClaim;
    reason: string;
    retryAt: string;
    confirmedNotSubmitted?: boolean;
  }) {
    z.string().min(1).parse(input.reason);
    z.string().datetime().parse(input.retryAt);
    return this.store.transaction((db) => {
      const row = this.requireClaim(db, input.claim);
      if (row.state === 'submitted' && input.confirmedNotSubmitted !== true)
        throw new Error('submitted effect requires explicit native reconciliation');
      db.prepare(
        'UPDATE controller_inbox_items SET state=?,not_before=?,last_error=?,claim_revision=claim_revision+1,service_generation=NULL,controller_generation=NULL WHERE id=?',
      ).run(
        Number(row.attempt_count) >= 5 ? 'dead-letter' : 'pending',
        input.retryAt,
        input.reason,
        input.claim.id,
      );
    });
  }
  /** Callback must persist local decision/effect intents only; never invoke external effects here. */
  commitDecision<T>(
    input: {
      actor: SessionIdentity;
      claims: InboxClaim[];
      decisionKey: string;
      decision: unknown;
      disposition?: 'processed' | 'dismissed' | 'superseded';
    },
    apply: (db: DatabaseSync) => T,
  ): { cycleId: string; receipt: T; replayed: boolean } {
    z.string().min(1).parse(input.decisionKey);
    if (input.claims.length === 0 || input.claims.length > 50)
      throw new Error('bounded nonempty claims required');
    const first = input.claims[0]!;
    if (new Set(input.claims.map((c) => c.id)).size !== input.claims.length)
      throw new Error('duplicate inbox claim');
    const digest = payloadDigest({
      decision: input.decision,
      items: input.claims.map((c) => ({ id: c.id, claimRevision: c.claimRevision })),
      disposition: input.disposition ?? 'processed',
    });
    return this.store.transaction((db) => {
      requireControlActor(this.store, db, input.actor);
      const incarnation = db
        .prepare('SELECT * FROM controller_incarnations WHERE controller_id=? AND generation=?')
        .get(first.controllerId, first.controllerGeneration);
      if (
        !incarnation ||
        incarnation.session_id !== input.actor.id ||
        incarnation.session_generation !== input.actor.generation
      )
        throw new Error('decision actor does not own incarnation');
      const old = db
        .prepare(
          'SELECT * FROM controller_decision_cycles WHERE project_id=? AND controller_id=? AND decision_key=?',
        )
        .get(this.store.project.id, first.controllerId, input.decisionKey);
      if (old) {
        if (old.decision_digest !== digest) throw new Error('decision idempotency conflict');
        return {
          cycleId: String(old.id),
          // SAFETY: Exact decision digest replay returns the JSON receipt written by this callback contract.
          receipt: JSON.parse(String(old.receipt_json)) as T,
          replayed: true,
        };
      }
      for (const claim of input.claims) {
        if (
          claim.controllerId !== first.controllerId ||
          claim.controllerGeneration !== first.controllerGeneration ||
          claim.serviceGeneration !== first.serviceGeneration
        )
          throw new Error('mixed decision batch');
        this.requireClaim(db, claim);
      }
      const receipt = apply(db);
      const encoded = canonicalJson(receipt);
      if (encoded === undefined || receipt === undefined || receipt === null)
        throw new Error('durable decision receipt required');
      const cycleId = randomUUID();
      db.prepare('INSERT INTO controller_decision_cycles VALUES(?,?,?,?,?,?,?,?)').run(
        cycleId,
        this.store.project.id,
        first.controllerId,
        first.controllerGeneration,
        input.decisionKey,
        digest,
        encoded,
        new Date().toISOString(),
      );
      for (const claim of input.claims) {
        db.prepare('INSERT INTO controller_inbox_acknowledgements VALUES(?,?,?,?,?,?,?)').run(
          claim.id,
          claim.claimRevision,
          cycleId,
          input.disposition ?? 'processed',
          input.actor.id,
          input.actor.generation,
          new Date().toISOString(),
        );
        db.prepare("UPDATE controller_inbox_items SET state='acknowledged' WHERE id=?").run(
          claim.id,
        );
      }
      return { cycleId, receipt, replayed: false };
    });
  }
}
