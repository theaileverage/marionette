import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../database.js';
import { EventStore } from '../events/event-store.js';
import type { Store, SessionIdentity } from '../store.js';
import { assertDecisionActor, decisionFence, DecisionExpectedSchema } from './fences.js';
export const ExactApprovalIdentitySchema = z
  .object({
    operationId: z.string().min(1),
    operationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    serverGeneration: z.string().min(1),
    sessionId: z.string().min(1),
    sessionGeneration: z.number().int().positive(),
  })
  .strict();
export type ExactApprovalIdentity = z.infer<typeof ExactApprovalIdentitySchema>;
export const NativeApprovalRequestSchema = z
  .object({
    attemptId: z.string().min(1),
    identity: ExactApprovalIdentitySchema,
    display: z.object({ tool: z.string().min(1), summary: z.string().min(1) }),
    expected: DecisionExpectedSchema,
    idempotencyKey: z.string().min(1),
  })
  .strict();
export const NativeApprovalResolveSchema = z
  .object({
    approvalId: z.string().min(1),
    action: z.enum(['approve', 'reject']),
    expected: DecisionExpectedSchema,
    idempotencyKey: z.string().min(1),
  })
  .strict();
export const NativeApprovalReconcileSchema = z
  .object({
    approvalId: z.string().min(1),
    identity: ExactApprovalIdentitySchema,
    outcome: z.enum(['resolved', 'rejected', 'obsolete']),
    evidence: z.string().trim().min(1),
    idempotencyKey: z.string().min(1),
  })
  .strict();
const receiptSchema = z
  .object({
    identity: ExactApprovalIdentitySchema,
    receiptId: z.string().min(1),
    outcome: z.enum(['forwarded', 'resolved', 'rejected']),
  })
  .strict();
/** Implementations must compare the entire identity atomically at the native action endpoint.
 * This capability must never implement approval by sending generic terminal input. */
