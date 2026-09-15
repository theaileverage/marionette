import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { Effect, Schema } from 'effect';

import { captureGitState } from './git.js';
import {
  AgentSessionIdSchema,
  DigestSchema,
  EvidenceSchema,
  HostIdSchema,
  ProjectIdSchema,
  SessionGenerationSchema,
  TimestampSchema,
  VerificationSchema,
  WorkspaceIdSchema,
  type WorkspaceId,
} from './model.js';
import {
  NativeIdentitySchema,
  type CleanupResult,
  type NativeIdentity,
  type NativeObservation,
} from './native.js';
import type { SessionIdentity, Store, Workspace } from './store.js';

const nonEmptyString = Schema.String.check(Schema.isMinLength(1));
const integer = Schema.Finite.check(
  Schema.makeFilter(Number.isInteger, { expected: 'an integer' }),
);
const nonnegativeInteger = integer.check(Schema.isGreaterThanOrEqualTo(0));
const positiveInteger = integer.check(Schema.isGreaterThan(0));
const nullable = <S extends Schema.ConstraintDecoder<unknown, never>>(schema: S) =>
  Schema.NullOr(schema);
const decode = <S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  value: unknown,
): S['Type'] => Schema.decodeUnknownSync(schema)(value);
const decodeOrUndefined = <S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  value: unknown,
): S['Type'] | undefined => {
  try {
    return decode(schema, value);
  } catch {
    return undefined;
  }
};

const RetirementIdSchema = nonEmptyString.pipe(Schema.brand('RetirementId'));
export type RetirementId = typeof RetirementIdSchema.Type;

const RetirementStateSchema = Schema.Literals([
  'pending',
  'native-closing',
  'worktree-removing',
  'completed',
  'unconfirmed',
  'blocked',
]);
export type RetirementState = typeof RetirementStateSchema.Type;

const retirementRowSchema = Schema.Struct({
  id: RetirementIdSchema,
  project_id: ProjectIdSchema,
  workspace_id: WorkspaceIdSchema,
  expected_host_id: HostIdSchema,
  expected_path: nonEmptyString,
  expected_workspace_created_at: TimestampSchema,
  idempotency_key: nonEmptyString,
  state: RetirementStateSchema,
  revision: positiveInteger,
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
  completed_at: nullable(TimestampSchema),
  last_error: nullable(Schema.String),
});
type RetirementRow = typeof retirementRowSchema.Type;

const workspaceRowSchema = Schema.Struct({
  id: WorkspaceIdSchema,
  project_id: ProjectIdSchema,
  host_id: HostIdSchema,
  kind: Schema.Literals(['isolated', 'existing']),
  path: nonEmptyString,
  repository_root: nonEmptyString,
  base_commit: nullable(Schema.String),
  access: Schema.Literals(['inspect', 'write']),
  writes_json: Schema.String,
  created_at: TimestampSchema,
  retired_at: nullable(TimestampSchema),
});

const nativeSessionRowSchema = Schema.Struct({
  id: AgentSessionIdSchema,
  generation: SessionGenerationSchema,
  host_id: HostIdSchema,
  state: Schema.Literals(['active', 'settled', 'unconfirmed']),
  native_kind: nullable(Schema.String),
  native_server_generation: nullable(Schema.String),
  native_locator: nullable(Schema.String),
});
type NativeSessionRow = typeof nativeSessionRowSchema.Type;

const artifactRowSchema = Schema.Struct({
  digest: DigestSchema,
  path: nonEmptyString,
  byte_length: nonnegativeInteger,
});

const resultArtifactReferenceSchema = Schema.Struct({
  artifact_digests_json: Schema.String,
  evidence_json: Schema.String,
  verification_json: Schema.String,
});

const countRowSchema = Schema.Struct({ count: nonnegativeInteger });
const digestListSchema = Schema.Array(DigestSchema);
const evidenceListSchema = Schema.Array(EvidenceSchema);

export type NativeRetirementTarget = {
  session: SessionIdentity;
  identity: NativeIdentity;
};

export interface NativeRetirementAdapter {
  observe(identity: NativeIdentity): Promise<NativeObservation>;
  cleanup(identity: NativeIdentity, authorized: boolean): Promise<CleanupResult>;
}

export type WorktreeObservation =
  | { kind: 'ready'; path: string }
  | { kind: 'absent' }
  | { kind: 'dirty'; path: string }
  | { kind: 'protected'; reason: string }
  | { kind: 'unconfirmed'; reason: string };

export interface WorkspaceRetirementGit {
  observe(workspace: Workspace): WorktreeObservation;
  remove(workspace: Workspace): void;
}

