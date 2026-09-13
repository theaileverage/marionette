import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TransitionRequestSchema } from '../model.js';
import { canonicalJson } from '../database.js';
import { EventStore } from '../events/event-store.js';
import type { Store, SessionIdentity } from '../store.js';
import { assertDecisionActor, decisionFence, DecisionExpectedSchema } from './fences.js';
export const HumanDecisionRequestSchema = z
  .object({
    workflowId: z.string().min(1),
    artifactResultId: z.string().min(1).nullable().default(null),
    question: z.string().trim().min(1),
    options: z
      .array(
        z.object({
          id: z.string().min(1),
          label: z.string().min(1),
          effects: z
            .object({ kind: z.literal('workflow-transition'), request: TransitionRequestSchema })
            .strict(),
        }),
      )
      .min(1),
    expected: DecisionExpectedSchema,
    idempotencyKey: z.string().min(1),
  })
  .strict();
export const HumanDecisionResolveSchema = z
  .object({
    decisionId: z.string().min(1),
    optionId: z.string().min(1),
    expected: DecisionExpectedSchema,
    idempotencyKey: z.string().min(1),
  })
  .strict();
export class HumanDecisions {
  constructor(
    readonly store: Store,
    readonly actor: SessionIdentity,
  ) {}
  list() {
    return this.store.read((db) =>
      db
        .prepare('SELECT * FROM human_decision_requests WHERE project_id=? ORDER BY created_at,id')
        .all(this.store.project.id),
    );
  }
  request(input: z.input<typeof HumanDecisionRequestSchema>) {
    const value = HumanDecisionRequestSchema.parse(input);
    return this.store.idempotent(
      'decision.request',
      value.idempotencyKey,
      { ...value, actor: this.actor },
      z.string(),
      (db) => {
        if (!decisionFence(db, this.store, this.actor, value.workflowId, value.expected))
          throw new Error('Stale decision revision or stopped workflow');
        if (new Set(value.options.map((o) => o.id)).size !== value.options.length)
          throw new Error('Decision option ids must be unique');
        if (
          value.artifactResultId &&
          !db
            .prepare(
              'SELECT r.id FROM results r JOIN jobs j ON j.id=r.job_id WHERE r.id=? AND r.project_id=? AND j.origin_workflow_id=?',
            )
            .get(value.artifactResultId, this.store.project.id, value.workflowId)
        )
          throw new Error('Decision result must belong to workflow');
        for (const option of value.options) {
          const r = option.effects.request;
          if (
            r.workflowId !== value.workflowId ||
            r.expectedWorkflowRevision !== value.expected.workflow ||
            r.expectedBriefRevision !== value.expected.brief ||
            r.expectedControlRevision !== value.expected.control
          )
            throw new Error('Decision option transition must match expected workflow revisions');
        }
        const id = randomUUID(),
          now = new Date().toISOString();
        db.prepare('INSERT INTO human_decision_requests VALUES (?,?,?,?,?,?,?,?,?,?)').run(
          id,
          this.store.project.id,
          value.workflowId,
          value.artifactResultId,
          value.question,
          canonicalJson(value.options),
          canonicalJson(value.expected),
          'pending',
          now,
          now,
        );
        new EventStore(this.store).append({
          kind: 'decision.requested',
          aggregate: { kind: 'decision', id, revision: 1 },
          payload: { workflowId: value.workflowId, question: value.question },
          dedupeKey: `decision:${id}:requested`,
        });
        return id;
      },
    );
  }
  resolve(input: z.input<typeof HumanDecisionResolveSchema>) {
    const value = HumanDecisionResolveSchema.parse(input);
    return this.store.transaction((db) => {
      assertDecisionActor(db, this.store, this.actor, true);
      return this.store.idempotent(
        'decision.resolve',
        value.idempotencyKey,
        { ...value, actor: this.actor },
        z.object({ state: z.enum(['resolved', 'obsolete']), receiptId: z.string().nullable() }),
        () => {
          const row = db
            .prepare('SELECT * FROM human_decision_requests WHERE project_id=? AND id=?')
            .get(this.store.project.id, value.decisionId);
          if (!row) throw new Error('Decision not found');
          if (row.state !== 'pending') throw new Error('Decision already settled');
          if (
            row.expected_json !== canonicalJson(value.expected) ||
            !decisionFence(db, this.store, this.actor, String(row.workflow_id), value.expected)
          ) {
            db.prepare(
              "UPDATE human_decision_requests SET state='obsolete',updated_at=? WHERE id=?",
            ).run(new Date().toISOString(), value.decisionId);
            return { state: 'obsolete' as const, receiptId: null };
          }
          const options = HumanDecisionRequestSchema.shape.options.parse(
            JSON.parse(String(row.options_json)),
          );
          const option = options.find((o) => o.id === value.optionId);
          if (!option) throw new Error('Unknown decision option');
          const transition = this.store.requestTransition({
            actor: this.actor,
            request: {
              ...option.effects.request,
              idempotencyKey: `human-decision:${value.decisionId}`,
            },
          });
          const receiptId = randomUUID(),
            now = new Date().toISOString();
          db.prepare('INSERT INTO human_decision_resolutions VALUES (?,?,?,?,?,?,?,?)').run(
            receiptId,
            value.decisionId,
            value.optionId,
            canonicalJson(option.effects),
            this.actor.id,
            this.actor.generation,
            value.expected.workflow + 1,
            now,
          );
          db.prepare(
            "UPDATE human_decision_requests SET state='resolved',updated_at=? WHERE id=?",
          ).run(now, value.decisionId);

          new EventStore(this.store).append({
            kind: 'decision.resolved',
            aggregate: {
              kind: 'workflow',
              id: String(row.workflow_id),
              revision: value.expected.workflow + 1,
            },
            payload: {
              decisionId: value.decisionId,
              receiptId,
              optionId: value.optionId,
              effects: option.effects,
              transition,
            },
            dedupeKey: `decision:${value.decisionId}:resolved`,
          });
          return { state: 'resolved' as const, receiptId };
        },
      );
    });
  }
}