export interface ExactNativeApprovalCapability {
  forward(input: {
    identity: ExactApprovalIdentity;
    action: 'approve' | 'reject';
    claimId: string;
  }): Promise<z.infer<typeof receiptSchema>>;
}
function rowIdentity(
  row: Record<string, import('node:sqlite').SQLOutputValue>,
): ExactApprovalIdentity {
  return ExactApprovalIdentitySchema.parse({
    operationId: row.operation_id,
    operationFingerprint: row.operation_fingerprint,
    serverGeneration: row.server_generation,
    sessionId: row.session_id,
    sessionGeneration: row.session_generation,
  });
}
export class NativeApprovals {
  constructor(
    readonly store: Store,
    readonly actor: SessionIdentity,
  ) {}
  list() {
    return this.store.read((db) => ({
      exact: db
        .prepare('SELECT * FROM exact_native_approvals WHERE project_id=? ORDER BY created_at,id')
        .all(this.store.project.id),
      legacy: db
        .prepare('SELECT * FROM native_approvals WHERE project_id=? ORDER BY created_at,id')
        .all(this.store.project.id),
    }));
  }
  request(input: z.input<typeof NativeApprovalRequestSchema>) {
    const value = NativeApprovalRequestSchema.parse(input);
    return this.store.idempotent(
      'approval.request',
      value.idempotencyKey,
      { ...value, actor: this.actor },
      z.string(),
      (db) => {
        const attempt = db
          .prepare('SELECT * FROM attempts WHERE project_id=? AND id=?')
          .get(this.store.project.id, value.attemptId);
        if (!attempt || !attempt.workflow_id)
          throw new Error('Exact approval requires a workflow attempt');
        if (
          attempt.session_id !== value.identity.sessionId ||
          attempt.session_generation !== value.identity.sessionGeneration ||
          attempt.native_server_generation !== value.identity.serverGeneration
        )
          throw new Error('Approval native identity differs from attempt');
        if (!decisionFence(db, this.store, this.actor, String(attempt.workflow_id), value.expected))
          throw new Error('Stale approval request');
        const id = randomUUID(),
          now = new Date().toISOString();
        db.prepare(
          `INSERT INTO exact_native_approvals (id,project_id,attempt_id,workflow_id,session_id,session_generation,operation_id,operation_fingerprint,server_generation,display_json,expected_json,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`,
        ).run(
          id,
          this.store.project.id,
          value.attemptId,
          String(attempt.workflow_id),
          value.identity.sessionId,
          value.identity.sessionGeneration,
          value.identity.operationId,
          value.identity.operationFingerprint,
          value.identity.serverGeneration,
          canonicalJson(value.display),
          canonicalJson(value.expected),
          now,
          now,
        );
        new EventStore(this.store).append({
          kind: 'approval.requested',
          aggregate: { kind: 'approval', id, revision: 1 },
          payload: { attemptId: value.attemptId, display: value.display },
          dedupeKey: `approval:${id}:requested`,
        });
        return id;
      },
    );
  }
  async resolve(
    input: z.input<typeof NativeApprovalResolveSchema>,
    capability?: ExactNativeApprovalCapability,
  ) {
    const value = NativeApprovalResolveSchema.parse(input);
    const claim = this.store.transaction((db) => {
      assertDecisionActor(db, this.store, this.actor, true);
      return this.store.idempotent(
        'approval.resolve',
        value.idempotencyKey,
        { ...value, actor: this.actor },
        z.object({
          state: z.enum(['forwarding', 'manual-required', 'obsolete']),
          claimId: z.string().nullable(),
          identity: ExactApprovalIdentitySchema,
        }),
        () => {
          const row = db
            .prepare('SELECT * FROM exact_native_approvals WHERE project_id=? AND id=?')
            .get(this.store.project.id, value.approvalId);
          if (!row) throw new Error('Approval not found');
          if (!['pending', 'manual-required'].includes(String(row.state)))
            throw new Error('Approval already claimed; reconcile rather than retry');
          const identity = rowIdentity(row);
          const attempt = db
            .prepare('SELECT * FROM attempts WHERE project_id=? AND id=?')
            .get(this.store.project.id, String(row.attempt_id));
          const current =
            attempt &&
            ['running', 'launching'].includes(String(attempt.phase)) &&
            attempt.session_id === identity.sessionId &&
            attempt.session_generation === identity.sessionGeneration &&
            attempt.native_server_generation === identity.serverGeneration;
          const valid =
            current &&
            row.expected_json === canonicalJson(value.expected) &&
            decisionFence(db, this.store, this.actor, String(row.workflow_id), value.expected);
          const state = !valid
            ? ('obsolete' as const)
            : capability
              ? ('forwarding' as const)
              : ('manual-required' as const);
          const claimId = state === 'forwarding' ? randomUUID() : null;
          db.prepare(
            'UPDATE exact_native_approvals SET state=?,claim_id=?,action=?,updated_at=? WHERE id=?',
          ).run(state, claimId, value.action, new Date().toISOString(), value.approvalId);
          new EventStore(this.store).append({
            kind: `approval.${state}`,
            aggregate: { kind: 'approval', id: value.approvalId, revision: 2 },
            payload: { claimId, action: value.action },
            dedupeKey: `approval:${value.approvalId}:${value.idempotencyKey}:claim`,
          });
          return { state, claimId, identity };
        },
      );
    });
    if (claim.replayed || claim.value.state !== 'forwarding' || !capability || !claim.value.claimId)
      return this.get(value.approvalId);
    // The committed forwarding claim precedes invocation. Any throw, malformed response or lost response is ambiguous.
    try {
      const receipt = receiptSchema.parse(
        await capability.forward({
          identity: claim.value.identity,
          action: value.action,
          claimId: claim.value.claimId,
        }),
      );
      if (canonicalJson(receipt.identity) !== canonicalJson(claim.value.identity))
        throw new Error('Native approval response identity mismatch');
      this.store.transaction((db) => {
        db.prepare(
          "UPDATE exact_native_approvals SET state=?,receipt_json=?,updated_at=? WHERE id=? AND claim_id=? AND state='forwarding'",
        ).run(
          receipt.outcome,
          canonicalJson(receipt),
          new Date().toISOString(),
          value.approvalId,
          claim.value.claimId,
        );
        new EventStore(this.store).append({
          kind: `approval.${receipt.outcome}`,
          aggregate: { kind: 'approval', id: value.approvalId, revision: 3 },
          payload: { receipt },
          dedupeKey: `approval:${value.approvalId}:receipt`,
        });
      });
    } catch (error) {
      this.store.transaction((db) => {
        db.prepare(
          "UPDATE exact_native_approvals SET state='unconfirmed',reason=?,updated_at=? WHERE id=? AND state='forwarding'",
        ).run(
          error instanceof Error ? error.message : 'Native approval response unavailable',
          new Date().toISOString(),
          value.approvalId,
        );
      });
    }
    return this.get(value.approvalId);
  }
  get(id: string) {
    return this.store.read((db) =>
      db
        .prepare('SELECT * FROM exact_native_approvals WHERE project_id=? AND id=?')
        .get(this.store.project.id, id),
    );
  }
  reconcile(request: z.input<typeof NativeApprovalReconcileSchema>) {
    const input = NativeApprovalReconcileSchema.parse(request);
    return this.store.transaction((db) => {
      assertDecisionActor(db, this.store, this.actor, true);
      return this.store.idempotent(
        'approval.reconcile',
        input.idempotencyKey,
        { ...input, actor: this.actor },
        z.string(),
        () => {
          const row = this.get(input.approvalId);
          if (!row) throw new Error('Approval not found');
          if (
            !['manual-required', 'unconfirmed', 'forwarding', 'forwarded', 'pending'].includes(
              String(row.state),
            )
          )
            throw new Error('Approval already terminal');
          if (canonicalJson(rowIdentity(row)) !== canonicalJson(input.identity))
            throw new Error('Reconciliation requires exact approval identity');
          db.prepare(
            'UPDATE exact_native_approvals SET state=?,evidence_json=?,updated_at=? WHERE id=?',
          ).run(
            input.outcome,
            canonicalJson({
              identity: input.identity,
              evidence: input.evidence,
              actor: this.actor,
            }),
            new Date().toISOString(),
            input.approvalId,
          );
          new EventStore(this.store).append({
            kind: 'approval.reconciled',
            aggregate: { kind: 'approval', id: input.approvalId, revision: 2 },
            payload: { outcome: input.outcome, evidence: input.evidence },
            dedupeKey: `approval:${input.approvalId}:reconciled`,
          });
          return input.outcome;
        },
      );
    });
  }
}
