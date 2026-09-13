import { createHash } from 'node:crypto';
import { Effect, Schema } from 'effect';
import { createHerdrAdapter, type HerdrAdapterFactory } from './adapters/herdr.js';
import type { BoardRecipient } from './board.js';
import {
  NativeIdentitySchema,
  type NativeIdentity,
  type PreparedEffect,
} from './native.js';
import type { Store } from './store.js';
import {
  WatcherError,
  type DeliveryEffectPort,
  type DeliveryPromisePort,
  type DeliveryReadiness,
  type DeliverySubmission,
} from './watcher.js';

type CheckReadyInput = Parameters<DeliveryEffectPort['checkReadyEffect']>[0];
type DeliverInput = Parameters<DeliveryEffectPort['deliverEffect']>[0];

const identityRowSchema = Schema.Struct({
  identity_json: Schema.NullOr(Schema.String),
  state: Schema.String,
  brief_revision: Schema.Finite,
  current_brief_revision: Schema.Finite,
  workflow_phase: Schema.NullOr(Schema.String),
});
const decode = <S extends Schema.ConstraintDecoder<unknown, never>>(schema: S, value: unknown): S['Type'] =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })(value);
const watcherError = (operation: string, cause: unknown) =>
  new WatcherError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
const sync = <A>(operation: string, evaluate: () => A) =>
  Effect.try({ try: evaluate, catch: (cause) => watcherError(operation, cause) });

export class NativeBoardDelivery implements DeliveryEffectPort, DeliveryPromisePort {
  constructor(
    private readonly store: Store,
    private readonly adapterFor: HerdrAdapterFactory = createHerdrAdapter,
  ) {}

  private identity(recipient: BoardRecipient): NativeIdentity | null {
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
    const parsed = decode(identityRowSchema, row);
    if (
      !parsed.identity_json ||
      parsed.state !== 'active' ||
      parsed.brief_revision !== parsed.current_brief_revision ||
      (parsed.workflow_phase !== null && parsed.workflow_phase !== 'running')
    ) {
      return null;
    }
    return decode(NativeIdentitySchema, JSON.parse(parsed.identity_json));
  }

  readonly checkReadyEffect = Effect.fn('NativeBoardDelivery.checkReady')(
    function* (this: NativeBoardDelivery, input: CheckReadyInput) {
      if (
        input.project.id !== this.store.project.id ||
        input.project.hostId !== this.store.project.hostId
      ) {
        return { kind: 'unsupported', reason: 'Notification belongs to another project or host' } as const;
      }
      const identity = yield* sync('NativeBoardDelivery.checkReady.identity', () =>
        this.identity(input.recipient),
      );
      if (!identity) {
        return {
          kind: 'unsupported',
          reason:
            'No active native endpoint is registered for this recipient; read the durable board directly',
        } as const;
      }
      const adapter = this.adapterFor({
        prepare: async () => ({
          kind: 'rejected',
          reason: 'Readiness checks cannot send messages',
        }),
        prepareEffect: () =>
          Effect.succeed({
            kind: 'rejected',
            reason: 'Readiness checks cannot send messages',
          }),
      });
      const observation = yield* adapter.invokeEffect('observe', { identity }).pipe(
        Effect.mapError((cause) => watcherError('NativeBoardDelivery.checkReady.observe', cause)),
      );
      switch (observation.kind) {
        case 'settled':
          return { kind: 'ready' } as const;
        case 'working':
        case 'blocked':
          return { kind: 'busy' } as const;
        case 'manual-required':
          return { kind: 'unsupported', reason: observation.reason } as const;
        case 'unconfirmed':
          return observation;
      }
    }.bind(this),
  );

  checkReady(input: CheckReadyInput): Promise<DeliveryReadiness> {
    return Effect.runPromise(this.checkReadyEffect(input));
  }

  readonly deliverEffect = Effect.fn('NativeBoardDelivery.deliver')(
    function* (this: NativeBoardDelivery, input: DeliverInput) {
      const identity = yield* sync('NativeBoardDelivery.deliver.identity', () =>
        this.identity(input.recipient),
      );
      if (!identity) {
        return { kind: 'unsupported', reason: 'Native recipient is no longer active' } as const;
      }
      const operationId = createHash('sha256')
        .update(JSON.stringify([...input.deliveryIds].sort()))
        .digest('hex');
      const prepare = (): PreparedEffect =>
        this.store.read((db) => {
          const current = this.identity(input.recipient);
          if (!current || JSON.stringify(current) !== JSON.stringify(identity)) {
            return { kind: 'rejected', reason: 'Native recipient changed before delivery' };
          }
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
            if (!claimed) {
              return {
                kind: 'rejected',
                reason: 'Notification has no current durable delivery claim',
              };
            }
          }
          return { kind: 'prepared', operationId };
        });
      const adapter = this.adapterFor({
        prepare: async () => prepare(),
        prepareEffect: () => sync('NativeBoardDelivery.deliver.prepare', prepare),
      });
      const submitted = yield* adapter.invokeEffect('prompt', {
        identity,
        text: input.message,
      }).pipe(
        Effect.mapError((cause) => watcherError('NativeBoardDelivery.deliver.prompt', cause)),
      );
      return submitted.kind === 'submitted' ? ({ kind: 'submitted' } as const) : submitted;
    }.bind(this),
  );

  deliver(input: DeliverInput): Promise<DeliverySubmission> {
    return Effect.runPromise(this.deliverEffect(input));
  }
}
