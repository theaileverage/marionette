import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';

import { Effect, Schema } from 'effect';

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
  type AttemptRecovery,
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
  reservationId: typeof ReservationIdSchema.Type;
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

export type RecoverAttemptInput = AttemptRecovery & {
  actor: SessionIdentity;
  attemptId: AttemptId;
  idempotencyKey: string;
};

export type RecoveredAttempt = {
  attempt: Attempt;
  replayed: boolean;
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

export type ResultDiscovery =
  | { readonly kind: 'found'; readonly result: Result }
  | { readonly kind: 'pending' };

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

type ConstraintDecoder<T> = Schema.ConstraintDecoder<T, never>;

const integer = Schema.Number.check(
  Schema.makeFilter(Number.isInteger, { expected: 'an integer' }),
);
const positiveInteger = integer.check(Schema.isGreaterThan(0));
const nonnegativeInteger = integer.check(Schema.isGreaterThanOrEqualTo(0));
const nonEmptyString = Schema.String.check(Schema.isMinLength(1));
const nullable = <S extends Schema.ConstraintDecoder<unknown, never>>(schema: S) =>
  Schema.NullOr(schema);

function decode<S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  value: unknown,
): S['Type'] {
  return Schema.decodeUnknownSync(schema)(value);
}

const workspaceRowSchema = Schema.Struct({
  id: WorkspaceIdSchema,
  project_id: ProjectIdSchema,
  host_id: HostIdSchema,
  kind: Schema.Literals(['isolated', 'existing']),
  path: Schema.String,
  repository_root: Schema.String,
  base_commit: nullable(Schema.String),
  access: Schema.Literals(['inspect', 'write']),
  writes_json: Schema.String,
  created_at: TimestampSchema,
  retired_at: nullable(TimestampSchema),
});

const sessionRowSchema = Schema.Struct({
  id: AgentSessionIdSchema,
  generation: SessionGenerationSchema,
  project_id: ProjectIdSchema,
  host_id: HostIdSchema,
  workspace_id: nullable(WorkspaceIdSchema),
  role: Schema.Literals(['user', 'controller', 'worker']),
  execution_role: Schema.String,
  parent_workflow_id: nullable(WorkflowIdSchema),
  attempt_id: nullable(AttemptIdSchema),
  native_kind: nullable(Schema.String),
  native_server_generation: nullable(Schema.String),
  native_locator: nullable(Schema.String),
  state: Schema.Literals(['active', 'settled', 'unconfirmed']),
  created_at: TimestampSchema,
  settled_at: nullable(TimestampSchema),
});

const jobRowSchema = Schema.Struct({
  id: JobIdSchema,
  stable_key: Schema.String,
  request_id: JobRequestIdSchema,
  current_brief_id: BriefIdSchema,
  current_brief_revision: positiveInteger,
  workspace_id: WorkspaceIdSchema,
  delivery_kind: Schema.Literals(['report', 'patch', 'commit']),
  origin_kind: Schema.Literals(['direct', 'workflow']),
  origin_workflow_id: nullable(WorkflowIdSchema),
  origin_step_run_id: nullable(StepRunIdSchema),
  state: Schema.Literals(['open', 'finished', 'cancelled']),
  created_at: TimestampSchema,
});

const briefRowSchema = Schema.Struct({
  id: BriefIdSchema,
  job_id: JobIdSchema,
  revision: positiveInteger,
  prior_brief_id: nullable(BriefIdSchema),
  content_json: Schema.String,
  change_reason: Schema.String,
  created_at: TimestampSchema,
});

const attemptRowSchema = Schema.Struct({
  id: AttemptIdSchema,
  job_id: JobIdSchema,
  workflow_id: nullable(WorkflowIdSchema),
  step_run_id: nullable(StepRunIdSchema),
  brief_id: BriefIdSchema,
  brief_revision: positiveInteger,
  host_id: HostIdSchema,
  workspace_id: WorkspaceIdSchema,
  session_id: AgentSessionIdSchema,
  session_generation: SessionGenerationSchema,
  phase: Schema.Literals([
    'pending',
    'launching',
    'running',
    'stopping',
    'settled',
    'unconfirmed',
    'closed',
  ]),
  native_kind: nullable(Schema.String),
  native_server_generation: nullable(Schema.String),
  native_locator: nullable(Schema.String),
  created_at: TimestampSchema,
  settled_at: nullable(TimestampSchema),
});

