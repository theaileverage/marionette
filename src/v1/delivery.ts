import { createHerdrAdapter, type HerdrAdapterFactory } from './adapters/herdr.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { NativeIdentitySchema } from './native.js';
import type { Store } from './store.js';
import type { DeliveryPort, DeliveryReadiness, DeliverySubmission } from './watcher.js';
import type { BoardRecipient } from './board.js';

export class NativeBoardDelivery implements DeliveryPort {
  constructor(
    private readonly store: Store,
    private readonly adapterFor: HerdrAdapterFactory = createHerdrAdapter,
  ) {}

  private identity(recipient: BoardRecipient) {
    if (recipient.kind !== 'session' || recipient.generation === undefined) return null;
    const generation = recipient.generation;
    const row = this.store.read((db) =>
      db
        .prepare(
          `SELECT n.identity_json,s.state,a.brief_revision,j.current_brief_revision,w.phase AS workflow_phase
      FROM agent_sessions s JOIN attempts a ON a.id=s.attempt_id
      JOIN native_attempts n ON n.attempt_id=a.id JOIN jobs j ON j.id=a.job_id
      LEFT JOIN workflow_runs w ON w.id=a.workflow_id
      WHERE s.project_id=? AND s.id=? AND s.generation=?`,
        )
        .get(this.store.project.id, recipient.id, generation),
    );
    if (!row) return null;
    const parsed = z
      .object({
        identity_json: z.string().nullable(),
        state: z.string(),
        brief_revision: z.number(),
        current_brief_revision: z.number(),
        workflow_phase: z.string().nullable(),
      })
      .parse(row);
    if (
      !parsed.identity_json ||
      parsed.state !== 'active' ||
      parsed.brief_revision !== parsed.current_brief_revision ||
      (parsed.workflow_phase !== null && parsed.workflow_phase !== 'running')
    )
      return null;
    return NativeIdentitySchema.parse(JSON.parse(parsed.identity_json));
  }

  async checkReady(input: Parameters<DeliveryPort['checkReady']>[0]): Promise<DeliveryReadiness> {
    if (
      input.project.id !== this.store.project.id ||
      input.project.hostId !== this.store.project.hostId
    )
      return { kind: 'unsupported', reason: 'Notification belongs to another project or host' };
    const identity = this.identity(input.recipient);
    if (!identity)
      return {
        kind: 'unsupported',
        reason:
          'No active native endpoint is registered for this recipient; read the durable board directly',
      };
    const adapter = this.adapterFor({
      prepare: async () => ({ kind: 'rejected', reason: 'Readiness checks cannot send messages' }),
    });
    const observation = await adapter.invoke('observe', { identity });
    switch (observation.kind) {
      case 'settled':
        return { kind: 'ready' };
      case 'working':
      case 'blocked':
        return { kind: 'busy' };
      case 'manual-required':
        return { kind: 'unsupported', reason: observation.reason };
      case 'unconfirmed':
        return observation;
    }
  }

  async deliver(input: Parameters<DeliveryPort['deliver']>[0]): Promise<DeliverySubmission> {
    const identity = this.identity(input.recipient);
    if (!identity) return { kind: 'unsupported', reason: 'Native recipient is no longer active' };
    const operationId = createHash('sha256')
      .update(JSON.stringify([...input.deliveryIds].sort()))
      .digest('hex');
    const adapter = this.adapterFor({
      prepare: async () =>
        this.store.read((db) => {
          const current = this.identity(input.recipient);
          if (!current || JSON.stringify(current) !== JSON.stringify(identity))
            return { kind: 'rejected', reason: 'Native recipient changed before delivery' };
          for (const id of input.deliveryIds) {
            const claimed = db
              .prepare(
                "SELECT 1 FROM notification_deliveries WHERE project_id=? AND id=? AND state='claimed' AND recipient_kind=? AND recipient_id=? AND recipient_generation IS ?",
              )
              .get(
                this.store.project.id,
                id,
                input.recipient.kind,
                input.recipient.id,
                input.recipient.generation ?? null,
              );
            if (!claimed)
              return {
                kind: 'rejected',
                reason: 'Notification has no current durable delivery claim',
              };
          }
          return { kind: 'prepared', operationId };
        }),
    });
    const submitted = await adapter.invoke('prompt', { identity, text: input.message });
    return submitted.kind === 'submitted' ? { kind: 'submitted' } : submitted;
  }
}
