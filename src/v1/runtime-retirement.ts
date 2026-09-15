import { createHerdrAdapter, type HerdrAdapterFactory } from './adapters/herdr.js';
import { randomUUID } from 'node:crypto';

import type { DatabaseSync } from 'node:sqlite';

import { Effect, Schema } from 'effect';

import {
  AgentSessionIdSchema,
  AttemptIdSchema,
  HostIdSchema,
  SessionGenerationSchema,
  WorkspaceIdSchema,
  type AttemptId,
  type WorkspaceId,
} from './model.js';
import {
  NativeBindingSchema,
  NativeIdentitySchema,
  type NativeBinding,
  type NativeEffect,
  type NativeIdentity,
  type NativeJournal,
  type NativeObservation,
  type PreparedEffect,
} from './native.js';
import type { NativeSessionBindingDraft } from './native-session.js';
import {
  nativeLocatorForRetirement,
  previewWorkspaceRetirement,
  retireWorkspaceEffect,
  type NativeRetirementTarget,
  type RetirementPreview,
  type RetirementResult,
  type WorkspaceRetirementGit,
} from './retirement.js';
import type { SessionIdentity, Store } from './store.js';

const nullable = <S extends Schema.ConstraintDecoder<unknown, never>>(schema: S) =>
  Schema.NullOr(schema);

const decode = <S extends Schema.ConstraintDecoder<unknown, never>, Value>(
  schema: S,
  value: Value,
): S['Type'] => Schema.decodeUnknownSync(schema)(value);

const decodeOrUndefined = <S extends Schema.ConstraintDecoder<unknown, never>, Value>(
  schema: S,
  value: Value,
): S['Type'] | undefined => {
  try {
    return decode(schema, value);
  } catch {
    return undefined;
  }
};

const runtimeAttemptRowSchema = Schema.Struct({
  attempt_id: AttemptIdSchema,
  workspace_id: WorkspaceIdSchema,
  host_id: HostIdSchema,
  session_id: AgentSessionIdSchema,
  session_generation: SessionGenerationSchema,
  attempt_native_kind: nullable(Schema.String),
  attempt_native_server_generation: nullable(Schema.String),
  attempt_native_locator: nullable(Schema.String),
  binding_json: Schema.String,
  identity_json: Schema.String,
  session_workspace_id: nullable(WorkspaceIdSchema),
  session_host_id: HostIdSchema,
  session_state: Schema.Literals(['active', 'settled', 'unconfirmed']),
  native_kind: nullable(Schema.String),
  native_server_generation: nullable(Schema.String),
  native_locator: nullable(Schema.String),
});

type RuntimeAttemptRow = typeof runtimeAttemptRowSchema.Type;

type RuntimeNativeTarget = NativeRetirementTarget & { attemptId: AttemptId };

export type RuntimeRetirementInput = {
  store: Store;
  actor: SessionIdentity;
  workspaceId: WorkspaceId;
  idempotencyKey: string;
  adapterFor?: HerdrAdapterFactory;
  git?: WorkspaceRetirementGit;
};

export type RuntimeRetirementPreviewInput = Omit<RuntimeRetirementInput, 'adapterFor'>;

export class RuntimeRetirementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeRetirementError';
  }
}

