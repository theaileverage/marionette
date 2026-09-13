import { EventStore } from './events/event-store.js';
import { recordWorkflowAdmission } from './workflows/scheduler.js';
import * as workflowService from './workflows/workflow-service.js';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';

import { z } from 'zod';

import { ArtifactFiles } from './artifacts.js';
import { canonicalJson, openDatabase, payloadDigest } from './database.js';
import {
  AgentSessionIdSchema,
  AttemptIdSchema,
  BriefContentSchema,
  BriefIdSchema,
  DigestSchema,
  EvidenceSchema,
  HostIdSchema,
  JobIdSchema,
  JobRequestIdSchema,
  ProjectBindingSchema,
  ProjectIdSchema,
  ReservationIdSchema,
  ResultContentSchema,
  ResultIdSchema,
  SessionGenerationSchema,
  StepRunIdSchema,
  TimestampSchema,
  VerificationSchema,
  WorkflowIdSchema,
  WorkflowPackageSnapshotSchema,
  WorkspaceIdSchema,
  type AgentSessionId,
  type Attempt,
  type AttemptId,
  type BriefContent,
  type BriefId,
  type BriefRevision,
  type ControlOperation,
  type DeliveryKind,
  type Digest,
  type Evidence,
  type HostId,
  type Job,
  type JobId,
  type JobOrigin,
  type OriginalRequest,
  type ProjectBinding,
  type ProjectId,
  type Result,
  type ResultContent,
  type ResultId,
  type Revision,
  type SessionGeneration,
  type StepRun,
  type StepRunId,
  type Timestamp,
  type TransitionRequest,
  type Verification,
  type WorkflowId,
  type WorkflowLimits,
  type WorkflowPackageSnapshot,
  type WorkflowRun,
  type WorkspaceId,
} from './model.js';

export type StoreErrorCode =
  | 'binding-mismatch'
  | 'dependency-cycle'
  | 'idempotency-conflict'
  | 'identity-mismatch'
  | 'invalid-state'
  | 'invalid-transition'
  | 'limit-exhausted'
  | 'not-found'
  | 'not-implemented'
  | 'permission-denied'
  | 'resource-busy'
  | 'result-stale'
  | 'stale-revision';

export class StoreError extends Error {
  constructor(
    readonly code: StoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'StoreError';
  }
}

export type StoreOptions = {
  readOnly?: boolean;
  databasePath: string;
  project: ProjectBinding;
  busyTimeoutMs?: number;
  clock?: () => Date;
  idFactory?: (kind: string) => string;
};

export type Workspace = {
  id: WorkspaceId;
  projectId: ProjectId;
  hostId: HostId;
  kind: 'isolated' | 'existing';
  path: string;
  repositoryRoot: string;
  baseCommit: string | null;
  access: 'inspect' | 'write';
  writes: string[];
  createdAt: Timestamp;
  retiredAt: Timestamp | null;
};

export type RegisterWorkspaceInput = {
  actor: SessionIdentity;
  id: WorkspaceId;
  kind: Workspace['kind'];
  path: string;
  repositoryRoot: string;
  baseCommit: string | null;
  access: Workspace['access'];
  writes: string[];
  idempotencyKey: string;
};

export type SessionIdentity = {
  id: AgentSessionId;
  generation: SessionGeneration;
};

export type AgentSession = SessionIdentity & {
  projectId: ProjectId;
  hostId: HostId;
  workspaceId: WorkspaceId | null;
  role: 'user' | 'controller' | 'worker';
  executionRole: string;
  parentWorkflowId: WorkflowId | null;
  attemptId: AttemptId | null;
  nativeKind: string | null;
  nativeServerGeneration: string | null;
  nativeLocator: string | null;
  state: 'active' | 'settled' | 'unconfirmed';
  createdAt: Timestamp;
  settledAt: Timestamp | null;
};

export type RegisterSessionInput = SessionIdentity & {
  workspaceId: WorkspaceId | null;
  role: AgentSession['role'];
  executionRole: string;
  tokenHash: string;
  parentWorkflowId: WorkflowId | null;
  attemptId: AttemptId | null;
  nativeKind: string | null;
  nativeServerGeneration: string | null;
  nativeLocator: string | null;
};

export type CreateJobInput = {
  actor: SessionIdentity;
  stableKey: string;
  request: OriginalRequest;
  brief: BriefContent;
  workspaceId: WorkspaceId;
  delivery: DeliveryKind;
  origin: JobOrigin;
  dependencies: JobId[];
  idempotencyKey: string;
};

export type CreateWorkflowInput = {
  actor: SessionIdentity;
  stableKey: string;
  package: WorkflowPackageSnapshot;
  request: OriginalRequest;
  brief: BriefContent;
  workspaceId: WorkspaceId;
  delivery: DeliveryKind;
  boundary: 'all' | 'design-only';
  idempotencyKey: string;
};

export type AdmitAttemptInput = {
  actor: SessionIdentity;
  jobId: JobId;
  session: SessionIdentity;
  resourceKey: string;
  inputResultIds: ResultId[];
  expectedBriefRevision: Revision;
  workflow:
    | { kind: 'direct' }
    | {
        kind: 'managed';
        workflowId: WorkflowId;
        stepRunId: StepRunId;
        expectedWorkflowRevision: Revision;
        expectedControlRevision: Revision;
      };
  idempotencyKey: string;
};

export type AdmittedAttempt = {
  attempt: Attempt;
  reservationId: z.infer<typeof ReservationIdSchema>;
  workflowRevision: Revision | null;
  replayed: boolean;
};

export type RecordResultInput = {
  actor: SessionIdentity;
  attemptId: AttemptId;
  content: ResultContent;
  inputDigest: Digest;
  workspaceDigest: Digest;
  evidenceClaims: string[];
  evidence: Evidence[];
  verification: Verification;
  upstreamResultIds: ResultId[];
  idempotencyKey: string;
};

export type ClaimAttemptInput = {
  actor: SessionIdentity;
  attemptId: AttemptId;
  expectedBriefRevision: Revision;
  expectedControlRevision: Revision | null;
  idempotencyKey: string;
};

export type ObserveAttemptRunningInput = {
  actor: SessionIdentity;
  attemptId: AttemptId;
  nativeKind: string;
  nativeServerGeneration: string;
  nativeLocator: string;
  idempotencyKey: string;
};

export type SettleAttemptInput = {
  actor: SessionIdentity;
  attemptId: AttemptId;
  observation:
    | { kind: 'settled'; outcome: 'succeeded' | 'failed' | 'interrupted'; reason: string }
    | { kind: 'unconfirmed'; reason: string };
  idempotencyKey: string;
};

export type ResultDecisionInput = {
  actor: SessionIdentity;
  resultId: ResultId;
  expectedBriefRevision: Revision;
  decision:
    { kind: 'accepted' } | { kind: 'rejected'; issues: string[]; retainedObservations: Evidence[] };
  idempotencyKey: string;
};

export type ResultDecision = {
  id: string;
  resultId: ResultId;
  briefId: BriefId;
  decision: 'accepted' | 'rejected';
  createdAt: Timestamp;
  replayed: boolean;
};

export type AcknowledgeBriefInput = {
  actor: SessionIdentity;
  attemptId: AttemptId;
  briefRevision: Revision;
  idempotencyKey: string;
};

export type ReviseBriefInput = {
  actor: SessionIdentity;
  jobId: JobId;
  expectedBriefRevision: Revision;
  brief: BriefContent;
  changeReason: string;
  idempotencyKey: string;
};

export type ControlWorkflowInput = {
  actor: SessionIdentity;
  workflowId: WorkflowId;
  expectedWorkflowRevision: Revision;
  expectedControlRevision: Revision;
  operation: ControlOperation;
  idempotencyKey: string;
};

export type RequestTransitionInput = {
  actor: SessionIdentity;
  request: TransitionRequest;
};

export type ResumeWorkflowInput = {
  actor: SessionIdentity;
  workflowId: WorkflowId;
  expectedWorkflowRevision: Revision;
  expectedBriefRevision: Revision;
  expectedControlRevision: Revision;
  decision: unknown | null;
  idempotencyKey: string;
};

export type ExtendLimitsInput = {
  actor: SessionIdentity;
  workflowId: WorkflowId;
  expectedLimitsRevision: Revision;
  limits: WorkflowLimits;
  deadlineAt: Timestamp;
  reason: string;
  idempotencyKey: string;
};

export type IdempotentResult<T> = { value: T; replayed: boolean };

const workspaceRowSchema = z.object({
  id: WorkspaceIdSchema,
  project_id: ProjectIdSchema,
  host_id: HostIdSchema,
  kind: z.enum(['isolated', 'existing']),
  path: z.string(),
  repository_root: z.string(),
  base_commit: z.string().nullable(),
  access: z.enum(['inspect', 'write']),
  writes_json: z.string(),
  created_at: TimestampSchema,
  retired_at: TimestampSchema.nullable(),
});

const sessionRowSchema = z.object({
  id: AgentSessionIdSchema,
  generation: SessionGenerationSchema,
  project_id: ProjectIdSchema,
  host_id: HostIdSchema,
  workspace_id: WorkspaceIdSchema.nullable(),
  role: z.enum(['user', 'controller', 'worker']),
  execution_role: z.string(),
  parent_workflow_id: WorkflowIdSchema.nullable(),
  attempt_id: AttemptIdSchema.nullable(),
  native_kind: z.string().nullable(),
  native_server_generation: z.string().nullable(),
  native_locator: z.string().nullable(),
  state: z.enum(['active', 'settled', 'unconfirmed']),
  created_at: TimestampSchema,
  settled_at: TimestampSchema.nullable(),
});

const jobRowSchema = z.object({
  id: JobIdSchema,
  stable_key: z.string(),
  request_id: JobRequestIdSchema,
  current_brief_id: BriefIdSchema,
  current_brief_revision: z.number().int().positive(),
  workspace_id: WorkspaceIdSchema,
  delivery_kind: z.enum(['report', 'patch', 'commit']),
  origin_kind: z.enum(['direct', 'workflow']),
  origin_workflow_id: WorkflowIdSchema.nullable(),
  origin_step_run_id: StepRunIdSchema.nullable(),
  state: z.enum(['open', 'finished', 'cancelled']),
  created_at: TimestampSchema,
});

const briefRowSchema = z.object({
  id: BriefIdSchema,
  job_id: JobIdSchema,
  revision: z.number().int().positive(),
  prior_brief_id: BriefIdSchema.nullable(),
  content_json: z.string(),
  change_reason: z.string(),
  created_at: TimestampSchema,
});

const attemptRowSchema = z.object({
  id: AttemptIdSchema,
  job_id: JobIdSchema,
  workflow_id: WorkflowIdSchema.nullable(),
  step_run_id: StepRunIdSchema.nullable(),
  brief_id: BriefIdSchema,
  brief_revision: z.number().int().positive(),
  host_id: HostIdSchema,
  workspace_id: WorkspaceIdSchema,
  session_id: AgentSessionIdSchema,
  session_generation: SessionGenerationSchema,
  phase: z.enum([
    'pending',
    'launching',
    'running',
    'stopping',
    'settled',
    'unconfirmed',
    'closed',
  ]),
  native_kind: z.string().nullable(),
  native_server_generation: z.string().nullable(),
  native_locator: z.string().nullable(),
  created_at: TimestampSchema,
  settled_at: TimestampSchema.nullable(),
});

