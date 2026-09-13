import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import { AgentSessionIdSchema, SessionGenerationSchema } from '../model.js';
import type { Store, SessionIdentity } from '../store.js';
import { canonicalJson } from '../database.js';
import { NativeIdentitySchema } from '../native.js';
import { EventStore } from '../events/event-store.js';

export function requireControlActor(
  store: Store,
  db: DatabaseSync,
  actor: SessionIdentity,
  userOnly = false,
) {
  const row = db
    .prepare('SELECT * FROM agent_sessions WHERE project_id=? AND id=? AND generation=?')
    .get(store.project.id, actor.id, actor.generation);
  if (
    !row ||
    row.state !== 'active' ||
    (row.role !== 'user' && (userOnly || row.role !== 'controller'))
  )
    throw new Error('active authorized control session required');
  if (
    row.role === 'controller' &&
    !db
      .prepare(
        "SELECT 1 FROM controller_definitions c JOIN controller_incarnations i ON i.controller_id=c.id AND i.generation=c.current_generation AND i.authority_revision=c.authority_revision WHERE c.project_id=? AND i.session_id=? AND i.session_generation=? AND i.state='active' AND c.state IN ('idle','working')",
      )
      .get(store.project.id, actor.id, actor.generation)
  )
    throw new Error('stale logical controller authority');
  return row;
}
export class ControllerStore {
  constructor(readonly store: Store) {}
  status() {
    return this.store.read(
      (db) =>
        db
          .prepare('SELECT * FROM controller_definitions WHERE project_id=?')
          .get(this.store.project.id) ?? null,
    );
  }
  configure(input: { actor: SessionIdentity; profilePolicyId: string; expectedRevision: number }) {
    z.string().min(1).parse(input.profilePolicyId);
    z.number().int().nonnegative().parse(input.expectedRevision);
    return this.store.transaction((db) => {
      requireControlActor(this.store, db, input.actor, true);
      const old = this.status();
      if (Number(old?.state_revision ?? 0) !== input.expectedRevision)
        throw new Error('stale controller revision');
      if (old) {
        const prior = db
          .prepare('SELECT * FROM controller_incarnations WHERE controller_id=? AND generation=?')
          .get(String(old.id), Number(old.current_generation ?? 0));
        const timestamp = new Date().toISOString();
        if (prior && !['settled', 'superseded'].includes(String(prior.state))) {
          db.prepare(
            "UPDATE controller_incarnations SET state='superseded' WHERE controller_id=? AND generation=?",
          ).run(String(old.id), Number(old.current_generation));
          db.prepare(
            "UPDATE agent_sessions SET state='unconfirmed',settled_at=? WHERE id=? AND generation=? AND state='active'",
          ).run(timestamp, String(prior.session_id), Number(prior.session_generation));
          db.prepare(
            `INSERT INTO controller_incarnation_retirements(
              id,project_id,controller_id,generation,disposition,reason,actor_id,actor_generation,
              idempotency_key,request_json,created_at
            ) VALUES(?,?,?,?,?,?,?,?,NULL,NULL,?)`,
          ).run(
            randomUUID(),
            this.store.project.id,
            String(old.id),
            Number(old.current_generation),
            'unconfirmed',
            'Controller policy authority changed; native state was not observed',
            input.actor.id,
            input.actor.generation,
            timestamp,
          );
        }
        db.prepare(
          'UPDATE controller_definitions SET profile_policy_id=?,state_revision=state_revision+1,authority_revision=authority_revision+1 WHERE id=?',
        ).run(input.profilePolicyId, String(old.id));
        db.prepare(
          "UPDATE controller_inbox_items SET state=CASE WHEN attempt_count>=5 THEN 'dead-letter' ELSE 'pending' END,claim_revision=claim_revision+1,service_generation=NULL,controller_generation=NULL,last_error='Controller policy changed before submission' WHERE controller_id=? AND state='claimed'",
        ).run(String(old.id));
        db.prepare(
          "UPDATE controller_inbox_items SET state='superseded',last_error='Submitted to a controller whose authority was replaced; native effect requires explicit resolution' WHERE controller_id=? AND state='submitted'",
        ).run(String(old.id));
      } else
        db.prepare(
          `INSERT INTO controller_definitions(id,project_id,profile_policy_id,state,created_at) VALUES(?,?,?,'idle',?)`,
        ).run(randomUUID(), this.store.project.id, input.profilePolicyId, new Date().toISOString());
      new EventStore(this.store).project();
      return this.status();
    });
  }
  ensure(input: {
    actor: SessionIdentity;
    expectedRevision: number;
    adapter: { id: string; version: number };
    endpointGeneration: string;
    stateDigest: string;
  }) {
    z.object({
      adapter: z.object({ id: z.string().min(1), version: z.number().int().positive() }),
      endpointGeneration: z.string().min(1),
      stateDigest: z.string().min(1),
    }).parse(input);
    return this.store.transaction((db) => {
      requireControlActor(this.store, db, input.actor, true);
      const c = this.status();
      if (!c || c.state_revision !== input.expectedRevision)
        throw new Error('stale controller revision');
      const prior = db
        .prepare('SELECT * FROM controller_incarnations WHERE controller_id=? AND generation=?')
        .get(String(c.id), Number(c.current_generation ?? 0));
      if (prior && !['settled', 'superseded'].includes(String(prior.state)))
        throw new Error('existing incarnation must be reconciled before replacement');
      const generation = Number(c.current_generation ?? 0) + 1;
      const token = randomBytes(32).toString('hex');
      const session = {
        id: AgentSessionIdSchema.parse(randomUUID()),
        generation: SessionGenerationSchema.parse(generation),
      };
      this.store.registerSession({
        ...session,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        role: 'controller',
        executionRole: 'chief-of-staff',
        workspaceId: null,
        parentWorkflowId: null,
        attemptId: null,
        nativeKind: null,
        nativeServerGeneration: null,
        nativeLocator: null,
      });
      db.prepare(
        `INSERT INTO controller_incarnations(
          controller_id,generation,session_id,session_generation,adapter_id,adapter_version,
          endpoint_generation,native_identity_json,state_digest,route_decision_id,state,created_at,
          authority_revision
        ) VALUES(?,?,?,?,?,?,?,NULL,?,NULL,'launching',?,?)`,
      ).run(
        String(c.id),
        generation,
        session.id,
        session.generation,
        input.adapter.id,
        input.adapter.version,
        input.endpointGeneration,
        input.stateDigest,
        new Date().toISOString(),
        Number(c.authority_revision),
      );
      db.prepare(
        "UPDATE controller_definitions SET current_generation=?,state='starting',state_revision=state_revision+1 WHERE id=?",
      ).run(generation, String(c.id));
      return { controllerId: String(c.id), generation, session, token };
    });
  }
  replace(input: {
    actor: SessionIdentity;
    controllerId: string;
    generation: number;
    expectedRevision: number;
    reason: string;
    nativeIdentity: string;
    idempotencyKey: string;
  }) {
    z.string().min(1).parse(input.reason);
    return this.store.transaction((db) => {
      requireControlActor(this.store, db, input.actor, true);
      const request = canonicalJson({
        controllerId: input.controllerId,
        generation: input.generation,
        expectedRevision: input.expectedRevision,
        reason: input.reason,
      });
      const existing = db
        .prepare(
          'SELECT * FROM controller_incarnation_retirements WHERE project_id=? AND idempotency_key=?',
        )
        .get(this.store.project.id, input.idempotencyKey);
      if (existing) {
        if (existing.request_json !== request)
          throw new Error('controller replacement idempotency conflict');
        return {
          id: String(existing.id),
          controllerId: String(existing.controller_id),
          generation: Number(existing.generation),
          createdAt: String(existing.created_at),
        };
      }
      const controller = this.status();
      if (
        !controller ||
        controller.id !== input.controllerId ||
        controller.current_generation !== input.generation ||
        controller.state_revision !== input.expectedRevision
      )
        throw new Error('stale controller replacement');
      const prior = db
        .prepare('SELECT * FROM controller_incarnations WHERE controller_id=? AND generation=?')
        .get(input.controllerId, input.generation);
      if (!prior || prior.state !== 'active' || prior.native_identity_json !== input.nativeIdentity)
        throw new Error('controller replacement requires the exact active native identity');
      const timestamp = new Date().toISOString();
      db.prepare(
        "UPDATE controller_incarnations SET state='superseded' WHERE controller_id=? AND generation=?",
      ).run(input.controllerId, input.generation);
      db.prepare(
        "UPDATE agent_sessions SET state='settled',settled_at=? WHERE id=? AND generation=? AND state='active'",
      ).run(timestamp, String(prior.session_id), Number(prior.session_generation));
      const id = randomUUID();
      db.prepare(
        `INSERT INTO controller_incarnation_retirements(
          id,project_id,controller_id,generation,disposition,reason,actor_id,actor_generation,
          idempotency_key,request_json,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        this.store.project.id,
        input.controllerId,
        input.generation,
        'settled',
        input.reason,
        input.actor.id,
        input.actor.generation,
        input.idempotencyKey,
        request,
        timestamp,
      );
      db.prepare(
        "UPDATE controller_definitions SET state='idle',state_revision=state_revision+1,authority_revision=authority_revision+1 WHERE id=?",
      ).run(input.controllerId);
      db.prepare(
        "UPDATE controller_inbox_items SET state=CASE WHEN attempt_count>=5 THEN 'dead-letter' ELSE 'pending' END,claim_revision=claim_revision+1,service_generation=NULL,controller_generation=NULL,last_error='Controller explicitly replaced before submission' WHERE controller_id=? AND state='claimed'",
      ).run(input.controllerId);
      db.prepare(
        "UPDATE controller_inbox_items SET state='superseded',last_error='Submitted to a controller that was explicitly replaced; native effect requires explicit resolution' WHERE controller_id=? AND state='submitted'",
      ).run(input.controllerId);
      return {
        id,
        controllerId: input.controllerId,
        generation: input.generation,
        createdAt: timestamp,
      };
    });
  }
  resolveEffect(input: {
    actor: SessionIdentity;
    effectId: string;
    expectedAuthorityRevision: number;
    reason: string;
  }) {
    z.string().min(1).parse(input.reason);
    return this.store.transaction((db) => {
      requireControlActor(this.store, db, input.actor, true);
      const effect = db
        .prepare('SELECT * FROM controller_native_effects WHERE project_id=? AND id=?')
        .get(this.store.project.id, input.effectId);
      if (!effect) throw new Error('controller native effect not found');
      const controller = db
        .prepare(
          'SELECT authority_revision FROM controller_definitions WHERE id=? AND project_id=?',
        )
        .get(effect.controller_id, this.store.project.id);
      if (controller?.authority_revision !== input.expectedAuthorityRevision)
        throw new Error('controller effect authority revision changed');
      if (effect.state === 'settled') {
        if (!effect.settled_at)
          throw new Error('settled controller native effect is missing settlement evidence');
        return {
          effectId: input.effectId,
          state: 'settled' as const,
          settledAt: String(effect.settled_at),
        };
      }
      if (effect.state !== 'claimed') throw new Error('controller native effect is not unresolved');
      const settledAt = new Date().toISOString();
      db.prepare(
        "UPDATE controller_native_effects SET state='settled',receipt_json=?,settled_at=? WHERE id=? AND state='claimed'",
      ).run(
        canonicalJson({
          disposition: 'explicit-manual-resolution',
          reason: input.reason,
          actor: input.actor,
        }),
        settledAt,
        input.effectId,
      );
      return { effectId: input.effectId, state: 'settled' as const, settledAt };
    });
  }
  reconcile(input: {
    actor: SessionIdentity;
    controllerId: string;
    generation: number;
    expectedRevision: number;
    observation:
      | {
          kind: 'active';
          nativeIdentity: { kind: string; serverGeneration: string; locator: string };
        }
      | { kind: 'settled' | 'unconfirmed'; reason: string };
  }) {
    return this.store.transaction((db) => {
      requireControlActor(this.store, db, input.actor, true);
      const c = this.status();
      if (
        !c ||
        c.id !== input.controllerId ||
        c.current_generation !== input.generation ||
        c.state_revision !== input.expectedRevision
      )
        throw new Error('stale controller incarnation');
      const row = db
        .prepare('SELECT * FROM controller_incarnations WHERE controller_id=? AND generation=?')
        .get(input.controllerId, input.generation);
      if (!row || ['settled', 'superseded'].includes(String(row.state)))
        throw new Error('terminal incarnation');
      if (input.observation.kind === 'active') {
        const native = z
          .object({
            kind: z.string().min(1),
            serverGeneration: z.string().min(1),
            locator: z.string().min(1),
          })
          .parse(input.observation.nativeIdentity);
        if (native.kind !== row.adapter_id || native.serverGeneration !== row.endpoint_generation)
          throw new Error('native endpoint does not match admitted incarnation');
        if (native.kind === 'herdr') {
          const exact = NativeIdentitySchema.parse(JSON.parse(native.locator));
          if (
            exact.binding.hostId !== this.store.project.hostId ||
            exact.binding.endpoint.serverStartToken !== native.serverGeneration
          )
            throw new Error('native identity project host or endpoint mismatch');
        }
        const encoded = canonicalJson(native);
        if (row.native_identity_json !== null && row.native_identity_json !== encoded)
          throw new Error('native identity mismatch');
        db.prepare(
          "UPDATE controller_incarnations SET native_identity_json=?,state='active' WHERE controller_id=? AND generation=?",
        ).run(encoded, input.controllerId, input.generation);
        db.prepare(
          "UPDATE agent_sessions SET state='active',settled_at=NULL,native_kind=?,native_server_generation=?,native_locator=? WHERE id=? AND generation=?",
        ).run(
          native.kind,
          native.serverGeneration,
          native.locator,
          String(row.session_id),
          Number(row.session_generation),
        );
      } else {
        z.string().min(1).parse(input.observation.reason);
        db.prepare(
          'UPDATE controller_incarnations SET state=? WHERE controller_id=? AND generation=?',
        ).run(input.observation.kind, input.controllerId, input.generation);
        db.prepare('UPDATE agent_sessions SET state=? WHERE id=? AND generation=?').run(
          input.observation.kind,
          String(row.session_id),
          Number(row.session_generation),
        );
      }
      db.prepare(
        'UPDATE controller_definitions SET state=?,state_revision=state_revision+1 WHERE id=?',
      ).run(
        input.observation.kind === 'active'
          ? 'idle'
          : input.observation.kind === 'settled'
            ? 'idle'
            : 'recovering',
        input.controllerId,
      );
      return this.status();
    });
  }
}