export type RetireWorkspaceInput = {
  store: Store;
  actor: SessionIdentity;
  workspaceId: WorkspaceId;
  idempotencyKey: string;
  nativeTargets?: readonly NativeRetirementTarget[];
  nativeAdapter?: NativeRetirementAdapter;
  git?: WorkspaceRetirementGit;
  clock?: () => Date;
  retirementIdFactory?: () => string;
};

export type PreviewWorkspaceRetirementInput = {
  store: Store;
  actor: SessionIdentity;
  workspaceId: WorkspaceId;
  idempotencyKey: string;
  nativeTargets?: readonly NativeRetirementTarget[];
  git?: WorkspaceRetirementGit;
};

export type RetirementResult =
  | {
      kind: 'completed';
      retirementId: RetirementId;
      workspaceId: WorkspaceId;
      revision: number;
    }
  | {
      kind: 'blocked' | 'unconfirmed';
      retirementId: RetirementId;
      workspaceId: WorkspaceId;
      revision: number;
      reason: string;
    };

export type RetirementPreviewEffect =
  | { kind: 'cleanup-native-tab'; session: SessionIdentity; identity: NativeIdentity }
  | { kind: 'remove-worktree'; path: string }
  | { kind: 'mark-workspace-retired'; workspaceId: WorkspaceId };

export type RetirementPreviewSkippedCheck =
  | { kind: 'native-observation'; reason: string }
  | { kind: 'native-cleanup'; reason: string }
  | { kind: 'post-native-cleanup-state'; reason: string }
  | { kind: 'post-worktree-removal'; reason: string };

export type RetirementPreview = {
  kind: 'ready' | 'blocked' | 'unconfirmed';
  workspaceId: WorkspaceId;
  reason?: string;
  nativeTargets: readonly NativeRetirementTarget[];
  effects: readonly RetirementPreviewEffect[];
  skippedChecks: readonly RetirementPreviewSkippedCheck[];
};

export class WorkspaceRetirementError extends Error {
  constructor(
    readonly code: 'active-retirement' | 'identity-mismatch' | 'invalid-state' | 'not-found',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WorkspaceRetirementError';
  }
}