const workflowRowSchema = Schema.Struct({
  id: WorkflowIdSchema,
  package_digest: DigestSchema,
  parent_workflow_id: nullable(WorkflowIdSchema),
  root_job_id: JobIdSchema,
  current_step_run_id: StepRunIdSchema,
  phase: Schema.Literals(['running', 'pausing', 'paused', 'cancelling', 'cancelled', 'finished']),
  outcome: nullable(Schema.Literals(['succeeded', 'failed'])),
  execution_boundary: Schema.Literals(['all', 'design-only']),
  revision: positiveInteger,
  brief_revision: positiveInteger,
  control_revision: positiveInteger,
  max_attempts: positiveInteger,
  max_repeats: positiveInteger,
  parallelism: positiveInteger,
  inner_loop_deadline_ms: positiveInteger,
  deadline_at: TimestampSchema,
  created_at: TimestampSchema,
});

const stepRunRowSchema = Schema.Struct({
  id: StepRunIdSchema,
  workflow_id: WorkflowIdSchema,
  job_id: JobIdSchema,
  step_name: Schema.String,
  ordinal: positiveInteger,
  phase: Schema.Literals([
    'pending',
    'active',
    'blocked',
    'awaiting-decision',
    'succeeded',
    'failed',
    'stale',
    'closed',
  ]),
  input_workflow_revision: positiveInteger,
  input_brief_revision: positiveInteger,
  created_at: TimestampSchema,
});

const resultRowSchema = Schema.Struct({
  id: ResultIdSchema,
  job_id: JobIdSchema,
  attempt_id: AttemptIdSchema,
  brief_id: BriefIdSchema,
  brief_revision: positiveInteger,
  host_id: HostIdSchema,
  workspace_id: WorkspaceIdSchema,
  result_kind: Schema.Literals(['report', 'patch', 'commit']),
  report_text: nullable(Schema.String),
  input_digest: DigestSchema,
  workspace_digest: DigestSchema,
  source_repository: nullable(Schema.String),
  base_commit: nullable(Schema.String),
  resulting_tree: nullable(Schema.String),
  resulting_commit: nullable(Schema.String),
  changed_paths_json: Schema.String,
  artifact_digests_json: Schema.String,
  evidence_claims_json: Schema.String,
  evidence_json: Schema.String,
  verification_json: Schema.String,
  created_at: TimestampSchema,
});