const workflowRowSchema = z.object({
  id: WorkflowIdSchema,
  package_digest: DigestSchema,
  parent_workflow_id: WorkflowIdSchema.nullable(),
  root_job_id: JobIdSchema,
  current_step_run_id: StepRunIdSchema,
  phase: z.enum(['running', 'pausing', 'paused', 'cancelling', 'cancelled', 'finished']),
  outcome: z.enum(['succeeded', 'failed']).nullable(),
  execution_boundary: z.enum(['all', 'design-only']),
  revision: z.number().int().positive(),
  brief_revision: z.number().int().positive(),
  control_revision: z.number().int().positive(),
  max_attempts: z.number().int().positive(),
  max_repeats: z.number().int().positive(),
  parallelism: z.number().int().positive(),
  inner_loop_deadline_ms: z.number().int().positive(),
  deadline_at: TimestampSchema,
  created_at: TimestampSchema,
});

const stepRunRowSchema = z.object({
  id: StepRunIdSchema,
  workflow_id: WorkflowIdSchema,
  job_id: JobIdSchema,
  step_name: z.string(),
  ordinal: z.number().int().positive(),
  phase: z.enum([
    'pending',
    'active',
    'blocked',
    'awaiting-decision',
    'succeeded',
    'failed',
    'stale',
    'closed',
  ]),
  input_workflow_revision: z.number().int().positive(),
  input_brief_revision: z.number().int().positive(),
  created_at: TimestampSchema,
});

const resultRowSchema = z.object({
  id: ResultIdSchema,
  job_id: JobIdSchema,
  attempt_id: AttemptIdSchema,
  brief_id: BriefIdSchema,
  brief_revision: z.number().int().positive(),
  host_id: HostIdSchema,
  workspace_id: WorkspaceIdSchema,
  result_kind: z.enum(['report', 'patch', 'commit']),
  report_text: z.string().nullable(),
  input_digest: DigestSchema,
  workspace_digest: DigestSchema,
  source_repository: z.string().nullable(),
  base_commit: z.string().nullable(),
  resulting_tree: z.string().nullable(),
  resulting_commit: z.string().nullable(),
  changed_paths_json: z.string(),
  artifact_digests_json: z.string(),
  evidence_claims_json: z.string(),
  evidence_json: z.string(),
  verification_json: z.string(),
  created_at: TimestampSchema,
});

const stringArraySchema = z.array(z.string());
const admittedAttemptSchema = z.object({
  attemptId: AttemptIdSchema,
  reservationId: ReservationIdSchema,
  workflowRevision: z.number().int().positive().nullable(),
});
const resultDecisionRecordSchema = z.object({
  id: z.string().min(1),
  resultId: ResultIdSchema,
  briefId: BriefIdSchema,
  decision: z.enum(['accepted', 'rejected']),
  createdAt: TimestampSchema,
});
const idempotencyRowSchema = z.object({
  payload_digest: DigestSchema,
  result_json: z.string(),
});
const tokenHashRowSchema = z.object({
  token_hash: z.string().regex(/^[a-f0-9]{64}$/),
});
const packageSnapshotRowSchema = z.object({ snapshot_json: z.string() });
const ancestorLimitRowSchema = z.object({
  id: WorkflowIdSchema,
  max_attempts: z.number().int().positive(),
  parallelism: z.number().int().positive(),
  deadline_at: TimestampSchema,
});
const attemptUsageRowSchema = z.object({
  attempts: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
});
const controlledWorkflowRowSchema = z.object({
  id: WorkflowIdSchema,
  phase: z.enum(['pausing', 'cancelling']),
});
const countRowSchema = z.object({ count: z.number().int().nonnegative() });
const evidenceClaimsSchema = z.array(z.string().min(1));
const acceptedResultRowSchema = z.object({ decision: z.literal('accepted') });
const artifactReferenceRowSchema = z.object({
  id: z.string().min(1),
  host_id: HostIdSchema,
  path: z.string().min(1),
  byte_length: z.number().int().nonnegative(),
});
const sessionIdentitySchema = z.object({
  id: AgentSessionIdSchema,
  generation: SessionGenerationSchema,
});
const nativeIdentitySchema = z.union([
  z.object({ kind: z.null(), serverGeneration: z.null(), locator: z.null() }),
  z.object({
    kind: z.string().min(1),
    serverGeneration: z.string().min(1),
    locator: z.string().min(1),
  }),
]);

type SqliteRow = Record<string, SQLOutputValue>;

function parseJson<TOutput, TInput>(
  schema: z.ZodType<TOutput, z.ZodTypeDef, TInput>,
  encoded: string,
): TOutput {
  const value: unknown = JSON.parse(encoded);
  return schema.parse(value);
}

function isPromise<T>(value: T): value is T & Promise<unknown> {
  return value instanceof Promise;
}

function requireValue<T>(value: T | undefined, code: StoreErrorCode, message: string): T {
  if (value === undefined) throw new StoreError(code, message);
  return value;
}