export class RetirementOperationError extends Schema.TaggedError<RetirementOperationError>()(
  'Marionette.RetirementOperationError',
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {}

function attempt<A>(operation: string, evaluate: () => A) {
  return Effect.try({
    try: evaluate,
    catch: (cause) => new RetirementOperationError({ operation, cause }),
  });
}

type Attempted<A, E> = { outcome: 'success'; value: A } | { outcome: 'failure'; error: E };

function attempted<A, E>(effect: Effect.Effect<A, E>): Effect.Effect<Attempted<A, E>> {
  return effect.pipe(
    Effect.map((value): Attempted<A, E> => ({ outcome: 'success', value })),
    Effect.catch((error) => Effect.succeed<Attempted<A, E>>({ outcome: 'failure', error })),
  );
}

function failureMessage(error: unknown): string {
  const cause = error instanceof RetirementOperationError ? error.cause : error;
  return cause instanceof Error ? cause.message : 'Unknown retirement failure';
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Git ${args[0] ?? 'operation'} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function registeredWorktrees(repositoryRoot: string): string[] {
  return git(repositoryRoot, ['worktree', 'list', '--porcelain', '-z'])
    .split('\0')
    .filter((field) => field.startsWith('worktree '))
    .map((field) => field.slice('worktree '.length));
}

function commonDirectory(path: string): string {
  return realpathSync(
    git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim(),
  );
}

export class NativeWorkspaceRetirementGit implements WorkspaceRetirementGit {
  observe(workspace: Workspace): WorktreeObservation {
    try {
      const expectedPath = resolve(workspace.path);
      const repositoryRoot = realpathSync(workspace.repositoryRoot);
      const registered = registeredWorktrees(repositoryRoot).some(
        (path) => resolve(path) === expectedPath,
      );
      if (!existsSync(expectedPath)) {
        return registered
          ? { kind: 'unconfirmed', reason: 'Git still registers the missing worktree path' }
          : { kind: 'absent' };
      }
      if (!registered) {
        return { kind: 'unconfirmed', reason: 'Workspace path exists without Git registration' };
      }
      const actualPath = realpathSync(expectedPath);
      if (actualPath !== expectedPath) {
        return {
          kind: 'protected',
          reason: 'Registered worktree path is not the exact stored path',
        };
      }
      if (actualPath === repositoryRoot) {
        return { kind: 'protected', reason: 'The main repository workspace cannot be retired' };
      }
      if (commonDirectory(actualPath) !== commonDirectory(repositoryRoot)) {
        return { kind: 'protected', reason: 'Workspace belongs to another Git repository' };
      }
      const state = captureGitState(actualPath);
      if (state.repositoryRoot !== actualPath) {
        return { kind: 'protected', reason: 'Workspace path is not the registered worktree root' };
      }
      if (!state.clean) return { kind: 'dirty', path: actualPath };
      return { kind: 'ready', path: actualPath };
    } catch (error) {
      return {
        kind: 'unconfirmed',
        reason: error instanceof Error ? error.message : 'Unknown retirement failure',
      };
    }
  }

  remove(workspace: Workspace): void {
    git(workspace.repositoryRoot, ['worktree', 'remove', workspace.path]);
  }
}

export function nativeLocatorForRetirement(identity: NativeIdentity): string {
  const parsed = decode(NativeIdentitySchema, identity);
  // Conversation references are controller evidence, not transport identity. A typed
  // reference can be refreshed without changing the pane this retirement targets.
  return JSON.stringify({
    workspaceId: parsed.binding.workspaceId,
    tabId: parsed.tabId,
    paneId: parsed.paneId,
    terminalId: parsed.terminalId,
    agentKind: parsed.agentKind,
    agentName: parsed.agentName,
    ownedTabId: parsed.ownedTabId,
    nativeSession: parsed.nativeSession,
    foregroundProcess:
      parsed.foregroundProcess === undefined
        ? undefined
        : {
            pid: parsed.foregroundProcess.pid,
            startToken: parsed.foregroundProcess.startToken,
          },
  });
}

function now(input: RetireWorkspaceInput): typeof TimestampSchema.Type {
  return decode(TimestampSchema, (input.clock ?? (() => new Date()))().toISOString());
}

function actorReason(input: Pick<RetireWorkspaceInput, 'store' | 'actor'>): string | null {
  return input.store.read((database) => {
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
        .get(input.store.project.id, input.actor.id, input.actor.generation),
    );
    return row === undefined ||
      row.state !== 'active' ||
      (row.role !== 'user' && row.role !== 'controller')
      ? 'Only an active user or controller can retire a workspace'
      : null;
  });
}

function requireActor(input: RetireWorkspaceInput): void {
  const reason = actorReason(input);
  if (reason !== null) throw new WorkspaceRetirementError('identity-mismatch', reason);
}

function activeRetirementReason(
  input: Pick<RetireWorkspaceInput, 'store' | 'workspaceId'>,
): string | null {
  return input.store.read((database) =>
    database
      .prepare(
        `SELECT id FROM workspace_retirements
         WHERE project_id = ? AND workspace_id = ? AND state <> 'completed'`,
      )
      .get(input.store.project.id, input.workspaceId) === undefined
      ? null
      : `Workspace ${input.workspaceId} already has an active retirement`,
  );
}

function loadWorkspace(
  database: DatabaseSync,
  input: Pick<RetireWorkspaceInput, 'store' | 'workspaceId'>,
): Workspace {
  const row = decodeOrUndefined(
    workspaceRowSchema,
    database
      .prepare('SELECT * FROM workspaces WHERE project_id = ? AND id = ?')
      .get(input.store.project.id, input.workspaceId),
  );
  if (row === undefined) {
    throw new WorkspaceRetirementError(
      'not-found',
      `Workspace ${input.workspaceId} was not found in this project`,
    );
  }
  return {
    id: row.id,
    projectId: row.project_id,
    hostId: row.host_id,
    kind: row.kind,
    path: row.path,
    repositoryRoot: row.repository_root,
    baseCommit: row.base_commit,
    access: row.access,
    writes: [...decode(Schema.Array(Schema.String), JSON.parse(row.writes_json))],
    createdAt: row.created_at,
    retiredAt: row.retired_at,
  };
}

function loadRetirement(store: Store, retirementId: RetirementId): RetirementRow {
  return store.read((database) =>
    decode(
      retirementRowSchema,
      database
        .prepare('SELECT * FROM workspace_retirements WHERE project_id = ? AND id = ?')
        .get(store.project.id, retirementId),
    ),
  );
}

function prepareIntent(input: RetireWorkspaceInput): RetirementRow {
  requireActor(input);
  const workspace = input.store.read((database) => loadWorkspace(database, input));
  const result = input.store.idempotent(
    'workspace-retirement-intent',
    input.idempotencyKey,
    {
      workspaceId: workspace.id,
      expectedHostId: workspace.hostId,
      expectedPath: workspace.path,
      expectedWorkspaceCreatedAt: workspace.createdAt,
    },
    RetirementIdSchema,
    (database) => {
      const active = database
        .prepare(
          `SELECT id FROM workspace_retirements
           WHERE project_id = ? AND workspace_id = ? AND state <> 'completed'`,
        )
        .get(input.store.project.id, workspace.id);
      if (active !== undefined) {
        throw new WorkspaceRetirementError(
          'active-retirement',
          `Workspace ${workspace.id} already has an active retirement`,
        );
      }
      const retirementId = decode(
        RetirementIdSchema,
        (input.retirementIdFactory ?? (() => `retirement_${randomUUID()}`))(),
      );
      const createdAt = now(input);
      database
        .prepare(
          `INSERT INTO workspace_retirements
             (id, project_id, workspace_id, expected_host_id, expected_path,
              expected_workspace_created_at, idempotency_key, state, revision, created_at,
              updated_at, completed_at, last_error)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?, NULL, NULL)`,
        )
        .run(
          retirementId,
          input.store.project.id,
          workspace.id,
          workspace.hostId,
          workspace.path,
          workspace.createdAt,
          input.idempotencyKey,
          createdAt,
          createdAt,
        );
      return retirementId;
    },
  );
  return loadRetirement(input.store, result.value);
}

function transition(
  input: RetireWorkspaceInput,
  previous: RetirementRow,
  state: RetirementState,
  reason: string | null,
): RetirementRow {
  return input.store.transaction((database) => {
    const current = decode(
      retirementRowSchema,
      database
        .prepare('SELECT * FROM workspace_retirements WHERE project_id = ? AND id = ?')
        .get(input.store.project.id, previous.id),
    );
    if (current.revision !== previous.revision) {
      throw new WorkspaceRetirementError(
        'invalid-state',
        `Retirement ${previous.id} changed during reconciliation`,
      );
    }
    const updatedAt = now(input);
    if (state === 'completed') {
      const workspace = loadWorkspace(database, input);
      if (
        workspace.hostId !== current.expected_host_id ||
        workspace.path !== current.expected_path ||
        workspace.createdAt !== current.expected_workspace_created_at
      ) {
        throw new WorkspaceRetirementError(
          'identity-mismatch',
          'Workspace identity changed during retirement',
        );
      }
      if (workspace.retiredAt === null) {
        const retired = database
          .prepare(
            `UPDATE workspaces SET retired_at = ?
             WHERE project_id = ? AND id = ? AND retired_at IS NULL`,
          )
          .run(updatedAt, input.store.project.id, workspace.id);
        if (Number(retired.changes) !== 1) {
          throw new WorkspaceRetirementError(
            'invalid-state',
            'Workspace retirement lost its claim',
          );
        }
      }
    }
    const changed = database
      .prepare(
        `UPDATE workspace_retirements
         SET state = ?, revision = revision + 1, updated_at = ?, completed_at = ?, last_error = ?
         WHERE project_id = ? AND id = ? AND revision = ?`,
      )
      .run(
        state,
        updatedAt,
        state === 'completed' ? updatedAt : null,
        reason,
        input.store.project.id,
        current.id,
        current.revision,
      );
    if (Number(changed.changes) !== 1) {
      throw new WorkspaceRetirementError('invalid-state', 'Retirement update lost its claim');
    }
    return decode(
      retirementRowSchema,
      database
        .prepare('SELECT * FROM workspace_retirements WHERE project_id = ? AND id = ?')
        .get(input.store.project.id, current.id),
    );
  });
}

function count(database: DatabaseSync, sql: string, parameters: readonly string[]): number {
  return decode(countRowSchema, database.prepare(sql).get(...parameters)).count;
}

function blockingConsumerReason(
  input: Pick<RetireWorkspaceInput, 'store'>,
  workspace: Workspace,
): string | null {
  return input.store.read((database) => {
    const parameters = [input.store.project.id, workspace.id];
    if (
      count(
        database,
        `SELECT count(*) AS count FROM attempts
         WHERE project_id = ? AND workspace_id = ? AND phase NOT IN ('settled', 'closed')`,
        parameters,
      ) > 0
    ) {
      return 'Workspace has a managed attempt that is not settled';
    }
    if (
      count(
        database,
        `SELECT count(*) AS count FROM execution_reservations er
         JOIN attempts a ON a.id = er.attempt_id
         WHERE er.project_id = ? AND a.workspace_id = ? AND er.state IN ('held', 'unconfirmed')`,
        parameters,
      ) > 0
    ) {
      return 'Workspace has an execution reservation';
    }
    if (
      count(
        database,
        `SELECT count(*) AS count FROM jobs
         WHERE project_id = ? AND workspace_id = ? AND state = 'open'`,
        parameters,
      ) > 0
    ) {
      return 'Workspace has an open job';
    }
    if (
      count(
        database,
        `SELECT count(*) AS count FROM workflow_runs w
         JOIN jobs j ON j.id = w.root_job_id
         WHERE w.project_id = ? AND j.workspace_id = ?
           AND w.phase NOT IN ('finished', 'cancelled')`,
        parameters,
      ) > 0
    ) {
      return 'Workspace has a workflow that is not finished';
    }
    if (
      count(
        database,
        `SELECT count(*) AS count FROM writer_reservations
         WHERE project_id = ? AND target_workspace_id = ? AND state IN ('held', 'unconfirmed')`,
        parameters,
      ) > 0
    ) {
      return 'Workspace has a writer reservation';
    }
    if (
      count(
        database,
        `SELECT count(DISTINCT h.id) AS count FROM handoffs h
         JOIN results r ON r.id = h.result_id
         WHERE h.project_id = ? AND (h.target_workspace_id = ? OR r.workspace_id = ?)
           AND h.state IN ('pending', 'integrating', 'conflict', 'unconfirmed')`,
        [input.store.project.id, workspace.id, workspace.id],
      ) > 0
    ) {
      return 'Workspace has an unresolved result handoff';
    }
    return null;
  });
}

function requiredArtifactRows(input: Pick<RetireWorkspaceInput, 'store'>, workspace: Workspace) {
  return input.store.read((database) => {
    const required = new Set<typeof DigestSchema.Type>();
    const references = database
      .prepare(
        `SELECT artifact_digests_json, evidence_json, verification_json FROM results
         WHERE project_id = ? AND workspace_id = ?`,
      )
      .all(input.store.project.id, workspace.id)
      .map((row) => decode(resultArtifactReferenceSchema, row));
    for (const reference of references) {
      for (const digest of decode(digestListSchema, JSON.parse(reference.artifact_digests_json))) {
        required.add(digest);
      }
      for (const evidence of decode(evidenceListSchema, JSON.parse(reference.evidence_json))) {
        if (evidence.kind === 'file') required.add(evidence.digest);
        if (evidence.kind === 'command') required.add(evidence.log);
      }
      const verification = decode(VerificationSchema, JSON.parse(reference.verification_json));
      if (verification.kind !== 'not-requested') {
        for (const evidence of verification.checks) {
          if (evidence.kind === 'file') required.add(evidence.digest);
          if (evidence.kind === 'command') required.add(evidence.log);
        }
      }
    }
    const linked = database
      .prepare(
        `SELECT a.digest, a.path, a.byte_length FROM result_artifacts ra
         JOIN results r ON r.id = ra.result_id
         JOIN artifacts a ON a.id = ra.artifact_id
         WHERE r.project_id = ? AND r.workspace_id = ?`,
      )
      .all(input.store.project.id, workspace.id)
      .map((row) => decode(artifactRowSchema, row));
    for (const artifact of linked) required.add(artifact.digest);
    const artifacts = database
      .prepare('SELECT digest, path, byte_length FROM artifacts WHERE project_id = ?')
      .all(input.store.project.id)
      .map((row) => decode(artifactRowSchema, row));
    return {
      required,
      artifacts: new Map(artifacts.map((artifact) => [artifact.digest, artifact])),
    };
  });
}

function verifyRequiredArtifacts(
  input: Pick<RetireWorkspaceInput, 'store'>,
  workspace: Workspace,
): string | null {
  try {
    const { required, artifacts } = requiredArtifactRows(input, workspace);
    for (const digest of required) {
      const artifact = artifacts.get(digest);
      if (artifact === undefined) return `Required artifact ${digest} has no durable record`;
      const expectedPath = join(
        input.store.project.stateDirectory,
        'artifacts',
        'sha256',
        digest.slice(0, 2),
        digest.slice(2),
      );
      if (resolve(artifact.path) !== resolve(expectedPath)) {
        return `Required artifact ${digest} is outside the durable artifact store`;
      }
      const metadata = lstatSync(expectedPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        return `Required artifact ${digest} is not a durable regular file`;
      }
      const bytes = readFileSync(expectedPath);
      if (
        bytes.byteLength !== artifact.byte_length ||
        createHash('sha256').update(bytes).digest('hex') !== digest
      ) {
        return `Required artifact ${digest} failed its integrity check`;
      }
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Unknown retirement failure';
  }
}

function nativeSessions(
  input: Pick<RetireWorkspaceInput, 'store'>,
  workspace: Workspace,
): NativeSessionRow[] {
  return input.store.read((database) =>
    database
      .prepare(
        `SELECT id, generation, host_id, state, native_kind, native_server_generation,
                native_locator
         FROM agent_sessions WHERE project_id = ? AND workspace_id = ?`,
      )
      .all(input.store.project.id, workspace.id)
      .map((row) => decode(nativeSessionRowSchema, row)),
  );
}

function sessionKey(identity: SessionIdentity): string {
  return `${identity.id}\u0000${identity.generation}`;
}

function matchesNativeTarget(
  input: Pick<RetireWorkspaceInput, 'store'>,
  workspace: Workspace,
  row: NativeSessionRow,
  target: NativeRetirementTarget,
): boolean {
  const identity = target.identity;
  return (
    row.id === target.session.id &&
    row.generation === target.session.generation &&
    row.host_id === workspace.hostId &&
    identity.binding.hostId === workspace.hostId &&
    identity.binding.workspaceId === workspace.id &&
    identity.tabId === identity.ownedTabId &&
    row.native_kind === identity.agentKind &&
    row.native_server_generation === identity.binding.endpoint.serverStartToken &&
    row.native_locator === nativeLocatorForRetirement(identity) &&
    input.store.project.id === workspace.projectId
  );
}

function settleNativeSession(
  input: RetireWorkspaceInput,
  row: NativeSessionRow,
  target: NativeRetirementTarget,
): void {
  const identity = target.identity;
  input.store.transaction((database) => {
    const changed = database
      .prepare(
        `UPDATE agent_sessions SET state = 'settled', settled_at = ?
         WHERE project_id = ? AND id = ? AND generation = ?
           AND state IN ('active', 'unconfirmed') AND host_id = ?
           AND native_kind = ? AND native_server_generation = ? AND native_locator = ?`,
      )
      .run(
        now(input),
        input.store.project.id,
        row.id,
        row.generation,
        row.host_id,
        identity.agentKind,
        identity.binding.endpoint.serverStartToken,
        nativeLocatorForRetirement(identity),
      );
    if (Number(changed.changes) !== 1) {
      throw new WorkspaceRetirementError(
        'identity-mismatch',
        `Native session ${row.id} changed during cleanup`,
      );
    }
  });
}

type NativeClosure = { kind: 'closed' } | { kind: 'blocked' | 'unconfirmed'; reason: string };

type NativeCleanupPlan = {
  kind: 'ready';
  cleanups: readonly { row: NativeSessionRow; target: NativeRetirementTarget }[];
};

function nativeCleanupPlan(
  input: Pick<RetireWorkspaceInput, 'store' | 'nativeTargets'>,
  workspace: Workspace,
): NativeCleanupPlan | { kind: 'blocked'; reason: string } {
  const rows = nativeSessions(input, workspace);
  const targets = new Map<string, NativeRetirementTarget>();
  for (const rawTarget of input.nativeTargets ?? []) {
    const identity = decodeOrUndefined(NativeIdentitySchema, rawTarget.identity);
    if (identity === undefined)
      return { kind: 'blocked', reason: 'Native cleanup target has an invalid identity' };
    const target = { session: rawTarget.session, identity };
    const key = sessionKey(target.session);
    if (targets.has(key)) return { kind: 'blocked', reason: 'Duplicate native cleanup target' };
    targets.set(key, target);
  }
  for (const [key, target] of targets) {
    const row = rows.find((candidate) => sessionKey(candidate) === key);
    if (row === undefined || !matchesNativeTarget(input, workspace, row, target))
      return { kind: 'blocked', reason: 'Native cleanup target does not match its registration' };
  }
  const cleanups: { row: NativeSessionRow; target: NativeRetirementTarget }[] = [];
  for (const row of rows) {
    if (row.state === 'settled') continue;
    const target = targets.get(sessionKey(row));
    if (target === undefined)
      return { kind: 'blocked', reason: `Workspace session ${row.id} is still a consumer` };
    cleanups.push({ row, target });
  }
  return { kind: 'ready', cleanups };
}

const closeNativeConsumers: (
  input: RetireWorkspaceInput,
  workspace: Workspace,
) => Effect.Effect<NativeClosure, RetirementOperationError> = Effect.fn(
  'Retirement.closeNativeConsumers',
)(function* (input, workspace) {
  const plan = yield* attempt('Retirement.planNativeCleanup', () =>
    nativeCleanupPlan(input, workspace),
  );
  if (plan.kind === 'blocked') return plan;
  for (const { row, target } of plan.cleanups) {
    if (input.nativeAdapter === undefined) {
      return { kind: 'blocked', reason: 'Native cleanup requires a registered adapter' };
    }
    const nativeAdapter = input.nativeAdapter;
    const observed = yield* attempted(
      Effect.tryPromise({
        try: () => nativeAdapter.observe(target.identity),
        catch: (cause) =>
          new RetirementOperationError({ operation: 'Retirement.observeNative', cause }),
      }),
    );
    if (observed.outcome === 'failure') {
      return {
        kind: 'unconfirmed',
        reason: failureMessage(observed.error),
      };
    }
    const observation: NativeObservation = observed.value;
    if (observation.kind === 'unconfirmed') {
      return { kind: 'unconfirmed', reason: observation.reason };
    }
    if (observation.kind === 'blocked' || observation.kind === 'manual-required') {
      return { kind: 'blocked', reason: observation.reason };
    }
    if (observation.kind !== 'settled') {
      return { kind: 'blocked', reason: `Native session ${row.id} is ${observation.kind}` };
    }
    const cleaned = yield* attempted(
      Effect.tryPromise({
        try: () => nativeAdapter.cleanup(target.identity, true),
        catch: (cause) =>
          new RetirementOperationError({ operation: 'Retirement.cleanupNative', cause }),
      }),
    );
    if (cleaned.outcome === 'failure') {
      return {
        kind: 'unconfirmed',
        reason: failureMessage(cleaned.error),
      };
    }
    const cleanup: CleanupResult = cleaned.value;
    if (cleanup.kind === 'unconfirmed') {
      return { kind: 'unconfirmed', reason: cleanup.reason };
    }
    if (cleanup.kind === 'unsupported') {
      return { kind: 'blocked', reason: cleanup.reason };
    }
    const settled = yield* attempted(
      attempt('Retirement.settleNativeSession', () => settleNativeSession(input, row, target)),
    );
    if (settled.outcome === 'failure') {
      return {
        kind: 'unconfirmed',
        reason: failureMessage(settled.error),
      };
    }
  }
  return { kind: 'closed' };
});

function result(row: RetirementRow): RetirementResult {
  if (row.state === 'completed') {
    return {
      kind: 'completed',
      retirementId: row.id,
      workspaceId: row.workspace_id,
      revision: row.revision,
    };
  }
  if (row.state !== 'blocked' && row.state !== 'unconfirmed') {
    throw new WorkspaceRetirementError(
      'invalid-state',
      `Retirement ${row.id} stopped in internal state ${row.state}`,
    );
  }
  return {
    kind: row.state,
    retirementId: row.id,
    workspaceId: row.workspace_id,
    revision: row.revision,
    reason: row.last_error ?? 'Retirement did not complete',
  };
}

function stop(
  input: RetireWorkspaceInput,
  row: RetirementRow,
  state: 'blocked' | 'unconfirmed',
  reason: string,
): RetirementResult {
  return result(transition(input, row, state, reason));
}

function preview(
  kind: RetirementPreview['kind'],
  workspaceId: WorkspaceId,
  reason?: string,
  nativeTargets: readonly NativeRetirementTarget[] = [],
  effects: readonly RetirementPreviewEffect[] = [],
  skippedChecks: readonly RetirementPreviewSkippedCheck[] = [],
): RetirementPreview {
  const result: RetirementPreview = { kind, workspaceId, nativeTargets, effects, skippedChecks };
  if (reason !== undefined) result.reason = reason;
  return result;
}

/** Reads current retirement preconditions without recording an intent or running an effect. */
export function previewWorkspaceRetirement(
  input: PreviewWorkspaceRetirementInput,
): RetirementPreview {
  const actor = actorReason(input);
  if (actor !== null) return preview('blocked', input.workspaceId, actor);
  const active = activeRetirementReason(input);
  if (active !== null) return preview('blocked', input.workspaceId, active);
  let workspace: Workspace;
  try {
    workspace = input.store.read((database) => loadWorkspace(database, input));
  } catch (error) {
    return preview(
      'unconfirmed',
      input.workspaceId,
      error instanceof Error ? error.message : 'Workspace preview failed',
    );
  }
  if (workspace.kind !== 'isolated')
    return preview('blocked', workspace.id, 'Only an isolated managed worktree can be retired');
  if (workspace.retiredAt !== null)
    return preview('unconfirmed', workspace.id, 'Workspace was retired outside this intent');
  const consumer = blockingConsumerReason(input, workspace);
  if (consumer !== null) return preview('blocked', workspace.id, consumer);
  const artifactFailure = verifyRequiredArtifacts(input, workspace);
  if (artifactFailure !== null) return preview('blocked', workspace.id, artifactFailure);
  const native = nativeCleanupPlan(input, workspace);
  const nativeTargets = (input.nativeTargets ?? []).map((target) => ({
    session: target.session,
    identity: target.identity,
  }));
  if (native.kind === 'blocked')
    return preview('blocked', workspace.id, native.reason, nativeTargets);
  const effects: RetirementPreviewEffect[] = native.cleanups.map(({ target }) => ({
    kind: 'cleanup-native-tab',
    session: target.session,
    identity: target.identity,
  }));
  const skippedChecks: RetirementPreviewSkippedCheck[] =
    native.cleanups.length === 0
      ? []
      : [
          {
            kind: 'native-observation',
            reason: 'Native state is checked only while executing retirement',
          },
          {
            kind: 'native-cleanup',
            reason: 'Native cleanup and its durable claim are not run during preview',
          },
          {
            kind: 'post-native-cleanup-state',
            reason: 'Session settlement and consumer state are rechecked after cleanup',
          },
        ];
  const gitAdapter = input.git ?? new NativeWorkspaceRetirementGit();
  const observed = gitAdapter.observe(workspace);
  if (observed.kind === 'dirty')
    return preview(
      'blocked',
      workspace.id,
      'Workspace has tracked or untracked changes',
      nativeTargets,
      effects,
      skippedChecks,
    );
  if (observed.kind === 'protected')
    return preview('blocked', workspace.id, observed.reason, nativeTargets, effects, skippedChecks);
  if (observed.kind === 'unconfirmed')
    return preview(
      'unconfirmed',
      workspace.id,
      observed.reason,
      nativeTargets,
      effects,
      skippedChecks,
    );
  if (observed.kind === 'ready') effects.push({ kind: 'remove-worktree', path: observed.path });
  effects.push({ kind: 'mark-workspace-retired', workspaceId: workspace.id });
  skippedChecks.push({
    kind: 'post-worktree-removal',
    reason: 'Worktree absence is rechecked only after removal',
  });
  return preview('ready', workspace.id, undefined, nativeTargets, effects, skippedChecks);
}

export const retireWorkspaceEffect = Effect.fn('Retirement.retireWorkspace')(function* (
  input: RetireWorkspaceInput,
) {
  let retirement = yield* attempt('Retirement.prepareIntent', () => prepareIntent(input));
  if (retirement.state === 'completed') return result(retirement);
  const workspace = yield* attempt('Retirement.loadWorkspace', () =>
    input.store.read((database) => loadWorkspace(database, input)),
  );
  if (
    workspace.hostId !== retirement.expected_host_id ||
    workspace.path !== retirement.expected_path ||
    workspace.createdAt !== retirement.expected_workspace_created_at
  ) {
    return stop(input, retirement, 'blocked', 'Workspace identity no longer matches the intent');
  }
  if (workspace.kind !== 'isolated') {
    return stop(input, retirement, 'blocked', 'Only an isolated managed worktree can be retired');
  }
  if (workspace.retiredAt !== null) {
    return stop(input, retirement, 'unconfirmed', 'Workspace was retired outside this intent');
  }
  const consumer = blockingConsumerReason(input, workspace);
  if (consumer !== null) return stop(input, retirement, 'blocked', consumer);
  const artifactFailure = verifyRequiredArtifacts(input, workspace);
  if (artifactFailure !== null) return stop(input, retirement, 'blocked', artifactFailure);

  retirement = yield* attempt('Retirement.markNativeClosing', () =>
    transition(input, retirement, 'native-closing', null),
  );
  const native = yield* closeNativeConsumers(input, workspace);
  if (native.kind !== 'closed') return stop(input, retirement, native.kind, native.reason);
  if (nativeSessions(input, workspace).some((session) => session.state !== 'settled')) {
    return stop(input, retirement, 'unconfirmed', 'A workspace session remains unsettled');
  }
  const changedConsumer = blockingConsumerReason(input, workspace);
  if (changedConsumer !== null) return stop(input, retirement, 'blocked', changedConsumer);

  const gitAdapter = input.git ?? new NativeWorkspaceRetirementGit();
  const observed = gitAdapter.observe(workspace);
  if (observed.kind === 'absent') {
    return result(transition(input, retirement, 'completed', null));
  }
  if (observed.kind === 'dirty') {
    return stop(input, retirement, 'blocked', 'Workspace has tracked or untracked changes');
  }
  if (observed.kind === 'protected') {
    return stop(input, retirement, 'blocked', observed.reason);
  }
  if (observed.kind === 'unconfirmed') {
    return stop(input, retirement, 'unconfirmed', observed.reason);
  }

  retirement = transition(input, retirement, 'worktree-removing', null);
  const removed = yield* attempted(
    attempt('Retirement.removeWorktree', () => gitAdapter.remove(workspace)),
  );
  if (removed.outcome === 'failure') {
    return stop(input, retirement, 'unconfirmed', failureMessage(removed.error));
  }
  const settled = gitAdapter.observe(workspace);
  if (settled.kind !== 'absent') {
    const reason =
      settled.kind === 'dirty'
        ? 'Git reported dirty state after worktree removal'
        : settled.kind === 'ready'
          ? 'Git still registers the worktree after removal'
          : settled.reason;
    return stop(input, retirement, 'unconfirmed', reason);
  }
  return result(transition(input, retirement, 'completed', null));
});

export function retireWorkspace(input: RetireWorkspaceInput): Promise<RetirementResult> {
  return Effect.runPromise(
    retireWorkspaceEffect(input).pipe(Effect.mapError((error) => error.cause)),
  );
}

export const reconcileWorkspaceRetirement = retireWorkspace;
