import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { z } from 'zod';

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

const RetirementIdSchema = z.string().min(1).brand<'RetirementId'>();
export type RetirementId = z.infer<typeof RetirementIdSchema>;

const RetirementStateSchema = z.enum([
  'pending',
  'native-closing',
  'worktree-removing',
  'completed',
  'unconfirmed',
  'blocked',
]);
export type RetirementState = z.infer<typeof RetirementStateSchema>;

const retirementRowSchema = z.object({
  id: RetirementIdSchema,
  project_id: ProjectIdSchema,
  workspace_id: WorkspaceIdSchema,
  expected_host_id: HostIdSchema,
  expected_path: z.string().min(1),
  expected_workspace_created_at: TimestampSchema,
  idempotency_key: z.string().min(1),
  state: RetirementStateSchema,
  revision: z.number().int().positive(),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
  completed_at: TimestampSchema.nullable(),
  last_error: z.string().nullable(),
});
type RetirementRow = z.infer<typeof retirementRowSchema>;

const workspaceRowSchema = z.object({
  id: WorkspaceIdSchema,
  project_id: ProjectIdSchema,
  host_id: HostIdSchema,
  kind: z.enum(['isolated', 'existing']),
  path: z.string().min(1),
  repository_root: z.string().min(1),
  base_commit: z.string().nullable(),
  access: z.enum(['inspect', 'write']),
  writes_json: z.string(),
  created_at: TimestampSchema,
  retired_at: TimestampSchema.nullable(),
});

const nativeSessionRowSchema = z.object({
  id: AgentSessionIdSchema,
  generation: SessionGenerationSchema,
  host_id: HostIdSchema,
  state: z.enum(['active', 'settled', 'unconfirmed']),
  native_kind: z.string().nullable(),
  native_server_generation: z.string().nullable(),
  native_locator: z.string().nullable(),
});
type NativeSessionRow = z.infer<typeof nativeSessionRowSchema>;

const artifactRowSchema = z.object({
  digest: DigestSchema,
  path: z.string().min(1),
  byte_length: z.number().int().nonnegative(),
});

const resultArtifactReferenceSchema = z.object({
  artifact_digests_json: z.string(),
  evidence_json: z.string(),
  verification_json: z.string(),
});

