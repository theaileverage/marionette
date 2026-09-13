import { z } from 'zod';
import { HarnessCatalog } from '../harnesses/index.js';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { Store, SessionIdentity } from '../store.js';
import { canonicalJson } from '../database.js';
import { writeSessionContext } from '../context.js';
import {
  HerdrNativeAdapter,
  NativeBindingSchema,
  NativeIdentitySchema,
  type NativeJournal,
  type NativeBinding,
  type LaunchRequest,
} from '../native.js';
import { ControllerStore, requireControlActor } from './controller-store.js';
import { buildControllerContext } from './context-builder.js';
import { ControllerInbox, type InboxClaim } from '../inbox/controller-inbox.js';
/** Native driver factory is injectable for crash tests; default uses exact Herdr identity inspection. */
export class ControllerRuntime {
  constructor(
    readonly store: Store,
    readonly bindingPath: string,
    readonly driverFor = (journal: NativeJournal) => new HerdrNativeAdapter(journal),
  ) {}
  private journal(
    actor: SessionIdentity,
    controllerId: string,
    generation: number,
    expectedRevision: number,
    routeId?: string,
    claims?: InboxClaim[],
  ): NativeJournal {
    return {
      prepare: async (effect) =>
        this.store.transaction((db) => {
          requireControlActor(this.store, db, actor, true);
          if (claims)
            for (const claim of claims) new ControllerInbox(this.store).requireClaim(db, claim);
          const storedRoute = db
            .prepare(
              'SELECT route_decision_id FROM controller_incarnations WHERE controller_id=? AND generation=?',
            )
            .get(controllerId, generation)?.route_decision_id;
          const route = routeId ?? (storedRoute ? String(storedRoute) : undefined);
          if (!route)
            return {
              kind: 'rejected' as const,
              reason: 'controller native effect requires a persisted route',
            };
          new HarnessCatalog(this.store, actor).validateRoute(route);
          const row = db
            .prepare(
              'SELECT * FROM controller_definitions WHERE project_id=? AND id=? AND current_generation=? AND state_revision=?',
            )
            .get(this.store.project.id, controllerId, generation, expectedRevision);
          if (!row)
            return {
              kind: 'rejected' as const,
              reason: 'controller authority changed before native effect',
            };
          const id = randomUUID();
          db.prepare(
            `INSERT INTO controller_native_effects(
              id,project_id,controller_id,generation,effect_json,state,created_at,inbox_claims_json,
              receipt_json,settled_at
            ) VALUES(?,?,?,?,?,'claimed',?,?,NULL,NULL)`,
          ).run(
            id,
            this.store.project.id,
            controllerId,
            generation,
            canonicalJson(effect),
            new Date().toISOString(),
            claims
              ? canonicalJson(
                  claims.map((claim) => ({ id: claim.id, claimRevision: claim.claimRevision })),
                )
              : null,
          );
          if (claims)
            for (const claim of claims)
              db.prepare("UPDATE controller_inbox_items SET state='submitted' WHERE id=?").run(
                claim.id,
              );
          return { kind: 'prepared' as const, operationId: id };
        }),
    };
  }
  async ensure(input: {
    actor: SessionIdentity;
    expectedRevision: number;
    routeId: string;
    idempotencyKey: string;
    binding: NativeBinding;
    request: LaunchRequest;
  }) {
    NativeBindingSchema.parse(input.binding);
    if (
      input.binding.hostId !== this.store.project.hostId ||
      input.request.cwd !== this.store.project.repositoryRoot
    )
      throw new Error('controller launch project/host mismatch');
    const controllers = new ControllerStore(this.store);
    const status = controllers.status();
    if (!status) throw new Error('configure controller first');
    const context = buildControllerContext(this.store, String(status.id));
    const admission = this.store.transaction((db) => {
      requireControlActor(this.store, db, input.actor, true);
      return this.store.idempotent(
        'controller-runtime-ensure',
        input.idempotencyKey,
        input,
        z.object({
          controllerId: z.string(),
          generation: z.number().int().positive(),
          contextPath: z.string(),
        }),
        () => {
          const route = new HarnessCatalog(this.store, input.actor).validateRoute(input.routeId);
          const routeBinding = z.string().parse(route.observation.locator.binding);
          if (
            route.adapter.id !== 'herdr' ||
            route.adapter.version !== 1 ||
            route.profile.native.kind !== input.request.agentKind ||
            canonicalJson(route.profile.native.args) !== canonicalJson(input.request.args ?? []) ||
            canonicalJson(NativeBindingSchema.parse(JSON.parse(routeBinding))) !==
              canonicalJson(input.binding)
          )
            throw new Error('controller route does not match native binding');
          const incarnation = controllers.ensure({
            actor: input.actor,
            expectedRevision: input.expectedRevision,
            adapter: { id: 'herdr', version: 1 },
            endpointGeneration: input.binding.endpoint.serverStartToken,
            stateDigest: context.digest,
          });
          this.store.transaction((db) =>
            db
              .prepare(
                'UPDATE controller_incarnations SET route_decision_id=? WHERE controller_id=? AND generation=?',
              )
              .run(input.routeId, incarnation.controllerId, incarnation.generation),
          );
          const contextPath = writeSessionContext({
            stateDirectory: this.store.project.stateDirectory,
            context: {
              version: 1,
              bindingPath: this.bindingPath,
              projectId: this.store.project.id,
              hostId: this.store.project.hostId,
              sessionId: incarnation.session.id,
              generation: incarnation.session.generation,
              token: incarnation.token,
            },
          });
          return {
            controllerId: incarnation.controllerId,
            generation: incarnation.generation,
            contextPath,
          };
        },
      );
    });
    const incarnation = admission.value;
    if (admission.replayed)
      return {
        controllerId: incarnation.controllerId,
        generation: incarnation.generation,
        replayed: true,
        result: { kind: 'reconciliation-required' as const },
      };
    const expectedRevision = input.expectedRevision + 1;
    try {
      const contextPath = incarnation.contextPath;
      const driver = this.driverFor(
        this.journal(
          input.actor,
          incarnation.controllerId,
          incarnation.generation,
          expectedRevision,
          input.routeId,
        ),
      );
      const result = await driver.launch(input.binding, {
        ...input.request,
        env: {
          ...input.request.env,
          MARIONETTE_CONTEXT: contextPath,
          MARIONETTE_STATE_HOME: dirname(dirname(this.store.project.stateDirectory)),
        },
      });
      if (result.kind === 'launched')
        this.store.transaction((db) => {
          controllers.reconcile({
            actor: input.actor,
            ...incarnation,
            expectedRevision,
            observation: {
              kind: 'active',
              nativeIdentity: {
                kind: 'herdr',
                serverGeneration: result.identity.binding.endpoint.serverStartToken,
                locator: canonicalJson(result.identity),
              },
            },
          });
          db.prepare(
            `UPDATE controller_native_effects
             SET state='settled',receipt_json=?,settled_at=?
             WHERE controller_id=? AND generation=? AND state='claimed' AND inbox_claims_json IS NULL
             AND json_extract(effect_json,'$.kind') IN ('create-tab','start-agent')`,
          ).run(
            canonicalJson({ kind: 'launched', identity: result.identity }),
            new Date().toISOString(),
            incarnation.controllerId,
            incarnation.generation,
          );
        });
      else
        controllers.reconcile({
          actor: input.actor,
          ...incarnation,
          expectedRevision,
          observation: { kind: 'unconfirmed', reason: result.reason },
        });
      return { controllerId: incarnation.controllerId, generation: incarnation.generation, result };
    } catch (error) {
      try {
        controllers.reconcile({
          actor: input.actor,
          ...incarnation,
          expectedRevision,
          observation: { kind: 'unconfirmed', reason: String(error) },
        });
      } catch {
        /* A changed revision must not be overwritten. */
      }
      throw error;
    }
  }
  async submit(input: { actor: SessionIdentity; claims: InboxClaim[]; expectedRevision: number }) {
    if (input.claims.length === 0 || input.claims.length > 50)
      throw new Error('bounded claims required');
    const first = input.claims[0]!;
    const inbox = new ControllerInbox(this.store);
    const identity = this.store.transaction((db) => {
      requireControlActor(this.store, db, input.actor, true);
      for (const claim of input.claims) {
        if (
          claim.controllerId !== first.controllerId ||
          claim.controllerGeneration !== first.controllerGeneration
        )
          throw new Error('mixed controller batch');
        const current = inbox.requireClaim(db, claim);
        if (current.state !== 'claimed')
          throw new Error(
            'submitted controller turn requires reconciliation before another prompt',
          );
      }
      const row = db
        .prepare(
          'SELECT native_identity_json FROM controller_incarnations WHERE controller_id=? AND generation=?',
        )
        .get(first.controllerId, first.controllerGeneration);
      const binding = z
        .object({ locator: z.string().min(1) })
        .parse(JSON.parse(String(row?.native_identity_json)));
      return NativeIdentitySchema.parse(JSON.parse(binding.locator));
    });
    const context = buildControllerContext(this.store, first.controllerId);
    const driver = this.driverFor(
      this.journal(
        input.actor,
        first.controllerId,
        first.controllerGeneration,
        input.expectedRevision,
        undefined,
        input.claims,
      ),
    );
    return driver.prompt(
      identity,
      `Run one bounded Chief of Staff decision cycle for inbox claims ${canonicalJson(input.claims)}. Read these canonical records with inbox.read and ids ${canonicalJson(input.claims.map((claim) => claim.id))}. Commit structured decisions with durable receipts; prompt submission is not acknowledgement. State digest ${context.digest}: ${context.text}`,
    );
  }
  async observe(input: {
    actor: SessionIdentity;
    controllerId: string;
    generation: number;
    expectedRevision: number;
  }) {
    const row = this.store.read((db) =>
      db
        .prepare(
          'SELECT native_identity_json FROM controller_incarnations WHERE controller_id=? AND generation=?',
        )
        .get(input.controllerId, input.generation),
    );
    if (!row?.native_identity_json)
      throw new Error('no exact native identity; manual reconciliation required');
    const saved = z
      .object({ locator: z.string().min(1) })
      .parse(JSON.parse(String(row.native_identity_json)));
    const identity = NativeIdentitySchema.parse(JSON.parse(saved.locator));
    const result = await this.driverFor(
      this.journal(input.actor, input.controllerId, input.generation, input.expectedRevision),
    ).observe(identity);
    if (result.kind === 'unconfirmed')
      new ControllerStore(this.store).reconcile({
        ...input,
        observation: {
          kind: result.kind,
          reason: result.reason,
        },
      });
    return result;
  }
  async replace(input: {
    actor: SessionIdentity;
    controllerId: string;
    generation: number;
    expectedRevision: number;
    reason: string;
    idempotencyKey: string;
  }) {
    const request = canonicalJson({
      controllerId: input.controllerId,
      generation: input.generation,
      expectedRevision: input.expectedRevision,
      reason: input.reason,
    });
    const replay = this.store.read((db) =>
      db
        .prepare(
          'SELECT * FROM controller_incarnation_retirements WHERE project_id=? AND idempotency_key=?',
        )
        .get(this.store.project.id, input.idempotencyKey),
    );
    if (replay) {
      if (replay.request_json !== request)
        throw new Error('controller replacement idempotency conflict');
      return {
        id: String(replay.id),
        controllerId: String(replay.controller_id),
        generation: Number(replay.generation),
        createdAt: String(replay.created_at),
      };
    }
    const row = this.store.read((db) =>
      db
        .prepare(
          'SELECT native_identity_json FROM controller_incarnations WHERE controller_id=? AND generation=?',
        )
        .get(input.controllerId, input.generation),
    );
    if (!row?.native_identity_json)
      throw new Error('controller replacement requires an exact persisted native identity');
    const encoded = String(row.native_identity_json);
    const saved = z.object({ locator: z.string().min(1) }).parse(JSON.parse(encoded));
    const identity = NativeIdentitySchema.parse(JSON.parse(saved.locator));
    const observation = await this.driverFor(
      this.journal(input.actor, input.controllerId, input.generation, input.expectedRevision),
    ).observe(identity);
    if (
      observation.kind !== 'settled' ||
      canonicalJson(observation.identity) !== canonicalJson(identity)
    )
      throw new Error('controller replacement requires exact native idle settlement');
    return new ControllerStore(this.store).replace({
      ...input,
      nativeIdentity: encoded,
    });
  }
}
