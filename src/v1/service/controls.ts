import { requireControlActor } from '../controllers/controller-store.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { canonicalJson } from '../database.js';
import { AttemptIdSchema } from '../model.js';
import { NativeIdentitySchema, type NativeJournal } from '../native.js';
import { createHerdrAdapter, type HerdrAdapterFactory } from '../adapters/herdr.js';
import type { SessionIdentity } from '../store.js';
import type { ServiceOwnership } from './ownership.js';

const controlSchema = z.object({
  id: z.string(),
  attempt_id: AttemptIdSchema,
  cause_kind: z.enum(['workflow-control', 'brief-revision']),
  cause_id: z.string(),
  operation: z.enum(['drain', 'safe', 'now', 'cancel', 'supersede']),
  state: z.enum(['requested', 'unconfirmed', 'confirmed']),
});
/** Controls only interrupt positively matched sessions, never synthesize checkpoints. */
export class ServiceControls {
  constructor(
    readonly owner: ServiceOwnership,
    readonly actor: SessionIdentity,
    readonly adapterFor: HerdrAdapterFactory = createHerdrAdapter,
  ) {}
  private authorize(db: DatabaseSync) {
    this.owner.assertCurrent(db);
    requireControlActor(this.owner.store, db, this.actor);
  }
  async scan(limit = 20) {
    z.number().int().min(1).max(100).parse(limit);
    const store = this.owner.store;
    const rows = store.read((db) =>
      db
        .prepare(
          "SELECT * FROM attempt_control_intents WHERE project_id=? AND state IN ('requested','unconfirmed') ORDER BY created_at,id LIMIT ?",
        )
        .all(store.project.id, limit)
        .map((row) => controlSchema.parse(row)),
    );
    for (const control of rows) {
      store.read((db) => this.authorize(db));
      const attempt = store.getAttempt(control.attempt_id);
      if (['settled', 'closed'].includes(attempt.phase)) {
        store.transaction((db) => {
          this.authorize(db);
          db.prepare(
            "UPDATE attempt_control_intents SET state='confirmed',settled_at=? WHERE id=?",
          ).run(new Date().toISOString(), control.id);
        });
        continue;
      }
      const native = store.read((db) =>
        db
          .prepare('SELECT identity_json FROM native_attempts WHERE project_id=? AND attempt_id=?')
          .get(store.project.id, control.attempt_id),
      );
      const encoded = z.string().nullable().optional().parse(native?.identity_json);
      if (!encoded) {
        this.uncertain(control.id);
        continue;
      }
      const identity = NativeIdentitySchema.parse(JSON.parse(encoded));
      const journal: NativeJournal = {
        prepare: async (effect) =>
          store.transaction((db) => {
            this.authorize(db);
            if (effect.kind !== 'interrupt' || effect.paneId !== identity.paneId)
              return {
                kind: 'rejected',
                reason: 'Control permits only the exact native interrupt',
              };
            const current = controlSchema.parse(
              db.prepare('SELECT * FROM attempt_control_intents WHERE id=?').get(control.id),
            );
            if (current.state === 'confirmed')
              return { kind: 'rejected', reason: 'Control already settled' };
            const live = store.getAttempt(control.attempt_id);
            if (['settled', 'closed'].includes(live.phase))
              return { kind: 'rejected', reason: 'Attempt settled' };
            if (control.cause_kind === 'workflow-control') {
              const cause = db
                .prepare(
                  'SELECT cw.expected_control_revision AS control_revision FROM control_workflows cw JOIN control_intents ci ON ci.id=cw.control_intent_id WHERE ci.id=? AND ci.project_id=? AND cw.workflow_id=?',
                )
                .get(control.cause_id, store.project.id, live.workflowId ?? null);
              if (!live.workflowId) return { kind: 'rejected', reason: 'Control workflow missing' };
              const workflow = store.getWorkflow(live.workflowId);
              if (!cause) {
                const deadline = db
                  .prepare(
                    "SELECT attempt_id FROM workflow_attempt_deadlines WHERE attempt_id=? AND state='requested' AND deadline_at<=?",
                  )
                  .get(live.id, new Date().toISOString());
                if (
                  control.cause_id !== 'deadline_' + live.id ||
                  !deadline ||
                  !['running', 'pausing', 'cancelling'].includes(workflow.phase)
                )
                  return { kind: 'rejected', reason: 'Control cause missing or obsolete deadline' };
              } else if (
                !['pausing', 'cancelling'].includes(workflow.phase) ||
                workflow.controlRevision !== Number(cause.control_revision)
              )
                return { kind: 'rejected', reason: 'Control revision changed' };
            } else if (store.getJob(live.jobId).currentBriefRevision === live.briefRevision)
              return { kind: 'rejected', reason: 'Brief supersession no longer current' };
            const exact = db
              .prepare('SELECT identity_json FROM native_attempts WHERE attempt_id=?')
              .get(control.attempt_id);
            if (exact?.identity_json !== encoded)
              return { kind: 'rejected', reason: 'Native identity changed' };
            const key = 'control/' + control.id;
            if (
              db
                .prepare('SELECT id FROM native_effects WHERE attempt_id=? AND effect_kind=?')
                .get(control.attempt_id, key)
            )
              return {
                kind: 'rejected',
                reason: 'Control effect already claimed; observe before any retry',
              };
            const id = randomUUID();
            db.prepare('INSERT INTO native_effects VALUES(?,?,?,?,?,?)').run(
              id,
              store.project.id,
              control.attempt_id,
              key,
              canonicalJson({ effect, controlId: control.id, identity }),
              new Date().toISOString(),
            );
            return { kind: 'prepared', operationId: id };
          }),
      };
      const adapter = this.adapterFor(journal);
      const observed = await adapter.invoke('observe', { identity });
      if (observed.kind === 'settled') {
        if (canonicalJson(observed.identity) !== canonicalJson(identity))
          throw new Error('Control observation returned a different native identity');
        store.transaction((db) => {
          this.authorize(db);
          if (
            db
              .prepare('SELECT identity_json FROM native_attempts WHERE attempt_id=?')
              .get(control.attempt_id)?.identity_json !== encoded
          )
            throw new Error('Native identity changed before control settlement');
          store.settleAttempt({
            actor: this.actor,
            attemptId: control.attempt_id,
            observation: {
              kind: 'settled',
              outcome: 'interrupted',
              reason: 'Exact native settlement observed for control ' + control.id,
            },
            idempotencyKey: 'service-control-settle/' + control.id,
          });
          db.prepare(
            "UPDATE native_attempts SET phase='settled',updated_at=? WHERE attempt_id=?",
          ).run(new Date().toISOString(), control.attempt_id);
        });
        continue;
      }
      if (control.operation === 'drain') continue;
      if (
        control.operation === 'safe' ||
        observed.kind === 'manual-required' ||
        observed.kind === 'unconfirmed'
      ) {
        this.uncertain(control.id);
        continue;
      }
      try {
        await adapter.invoke('interrupt', { identity });
      } finally {
        this.uncertain(control.id);
      }
    }
    return rows.length;
  }
  private uncertain(id: string) {
    this.owner.store.transaction((db) => {
      this.authorize(db);
      db.prepare(
        "UPDATE attempt_control_intents SET state='unconfirmed' WHERE id=? AND state='requested'",
      ).run(id);
    });
  }
}