const countRowSchema = z.object({ count: z.number().int().nonnegative() });
const digestListSchema = z.array(DigestSchema);
const evidenceListSchema = z.array(EvidenceSchema);

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
  const parsed = NativeIdentitySchema.parse(identity);
  return JSON.stringify({
    workspaceId: parsed.binding.workspaceId,
    tabId: parsed.tabId,
    paneId: parsed.paneId,
    terminalId: parsed.terminalId,
    agentKind: parsed.agentKind,
    agentName: parsed.agentName,
    ownedTabId: parsed.ownedTabId,
    identityRevision: parsed.identityRevision,
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

function now(input: RetireWorkspaceInput): z.infer<typeof TimestampSchema> {
  return TimestampSchema.parse((input.clock ?? (() => new Date()))().toISOString());
}

function requireActor(input: RetireWorkspaceInput): void {
  input.store.read((database) => {
    const row = z
      .object({ role: z.enum(['user', 'controller', 'worker']), state: z.string() })
      .safeParse(
        database
          .prepare(
            `SELECT role, state FROM agent_sessions
             WHERE project_id = ? AND id = ? AND generation = ?`,
          )
          .get(input.store.project.id, input.actor.id, input.actor.generation),
      );
    if (
      !row.success ||
      row.data.state !== 'active' ||
      (row.data.role !== 'user' && row.data.role !== 'controller')
    ) {
      throw new WorkspaceRetirementError(
        'identity-mismatch',
        'Only an active user or controller can retire a workspace',
      );
    }
  });
}

function loadWorkspace(database: DatabaseSync, input: RetireWorkspaceInput): Workspace {
  const row = workspaceRowSchema.safeParse(
    database
      .prepare('SELECT * FROM workspaces WHERE project_id = ? AND id = ?')
      .get(input.store.project.id, input.workspaceId),
  );
  if (!row.success) {
    throw new WorkspaceRetirementError(
      'not-found',
      `Workspace ${input.workspaceId} was not found in this project`,
    );
  }
  return {
    id: row.data.id,
    projectId: row.data.project_id,
    hostId: row.data.host_id,
    kind: row.data.kind,
    path: row.data.path,
    repositoryRoot: row.data.repository_root,
    baseCommit: row.data.base_commit,
    access: row.data.access,
    writes: z.array(z.string()).parse(JSON.parse(row.data.writes_json)),
    createdAt: row.data.created_at,
    retiredAt: row.data.retired_at,
  };
}

function loadRetirement(store: Store, retirementId: RetirementId): RetirementRow {
  return store.read((database) =>
    retirementRowSchema.parse(
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
      const retirementId = RetirementIdSchema.parse(
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
    const current = retirementRowSchema.parse(
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
    return retirementRowSchema.parse(
      database
        .prepare('SELECT * FROM workspace_retirements WHERE project_id = ? AND id = ?')
        .get(input.store.project.id, current.id),
    );
  });
}

function count(database: DatabaseSync, sql: string, parameters: readonly string[]): number {
  return countRowSchema.parse(database.prepare(sql).get(...parameters)).count;
}

function blockingConsumerReason(input: RetireWorkspaceInput, workspace: Workspace): string | null {
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

function requiredArtifactRows(input: RetireWorkspaceInput, workspace: Workspace) {
  return input.store.read((database) => {
    const required = new Set<z.infer<typeof DigestSchema>>();
    const references = database
      .prepare(
        `SELECT artifact_digests_json, evidence_json, verification_json FROM results
         WHERE project_id = ? AND workspace_id = ?`,
      )
      .all(input.store.project.id, workspace.id)
      .map((row) => resultArtifactReferenceSchema.parse(row));
    for (const reference of references) {
      for (const digest of digestListSchema.parse(JSON.parse(reference.artifact_digests_json))) {
        required.add(digest);
      }
      for (const evidence of evidenceListSchema.parse(JSON.parse(reference.evidence_json))) {
        if (evidence.kind === 'file') required.add(evidence.digest);
        if (evidence.kind === 'command') required.add(evidence.log);
      }
      const verification = VerificationSchema.parse(JSON.parse(reference.verification_json));
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
      .map((row) => artifactRowSchema.parse(row));
    for (const artifact of linked) required.add(artifact.digest);
    const artifacts = database
      .prepare('SELECT digest, path, byte_length FROM artifacts WHERE project_id = ?')
      .all(input.store.project.id)
      .map((row) => artifactRowSchema.parse(row));
    return {
      required,
      artifacts: new Map(artifacts.map((artifact) => [artifact.digest, artifact])),
    };
  });
}

function verifyRequiredArtifacts(input: RetireWorkspaceInput, workspace: Workspace): string | null {
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

function nativeSessions(input: RetireWorkspaceInput, workspace: Workspace): NativeSessionRow[] {
  return input.store.read((database) =>
    database
      .prepare(
        `SELECT id, generation, host_id, state, native_kind, native_server_generation,
                native_locator
         FROM agent_sessions WHERE project_id = ? AND workspace_id = ?`,
      )
      .all(input.store.project.id, workspace.id)
      .map((row) => nativeSessionRowSchema.parse(row)),
  );
}

function sessionKey(identity: SessionIdentity): string {
  return `${identity.id}\u0000${identity.generation}`;
}

function matchesNativeTarget(
  input: RetireWorkspaceInput,
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

async function closeNativeConsumers(
  input: RetireWorkspaceInput,
  workspace: Workspace,
): Promise<NativeClosure> {
  const rows = nativeSessions(input, workspace);
  const targets = new Map<string, NativeRetirementTarget>();
  for (const rawTarget of input.nativeTargets ?? []) {
    const identity = NativeIdentitySchema.safeParse(rawTarget.identity);
    if (!identity.success) {
      return { kind: 'blocked', reason: 'Native cleanup target has an invalid identity' };
    }
    const target = {
      session: rawTarget.session,
      identity: identity.data,
    };
    const key = sessionKey(target.session);
    if (targets.has(key)) return { kind: 'blocked', reason: 'Duplicate native cleanup target' };
    targets.set(key, target);
  }
  for (const [key, target] of targets) {
    const row = rows.find((candidate) => sessionKey(candidate) === key);
    if (row === undefined || !matchesNativeTarget(input, workspace, row, target)) {
      return { kind: 'blocked', reason: 'Native cleanup target does not match its registration' };
    }
  }
  for (const row of rows) {
    if (row.state === 'settled') continue;
    const target = targets.get(sessionKey(row));
    if (target === undefined) {
      return { kind: 'blocked', reason: `Workspace session ${row.id} is still a consumer` };
    }
    if (input.nativeAdapter === undefined) {
      return { kind: 'blocked', reason: 'Native cleanup requires a registered adapter' };
    }
    let observation: NativeObservation;
    try {
      observation = await input.nativeAdapter.observe(target.identity);
    } catch (error) {
      return {
        kind: 'unconfirmed',
        reason: error instanceof Error ? error.message : 'Unknown retirement failure',
      };
    }
    if (observation.kind === 'unconfirmed') {
      return { kind: 'unconfirmed', reason: observation.reason };
    }
    if (observation.kind === 'blocked' || observation.kind === 'manual-required') {
      return { kind: 'blocked', reason: observation.reason };
    }
    if (observation.kind !== 'settled') {
      return { kind: 'blocked', reason: `Native session ${row.id} is ${observation.kind}` };
    }
    let cleanup: CleanupResult;
    try {
      cleanup = await input.nativeAdapter.cleanup(target.identity, true);
    } catch (error) {
      return {
        kind: 'unconfirmed',
        reason: error instanceof Error ? error.message : 'Unknown retirement failure',
      };
    }
    if (cleanup.kind === 'unconfirmed') {
      return { kind: 'unconfirmed', reason: cleanup.reason };
    }
    if (cleanup.kind === 'unsupported') {
      return { kind: 'blocked', reason: cleanup.reason };
    }
    try {
      settleNativeSession(input, row, target);
    } catch (error) {
      return {
        kind: 'unconfirmed',
        reason: error instanceof Error ? error.message : 'Unknown retirement failure',
      };
    }
  }
  return { kind: 'closed' };
}

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

export async function retireWorkspace(input: RetireWorkspaceInput): Promise<RetirementResult> {
  let retirement = prepareIntent(input);
  if (retirement.state === 'completed') return result(retirement);
  const workspace = input.store.read((database) => loadWorkspace(database, input));
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

  retirement = transition(input, retirement, 'native-closing', null);
  const native = await closeNativeConsumers(input, workspace);
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
  try {
    gitAdapter.remove(workspace);
  } catch (error) {
    return stop(
      input,
      retirement,
      'unconfirmed',
      error instanceof Error ? error.message : 'Unknown retirement failure',
    );
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
}

export const reconcileWorkspaceRetirement = retireWorkspace;