const stringArraySchema = Schema.mutable(Schema.Array(Schema.String));
const admittedAttemptSchema = Schema.Struct({
  attemptId: AttemptIdSchema,
  reservationId: ReservationIdSchema,
  workflowRevision: nullable(positiveInteger),
});
const resultDecisionRecordSchema = Schema.Struct({
  id: nonEmptyString,
  resultId: ResultIdSchema,
  briefId: BriefIdSchema,
  decision: Schema.Literals(['accepted', 'rejected']),
  createdAt: TimestampSchema,
});
const idempotencyRowSchema = Schema.Struct({
  payload_digest: DigestSchema,
  result_json: Schema.String,
});
const tokenHashRowSchema = Schema.Struct({
  token_hash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
const packageSnapshotRowSchema = Schema.Struct({ snapshot_json: Schema.String });
const ancestorLimitRowSchema = Schema.Struct({
  id: WorkflowIdSchema,
  max_attempts: positiveInteger,
  parallelism: positiveInteger,
  deadline_at: TimestampSchema,
});
const attemptUsageRowSchema = Schema.Struct({
  attempts: nonnegativeInteger,
  active: nonnegativeInteger,
});
const controlledWorkflowRowSchema = Schema.Struct({
  id: WorkflowIdSchema,
  phase: Schema.Literals(['pausing', 'cancelling']),
});
const countRowSchema = Schema.Struct({ count: nonnegativeInteger });
const evidenceClaimsSchema = Schema.mutable(Schema.Array(nonEmptyString));
const acceptedResultRowSchema = Schema.Struct({ decision: Schema.Literal('accepted') });
const artifactReferenceRowSchema = Schema.Struct({
  id: nonEmptyString,
  host_id: HostIdSchema,
  path: nonEmptyString,
  byte_length: nonnegativeInteger,
});
const sessionIdentitySchema = Schema.Struct({
  id: AgentSessionIdSchema,
  generation: SessionGenerationSchema,
});
const nativeIdentitySchema = Schema.Union([
  Schema.Struct({ kind: Schema.Null, serverGeneration: Schema.Null, locator: Schema.Null }),
  Schema.Struct({
    kind: nonEmptyString,
    serverGeneration: nonEmptyString,
    locator: nonEmptyString,
  }),
]);
const recoverableNativeObservationSchema = Schema.Struct({
  kind: Schema.Literal('settled'),
});
const recoveryRuntimeRowSchema = Schema.Struct({
  phase: Schema.Literals([
    'admitted',
    'launch-claimed',
    'launched',
    'prompt-claimed',
    'active',
    'settled',
    'unconfirmed',
  ]),
  identity_json: nullable(Schema.String),
  last_observation_json: nullable(Schema.String),
  effect_count: nonnegativeInteger,
});

type SqliteRow = Record<string, SQLOutputValue>;

function parseJson<TOutput>(schema: ConstraintDecoder<TOutput>, encoded: string): TOutput {
  const value: unknown = JSON.parse(encoded);
  return decode(schema, value);
}

function isAsyncTransactionResult(value: unknown): boolean {
  return Effect.isEffect(value) || value instanceof Promise;
}

function requireValue<T>(value: T | undefined, code: StoreErrorCode, message: string): T {
  if (value === undefined) throw new StoreError(code, message);
  return value;
}

function attemptFromRow(raw: SqliteRow): Attempt {
  const row = decode(attemptRowSchema, raw);
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
    this.project = decode(ProjectBindingSchema, options.project);
    this.#database = database;
    this.#clock = options.clock ?? (() => new Date());
    this.#idFactory = options.idFactory ?? ((kind) => `${kind}_${randomUUID()}`);
    this.#bindProject(options.readOnly ?? false);
  }

  static open(options: StoreOptions): Store {
    const project = decode(ProjectBindingSchema, options.project);
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

  idempotent<TOutput, TPayload extends object = object>(
    scope: string,
    key: string,
    payload: TPayload,
    resultSchema: ConstraintDecoder<TOutput>,
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
        const existing = decode(idempotencyRowSchema, rawExisting);
        if (existing.payload_digest !== digest) {
          throw new StoreError(
            'idempotency-conflict',
            `Idempotency key ${key} was already used with a different payload`,
          );
        }
        const value: unknown = JSON.parse(existing.result_json);
        return { value: decode(resultSchema, value), replayed: true };
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
      if (isAsyncTransactionResult(value)) {
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
    return decode(TimestampSchema, this.#clock().toISOString());
  }

  #newId<T>(kind: string, schema: ConstraintDecoder<T>): T {
    return decode(schema, this.#idFactory(kind));
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
    const tokenHash = decode(
      Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
      input.tokenHash,
    );
    const executionRole = decode(nonEmptyString, input.executionRole);
    const nativeIdentity = decode(nativeIdentitySchema, {
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
      const tokenHash = decode(tokenHashRowSchema, tokenRow).token_hash;
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
    const row = decode(
      workspaceRowSchema,
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
    const row = decode(sessionRowSchema, raw);
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
    const row = decode(jobRowSchema, raw);
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
    const row = decode(briefRowSchema, raw);
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
    const workflowPackage = decode(WorkflowPackageSnapshotSchema, input.package);
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
        const deadlineAt = decode(
          TimestampSchema,
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
            this.#newId('limits', nonEmptyString),
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
    const row = decode(workflowRowSchema, raw);
    const snapshotRow = requireValue(
      database
        .prepare('SELECT snapshot_json FROM workflow_packages WHERE project_id = ? AND digest = ?')
        .get(this.project.id, row.package_digest),
      'invalid-state',
      `Workflow ${row.id} has no package snapshot`,
    );
    const snapshot = decode(packageSnapshotRowSchema, snapshotRow).snapshot_json;
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
    const row = decode(
      stepRunRowSchema,
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
            packageStep.requiresDistinctRole ?? false,
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

        for (const resultId of input.inputResultIds)
          this.#requireAcceptedResult(database, resultId);
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
      .map((row) => decode(ancestorLimitRowSchema, row));
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
      const parsedUsage = decode(attemptUsageRowSchema, usage);
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

  reviseBrief(_input: ReviseBriefInput): never {
    throw new StoreError('not-implemented', 'Brief revision is not implemented');
  }

  requestTransition(_input: RequestTransitionInput): never {
    throw new StoreError('not-implemented', 'Workflow transition is not implemented');
  }

  controlWorkflow(_input: ControlWorkflowInput): never {
    throw new StoreError('not-implemented', 'Workflow control is not implemented');
  }

  resumeWorkflow(_input: ResumeWorkflowInput): never {
    throw new StoreError('not-implemented', 'Workflow resume is not implemented');
  }

  extendLimits(_input: ExtendLimitsInput): never {
    throw new StoreError('not-implemented', 'Workflow limit extension is not implemented');
  }

  recordResult(input: RecordResultInput): Result {
    const command: RecordResultInput = {
      actor: decode(sessionIdentitySchema, input.actor),
      attemptId: decode(AttemptIdSchema, input.attemptId),
      content: decode(ResultContentSchema, input.content),
      inputDigest: decode(DigestSchema, input.inputDigest),
      workspaceDigest: decode(DigestSchema, input.workspaceDigest),
      evidenceClaims: decode(evidenceClaimsSchema, input.evidenceClaims),
      evidence: decode(Schema.mutable(Schema.Array(EvidenceSchema)), input.evidence),
      verification: decode(VerificationSchema, input.verification),
      upstreamResultIds: decode(
        Schema.mutable(Schema.Array(ResultIdSchema)),
        input.upstreamResultIds,
      ),
      idempotencyKey: decode(nonEmptyString, input.idempotencyKey),
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
        if (actor.state !== 'active') {
          throw new StoreError(
            'permission-denied',
            'Only an active session can record a new result',
          );
        }
        if (!['running', 'stopping'].includes(attempt.phase))
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
        const validatedArtifacts = new Map<Digest, typeof artifactReferenceRowSchema.Type>();
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
        const eligible =
          job.currentBriefId === attempt.briefId &&
          job.currentBriefRevision === attempt.briefRevision &&
          attempt.phase !== 'closed';
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
            eligible ? null : 'Result used a superseded brief revision',
            now,
          );
        const dependencyInsert = database.prepare(
          'INSERT INTO result_dependencies (result_id, upstream_result_id) VALUES (?, ?)',
        );
        for (const upstream of command.upstreamResultIds) dependencyInsert.run(resultId, upstream);
        return resultId;
      },
    );
    return this.getResult(result.value);
  }

  getResult(id: ResultId): Result {
    return this.read((database) => this.#requireResult(database, id));
  }

  discoverResult(attemptId: AttemptId): ResultDiscovery {
    return this.read((database) => {
      this.#requireAttempt(database, attemptId);

      const row = database
        .prepare('SELECT * FROM results WHERE project_id = ? AND attempt_id = ?')
        .get(this.project.id, attemptId);

      return row === undefined
        ? { kind: 'pending' }
        : { kind: 'found', result: this.#resultFromRow(row) };
    });
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
    const row = decode(resultRowSchema, raw);
    let content: ResultContent;
    if (row.result_kind === 'report') {
      if (row.report_text === null) {
        throw new StoreError('invalid-state', `Report result ${row.id} has no body`);
      }
      content = {
        kind: 'report',
        body: row.report_text,
        artifactDigests: parseJson(
          Schema.mutable(Schema.Array(DigestSchema)),
          row.artifact_digests_json,
        ),
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
        artifactDigests: parseJson(
          Schema.mutable(Schema.Array(DigestSchema)),
          row.artifact_digests_json,
        ),
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
      content: decode(ResultContentSchema, content),
      evidenceClaims: parseJson(stringArraySchema, row.evidence_claims_json),
      evidence: parseJson(Schema.mutable(Schema.Array(EvidenceSchema)), row.evidence_json),
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
  ): typeof artifactReferenceRowSchema.Type {
    const row = requireValue(
      database
        .prepare(
          'SELECT id, host_id, path, byte_length FROM artifacts WHERE project_id = ? AND digest = ?',
        )
        .get(this.project.id, input.digest),
      'not-found',
      `Artifact ${input.digest} was not found`,
    );
    const artifact = decode(artifactReferenceRowSchema, row);
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
      .map((row) => decode(Schema.Struct({ digest: DigestSchema }), row).digest);
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
    if (!Schema.is(acceptedResultRowSchema)(decision)) {
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
        const id = this.#newId('acceptance', nonEmptyString);
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
    const nativeIdentity = decode(nativeIdentitySchema, {
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

  recoverAttempt(input: RecoverAttemptInput): RecoveredAttempt {
    this.#requireActor(input.actor, ['user', 'controller']);
    const result = this.idempotent(
      'recover-attempt',
      input.idempotencyKey,
      input,
      AttemptIdSchema,
      (database) => {
        const attempt = this.#requireAttempt(database, input.attemptId);
        const job = this.#requireJob(database, attempt.jobId);
        if (
          attempt.briefRevision !== input.expectedBriefRevision ||
          job.currentBriefRevision !== input.expectedBriefRevision
        ) {
          throw new StoreError('stale-revision', 'Attempt brief is no longer current');
        }
        if (['settled', 'closed'].includes(attempt.phase)) {
          throw new StoreError('invalid-state', `Attempt ${attempt.id} is ${attempt.phase}`);
        }
        const runtime = decode(
          recoveryRuntimeRowSchema,
          requireValue(
            database
              .prepare(
                `SELECT n.phase, n.identity_json, n.last_observation_json,
                        count(e.id) AS effect_count
                 FROM native_attempts n
                 LEFT JOIN native_effects e
                   ON e.project_id = n.project_id AND e.attempt_id = n.attempt_id
                 WHERE n.project_id = ? AND n.attempt_id = ?
                 GROUP BY n.attempt_id`,
              )
              .get(this.project.id, attempt.id),
            'invalid-state',
            `Attempt ${attempt.id} has no native runtime record`,
          ),
        );
        const neverStarted =
          attempt.phase === 'pending' &&
          runtime.phase === 'admitted' &&
          runtime.identity_json === null &&
          runtime.effect_count === 0;
        const observedNonRunning =
          runtime.last_observation_json !== null &&
          Schema.is(recoverableNativeObservationSchema)(JSON.parse(runtime.last_observation_json));
        if (!neverStarted && !observedNonRunning) {
          throw new StoreError(
            'invalid-state',
            `Attempt ${attempt.id} has not been confirmed non-running`,
          );
        }
        this.#applyAttemptSettlement(database, attempt, {
          kind: 'settled',
          outcome: input.outcome,
          reason: input.reason,
        });
        return attempt.id;
      },
    );
    return { attempt: this.getAttempt(result.value), replayed: result.replayed };
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
        this.#applyAttemptSettlement(database, attempt, input.observation);
        return attempt.id;
      },
    );
    return this.getAttempt(result.value);
  }

  #applyAttemptSettlement(
    database: DatabaseSync,
    attempt: Attempt,
    observation: SettleAttemptInput['observation'],
  ): void {
    const now = this.#now();
    if (observation.kind === 'unconfirmed') {
      database
        .prepare(
          `UPDATE attempts SET phase = 'unconfirmed', settlement_reason = ?, settled_at = ?
           WHERE project_id = ? AND id = ?`,
        )
        .run(observation.reason, now, this.project.id, attempt.id);
      database
        .prepare(
          `UPDATE execution_reservations SET state = 'unconfirmed', release_reason = ?
           WHERE project_id = ? AND attempt_id = ? AND state = 'held'`,
        )
        .run(observation.reason, this.project.id, attempt.id);
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
        .run(observation.reason, this.project.id, attempt.id);
      database
        .prepare(
          `UPDATE handoffs SET state = 'unconfirmed', reason = ?, updated_at = ?
           WHERE project_id = ? AND claimed_attempt_id = ? AND state = 'integrating'`,
        )
        .run(observation.reason, now, this.project.id, attempt.id);
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
        .run(observation.outcome, observation.reason, now, this.project.id, attempt.id);
      database
        .prepare(
          `UPDATE execution_reservations
           SET state = 'released', released_at = ?, release_reason = ?
           WHERE project_id = ? AND attempt_id = ? AND state IN ('held', 'unconfirmed')`,
        )
        .run(now, observation.reason, this.project.id, attempt.id);
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
        .run(now, observation.reason, this.project.id, attempt.id);
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
    }
    this.#finishSettledControls(database);
  }

  #finishSettledControls(database: DatabaseSync): void {
    const controlled = database
      .prepare(
        `SELECT id, phase FROM workflow_runs
         WHERE project_id = ? AND phase IN ('pausing', 'cancelling')`,
      )
      .all(this.project.id)
      .map((row) => decode(controlledWorkflowRowSchema, row));
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
      if (decode(countRowSchema, unsettledRow).count === 0) {
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
