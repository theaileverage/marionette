import { randomUUID } from 'node:crypto';

import type { DatabaseSync } from 'node:sqlite';

import { z } from 'zod';

import {
  AgentSessionIdSchema,
  AttemptIdSchema,
  HostIdSchema,
  SessionGenerationSchema,
  WorkspaceIdSchema,
  type WorkspaceId,
} from './model.js';
import {
  HerdrNativeAdapter,
  NativeBindingSchema,
  NativeIdentitySchema,
  type NativeBinding,
  type NativeEffect,
  type NativeJournal,
} from './native.js';
import {
  nativeLocatorForRetirement,
  retireWorkspace,
  type NativeRetirementTarget,
  type RetirementResult,
  type WorkspaceRetirementGit,
} from './retirement.js';
import type { SessionIdentity, Store } from './store.js';

const runtimeAttemptRowSchema = z.object({
  attempt_id: AttemptIdSchema,
  workspace_id: WorkspaceIdSchema,
  host_id: HostIdSchema,
  session_id: AgentSessionIdSchema,
  session_generation: SessionGenerationSchema,
  attempt_native_kind: z.string().nullable(),
  attempt_native_server_generation: z.string().nullable(),
  attempt_native_locator: z.string().nullable(),
  binding_json: z.string(),
  identity_json: z.string(),
  session_workspace_id: WorkspaceIdSchema.nullable(),
  session_host_id: HostIdSchema,
  session_state: z.enum(['active', 'settled', 'unconfirmed']),
  native_kind: z.string().nullable(),
  native_server_generation: z.string().nullable(),
  native_locator: z.string().nullable(),
});
type RuntimeAttemptRow = z.infer<typeof runtimeAttemptRowSchema>;

type RuntimeNativeTarget = NativeRetirementTarget & { attemptId: string };

export type RuntimeRetirementAdapterFactory = (journal: NativeJournal) => HerdrNativeAdapter;

export type RuntimeRetirementInput = {
  store: Store;
  actor: SessionIdentity;
  workspaceId: WorkspaceId;
  idempotencyKey: string;
  adapterFor?: RuntimeRetirementAdapterFactory;
  git?: WorkspaceRetirementGit;
};

export class RuntimeRetirementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeRetirementError';
  }
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
      .map((row) => runtimeAttemptRowSchema.parse(row)),
  );
}

function targetForRow(
  store: Store,
  workspaceId: WorkspaceId,
  row: RuntimeAttemptRow,
): RuntimeNativeTarget {
  const binding = NativeBindingSchema.parse(JSON.parse(row.binding_json));
  const identity = NativeIdentitySchema.parse(JSON.parse(row.identity_json));
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
  const row = z
    .object({ role: z.enum(['user', 'controller', 'worker']), state: z.string() })
    .safeParse(
      database
        .prepare(
          `SELECT role, state FROM agent_sessions
           WHERE project_id = ? AND id = ? AND generation = ?`,
        )
        .get(store.project.id, actor.id, actor.generation),
    );
  if (!row.success || row.data.state !== 'active' || row.data.role === 'worker')
    return 'An active user or controller is required for native retirement cleanup';
  return undefined;
}

function cleanupJournal(
  input: RuntimeRetirementInput,
  targets: readonly RuntimeNativeTarget[],
): NativeJournal {
  const byTab = new Map(targets.map((target) => [target.identity.ownedTabId, target]));
  return {
    prepare: async (effect) => {
      if (effect.kind !== 'cleanup')
        return {
          kind: 'rejected',
          reason: 'Runtime retirement only prepares native cleanup effects',
        };
      const target = byTab.get(effect.tabId);
      if (!target)
        return {
          kind: 'rejected',
          reason: 'Native cleanup target is not a persisted runtime identity',
        };
      const effectError = requireCleanupEffect(effect, target);
      if (effectError) return { kind: 'rejected', reason: effectError };
      return input.store.transaction((database) => {
        const actorError = requireActor(database, input.store, input.actor);
        if (actorError) return { kind: 'rejected' as const, reason: actorError };
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
          .map((row) => runtimeAttemptRowSchema.parse(row));
        const current = rows.at(0);
        if (!current || rows.length !== 1)
          return {
            kind: 'rejected' as const,
            reason: 'Native runtime attempt changed before cleanup',
          };
        try {
          const persisted = targetForRow(input.store, input.workspaceId, current);
          if (
            persisted.session.id !== target.session.id ||
            persisted.session.generation !== target.session.generation ||
            nativeLocatorForRetirement(persisted.identity) !==
              nativeLocatorForRetirement(target.identity)
          )
            return {
              kind: 'rejected' as const,
              reason: 'Native runtime identity changed before cleanup',
            };
        } catch (error) {
          return {
            kind: 'rejected' as const,
            reason:
              error instanceof Error ? error.message : 'Native runtime identity is unavailable',
          };
        }
        const prior = database
          .prepare(
            `SELECT id FROM native_effects
             WHERE project_id = ? AND attempt_id = ? AND effect_kind = 'cleanup'`,
          )
          .get(input.store.project.id, target.attemptId);
        if (prior)
          return {
            kind: 'rejected' as const,
            reason: 'Native cleanup was already claimed; inspect its outcome before retrying',
          };
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
        return { kind: 'prepared' as const, operationId };
      });
    },
  };
}

/**
 * Retires a workspace using only native identities persisted by Runtime.
 * A prior cleanup claim is intentionally left unconfirmed rather than retried.
 */
export async function retireRuntimeWorkspace(
  input: RuntimeRetirementInput,
): Promise<RetirementResult> {
  const targets = nativeTargets(input);
  const adapter = targets.length
    ? (input.adapterFor ?? ((journal) => new HerdrNativeAdapter(journal)))(
        cleanupJournal(input, targets),
      )
    : undefined;
  return retireWorkspace({
    store: input.store,
    actor: input.actor,
    workspaceId: input.workspaceId,
    idempotencyKey: input.idempotencyKey,
    nativeTargets: targets,
    nativeAdapter: adapter,
    git: input.git,
  });
}