export class RuntimeRetirementOperationError extends Schema.TaggedError<RuntimeRetirementOperationError>()(
  'Marionette.RuntimeRetirementOperationError',
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {}

function rejected(reason: string): PreparedEffect {
  return { kind: 'rejected', reason };
}

function prepared(operationId: string): PreparedEffect {
  return { kind: 'prepared', operationId };
}

function sameBinding(left: NativeBinding, right: NativeBinding): boolean {
  return (
    left.hostId === right.hostId &&
    left.socketPath === right.socketPath &&
    left.workspaceId === right.workspaceId &&
    left.endpoint.device === right.endpoint.device &&
    left.endpoint.inode === right.endpoint.inode &&
    left.endpoint.birthtimeMs === right.endpoint.birthtimeMs &&
    left.endpoint.serverStartToken === right.endpoint.serverStartToken &&
    left.endpoint.protocol === right.endpoint.protocol &&
    left.endpoint.endpointProtocolGeneration === right.endpoint.endpointProtocolGeneration
  );
}

function runtimeAttemptRows(store: Store, workspaceId: WorkspaceId): RuntimeAttemptRow[] {
  return store.read((database) =>
    database
      .prepare(
        `SELECT a.id AS attempt_id, a.workspace_id, a.host_id, a.session_id,
                a.session_generation, a.native_kind AS attempt_native_kind,
                a.native_server_generation AS attempt_native_server_generation,
                a.native_locator AS attempt_native_locator, n.binding_json, n.identity_json,
                s.workspace_id AS session_workspace_id, s.host_id AS session_host_id,
                s.state AS session_state, s.native_kind, s.native_server_generation,
                s.native_locator
         FROM attempts a
         JOIN native_attempts n ON n.project_id = a.project_id AND n.attempt_id = a.id
         JOIN agent_sessions s ON s.project_id = a.project_id
                             AND s.id = a.session_id
                             AND s.generation = a.session_generation
         WHERE a.project_id = ? AND a.workspace_id = ? AND n.identity_json IS NOT NULL`,
      )
      .all(store.project.id, workspaceId)
      .map((row) => decode(runtimeAttemptRowSchema, row)),
  );
}

function targetForRow(
  store: Store,
  workspaceId: WorkspaceId,
  row: RuntimeAttemptRow,
): RuntimeNativeTarget {
  const binding = decode(NativeBindingSchema, JSON.parse(row.binding_json));
  const identity = decode(NativeIdentitySchema, JSON.parse(row.identity_json));
  const session: SessionIdentity = { id: row.session_id, generation: row.session_generation };

  if (
    row.workspace_id !== workspaceId ||
    row.host_id !== store.project.hostId ||
    row.session_workspace_id !== workspaceId ||
    row.session_host_id !== store.project.hostId ||
    !sameBinding(binding, identity.binding) ||
    identity.binding.hostId !== store.project.hostId ||
    identity.binding.workspaceId !== workspaceId ||
    identity.tabId !== identity.ownedTabId ||
    row.attempt_native_kind !== identity.agentKind ||
    row.attempt_native_server_generation !== identity.binding.endpoint.serverStartToken ||
    row.attempt_native_locator !== nativeLocatorForRetirement(identity) ||
    row.native_kind !== identity.agentKind ||
    row.native_server_generation !== identity.binding.endpoint.serverStartToken ||
    row.native_locator !== nativeLocatorForRetirement(identity)
  ) {
    throw new RuntimeRetirementError(
      `Native attempt ${row.attempt_id} does not match its persisted session binding`,
    );
  }

  return { attemptId: row.attempt_id, session, identity };
}

function nativeTargets(input: RuntimeRetirementInput): RuntimeNativeTarget[] {
  const targets = runtimeAttemptRows(input.store, input.workspaceId).map((row) =>
    targetForRow(input.store, input.workspaceId, row),
  );

  const sessions = new Set<string>();
  const tabs = new Set<string>();

  for (const target of targets) {
    const session = `${target.session.id}\u0000${target.session.generation}`;

    if (sessions.has(session))
      throw new RuntimeRetirementError(`Session ${target.session.id} has multiple native attempts`);

    if (tabs.has(target.identity.ownedTabId))
      throw new RuntimeRetirementError(
        `Native tab ${target.identity.ownedTabId} belongs to multiple runtime attempts`,
      );
    sessions.add(session);
    tabs.add(target.identity.ownedTabId);
  }

  return targets;
}

/** Plans retirement from Runtime's persisted native bindings without constructing an adapter. */
export function previewRuntimeWorkspaceRetirement(
  input: RuntimeRetirementPreviewInput,
): RetirementPreview {
  try {
    return previewWorkspaceRetirement({
      store: input.store,
      actor: input.actor,
      workspaceId: input.workspaceId,
      idempotencyKey: input.idempotencyKey,
      nativeTargets: nativeTargets(input),
      git: input.git,
    });
  } catch (error) {
    return {
      kind: 'blocked',
      workspaceId: input.workspaceId,
      reason: error instanceof Error ? error.message : 'Runtime retirement preview is unavailable',
      nativeTargets: [],
      effects: [],
      skippedChecks: [],
    };
  }
}

function requireCleanupEffect(
  effect: NativeEffect,
  target: RuntimeNativeTarget,
): string | undefined {
  if (effect.kind !== 'cleanup') return 'Runtime retirement only prepares native cleanup effects';

  if (effect.tabId !== target.identity.ownedTabId)
    return 'Native cleanup tab does not match its persisted runtime identity';

  return undefined;
}

function requireActor(
  database: DatabaseSync,
  store: Store,
  actor: SessionIdentity,
): string | undefined {
  const row = decodeOrUndefined(
    Schema.Struct({
      role: Schema.Literals(['user', 'controller', 'worker']),
      state: Schema.String,
    }),
    database
      .prepare(
        `SELECT role, state FROM agent_sessions
           WHERE project_id = ? AND id = ? AND generation = ?`,
      )
      .get(store.project.id, actor.id, actor.generation),
  );

  if (row === undefined || row.state !== 'active' || row.role === 'worker')
    return 'An active user or controller is required for native retirement cleanup';

  return undefined;
}

function cleanupJournal(
  input: RuntimeRetirementInput,
  targets: readonly RuntimeNativeTarget[],
): NativeJournal {
  const byTab = new Map(targets.map((target) => [target.identity.ownedTabId, target]));

  const prepareEffect = Effect.fn('RuntimeRetirement.prepareCleanup')(function* (
    effect: NativeEffect,
  ) {
    if (effect.kind !== 'cleanup')
      return rejected('Runtime retirement only prepares native cleanup effects');
    const target = byTab.get(effect.tabId);

    if (!target) return rejected('Native cleanup target is not a persisted runtime identity');
    const effectError = requireCleanupEffect(effect, target);

    if (effectError) return rejected(effectError);

    return yield* Effect.try({
      try: () =>
        input.store.transaction((database) => {
          const actorError = requireActor(database, input.store, input.actor);

          if (actorError) return rejected(actorError);

          const rows = database
            .prepare(
              `SELECT a.id AS attempt_id, a.workspace_id, a.host_id, a.session_id,
                    a.session_generation, a.native_kind AS attempt_native_kind,
                    a.native_server_generation AS attempt_native_server_generation,
                    a.native_locator AS attempt_native_locator, n.binding_json, n.identity_json,
                    s.workspace_id AS session_workspace_id, s.host_id AS session_host_id,
                    s.state AS session_state, s.native_kind, s.native_server_generation,
                    s.native_locator
             FROM attempts a
             JOIN native_attempts n ON n.project_id = a.project_id AND n.attempt_id = a.id
             JOIN agent_sessions s ON s.project_id = a.project_id
                                 AND s.id = a.session_id
                                 AND s.generation = a.session_generation
             WHERE a.project_id = ? AND a.id = ? AND n.identity_json IS NOT NULL`,
            )
            .all(input.store.project.id, target.attemptId)
            .map((row) => decode(runtimeAttemptRowSchema, row));

          const current = rows.at(0);

          if (!current || rows.length !== 1)
            return rejected('Native runtime attempt changed before cleanup');

          try {
            const persisted = targetForRow(input.store, input.workspaceId, current);

            if (
              persisted.session.id !== target.session.id ||
              persisted.session.generation !== target.session.generation ||
              nativeLocatorForRetirement(persisted.identity) !==
                nativeLocatorForRetirement(target.identity)
            )
              return rejected('Native runtime identity changed before cleanup');
          } catch (error) {
            return rejected(
              error instanceof Error ? error.message : 'Native runtime identity is unavailable',
            );
          }

          const prior = database
            .prepare(
              `SELECT id FROM native_effects
             WHERE project_id = ? AND attempt_id = ? AND effect_kind = 'cleanup'`,
            )
            .get(input.store.project.id, target.attemptId);

          if (prior)
            return rejected(
              'Native cleanup was already claimed; inspect its outcome before retrying',
            );
          const operationId = randomUUID();
          database
            .prepare(
              `INSERT INTO native_effects
               (id, project_id, attempt_id, effect_kind, effect_json, created_at)
             VALUES (?, ?, ?, 'cleanup', ?, ?)`,
            )
            .run(
              operationId,
              input.store.project.id,
              target.attemptId,
              JSON.stringify(effect),
              new Date().toISOString(),
            );

          return prepared(operationId);
        }),
      catch: (cause) =>
        new RuntimeRetirementOperationError({
          operation: 'RuntimeRetirement.prepareCleanup',
          cause,
        }),
    });
  });

  return {
    prepareEffect,
    prepare: (effect) => Effect.runPromise(prepareEffect(effect)),
  };
}

function persistRetirementObservation(
  input: RuntimeRetirementInput,
  target: RuntimeNativeTarget,
  priorIdentity: NativeIdentity,
  observation: NativeObservation,
): void {
  const identity = 'identity' in observation ? observation.identity : priorIdentity;

  if ('identity' in observation) {
    input.store.transaction((database) =>
      database
        .prepare(
          'UPDATE native_attempts SET identity_json=?,last_observation_json=?,updated_at=? WHERE project_id=? AND attempt_id=?',
        )
        .run(
          JSON.stringify(observation.identity),
          JSON.stringify(observation),
          new Date().toISOString(),
          input.store.project.id,
          target.attemptId,
        ),
    );
  }

  const attempt = input.store.getAttempt(target.attemptId);

  if (!attempt.nativeKind || !attempt.nativeServerGeneration) return;
  const candidate = observation.kind === 'unconfirmed' ? observation.candidate : undefined;
  const reference = candidate?.reference ?? identity.sessionReference;

  if (!reference) return;

  const binding: NativeSessionBindingDraft = {
    workspaceId: identity.binding.workspaceId,
    tabId: identity.tabId,
    paneId: identity.paneId,
    terminalId: identity.terminalId,
    identityRevision: candidate?.identityRevision ?? identity.identityRevision,
  };

  if (identity.foregroundProcess) binding.foregroundProcess = identity.foregroundProcess;

  if (identity.binding.endpoint.endpointProtocolGeneration !== undefined)
    binding.endpointProtocolGeneration = identity.binding.endpoint.endpointProtocolGeneration;

  const record: Parameters<typeof input.store.recordNativeSessionReference>[0] = {
    actor: input.actor,
    attemptId: target.attemptId,
    nativeKind: attempt.nativeKind,
    nativeServerGeneration: attempt.nativeServerGeneration,
    reference,
    status: candidate ? 'unconfirmed' : 'confirmed',
    binding,
  };

  if (observation.kind === 'unconfirmed' && candidate) record.rejectionReason = observation.reason;

  input.store.recordNativeSessionReference(record);
}

/**
 * Retires a workspace using only native identities persisted by Runtime.
 * A prior cleanup claim is intentionally left unconfirmed rather than retried.
 */
export const retireRuntimeWorkspaceEffect = Effect.fn('RuntimeRetirement.retireWorkspace')(
  function* (input: RuntimeRetirementInput) {
    const targets = yield* Effect.try({
      try: () => nativeTargets(input),
      catch: (cause) =>
        new RuntimeRetirementOperationError({
          operation: 'RuntimeRetirement.loadNativeTargets',
          cause,
        }),
    });

    const adapter = targets.length
      ? (input.adapterFor ?? createHerdrAdapter)(cleanupJournal(input, targets))
      : undefined;

    return yield* retireWorkspaceEffect({
      store: input.store,
      actor: input.actor,
      workspaceId: input.workspaceId,
      idempotencyKey: input.idempotencyKey,
      nativeTargets: targets,
      nativeAdapter: adapter
        ? {
            observe: async (identity) => {
              const target = targets.find(
                (candidate) =>
                  nativeLocatorForRetirement(candidate.identity) === nativeLocatorForRetirement(identity),
              );

              const observation = await adapter.invoke('observe', { identity });

              if (target) persistRetirementObservation(input, target, identity, observation);

              return observation;
            },
            cleanup: (identity, authorized) => adapter.invoke('cleanup', { identity, authorized }),
          }
        : undefined,
      git: input.git,
    });
  },
);

export function retireRuntimeWorkspace(input: RuntimeRetirementInput): Promise<RetirementResult> {
  return Effect.runPromise(
    retireRuntimeWorkspaceEffect(input).pipe(Effect.mapError((error) => error.cause)),
  );
}