function attemptFromRow(raw: SqliteRow): Attempt {
  const row = attemptRowSchema.parse(raw);
  return {
    id: row.id,
    jobId: row.job_id,
    workflowId: row.workflow_id,
    stepRunId: row.step_run_id,
    briefId: row.brief_id,
    briefRevision: row.brief_revision,
    hostId: row.host_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    sessionGeneration: row.session_generation,
    phase: row.phase,
    nativeKind: row.native_kind,
    nativeServerGeneration: row.native_server_generation,
    nativeLocator: row.native_locator,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

function evidenceArtifactDigests(evidence: readonly Evidence[]): Digest[] {
  const digests: Digest[] = [];
  for (const item of evidence) {
    switch (item.kind) {
      case 'file':
        digests.push(item.digest);
        break;
      case 'command':
        digests.push(item.log);
        break;
      case 'git-commit':
        break;
    }
  }
  return digests;
}

export class Store {
  readonly databasePath: string;
  readonly project: ProjectBinding;
  readonly #database: DatabaseSync;
  readonly #clock: () => Date;
  readonly #idFactory: (kind: string) => string;
  #transactionDepth = 0;
  #closed = false;

  private constructor(options: StoreOptions, database: DatabaseSync) {
    this.databasePath = options.databasePath;
    this.project = ProjectBindingSchema.parse(options.project);
    this.#database = database;
    this.#clock = options.clock ?? (() => new Date());
    this.#idFactory = options.idFactory ?? ((kind) => `${kind}_${randomUUID()}`);
    this.#bindProject(options.readOnly ?? false);
  }

  static open(options: StoreOptions): Store {
    const project = ProjectBindingSchema.parse(options.project);
    const database = openDatabase({
      readOnly: options.readOnly,
      path: options.databasePath,
      projectId: project.id,
      busyTimeoutMs: options.busyTimeoutMs,
    });
    try {
      return new Store({ ...options, project }, database);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  read<T>(fn: (database: DatabaseSync) => T): T {
    return this.#runTransaction('deferred', fn);
  }

  transaction<T>(fn: (database: DatabaseSync) => T): T {
    return this.#runTransaction('immediate', fn);
  }

  idempotent<TOutput, TInput, TPayload extends object = object>(
    scope: string,
    key: string,
    payload: TPayload,
    resultSchema: z.ZodType<TOutput, z.ZodTypeDef, TInput>,
    fn: (database: DatabaseSync) => TOutput,
  ): IdempotentResult<TOutput> {
    if (scope.length === 0 || key.length === 0) {
      throw new StoreError('idempotency-conflict', 'Idempotency scope and key are required');
    }
    const digest = payloadDigest(payload);
    return this.transaction((database) => {
      const rawExisting = database
        .prepare(
          `SELECT payload_digest, result_json FROM idempotency_records
           WHERE project_id = ? AND scope = ? AND idempotency_key = ?`,
        )
        .get(this.project.id, scope, key);
      if (rawExisting !== undefined) {
        const existing = idempotencyRowSchema.parse(rawExisting);
        if (existing.payload_digest !== digest) {
          throw new StoreError(
            'idempotency-conflict',
            `Idempotency key ${key} was already used with a different payload`,
          );
        }
        const value: unknown = JSON.parse(existing.result_json);
        return { value: resultSchema.parse(value), replayed: true };
      }

      const value = fn(database);
      database
        .prepare(
          `INSERT INTO idempotency_records
             (project_id, scope, idempotency_key, payload_digest, result_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(this.project.id, scope, key, digest, canonicalJson(value), this.#now());
      return { value, replayed: false };
    });
  }

  #runTransaction<T>(mode: 'deferred' | 'immediate', fn: (database: DatabaseSync) => T): T {
    if (this.#closed) throw new StoreError('invalid-state', 'Store is closed');
    const depth = this.#transactionDepth;
    const savepoint = `marionette_nested_${depth}`;
    if (depth === 0) this.#database.exec(mode === 'immediate' ? 'BEGIN IMMEDIATE' : 'BEGIN');
    else this.#database.exec(`SAVEPOINT ${savepoint}`);
    this.#transactionDepth += 1;
    try {
      const value = fn(this.#database);
      if (isPromise(value)) {
        throw new StoreError('invalid-state', 'Store transactions must be synchronous');
      }
      if (depth === 0) this.#database.exec('COMMIT');
      else this.#database.exec(`RELEASE ${savepoint}`);
      return value;
    } catch (error) {
      if (depth === 0) this.#database.exec('ROLLBACK');
      else {
        this.#database.exec(`ROLLBACK TO ${savepoint}`);
        this.#database.exec(`RELEASE ${savepoint}`);
      }
      throw error;
    } finally {
      this.#transactionDepth -= 1;
    }
  }

  #now(): Timestamp {
    return TimestampSchema.parse(this.#clock().toISOString());
  }

  #newId<T>(kind: string, schema: z.ZodType<T>): T {
    return schema.parse(this.#idFactory(kind));
  }

  #bindProject(readOnly: boolean): void {
    this.#runTransaction(readOnly ? 'deferred' : 'immediate', (database) => {
      const existing = database
        .prepare(
          `SELECT b.project_id, b.host_id, p.repository_root, p.state_directory
           FROM store_binding b JOIN projects p ON p.id = b.project_id
           WHERE b.singleton = 1`,
        )
        .get();
      if (existing !== undefined) {
        if (
          existing.project_id !== this.project.id ||
          existing.host_id !== this.project.hostId ||
          existing.repository_root !== this.project.repositoryRoot ||
          existing.state_directory !== this.project.stateDirectory
        ) {
          throw new StoreError(
            'binding-mismatch',
            'Database is already bound to a different project or execution host',
          );
        }
        return;
      }
      if (readOnly)
        throw new StoreError(
          'binding-mismatch',
          'Preview requires an initialized project binding.',
        );
      const now = this.#now();
      database
        .prepare('INSERT OR IGNORE INTO hosts (id, created_at) VALUES (?, ?)')
        .run(this.project.hostId, now);
      database
        .prepare(
          `INSERT INTO projects (id, host_id, repository_root, state_directory, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          this.project.id,
          this.project.hostId,
          this.project.repositoryRoot,
          this.project.stateDirectory,
          now,
        );
      database
        .prepare('INSERT INTO store_binding (singleton, project_id, host_id) VALUES (1, ?, ?)')
        .run(this.project.id, this.project.hostId);
    });
  }

  registerSession(input: RegisterSessionInput): AgentSession {
    const tokenHash = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(input.tokenHash);
    const executionRole = z.string().min(1).parse(input.executionRole);
    const nativeIdentity = nativeIdentitySchema.parse({
      kind: input.nativeKind,
      serverGeneration: input.nativeServerGeneration,
      locator: input.nativeLocator,
    });
    return this.transaction((database) => {
      const existing = database
        .prepare('SELECT * FROM agent_sessions WHERE id = ? AND generation = ?')
        .get(input.id, input.generation);
      if (existing !== undefined) {
        const storedHash = database
          .prepare('SELECT token_hash FROM agent_sessions WHERE id = ? AND generation = ?')
          .get(input.id, input.generation)?.token_hash;
        const session = this.#sessionFromRow(existing);
        if (
          storedHash !== tokenHash ||
          canonicalJson({ ...session, tokenHash }) !==
            canonicalJson({
              id: input.id,
              generation: input.generation,
              projectId: this.project.id,
              hostId: this.project.hostId,
              workspaceId: input.workspaceId,
              role: input.role,
              executionRole,
              parentWorkflowId: input.parentWorkflowId,
              attemptId: input.attemptId,
              nativeKind: nativeIdentity.kind,
              nativeServerGeneration: nativeIdentity.serverGeneration,
              nativeLocator: nativeIdentity.locator,
              state: 'active',
              createdAt: session.createdAt,
              settledAt: null,
              tokenHash,
            })
        ) {
          throw new StoreError(
            'identity-mismatch',
            'Session identity and role binding cannot change within a generation',
          );
        }
        return session;
      }
      if (input.workspaceId !== null) this.#requireAdmissibleWorkspace(database, input.workspaceId);
      const now = this.#now();
      database
        .prepare(
          `INSERT INTO agent_sessions
             (id, generation, project_id, host_id, workspace_id, role, execution_role,
              token_hash, parent_workflow_id, attempt_id, native_kind,
              native_server_generation, native_locator, state, created_at, settled_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL)`,
        )
        .run(
          input.id,
          input.generation,
          this.project.id,
          this.project.hostId,
          input.workspaceId,
          input.role,
          executionRole,
          tokenHash,
          input.parentWorkflowId,
          input.attemptId,
          nativeIdentity.kind,
          nativeIdentity.serverGeneration,
          nativeIdentity.locator,
          now,
        );
      return this.#requireSession(database, input);
    });
  }

  authenticateSession(input: SessionIdentity & { token: string }): AgentSession {
    return this.read((database) => {
      const row = requireValue(
        database
          .prepare('SELECT * FROM agent_sessions WHERE id = ? AND generation = ?')
          .get(input.id, input.generation),
        'not-found',
        `Session ${input.id} generation ${input.generation} was not found`,
      );
      const tokenRow = requireValue(
        database
          .prepare('SELECT token_hash FROM agent_sessions WHERE id = ? AND generation = ?')
          .get(input.id, input.generation),
        'identity-mismatch',
        'Invalid session',
      );
      const tokenHash = tokenHashRowSchema.parse(tokenRow).token_hash;
      const suppliedHash = createHash('sha256').update(input.token).digest();
      const storedHash = Buffer.from(tokenHash, 'hex');
      if (storedHash.length !== suppliedHash.length || !timingSafeEqual(storedHash, suppliedHash)) {
        throw new StoreError('identity-mismatch', 'Invalid session token');
      }
      const session = this.#sessionFromRow(row);
      if (session.state !== 'active') {
        throw new StoreError('identity-mismatch', `Session ${input.id} is ${session.state}`);
      }
      return session;
    });
  }

  /**
   * Authenticate the original worker narrowly for a result that races native settlement.
   * Settled/unconfirmed sessions stay unusable for every other operation.
   */
  authenticateResultSession(
    input: SessionIdentity & { token: string },
    attemptId: AttemptId,
  ): AgentSession {
    return this.read((database) => {
      const row = requireValue(
        database
          .prepare('SELECT * FROM agent_sessions WHERE id = ? AND generation = ?')
          .get(input.id, input.generation),
        'not-found',
        `Session ${input.id} generation ${input.generation} was not found`,
      );
      const tokenHash = tokenHashRowSchema.parse(
        requireValue(
          database
            .prepare('SELECT token_hash FROM agent_sessions WHERE id = ? AND generation = ?')
            .get(input.id, input.generation),
          'identity-mismatch',
          'Invalid session',
        ),
      ).token_hash;
      const suppliedHash = createHash('sha256').update(input.token).digest();
      const storedHash = Buffer.from(tokenHash, 'hex');
      if (storedHash.length !== suppliedHash.length || !timingSafeEqual(storedHash, suppliedHash))
        throw new StoreError('identity-mismatch', 'Invalid session token');
      const session = this.#sessionFromRow(row);
      if (
        session.role !== 'worker' ||
        session.attemptId !== attemptId ||
        !['active', 'settled', 'unconfirmed'].includes(session.state)
      )
        throw new StoreError(
          'identity-mismatch',
          `Session ${input.id} is not the original worker for attempt ${attemptId}`,
        );
      return session;
    });
  }

  registerWorkspace(input: RegisterWorkspaceInput): Workspace {
    this.#requireActor(input.actor, ['user', 'controller']);
    const result = this.idempotent(
      'register-workspace',
      input.idempotencyKey,
      input,
      WorkspaceIdSchema,
      (database) => {
        const now = this.#now();
        database
          .prepare(
            `INSERT INTO workspaces
               (id, project_id, host_id, kind, path, repository_root, base_commit, access,
                writes_json, created_at, retired_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          )
          .run(
            input.id,
            this.project.id,
            this.project.hostId,
            input.kind,
            input.path,
            input.repositoryRoot,
            input.baseCommit,
            input.access,
            canonicalJson(input.writes),
            now,
          );
        return input.id;
      },
    );
    return this.getWorkspace(result.value);
  }

  getWorkspace(id: WorkspaceId): Workspace {
    return this.read((database) => this.#requireWorkspace(database, id));
  }

  #requireWorkspace(database: DatabaseSync, id: WorkspaceId): Workspace {
    const row = workspaceRowSchema.parse(
      requireValue(
        database
          .prepare('SELECT * FROM workspaces WHERE project_id = ? AND id = ?')
          .get(this.project.id, id),
        'not-found',
        `Workspace ${id} was not found`,
      ),
    );
    return {
      id: row.id,
      projectId: row.project_id,
      hostId: row.host_id,
      kind: row.kind,
      path: row.path,
      repositoryRoot: row.repository_root,
      baseCommit: row.base_commit,
      access: row.access,
      writes: parseJson(stringArraySchema, row.writes_json),
      createdAt: row.created_at,
      retiredAt: row.retired_at,
    };
  }

  #requireAdmissibleWorkspace(database: DatabaseSync, id: WorkspaceId): Workspace {
    const workspace = this.#requireWorkspace(database, id);
    if (workspace.retiredAt !== null) {
      throw new StoreError('invalid-state', `Workspace ${id} has been retired`);
    }
    const retirement = database
      .prepare(
        `SELECT id FROM workspace_retirements
         WHERE project_id = ? AND workspace_id = ? AND state <> 'completed'`,
      )
      .get(this.project.id, id);
    if (retirement !== undefined) {
      throw new StoreError('resource-busy', `Workspace ${id} is being retired`);
    }
    return workspace;
  }

  #sessionFromRow(raw: SqliteRow): AgentSession {
    const row = sessionRowSchema.parse(raw);
    return {
      id: row.id,
      generation: row.generation,
      projectId: row.project_id,
      hostId: row.host_id,
      workspaceId: row.workspace_id,
      role: row.role,
      executionRole: row.execution_role,
      parentWorkflowId: row.parent_workflow_id,
      attemptId: row.attempt_id,
      nativeKind: row.native_kind,
      nativeServerGeneration: row.native_server_generation,
      nativeLocator: row.native_locator,
      state: row.state,
      createdAt: row.created_at,
      settledAt: row.settled_at,
    };
  }

  #requireSession(database: DatabaseSync, identity: SessionIdentity): AgentSession {
    const row = requireValue(
      database
        .prepare('SELECT * FROM agent_sessions WHERE project_id = ? AND id = ? AND generation = ?')
        .get(this.project.id, identity.id, identity.generation),
      'not-found',
      `Session ${identity.id} generation ${identity.generation} was not found`,
    );
    return this.#sessionFromRow(row);
  }

  #requireActor(
    actor: SessionIdentity,
    allowedRoles: readonly AgentSession['role'][] = ['user', 'controller', 'worker'],
  ): AgentSession {
    return this.read((database) => {
      const session = this.#requireSession(database, actor);
      if (session.state !== 'active' || !allowedRoles.includes(session.role)) {
        throw new StoreError('permission-denied', 'Session cannot perform this operation');
      }
      if (session.role === 'controller') workflowService.assertWorkflowActor(database, this, actor);
      return session;
    });
  }

  createJob(input: CreateJobInput): Job {
    this.#requireActor(input.actor, ['user', 'controller']);
    const result = this.idempotent(
      'create-job',
      input.idempotencyKey,
      input,
      JobIdSchema,
      (database) => this.#insertJob(database, input),
    );
    return this.getJob(result.value);
  }

  #insertJob(
    database: DatabaseSync,
    input: Omit<CreateJobInput, 'actor' | 'idempotencyKey'>,
  ): JobId {
    this.#requireAdmissibleWorkspace(database, input.workspaceId);
    if (input.origin.kind === 'workflow') {
      this.#requireWorkflow(database, input.origin.workflowId);
      const step = this.#requireStepRun(database, input.origin.stepRunId);
      if (step.workflowId !== input.origin.workflowId) {
        throw new StoreError('invalid-state', 'Job origin step belongs to another workflow');
      }
    }
    for (const dependency of input.dependencies) this.#requireJob(database, dependency);

    const requestId = this.#newId('request', JobRequestIdSchema);
    const jobId = this.#newId('job', JobIdSchema);
    const briefId = this.#newId('brief', BriefIdSchema);
    const now = this.#now();
    database
      .prepare(
        `INSERT INTO job_requests (id, project_id, request_digest, request_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(requestId, this.project.id, input.request.digest, canonicalJson(input.request), now);
    database
      .prepare(
        `INSERT INTO jobs
           (id, project_id, stable_key, request_id, current_brief_id, current_brief_revision,
            workspace_id, delivery_kind, origin_kind, origin_workflow_id, origin_step_run_id,
            state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(
        jobId,
        this.project.id,
        input.stableKey,
        requestId,
        briefId,
        input.workspaceId,
        input.delivery,
        input.origin.kind,
        input.origin.kind === 'workflow' ? input.origin.workflowId : null,
        input.origin.kind === 'workflow' ? input.origin.stepRunId : null,
        now,
        now,
      );
    database
      .prepare(
        `INSERT INTO brief_revisions
           (id, project_id, job_id, revision, prior_brief_id, content_json, change_reason, created_at)
         VALUES (?, ?, ?, 1, NULL, ?, 'Initial execution brief', ?)`,
      )
      .run(briefId, this.project.id, jobId, canonicalJson(input.brief), now);
    const dependencyInsert = database.prepare(
      'INSERT INTO job_dependencies (job_id, depends_on_job_id, created_at) VALUES (?, ?, ?)',
    );
    for (const dependency of input.dependencies) dependencyInsert.run(jobId, dependency, now);
    new EventStore(this).append({
      kind: 'job.created',
      aggregate: { kind: 'job', id: jobId, revision: 1 },
      payload: { jobId },
      dedupeKey: `job.created/${jobId}`,
    });
    return jobId;
  }

  getJob(id: JobId): Job {
    return this.read((database) => this.#requireJob(database, id));
  }

  listJobs(): Job[] {
    return this.read((database) =>
      database
        .prepare('SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at, id')
        .all(this.project.id)
        .map((row) => this.#jobFromRow(row)),
    );
  }

  #jobFromRow(raw: SqliteRow): Job {
    const row = jobRowSchema.parse(raw);
    let origin: JobOrigin;
    if (row.origin_kind === 'direct') {
      if (row.origin_workflow_id !== null || row.origin_step_run_id !== null) {
        throw new StoreError('invalid-state', `Direct job ${row.id} has workflow origin fields`);
      }
      origin = { kind: 'direct' };
    } else {
      if (row.origin_workflow_id === null || row.origin_step_run_id === null) {
        throw new StoreError(
          'invalid-state',
          `Workflow job ${row.id} has incomplete origin fields`,
        );
      }
      origin = {
        kind: 'workflow',
        workflowId: row.origin_workflow_id,
        stepRunId: row.origin_step_run_id,
      };
    }
    return {
      id: row.id,
      key: row.stable_key,
      requestId: row.request_id,
      currentBriefId: row.current_brief_id,
      currentBriefRevision: row.current_brief_revision,
      workspaceId: row.workspace_id,
      delivery: row.delivery_kind,
      origin,
      state: row.state,
      createdAt: row.created_at,
    };
  }

  #requireJob(database: DatabaseSync, id: JobId): Job {
    return this.#jobFromRow(
      requireValue(
        database
          .prepare('SELECT * FROM jobs WHERE project_id = ? AND id = ?')
          .get(this.project.id, id),
        'not-found',
        `Job ${id} was not found`,
      ),
    );
  }

  getBrief(jobId: JobId, revision?: Revision): BriefRevision {
    return this.read((database) => {
      const job = this.#requireJob(database, jobId);
      const requestedRevision = revision ?? job.currentBriefRevision;
      const row = requireValue(
        database
          .prepare(
            `SELECT * FROM brief_revisions
             WHERE project_id = ? AND job_id = ? AND revision = ?`,
          )
          .get(this.project.id, jobId, requestedRevision),
        'not-found',
        `Brief revision ${requestedRevision} for job ${jobId} was not found`,
      );
      return this.#briefFromRow(row);
    });
  }

  #briefFromRow(raw: SqliteRow): BriefRevision {
    const row = briefRowSchema.parse(raw);
    return {
      id: row.id,
      jobId: row.job_id,
      revision: row.revision,
      priorBriefId: row.prior_brief_id,
      content: parseJson(BriefContentSchema, row.content_json),
      changeReason: row.change_reason,
      createdAt: row.created_at,
    };
  }

  createWorkflow(input: CreateWorkflowInput): WorkflowRun {
    this.#requireActor(input.actor, ['user', 'controller']);
    const workflowPackage = WorkflowPackageSnapshotSchema.parse(input.package);
    const result = this.idempotent(
      'create-workflow',
      input.idempotencyKey,
      { ...input, package: workflowPackage },
      WorkflowIdSchema,
      (database) => {
        const firstStep = requireValue(
          workflowPackage.steps.find((step) => step.name === workflowPackage.entryStep),
          'invalid-transition',
          `Workflow package ${workflowPackage.name} has no entry step`,
        );
        if (input.boundary === 'design-only' && firstStep.phase === 'implementation') {
          throw new StoreError(
            'invalid-transition',
            'A design-only workflow cannot start an implementation step',
          );
        }
        this.#requireAdmissibleWorkspace(database, input.workspaceId);
        this.#insertPackage(database, workflowPackage);
        const workflowId = this.#newId('workflow', WorkflowIdSchema);
        const stepRunId = this.#newId('step', StepRunIdSchema);
        const now = this.#now();
        const deadlineAt = TimestampSchema.parse(
          new Date(this.#clock().getTime() + workflowPackage.limits.deadlineMs).toISOString(),
        );
        const requestId = this.#newId('request', JobRequestIdSchema);
        const jobId = this.#newId('job', JobIdSchema);
        const briefId = this.#newId('brief', BriefIdSchema);

        database
          .prepare(
            `INSERT INTO workflow_runs
               (id, project_id, package_digest, parent_workflow_id, root_job_id,
                current_step_run_id, phase, outcome, execution_boundary, revision,
                brief_revision, control_revision, limits_revision, max_attempts,
                max_repeats, parallelism, inner_loop_deadline_ms, deadline_at,
                created_at, updated_at)
             VALUES (?, ?, ?, NULL, ?, ?, 'running', NULL, ?, 1, 1, 1, 1,
                     ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            workflowId,
            this.project.id,
            workflowPackage.digest,
            jobId,
            stepRunId,
            input.boundary,
            workflowPackage.limits.maxAttempts,
            workflowPackage.limits.maxRepeats,
            workflowPackage.limits.parallelism,
            workflowPackage.limits.innerLoopDeadlineMs,
            deadlineAt,
            now,
            now,
          );
        database
          .prepare(
            `INSERT INTO job_requests (id, project_id, request_digest, request_json, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(requestId, this.project.id, input.request.digest, canonicalJson(input.request), now);
        database
          .prepare(
            `INSERT INTO jobs
               (id, project_id, stable_key, request_id, current_brief_id,
                current_brief_revision, workspace_id, delivery_kind, origin_kind,
                origin_workflow_id, origin_step_run_id, state, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'workflow', ?, ?, 'open', ?, ?)`,
          )
          .run(
            jobId,
            this.project.id,
            input.stableKey,
            requestId,
            briefId,
            input.workspaceId,
            input.delivery,
            workflowId,
            stepRunId,
            now,
            now,
          );
        database
          .prepare(
            `INSERT INTO brief_revisions
               (id, project_id, job_id, revision, prior_brief_id, content_json,
                change_reason, created_at)
             VALUES (?, ?, ?, 1, NULL, ?, 'Initial workflow brief', ?)`,
          )
          .run(briefId, this.project.id, jobId, canonicalJson(input.brief), now);
        database
          .prepare(
            `INSERT INTO step_runs
               (id, project_id, workflow_id, job_id, step_name, step_phase, ordinal,
                phase, input_workflow_revision, input_brief_revision,
                source_transition_request_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, 'pending', 1, 1, NULL, ?, ?)`,
          )
          .run(
            stepRunId,
            this.project.id,
            workflowId,
            jobId,
            firstStep.name,
            firstStep.phase,
            now,
            now,
          );
        database
          .prepare(
            `INSERT INTO step_run_inputs (step_run_id, brief_id, result_id, ordinal)
             VALUES (?, ?, NULL, 0)`,
          )
          .run(stepRunId, briefId);
        database
          .prepare(
            `INSERT INTO limit_revisions
               (id, project_id, workflow_id, revision, max_attempts, max_repeats,
                parallelism, inner_loop_deadline_ms, deadline_at, reason,
                authorized_by_session_id, authorized_by_session_generation, created_at)
             VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 'Initial package limits', ?, ?, ?)`,
          )
          .run(
            this.#newId('limits', z.string().min(1)),
            this.project.id,
            workflowId,
            workflowPackage.limits.maxAttempts,
            workflowPackage.limits.maxRepeats,
            workflowPackage.limits.parallelism,
            workflowPackage.limits.innerLoopDeadlineMs,
            deadlineAt,
            input.actor.id,
            input.actor.generation,
            now,
          );
        new EventStore(this).append({
          kind: 'workflow.created',
          aggregate: { kind: 'workflow', id: workflowId, revision: 1 },
          payload: { workflowId, jobId },
          dedupeKey: `workflow.created/${workflowId}`,
        });
        return workflowId;
      },
    );
    return this.getWorkflow(result.value);
  }

  #insertPackage(database: DatabaseSync, workflowPackage: WorkflowPackageSnapshot): void {
    const existing = database
      .prepare('SELECT snapshot_json FROM workflow_packages WHERE project_id = ? AND digest = ?')
      .get(this.project.id, workflowPackage.digest)?.snapshot_json;
    const snapshot = canonicalJson(workflowPackage);
    if (existing !== undefined) {
      if (existing !== snapshot) {
        throw new StoreError(
          'idempotency-conflict',
          `Workflow package digest ${workflowPackage.digest} has different content`,
        );
      }
      return;
    }
    database
      .prepare(
        `INSERT INTO workflow_packages
           (project_id, digest, name, version, snapshot_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.project.id,
        workflowPackage.digest,
        workflowPackage.name,
        workflowPackage.version,
        snapshot,
        this.#now(),
      );
  }

  getWorkflow(id: WorkflowId): WorkflowRun {
    return this.read((database) => this.#requireWorkflow(database, id));
  }

  listWorkflows(): WorkflowRun[] {
    return this.read((database) =>
      database
        .prepare('SELECT * FROM workflow_runs WHERE project_id = ? ORDER BY created_at, id')
        .all(this.project.id)
        .map((row) => this.#workflowFromRow(database, row)),
    );
  }

  #workflowFromRow(database: DatabaseSync, raw: SqliteRow): WorkflowRun {
    const row = workflowRowSchema.parse(raw);
    const snapshotRow = requireValue(
      database
        .prepare('SELECT snapshot_json FROM workflow_packages WHERE project_id = ? AND digest = ?')
        .get(this.project.id, row.package_digest),
      'invalid-state',
      `Workflow ${row.id} has no package snapshot`,
    );
    const snapshot = packageSnapshotRowSchema.parse(snapshotRow).snapshot_json;
    return {
      id: row.id,
      package: parseJson(WorkflowPackageSnapshotSchema, snapshot),
      parentWorkflowId: row.parent_workflow_id,
      rootJobId: row.root_job_id,
      currentStepRunId: row.current_step_run_id,
      phase: row.phase,
      outcome: row.outcome,
      boundary: row.execution_boundary,
      revision: row.revision,
      briefRevision: row.brief_revision,
      controlRevision: row.control_revision,
      limits: {
        maxAttempts: row.max_attempts,
        maxRepeats: row.max_repeats,
        parallelism: row.parallelism,
        innerLoopDeadlineMs: row.inner_loop_deadline_ms,
        deadlineMs: Math.max(
          1,
          new Date(row.deadline_at).getTime() - new Date(row.created_at).getTime(),
        ),
      },
      deadlineAt: row.deadline_at,
      createdAt: row.created_at,
    };
  }

  #requireWorkflow(database: DatabaseSync, id: WorkflowId): WorkflowRun {
    return this.#workflowFromRow(
      database,
      requireValue(
        database
          .prepare('SELECT * FROM workflow_runs WHERE project_id = ? AND id = ?')
          .get(this.project.id, id),
        'not-found',
        `Workflow ${id} was not found`,
      ),
    );
  }

  getStepRun(id: StepRunId): StepRun {
    return this.read((database) => this.#requireStepRun(database, id));
  }

  #requireStepRun(database: DatabaseSync, id: StepRunId): StepRun {
    const row = stepRunRowSchema.parse(
      requireValue(
        database
          .prepare('SELECT * FROM step_runs WHERE project_id = ? AND id = ?')
          .get(this.project.id, id),
        'not-found',
        `Step run ${id} was not found`,
      ),
    );
    return {
      id: row.id,
      workflowId: row.workflow_id,
      jobId: row.job_id,
      stepName: row.step_name,
      ordinal: row.ordinal,
      phase: row.phase,
      inputWorkflowRevision: row.input_workflow_revision,
      inputBriefRevision: row.input_brief_revision,
      createdAt: row.created_at,
    };
  }

  admitAttempt(input: AdmitAttemptInput): AdmittedAttempt {
    this.#requireActor(input.actor, ['user', 'controller']);
    const result = this.idempotent(
      'admit-attempt',
      input.idempotencyKey,
      input,
      admittedAttemptSchema,
      (database) => {
        workflowService.assertWorkflowActor(database, this, input.actor);
        const job = this.#requireJob(database, input.jobId);
        if (job.state !== 'open') {
          throw new StoreError('invalid-state', `Job ${job.id} is ${job.state}`);
        }
        if (job.currentBriefRevision !== input.expectedBriefRevision) {
          throw new StoreError(
            'stale-revision',
            `Job ${job.id} brief is revision ${job.currentBriefRevision}`,
          );
        }
        const unsettledPriorAttempt = database
          .prepare(
            `SELECT id FROM attempts
             WHERE project_id = ? AND job_id = ?
               AND phase IN ('launching','running','stopping','unconfirmed')
             LIMIT 1`,
          )
          .get(this.project.id, job.id);
        if (unsettledPriorAttempt !== undefined) {
          throw new StoreError(
            'resource-busy',
            `Job ${job.id} has a prior attempt whose effects are not settled`,
          );
        }
        this.#requireAdmissibleWorkspace(database, job.workspaceId);
        const session = this.#requireSession(database, input.session);
        if (session.state !== 'active') {
          throw new StoreError('identity-mismatch', `Session ${session.id} is ${session.state}`);
        }
        if (session.hostId !== this.project.hostId || session.workspaceId !== job.workspaceId) {
          throw new StoreError(
            'identity-mismatch',
            'Attempt session does not match the job execution host and workspace',
          );
        }
        if (session.attemptId !== null) {
          throw new StoreError(
            'identity-mismatch',
            `Session ${session.id} already owns an attempt`,
          );
        }

        let workflowId: WorkflowId | null = null;
        let stepRunId: StepRunId | null = null;
        let workflowRevision: Revision | null = null;
        if (input.workflow.kind === 'managed') {
          const workflow = this.#requireWorkflow(database, input.workflow.workflowId);
          const step = this.#requireStepRun(database, input.workflow.stepRunId);
          if (
            workflow.phase !== 'running' ||
            workflow.revision !== input.workflow.expectedWorkflowRevision ||
            workflow.controlRevision !== input.workflow.expectedControlRevision ||
            workflow.briefRevision !== input.expectedBriefRevision
          ) {
            throw new StoreError(
              'stale-revision',
              `Workflow ${workflow.id} changed or is not accepting work`,
            );
          }
          if (
            workflow.currentStepRunId !== step.id ||
            step.workflowId !== workflow.id ||
            step.jobId !== job.id ||
            !['pending', 'active'].includes(step.phase)
          ) {
            throw new StoreError('invalid-state', 'Step run is not the active workflow step');
          }
          if (session.parentWorkflowId !== workflow.id) {
            throw new StoreError(
              'identity-mismatch',
              'Managed attempt session is not bound to its workflow',
            );
          }
          const packageStep = requireValue(
            workflow.package.steps.find((candidate) => candidate.name === step.stepName),
            'invalid-state',
            `Step ${step.stepName} is missing from its pinned package`,
          );
          if (workflow.boundary === 'design-only' && packageStep.phase === 'implementation') {
            throw new StoreError(
              'invalid-transition',
              'A design-only workflow cannot admit implementation work',
            );
          }
          this.#assertDistinctRole(
            database,
            workflow,
            step,
            packageStep.requiresDistinctRole,
            session,
          );
          this.#assertAttemptCapacity(database, workflow.id);
          workflowId = workflow.id;
          stepRunId = step.id;
          workflowRevision = workflow.revision + 1;
        } else if (session.parentWorkflowId !== null) {
          throw new StoreError(
            'identity-mismatch',
            'A direct attempt session cannot inherit a managed workflow',
          );
        }

        if (stepRunId !== null) {
          const required = database
            .prepare(
              'SELECT result_id FROM step_run_inputs WHERE step_run_id=? AND result_id IS NOT NULL',
            )
            .all(stepRunId);
          if (
            required.some(
              (row) => !input.inputResultIds.includes(ResultIdSchema.parse(row.result_id)),
            )
          )
            throw new StoreError(
              'invalid-state',
              'Managed admission must include every declared step input result',
            );
        }
        for (const resultId of input.inputResultIds) {
          const repair =
            stepRunId !== null &&
            database
              .prepare(
                'SELECT 1 FROM workflow_repair_cycles r,json_each(r.issue_result_ids_json) i WHERE r.target_step_run_id=? AND i.value=?',
              )
              .get(stepRunId, resultId);
          if (repair) this.#requireEligibleResult(database, resultId);
          else this.#requireAcceptedResult(database, resultId);
        }
        const attemptId = this.#newId('attempt', AttemptIdSchema);
        const reservationId = this.#newId('reservation', ReservationIdSchema);
        const now = this.#now();
        try {
          database
            .prepare(
              `INSERT INTO attempts
                 (id, project_id, job_id, workflow_id, step_run_id, brief_id,
                  brief_revision, host_id, workspace_id, session_id, session_generation,
                  phase, native_kind, native_server_generation, native_locator, outcome,
                  settlement_reason, created_at, launch_claimed_at, running_at, settled_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL,
                       NULL, NULL, ?, NULL, NULL, NULL)`,
            )
            .run(
              attemptId,
              this.project.id,
              job.id,
              workflowId,
              stepRunId,
              job.currentBriefId,
              job.currentBriefRevision,
              this.project.hostId,
              job.workspaceId,
              session.id,
              session.generation,
              now,
            );
          database
            .prepare(
              `INSERT INTO execution_reservations
                 (id, project_id, attempt_id, workflow_id, resource_key, state,
                  created_at, released_at, release_reason)
               VALUES (?, ?, ?, ?, ?, 'held', ?, NULL, NULL)`,
            )
            .run(reservationId, this.project.id, attemptId, workflowId, input.resourceKey, now);
        } catch (error) {
          if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
            throw new StoreError('resource-busy', `Resource ${input.resourceKey} is reserved`, {
              cause: error,
            });
          }
          throw error;
        }
        const inputInsert = database.prepare(
          'INSERT INTO attempt_input_results (attempt_id, result_id, ordinal) VALUES (?, ?, ?)',
        );
        input.inputResultIds.forEach((resultId, index) =>
          inputInsert.run(attemptId, resultId, index),
        );
        database
          .prepare(
            `UPDATE agent_sessions SET attempt_id = ?
             WHERE project_id = ? AND id = ? AND generation = ? AND attempt_id IS NULL`,
          )
          .run(attemptId, this.project.id, session.id, session.generation);
        if (workflowId !== null && stepRunId !== null && workflowRevision !== null) {
          recordWorkflowAdmission(database, this, workflowId, stepRunId, attemptId, now);
          database
            .prepare(
              `UPDATE workflow_runs SET revision = ?, updated_at = ?
               WHERE project_id = ? AND id = ?`,
            )
            .run(workflowRevision, now, this.project.id, workflowId);
          database
            .prepare(
              `UPDATE step_runs SET phase = 'active', updated_at = ?
               WHERE project_id = ? AND id = ?`,
            )
            .run(now, this.project.id, stepRunId);
        }
        return { attemptId, reservationId, workflowRevision };
      },
    );
    return {
      attempt: this.getAttempt(result.value.attemptId),
      reservationId: result.value.reservationId,
      workflowRevision: result.value.workflowRevision,
      replayed: result.replayed,
    };
  }

  #assertDistinctRole(
    database: DatabaseSync,
    workflow: WorkflowRun,
    step: StepRun,
    required: boolean,
    session: AgentSession,
  ): void {
    if (!required) return;
    const prior = database
      .prepare(
        `SELECT s.id, s.generation, s.execution_role
         FROM attempts a
         JOIN step_runs sr ON sr.id = a.step_run_id
         JOIN agent_sessions s ON s.id = a.session_id AND s.generation = a.session_generation
         WHERE a.project_id = ? AND a.workflow_id = ? AND sr.ordinal < ?
           AND sr.step_phase = 'implementation'`,
      )
      .all(this.project.id, workflow.id, step.ordinal);
    for (const producer of prior) {
      if (
        (producer.id === session.id && producer.generation === session.generation) ||
        producer.execution_role === session.executionRole
      ) {
        throw new StoreError(
          'permission-denied',
          'This step requires a different session and execution role from implementation',
        );
      }
    }
  }

  #assertAttemptCapacity(database: DatabaseSync, workflowId: WorkflowId): void {
    const ancestors = database
      .prepare(
        `WITH RECURSIVE ancestors(id, parent_workflow_id, max_attempts, parallelism, deadline_at) AS (
           SELECT id, parent_workflow_id, max_attempts, parallelism, deadline_at
           FROM workflow_runs WHERE project_id = ? AND id = ?
           UNION ALL
           SELECT w.id, w.parent_workflow_id, w.max_attempts, w.parallelism, w.deadline_at
           FROM workflow_runs w JOIN ancestors a ON a.parent_workflow_id = w.id
           WHERE w.project_id = ?
         ) SELECT * FROM ancestors`,
      )
      .all(this.project.id, workflowId, this.project.id)
      .map((row) => ancestorLimitRowSchema.parse(row));
    for (const ancestor of ancestors) {
      if (new Date(ancestor.deadline_at).getTime() <= this.#clock().getTime()) {
        throw new StoreError('limit-exhausted', `Workflow ${ancestor.id} deadline has passed`);
      }
      const usage = database
        .prepare(
          `WITH RECURSIVE descendants(id) AS (
             SELECT id FROM workflow_runs WHERE project_id = ? AND id = ?
             UNION ALL
             SELECT w.id FROM workflow_runs w JOIN descendants d ON w.parent_workflow_id = d.id
             WHERE w.project_id = ?
           )
           SELECT count(*) AS attempts,
                  coalesce(sum(CASE WHEN a.phase IN
                                    ('pending','launching','running','stopping','unconfirmed')
                                    THEN 1 ELSE 0 END), 0) AS active
           FROM attempts a JOIN descendants d ON d.id = a.workflow_id`,
        )
        .get(this.project.id, ancestor.id, this.project.id);
      const parsedUsage = attemptUsageRowSchema.parse(usage);
      const attemptCount = parsedUsage.attempts;
      const activeCount = parsedUsage.active;
      if (attemptCount >= ancestor.max_attempts) {
        throw new StoreError(
          'limit-exhausted',
          `Workflow ${ancestor.id} attempt limit is exhausted`,
        );
      }
      if (activeCount >= ancestor.parallelism) {
        throw new StoreError(
          'limit-exhausted',
          `Workflow ${ancestor.id} parallelism limit is reached`,
        );
      }
    }
  }

  getAttempt(id: AttemptId): Attempt {
    return this.read((database) => this.#requireAttempt(database, id));
  }

  listAttempts(filter: { jobId?: JobId; workflowId?: WorkflowId } = {}): Attempt[] {
    return this.read((database) => {
      if (filter.jobId !== undefined) {
        return database
          .prepare(
            'SELECT * FROM attempts WHERE project_id = ? AND job_id = ? ORDER BY created_at, id',
          )
          .all(this.project.id, filter.jobId)
          .map(attemptFromRow);
      }
      if (filter.workflowId !== undefined) {
        return database
          .prepare(
            `WITH RECURSIVE descendants(id) AS (
               SELECT id FROM workflow_runs WHERE project_id = ? AND id = ?
               UNION ALL
               SELECT w.id FROM workflow_runs w JOIN descendants d ON w.parent_workflow_id = d.id
               WHERE w.project_id = ?
             )
             SELECT a.* FROM attempts a JOIN descendants d ON d.id = a.workflow_id
             ORDER BY a.created_at, a.id`,
          )
          .all(this.project.id, filter.workflowId, this.project.id)
          .map(attemptFromRow);
      }
      return database
        .prepare('SELECT * FROM attempts WHERE project_id = ? ORDER BY created_at, id')
        .all(this.project.id)
        .map(attemptFromRow);
    });
  }

  #requireAttempt(database: DatabaseSync, id: AttemptId): Attempt {
    return attemptFromRow(
      requireValue(
        database
          .prepare('SELECT * FROM attempts WHERE project_id = ? AND id = ?')
          .get(this.project.id, id),
        'not-found',
        `Attempt ${id} was not found`,
      ),
    );
  }

  acknowledgeBrief(input: AcknowledgeBriefInput): BriefRevision {
    const actor = this.#requireActor(input.actor);
    this.idempotent('acknowledge-brief', input.idempotencyKey, input, BriefIdSchema, (database) => {
      const attempt = this.#requireAttempt(database, input.attemptId);
      if (
        actor.id !== attempt.sessionId ||
        actor.generation !== attempt.sessionGeneration ||
        attempt.briefRevision !== input.briefRevision
      ) {
        throw new StoreError(
          'identity-mismatch',
          'Only the assigned attempt session can acknowledge its brief revision',
        );
      }
      database
        .prepare(
          `INSERT INTO brief_acknowledgements
               (brief_id, attempt_id, session_id, session_generation, adopted_at)
             VALUES (?, ?, ?, ?, ?)`,
        )
        .run(attempt.briefId, attempt.id, actor.id, actor.generation, this.#now());
      return attempt.briefId;
    });
    return this.getBrief(this.getAttempt(input.attemptId).jobId, input.briefRevision);
  }

  activateWorkflow(input: workflowService.ActivateWorkflowInput): WorkflowRun {
    return workflowService.activateWorkflow(this, input, this.#now());
  }

  reviseBrief(input: ReviseBriefInput): BriefRevision {
    return workflowService.reviseBrief(this, input, this.#now());
  }

  requestTransition(input: RequestTransitionInput) {
    return workflowService.requestTransition(this, input, this.#now());
  }

  controlWorkflow(input: ControlWorkflowInput) {
    return workflowService.controlWorkflow(this, input, this.#now());
  }

  resumeWorkflow(input: ResumeWorkflowInput): WorkflowRun {
    return workflowService.resumeWorkflow(this, input, this.#now());
  }

  extendLimits(input: ExtendLimitsInput): WorkflowRun {
    return workflowService.extendLimits(this, input, this.#now());
  }

  workflowStatus(id: WorkflowId) {
    return this.read((database) => ({
      workflow: this.getWorkflow(id),
      control: database
        .prepare('SELECT activated, limits_revision FROM workflow_runs WHERE id=? AND project_id=?')
        .get(id, this.project.id),
      schedule: database
        .prepare(
          'SELECT * FROM workflow_schedule_intents WHERE workflow_id=? AND project_id=? ORDER BY created_at',
        )
        .all(id, this.project.id),
      controls: database
        .prepare(
          'SELECT * FROM control_intents WHERE workflow_id=? AND project_id=? ORDER BY created_at',
        )
        .all(id, this.project.id),
    }));
  }

  recordResult(input: RecordResultInput): Result {
    const command: RecordResultInput = {
      actor: sessionIdentitySchema.parse(input.actor),
      attemptId: AttemptIdSchema.parse(input.attemptId),
      content: ResultContentSchema.parse(input.content),
      inputDigest: DigestSchema.parse(input.inputDigest),
      workspaceDigest: DigestSchema.parse(input.workspaceDigest),
      evidenceClaims: evidenceClaimsSchema.parse(input.evidenceClaims),
      evidence: z.array(EvidenceSchema).parse(input.evidence),
      verification: VerificationSchema.parse(input.verification),
      upstreamResultIds: z.array(ResultIdSchema).parse(input.upstreamResultIds),
      idempotencyKey: z.string().min(1).parse(input.idempotencyKey),
    };
    const actor = this.read((database) => this.#requireSession(database, command.actor));
    const result = this.idempotent(
      'record-result',
      command.idempotencyKey,
      command,
      ResultIdSchema,
      (database) => {
        const attempt = this.#requireAttempt(database, command.attemptId);
        if (
          actor.role === 'worker' &&
          (actor.id !== attempt.sessionId || actor.generation !== attempt.sessionGeneration)
        ) {
          throw new StoreError('permission-denied', 'A worker can record only its assigned result');
        }
        const lateWorker =
          actor.role === 'worker' &&
          actor.id === attempt.sessionId &&
          actor.generation === attempt.sessionGeneration &&
          ['settled', 'unconfirmed'].includes(actor.state) &&
          ['settled', 'unconfirmed'].includes(attempt.phase);
        if (actor.state !== 'active' && !lateWorker) {
          throw new StoreError(
            'permission-denied',
            'Only an active session can record a new result',
          );
        }
        if (!['running', 'stopping', 'settled', 'unconfirmed'].includes(attempt.phase))
          throw new StoreError(
            'invalid-state',
            `Attempt ${attempt.id} is ${attempt.phase} and cannot record a new result`,
          );
        const job = this.#requireJob(database, attempt.jobId);
        if (job.delivery !== command.content.kind) {
          throw new StoreError('invalid-state', `Job ${job.id} requires a ${job.delivery} result`);
        }
        for (const upstream of command.upstreamResultIds)
          this.#requireAcceptedResult(database, upstream);
        const resultId = this.#newId('result', ResultIdSchema);
        const now = this.#now();
        const reportText = command.content.kind === 'report' ? command.content.body : null;
        const sourceRepository =
          command.content.kind === 'report' ? null : command.content.sourceRepository;
        const baseCommit = command.content.kind === 'report' ? null : command.content.baseCommit;
        const resultingTree =
          command.content.kind === 'report' ? null : command.content.resultingTree;
        const resultingCommit =
          command.content.kind === 'commit' ? command.content.resultingCommit : null;
        const changedPaths = command.content.kind === 'report' ? [] : command.content.changedPaths;
        const artifactDigests = command.content.artifactDigests;
        if (new Set(artifactDigests).size !== artifactDigests.length) {
          throw new StoreError('invalid-state', 'Result artifact digests must be unique');
        }
        const evidenceDigests = [
          ...evidenceArtifactDigests(command.evidence),
          ...(command.verification.kind === 'not-requested'
            ? []
            : evidenceArtifactDigests(command.verification.checks)),
        ];
        const files = new ArtifactFiles(this.project.stateDirectory);
        const validatedArtifacts = new Map<Digest, z.infer<typeof artifactReferenceRowSchema>>();
        for (const digest of new Set([...artifactDigests, ...evidenceDigests]))
          validatedArtifacts.set(
            digest,
            this.#verifyArtifact(database, { digest, hostId: attempt.hostId, files }),
          );
        const artifacts = [...validatedArtifacts.values()];
        database
          .prepare(
            `INSERT INTO results
               (id, project_id, job_id, attempt_id, brief_id, brief_revision, host_id,
                workspace_id, result_kind, report_text, input_digest, workspace_digest,
                source_repository, base_commit, resulting_tree, resulting_commit,
                changed_paths_json, artifact_digests_json, evidence_claims_json,
                evidence_json, verification_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            resultId,
            this.project.id,
            attempt.jobId,
            attempt.id,
            attempt.briefId,
            attempt.briefRevision,
            attempt.hostId,
            attempt.workspaceId,
            command.content.kind,
            reportText,
            command.inputDigest,
            command.workspaceDigest,
            sourceRepository,
            baseCommit,
            resultingTree,
            resultingCommit,
            canonicalJson(changedPaths),
            canonicalJson(artifactDigests),
            canonicalJson([...new Set(command.evidenceClaims)].sort()),
            canonicalJson(command.evidence),
            canonicalJson(command.verification),
            now,
          );
        const artifactInsert = database.prepare(
          `INSERT INTO result_artifacts (result_id, artifact_id, ordinal)
           VALUES (?, ?, ?)`,
        );
        artifacts.forEach((artifact, ordinal) =>
          artifactInsert.run(resultId, artifact.id, ordinal),
        );
        const workflowRunning =
          attempt.workflowId === null ||
          database.prepare('SELECT phase FROM workflow_runs WHERE id=?').get(attempt.workflowId)
            ?.phase === 'running';
        const eligible =
          job.currentBriefId === attempt.briefId &&
          job.currentBriefRevision === attempt.briefRevision &&
          ['running', 'stopping'].includes(attempt.phase) &&
          workflowRunning;
        database
          .prepare(
            `INSERT INTO result_validity
               (result_id, project_id, state, stale_by_brief_id, reason, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            resultId,
            this.project.id,
            eligible ? 'eligible' : 'stale',
            eligible ? null : job.currentBriefId,
            eligible
              ? null
              : job.currentBriefId !== attempt.briefId ||
                  job.currentBriefRevision !== attempt.briefRevision
                ? 'Result used a superseded brief revision'
                : 'Result arrived after its attempt or workflow stopped',
            now,
          );
        const dependencyInsert = database.prepare(
          'INSERT INTO result_dependencies (result_id, upstream_result_id) VALUES (?, ?)',
        );
        for (const upstream of command.upstreamResultIds) dependencyInsert.run(resultId, upstream);
        new EventStore(this).append({
          kind: 'result.recorded',
          aggregate: { kind: 'result', id: resultId, revision: 1 },
          payload: { resultId, attemptId: attempt.id, workflowId: attempt.workflowId, eligible },
          dedupeKey: `result.recorded/${resultId}`,
        });
        return resultId;
      },
    );
    return this.getResult(result.value);
  }

  getResult(id: ResultId): Result {
    return this.read((database) => this.#requireResult(database, id));
  }

  listResults(jobId?: JobId): Result[] {
    return this.read((database) => {
      const rows =
        jobId === undefined
          ? database
              .prepare('SELECT * FROM results WHERE project_id = ? ORDER BY created_at, id')
              .all(this.project.id)
          : database
              .prepare(
                `SELECT * FROM results
                 WHERE project_id = ? AND job_id = ? ORDER BY created_at, id`,
              )
              .all(this.project.id, jobId);
      return rows.map((row) => this.#resultFromRow(row));
    });
  }

  #resultFromRow(raw: SqliteRow): Result {
    const row = resultRowSchema.parse(raw);
    let content: ResultContent;
    if (row.result_kind === 'report') {
      if (row.report_text === null) {
        throw new StoreError('invalid-state', `Report result ${row.id} has no body`);
      }
      content = {
        kind: 'report',
        body: row.report_text,
        artifactDigests: parseJson(z.array(DigestSchema), row.artifact_digests_json),
      };
    } else {
      if (row.report_text !== null) {
        throw new StoreError('invalid-state', `Git result ${row.id} has report text`);
      }
      if (
        row.source_repository === null ||
        row.base_commit === null ||
        row.resulting_tree === null
      ) {
        throw new StoreError('invalid-state', `Result ${row.id} has incomplete Git identity`);
      }
      const common = {
        sourceRepository: row.source_repository,
        baseCommit: row.base_commit,
        resultingTree: row.resulting_tree,
        changedPaths: parseJson(stringArraySchema, row.changed_paths_json),
        artifactDigests: parseJson(z.array(DigestSchema), row.artifact_digests_json),
      };
      if (row.result_kind === 'patch') content = { kind: 'patch', ...common };
      else {
        if (row.resulting_commit === null) {
          throw new StoreError('invalid-state', `Commit result ${row.id} has no commit`);
        }
        content = { kind: 'commit', ...common, resultingCommit: row.resulting_commit };
      }
    }
    return {
      id: row.id,
      jobId: row.job_id,
      attemptId: row.attempt_id,
      briefId: row.brief_id,
      briefRevision: row.brief_revision,
      hostId: row.host_id,
      workspaceId: row.workspace_id,
      inputDigest: row.input_digest,
      workspaceDigest: row.workspace_digest,
      content: ResultContentSchema.parse(content),
      evidenceClaims: parseJson(stringArraySchema, row.evidence_claims_json),
      evidence: parseJson(z.array(EvidenceSchema), row.evidence_json),
      verification: parseJson(VerificationSchema, row.verification_json),
      createdAt: row.created_at,
    };
  }

  #requireResult(database: DatabaseSync, id: ResultId): Result {
    return this.#resultFromRow(
      requireValue(
        database
          .prepare('SELECT * FROM results WHERE project_id = ? AND id = ?')
          .get(this.project.id, id),
        'not-found',
        `Result ${id} was not found`,
      ),
    );
  }

  #verifyArtifact(
    database: DatabaseSync,
    input: { digest: Digest; hostId: HostId; files: ArtifactFiles },
  ): z.infer<typeof artifactReferenceRowSchema> {
    const row = requireValue(
      database
        .prepare(
          'SELECT id, host_id, path, byte_length FROM artifacts WHERE project_id = ? AND digest = ?',
        )
        .get(this.project.id, input.digest),
      'not-found',
      `Artifact ${input.digest} was not found`,
    );
    const artifact = artifactReferenceRowSchema.parse(row);
    if (artifact.host_id !== input.hostId)
      throw new StoreError('invalid-state', `Artifact ${input.digest} belongs to another host`);
    const durable = {
      digest: input.digest,
      byteLength: artifact.byte_length,
      mediaType: 'application/octet-stream',
    };
    if (artifact.path !== input.files.path(durable))
      throw new StoreError('invalid-state', `Artifact ${input.digest} catalog path is not durable`);
    try {
      input.files.verify(durable);
    } catch (error) {
      throw new StoreError('invalid-state', `Artifact ${input.digest} failed its integrity check`, {
        cause: error,
      });
    }
    return artifact;
  }

  #verifyResultArtifacts(database: DatabaseSync, result: Result): void {
    const files = new ArtifactFiles(this.project.stateDirectory);
    const stored = database
      .prepare(
        `SELECT a.digest FROM result_artifacts ra
         JOIN artifacts a ON a.id = ra.artifact_id
         WHERE ra.result_id = ? AND a.project_id = ?`,
      )
      .all(result.id, this.project.id)
      .map((row) => z.object({ digest: DigestSchema }).parse(row).digest);
    const retained = new Set(stored);
    const required = new Set([
      ...result.content.artifactDigests,
      ...evidenceArtifactDigests(result.evidence),
      ...(result.verification.kind === 'not-requested'
        ? []
        : evidenceArtifactDigests(result.verification.checks)),
    ]);
    for (const digest of required) {
      if (!retained.has(digest))
        throw new StoreError('invalid-state', `Artifact ${digest} is not retained with its result`);
    }
    for (const digest of stored)
      this.#verifyArtifact(database, { digest, hostId: result.hostId, files });
  }

  #requireEligibleResult(database: DatabaseSync, id: ResultId): Result {
    const result = this.#requireResult(database, id);
    const state = database
      .prepare('SELECT state FROM result_validity WHERE project_id = ? AND result_id = ?')
      .get(this.project.id, id)?.state;
    if (state !== 'eligible') throw new StoreError('result-stale', `Result ${id} is stale`);
    return result;
  }

  #requireAcceptedResult(database: DatabaseSync, id: ResultId): Result {
    const result = this.#requireEligibleResult(database, id);
    const decision = database
      .prepare(
        `SELECT decision FROM result_acceptances
         WHERE project_id = ? AND result_id = ? AND brief_id = ?`,
      )
      .get(this.project.id, result.id, result.briefId);
    if (!acceptedResultRowSchema.safeParse(decision).success) {
      throw new StoreError('invalid-state', `Result ${id} has not been accepted`);
    }
    return result;
  }

  decideResult(input: ResultDecisionInput): ResultDecision {
    this.#requireActor(input.actor, ['user', 'controller']);
    const result = this.idempotent(
      'decide-result',
      input.idempotencyKey,
      input,
      resultDecisionRecordSchema,
      (database) => {
        const recorded = this.#requireEligibleResult(database, input.resultId);
        const job = this.#requireJob(database, recorded.jobId);
        if (
          job.currentBriefRevision !== input.expectedBriefRevision ||
          recorded.briefRevision !== input.expectedBriefRevision
        ) {
          throw new StoreError(
            'stale-revision',
            'Result does not match the current brief revision',
          );
        }
        if (input.decision.kind === 'accepted') {
          this.#assertRequiredEvidence(database, recorded);
          this.#verifyResultArtifacts(database, recorded);
        }
        const id = this.#newId('acceptance', z.string().min(1));
        const createdAt = this.#now();
        database
          .prepare(
            `INSERT INTO result_acceptances
               (id, project_id, result_id, brief_id, decision, issues_json,
                retained_observations_json, decided_by_session_id,
                decided_by_session_generation, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            this.project.id,
            recorded.id,
            recorded.briefId,
            input.decision.kind,
            canonicalJson(input.decision.kind === 'rejected' ? input.decision.issues : []),
            canonicalJson(
              input.decision.kind === 'rejected' ? input.decision.retainedObservations : [],
            ),
            input.actor.id,
            input.actor.generation,
            createdAt,
          );
        new EventStore(this).append({
          kind: `result.${input.decision.kind}`,
          aggregate: { kind: 'result', id: recorded.id, revision: recorded.briefRevision },
          payload: { resultId: recorded.id, decisionId: id, decision: input.decision },
          dedupeKey: `result.decision/${id}`,
        });
        return {
          id,
          resultId: recorded.id,
          briefId: recorded.briefId,
          decision: input.decision.kind,
          createdAt,
        };
      },
    );
    return { ...result.value, replayed: result.replayed };
  }

  #assertRequiredEvidence(database: DatabaseSync, result: Result): void {
    const attempt = this.#requireAttempt(database, result.attemptId);
    if (attempt.workflowId === null || attempt.stepRunId === null) return;
    const workflow = this.#requireWorkflow(database, attempt.workflowId);
    const step = this.#requireStepRun(database, attempt.stepRunId);
    const packageStep = requireValue(
      workflow.package.steps.find((candidate) => candidate.name === step.stepName),
      'invalid-state',
      `Step ${step.stepName} is missing from its pinned package`,
    );
    const claims = new Set(result.evidenceClaims);
    const missing = packageStep.requiredEvidence.filter((claim) => !claims.has(claim));
    if (missing.length > 0) {
      throw new StoreError(
        'invalid-state',
        `Result ${result.id} is missing required evidence: ${missing.join(', ')}`,
      );
    }
  }

  claimAttemptLaunch(input: ClaimAttemptInput): Attempt {
    this.#requireActor(input.actor, ['user', 'controller']);
    const result = this.idempotent(
      'claim-attempt-launch',
      input.idempotencyKey,
      input,
      AttemptIdSchema,
      (database) => {
        workflowService.assertWorkflowActor(database, this, input.actor);
        const attempt = this.#requireAttempt(database, input.attemptId);
        const job = this.#requireJob(database, attempt.jobId);
        if (
          job.currentBriefRevision !== input.expectedBriefRevision ||
          attempt.briefRevision !== input.expectedBriefRevision
        ) {
          throw new StoreError('stale-revision', 'Attempt brief is no longer current');
        }
        if (attempt.phase !== 'pending') {
          throw new StoreError('invalid-state', `Attempt ${attempt.id} is ${attempt.phase}`);
        }
        this.#requireAdmissibleWorkspace(database, attempt.workspaceId);
        if (attempt.workflowId !== null) {
          const workflow = this.#requireWorkflow(database, attempt.workflowId);
          if (
            workflow.phase !== 'running' ||
            workflow.briefRevision !== input.expectedBriefRevision ||
            input.expectedControlRevision === null ||
            workflow.controlRevision !== input.expectedControlRevision
          ) {
            throw new StoreError('stale-revision', 'Workflow control changed before launch');
          }
        } else if (input.expectedControlRevision !== null) {
          throw new StoreError('invalid-state', 'Direct attempt has no workflow control revision');
        }
        database
          .prepare(
            `UPDATE attempts SET phase = 'launching', launch_claimed_at = ?
             WHERE project_id = ? AND id = ? AND phase = 'pending'`,
          )
          .run(this.#now(), this.project.id, attempt.id);
        return attempt.id;
      },
    );
    return this.getAttempt(result.value);
  }

  observeAttemptRunning(input: ObserveAttemptRunningInput): Attempt {
    this.#requireActor(input.actor, ['user', 'controller']);
    const nativeIdentity = nativeIdentitySchema.parse({
      kind: input.nativeKind,
      serverGeneration: input.nativeServerGeneration,
      locator: input.nativeLocator,
    });
    if (nativeIdentity.kind === null) {
      throw new StoreError('identity-mismatch', 'A running attempt requires native identity');
    }
    const result = this.idempotent(
      'observe-attempt-running',
      input.idempotencyKey,
      input,
      AttemptIdSchema,
      (database) => {
        const attempt = this.#requireAttempt(database, input.attemptId);
        if (!['launching', 'stopping'].includes(attempt.phase)) {
          throw new StoreError('invalid-state', `Attempt ${attempt.id} is ${attempt.phase}`);
        }
        if (
          attempt.nativeKind !== null &&
          (attempt.nativeKind !== nativeIdentity.kind ||
            attempt.nativeServerGeneration !== nativeIdentity.serverGeneration ||
            attempt.nativeLocator !== nativeIdentity.locator)
        ) {
          throw new StoreError('identity-mismatch', 'Attempt native identity cannot change');
        }
        const session = this.#requireSession(database, {
          id: attempt.sessionId,
          generation: attempt.sessionGeneration,
        });
        const sessionIsUnbound =
          session.nativeKind === null &&
          session.nativeServerGeneration === null &&
          session.nativeLocator === null;
        const sessionMatches =
          session.nativeKind === nativeIdentity.kind &&
          session.nativeServerGeneration === nativeIdentity.serverGeneration &&
          session.nativeLocator === nativeIdentity.locator;
        if (!sessionIsUnbound && !sessionMatches) {
          throw new StoreError('identity-mismatch', 'Session native identity cannot change');
        }
        database
          .prepare(
            `UPDATE attempts
             SET phase = CASE WHEN phase = 'stopping' THEN 'stopping' ELSE 'running' END,
                 native_kind = ?, native_server_generation = ?, native_locator = ?, running_at = ?
             WHERE project_id = ? AND id = ?`,
          )
          .run(
            nativeIdentity.kind,
            nativeIdentity.serverGeneration,
            nativeIdentity.locator,
            this.#now(),
            this.project.id,
            attempt.id,
          );
        database
          .prepare(
            `UPDATE agent_sessions
             SET native_kind = ?, native_server_generation = ?, native_locator = ?
             WHERE project_id = ? AND id = ? AND generation = ?
               AND (native_kind IS NULL OR
                    (native_kind = ? AND native_server_generation = ? AND native_locator = ?))`,
          )
          .run(
            nativeIdentity.kind,
            nativeIdentity.serverGeneration,
            nativeIdentity.locator,
            this.project.id,
            attempt.sessionId,
            attempt.sessionGeneration,
            nativeIdentity.kind,
            nativeIdentity.serverGeneration,
            nativeIdentity.locator,
          );
        return attempt.id;
      },
    );
    return this.getAttempt(result.value);
  }

  settleAttempt(input: SettleAttemptInput): Attempt {
    this.#requireActor(input.actor, ['user', 'controller']);
    const result = this.idempotent(
      'settle-attempt',
      input.idempotencyKey,
      input,
      AttemptIdSchema,
      (database) => {
        const attempt = this.#requireAttempt(database, input.attemptId);
        if (['settled', 'closed'].includes(attempt.phase)) {
          throw new StoreError('invalid-state', `Attempt ${attempt.id} is ${attempt.phase}`);
        }
        const now = this.#now();
        const expiredDeadline = database
          .prepare(
            "SELECT 1 FROM workflow_attempt_deadlines WHERE attempt_id=? AND state='requested'",
          )
          .get(attempt.id);
        if (input.observation.kind === 'unconfirmed') {
          database
            .prepare(
              `UPDATE attempts SET phase = 'unconfirmed', settlement_reason = ?, settled_at = ?
               WHERE project_id = ? AND id = ?`,
            )
            .run(input.observation.reason, now, this.project.id, attempt.id);
          database
            .prepare(
              `UPDATE execution_reservations SET state = 'unconfirmed', release_reason = ?
               WHERE project_id = ? AND attempt_id = ? AND state = 'held'`,
            )
            .run(input.observation.reason, this.project.id, attempt.id);
          database
            .prepare(
              `UPDATE handoff_claims SET state = 'unconfirmed', settled_at = ?
               WHERE project_id = ? AND attempt_id = ? AND state = 'active'`,
            )
            .run(now, this.project.id, attempt.id);
          database
            .prepare(
              `UPDATE writer_reservations SET state = 'unconfirmed', release_reason = ?
               WHERE project_id = ? AND owner_attempt_id = ? AND state = 'held'`,
            )
            .run(input.observation.reason, this.project.id, attempt.id);
          database
            .prepare(
              `UPDATE handoffs SET state = 'unconfirmed', reason = ?, updated_at = ?
               WHERE project_id = ? AND claimed_attempt_id = ? AND state = 'integrating'`,
            )
            .run(input.observation.reason, now, this.project.id, attempt.id);
          database
            .prepare(
              `UPDATE agent_sessions SET state = 'unconfirmed', settled_at = ?
               WHERE project_id = ? AND id = ? AND generation = ?`,
            )
            .run(now, this.project.id, attempt.sessionId, attempt.sessionGeneration);
          database
            .prepare(
              `UPDATE attempt_control_intents SET state = 'unconfirmed', settled_at = ?
               WHERE project_id = ? AND attempt_id = ? AND state = 'requested'`,
            )
            .run(now, this.project.id, attempt.id);
        } else {
          database
            .prepare(
              `UPDATE attempts
               SET phase = 'settled', outcome = ?, settlement_reason = ?, settled_at = ?
               WHERE project_id = ? AND id = ?`,
            )
            .run(
              input.observation.outcome,
              input.observation.reason,
              now,
              this.project.id,
              attempt.id,
            );
          database
            .prepare(
              `UPDATE execution_reservations
               SET state = 'released', released_at = ?, release_reason = ?
               WHERE project_id = ? AND attempt_id = ? AND state IN ('held', 'unconfirmed')`,
            )
            .run(now, input.observation.reason, this.project.id, attempt.id);
          database
            .prepare(
              `UPDATE handoff_claims SET state = 'settled', settled_at = ?
               WHERE project_id = ? AND attempt_id = ? AND state IN ('active', 'unconfirmed')`,
            )
            .run(now, this.project.id, attempt.id);
          database
            .prepare(
              `UPDATE writer_reservations
               SET state = 'released', released_at = ?, release_reason = ?
               WHERE project_id = ? AND owner_attempt_id = ?
                 AND state IN ('held', 'unconfirmed')`,
            )
            .run(now, input.observation.reason, this.project.id, attempt.id);
          database
            .prepare(
              `UPDATE agent_sessions SET state = 'settled', settled_at = ?
               WHERE project_id = ? AND id = ? AND generation = ?`,
            )
            .run(now, this.project.id, attempt.sessionId, attempt.sessionGeneration);
          database
            .prepare(
              `UPDATE attempt_control_intents SET state = 'confirmed', settled_at = ?
               WHERE project_id = ? AND attempt_id = ? AND state IN ('requested', 'unconfirmed')`,
            )
            .run(now, this.project.id, attempt.id);
          database
            .prepare(
              "UPDATE workflow_attempt_deadlines SET state='settled' WHERE attempt_id=? AND state IN ('pending','requested')",
            )
            .run(attempt.id);
          if (
            expiredDeadline &&
            input.observation.outcome === 'interrupted' &&
            attempt.workflowId !== null &&
            attempt.stepRunId !== null &&
            !database.prepare('SELECT 1 FROM results WHERE attempt_id=? LIMIT 1').get(attempt.id)
          ) {
            const retryable = database
              .prepare(
                `SELECT current.revision,current.brief_revision,current.control_revision
                 FROM workflow_runs current
                 WHERE current.id=? AND current.current_step_run_id=? AND current.phase='running'
                   AND current.brief_revision=?
                   AND NOT EXISTS(
                     SELECT 1 FROM native_attempts n WHERE n.attempt_id=?
                       AND n.expected_control_revision<>current.control_revision
                   )`,
              )
              .get(attempt.workflowId, attempt.stepRunId, attempt.briefRevision, attempt.id);
            if (retryable) {
              database
                .prepare(
                  "UPDATE step_runs SET phase='pending',updated_at=? WHERE id=? AND phase='active'",
                )
                .run(now, attempt.stepRunId);
              database
                .prepare('UPDATE workflow_runs SET revision=revision+1,updated_at=? WHERE id=?')
                .run(now, attempt.workflowId);
              const exhausted = database
                .prepare(
                  `WITH RECURSIVE ancestors(id,parent_workflow_id,max_attempts,deadline_at,phase) AS (
                     SELECT id,parent_workflow_id,max_attempts,deadline_at,phase
                     FROM workflow_runs WHERE id=?
                     UNION ALL SELECT w.id,w.parent_workflow_id,w.max_attempts,w.deadline_at,w.phase
                     FROM workflow_runs w JOIN ancestors a ON a.parent_workflow_id=w.id
                   ), descendants(root,id) AS (
                     SELECT id,id FROM ancestors
                     UNION ALL SELECT d.root,w.id FROM descendants d
                     JOIN workflow_runs w ON w.parent_workflow_id=d.id
                   ), usage AS (
                     SELECT d.root AS id,count(a.id) AS attempts
                     FROM descendants d LEFT JOIN attempts a ON a.workflow_id=d.id
                     GROUP BY d.root
                   )
                   SELECT ancestor.id FROM ancestors ancestor JOIN usage ON usage.id=ancestor.id
                   WHERE ancestor.phase<>'running' OR ancestor.deadline_at<=?
                      OR usage.attempts>=ancestor.max_attempts LIMIT 1`,
                )
                .get(attempt.workflowId, now);
              if (!exhausted) workflowService.refreshSchedule(this, attempt.workflowId, now);
              else {
                const workflow = this.getWorkflow(attempt.workflowId);
                new EventStore(this).append({
                  kind: 'workflow.retry-blocked',
                  aggregate: {
                    kind: 'workflow',
                    id: attempt.workflowId,
                    revision: workflow.revision,
                  },
                  payload: {
                    workflowId: attempt.workflowId,
                    attemptId: attempt.id,
                    reason: 'Deadline retry requires a limit or deadline extension',
                  },
                  dedupeKey: `workflow.retry-blocked/${attempt.id}`,
                });
              }
            }
          }
        }
        this.#finishSettledControls(database);
        new EventStore(this).append({
          kind: `attempt.${input.observation.kind}`,
          aggregate: { kind: 'attempt', id: attempt.id, revision: attempt.briefRevision },
          payload: {
            attemptId: attempt.id,
            workflowId: attempt.workflowId,
            observation: input.observation,
          },
          dedupeKey: `attempt.settle/${input.idempotencyKey}`,
        });
        return attempt.id;
      },
    );
    return this.getAttempt(result.value);
  }

  #finishSettledControls(database: DatabaseSync): void {
    const controlled = database
      .prepare(
        `SELECT id, phase FROM workflow_runs
         WHERE project_id = ? AND phase IN ('pausing', 'cancelling')`,
      )
      .all(this.project.id)
      .map((row) => controlledWorkflowRowSchema.parse(row));
    for (const row of controlled) {
      const unsettledRow = database
        .prepare(
          `WITH RECURSIVE descendants(id) AS (
             SELECT id FROM workflow_runs WHERE project_id = ? AND id = ?
             UNION ALL
             SELECT w.id FROM workflow_runs w JOIN descendants d ON w.parent_workflow_id = d.id
             WHERE w.project_id = ?
           )
           SELECT count(*) AS count
           FROM attempts a JOIN descendants d ON d.id = a.workflow_id
           WHERE a.phase IN ('launching','running','stopping','unconfirmed')`,
        )
        .get(this.project.id, row.id, this.project.id);
      if (countRowSchema.parse(unsettledRow).count === 0) {
        database
          .prepare(
            `UPDATE workflow_runs SET phase = ?, updated_at = ?
             WHERE project_id = ? AND id = ?`,
          )
          .run(
            row.phase === 'cancelling' ? 'cancelled' : 'paused',
            this.#now(),
            this.project.id,
            row.id,
          );
      }
    }
  }
}
