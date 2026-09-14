import { Schema } from 'effect';
import { artifactSchema } from './artifacts.js';
import { BoardPostKindSchema, BoardReferenceSchema } from './board.js';
import {
  AgentSessionIdSchema,
  AttemptIdSchema,
  AttemptPhaseSchema,
  BriefContentSchema,
  BriefIdSchema,
  DeliveryKindSchema,
  DigestSchema,
  EvidenceSchema,
  ExecutionBoundarySchema,
  HostIdSchema,
  JobIdSchema,
  JobRequestIdSchema,
  ProjectBindingSchema,
  ResultContentSchema,
  ResultIdSchema,
  RevisionSchema,
  SessionGenerationSchema,
  StepRunIdSchema,
  TimestampSchema,
  VerificationSchema,
  WorkflowIdSchema,
  WorkflowLimitsSchema,
  WorkflowPackageSnapshotSchema,
  WorkflowPhaseSchema,
  WorkspaceIdSchema,
} from './model.js';
import { NativeBindingSchema, NativeIdentitySchema } from './native.js';
import type { Operation } from './operations.js';
import { profileSchema } from './settings.js';

export const outputContractVersion = 'v1' as const;
const string = Schema.String;
const key = string.check(Schema.isMinLength(1));
const integer = Schema.Finite.check(
  Schema.makeFilter(Number.isInteger, {
    expected: 'an integer',
    representation: { id: 'effect/schema/isInt', payload: null },
  }),
);
const positiveInteger = integer.check(Schema.isGreaterThanOrEqualTo(1));
const natural = integer.check(Schema.isGreaterThanOrEqualTo(0));
const finite = Schema.Number.check(Schema.isFinite());
const array = <S extends Schema.Constraint>(schema: S) => Schema.Array(schema);
const publicObject = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Struct(fields).annotate({ parseOptions: { onExcessProperty: 'preserve' } });

const boardAuthorSchema = publicObject({
  kind: Schema.Literals(['session', 'system', 'user']),
  id: key,
  generation: Schema.optional(SessionGenerationSchema),
});
const boardRecipientSchema = publicObject({
  kind: Schema.Literals(['desktop', 'session', 'user']),
  id: key,
  generation: Schema.optional(SessionGenerationSchema),
});
const boardThreadSchema = publicObject({
  id: key,
  title: key,
  jobId: Schema.NullOr(JobIdSchema),
  author: boardAuthorSchema,
  createdAt: TimestampSchema,
});
const boardPostSchema = publicObject({
  id: key,
  threadId: key,
  sequence: positiveInteger,
  body: key,
  kind: BoardPostKindSchema,
  author: boardAuthorSchema,
  replyToPostId: Schema.NullOr(key),
  replacesPostId: Schema.NullOr(key),
  references: array(BoardReferenceSchema),
  createdAt: TimestampSchema,
});
const page = <S extends Schema.Constraint>(item: S) =>
  publicObject({ entries: array(item), nextCursor: Schema.NullOr(key) });
const workspaceSchema = publicObject({
  id: WorkspaceIdSchema,
  projectId: ProjectBindingSchema.fields.id,
  hostId: HostIdSchema,
  kind: Schema.Literals(['isolated', 'existing']),
  path: key,
  repositoryRoot: key,
  baseCommit: Schema.NullOr(string),
  access: Schema.Literals(['inspect', 'write']),
  writes: array(string),
  createdAt: TimestampSchema,
  retiredAt: Schema.NullOr(TimestampSchema),
});
const sessionSchema = publicObject({
  id: AgentSessionIdSchema,
  generation: SessionGenerationSchema,
  projectId: ProjectBindingSchema.fields.id,
  hostId: HostIdSchema,
  workspaceId: Schema.NullOr(WorkspaceIdSchema),
  role: Schema.Literals(['user', 'controller', 'worker']),
  executionRole: key,
  parentWorkflowId: Schema.NullOr(WorkflowIdSchema),
  attemptId: Schema.NullOr(AttemptIdSchema),
  state: Schema.Literals(['active', 'settled', 'unconfirmed']),
  nativeKind: Schema.NullOr(string),
  nativeServerGeneration: Schema.NullOr(string),
  nativeLocator: Schema.NullOr(string),
  createdAt: TimestampSchema,
  settledAt: Schema.NullOr(TimestampSchema),
});
const jobSchema = publicObject({
  id: JobIdSchema,
  key,
  requestId: JobRequestIdSchema,
  currentBriefId: BriefIdSchema,
  currentBriefRevision: RevisionSchema,
  workspaceId: WorkspaceIdSchema,
  delivery: DeliveryKindSchema,
  origin: Schema.Union([
    publicObject({ kind: Schema.Literal('direct') }),
    publicObject({
      kind: Schema.Literal('workflow'),
      workflowId: WorkflowIdSchema,
      stepRunId: StepRunIdSchema,
    }),
  ]),
  state: Schema.Literals(['open', 'finished', 'cancelled']),
  createdAt: TimestampSchema,
});
const briefSchema = publicObject({
  id: BriefIdSchema,
  jobId: JobIdSchema,
  revision: RevisionSchema,
  priorBriefId: Schema.NullOr(BriefIdSchema),
  content: BriefContentSchema,
  changeReason: key,
  createdAt: TimestampSchema,
});
const workflowSchema = publicObject({
  id: WorkflowIdSchema,
  package: WorkflowPackageSnapshotSchema,
  parentWorkflowId: Schema.NullOr(WorkflowIdSchema),
  rootJobId: JobIdSchema,
  currentStepRunId: StepRunIdSchema,
  phase: WorkflowPhaseSchema,
  outcome: Schema.NullOr(Schema.Literals(['succeeded', 'failed'])),
  boundary: ExecutionBoundarySchema,
  revision: RevisionSchema,
  briefRevision: RevisionSchema,
  controlRevision: RevisionSchema,
  limits: WorkflowLimitsSchema,
  deadlineAt: TimestampSchema,
  createdAt: TimestampSchema,
});
const attemptSchema = publicObject({
  id: AttemptIdSchema,
  jobId: JobIdSchema,
  workflowId: Schema.NullOr(WorkflowIdSchema),
  stepRunId: Schema.NullOr(StepRunIdSchema),
  briefId: BriefIdSchema,
  briefRevision: RevisionSchema,
  hostId: HostIdSchema,
  workspaceId: WorkspaceIdSchema,
  sessionId: AgentSessionIdSchema,
  sessionGeneration: SessionGenerationSchema,
  phase: AttemptPhaseSchema,
  nativeKind: Schema.NullOr(string),
  nativeServerGeneration: Schema.NullOr(string),
  nativeLocator: Schema.NullOr(string),
  createdAt: TimestampSchema,
  settledAt: Schema.NullOr(TimestampSchema),
});
const resultSchema = publicObject({
  id: ResultIdSchema,
  jobId: JobIdSchema,
  attemptId: AttemptIdSchema,
  briefId: BriefIdSchema,
  briefRevision: RevisionSchema,
  hostId: HostIdSchema,
  workspaceId: WorkspaceIdSchema,
  inputDigest: DigestSchema,
  workspaceDigest: DigestSchema,
  content: ResultContentSchema,
  evidenceClaims: Schema.mutable(Schema.Array(string)),
  evidence: Schema.mutable(Schema.Array(EvidenceSchema)),
  verification: VerificationSchema,
  createdAt: TimestampSchema,
});
const handoffSchema = publicObject({
  id: key,
  result_id: ResultIdSchema,
  target_workspace_id: WorkspaceIdSchema,
  expected_target_state_json: string,
  state: Schema.Literals([
    'pending',
    'integrating',
    'integrated',
    'conflict',
    'unconfirmed',
    'retained',
    'abandoned',
  ]),
  claim_revision: natural,
  claimed_attempt_id: Schema.NullOr(AttemptIdSchema),
  current_claim_id: Schema.NullOr(string),
  actual_target_state_json: Schema.NullOr(string),
  checks_json: Schema.NullOr(string),
  reason: Schema.NullOr(string),
});
const nativeObservationSchema = Schema.Union([
  publicObject({ kind: Schema.Literal('working'), identity: NativeIdentitySchema }),
  publicObject({ kind: Schema.Literal('blocked'), identity: NativeIdentitySchema, reason: key }),
  publicObject({
    kind: Schema.Literal('manual-required'),
    identity: NativeIdentitySchema,
    reason: key,
  }),
  publicObject({
    kind: Schema.Literal('settled'),
    identity: NativeIdentitySchema,
    slotReady: Schema.Literal(true),
  }),
  publicObject({ kind: Schema.Literal('unconfirmed'), reason: key }),
  publicObject({ kind: Schema.Literal('unsupported'), reason: key }),
  publicObject({ kind: Schema.Literal('submitted'), operationId: key }),
]);
const attemptNativeSchema = publicObject({
  attempt: attemptSchema,
  native: nativeObservationSchema,
});
const retirementTargetSchema = publicObject({
  session: publicObject({ id: AgentSessionIdSchema, generation: SessionGenerationSchema }),
  identity: NativeIdentitySchema,
});
export const retirementPreviewOutputSchema = publicObject({
  kind: Schema.Literals(['ready', 'blocked', 'unconfirmed']),
  workspaceId: WorkspaceIdSchema,
  reason: Schema.optional(string),
  nativeTargets: array(retirementTargetSchema),
  effects: array(
    Schema.Union([
      publicObject({
        kind: Schema.Literal('cleanup-native-tab'),
        session: retirementTargetSchema.fields.session,
        identity: NativeIdentitySchema,
      }),
      publicObject({ kind: Schema.Literal('remove-worktree'), path: string }),
      publicObject({
        kind: Schema.Literal('mark-workspace-retired'),
        workspaceId: WorkspaceIdSchema,
      }),
    ]),
  ),
  skippedChecks: array(
    publicObject({
      kind: Schema.Literals([
        'native-observation',
        'native-cleanup',
        'post-native-cleanup-state',
        'post-worktree-removal',
      ]),
      reason: string,
    }),
  ),
});

type OperationName = Operation['operation'];
type OperationOutputSchemaMap = { readonly [Name in OperationName]: Schema.Constraint };
export const operationOutputSchemas = {
  context: publicObject({
    project: ProjectBindingSchema,
    bindingPath: key,
    session: sessionSchema,
    authentication: publicObject({
      source: Schema.Literals(['managed-context-file', 'local-session-file']),
      projectId: ProjectBindingSchema.fields.id,
      role: sessionSchema.fields.role,
      workspaceId: Schema.NullOr(WorkspaceIdSchema),
    }),
  }),
  'handoff.get': handoffSchema,
  'handoff.create': handoffSchema,
  'handoff.claim': handoffSchema,
  'handoff.check': handoffSchema,
  'handoff.complete': handoffSchema,
  'handoff.resolve': handoffSchema,
  'handoff.replan': handoffSchema,
  'workspace.register': workspaceSchema,
  'workspace.retire': Schema.Union([
    publicObject({
      kind: Schema.Literal('completed'),
      retirementId: key,
      workspaceId: WorkspaceIdSchema,
      revision: RevisionSchema,
    }),
    publicObject({
      kind: Schema.Literal('blocked'),
      retirementId: key,
      workspaceId: WorkspaceIdSchema,
      revision: RevisionSchema,
      reason: key,
    }),
    publicObject({
      kind: Schema.Literal('unconfirmed'),
      retirementId: key,
      workspaceId: WorkspaceIdSchema,
      revision: RevisionSchema,
      reason: key,
    }),
  ]),
  'workspace.get': workspaceSchema,
  'input.snapshot': publicObject({ id: key, name: key, ...artifactSchema.fields }),
  'job.create': jobSchema,
  'job.list': array(jobSchema),
  'job.get': jobSchema,
  'job.brief': briefSchema,
  'workflow.create': workflowSchema,
  'workflow.list': array(workflowSchema),
  'workflow.get': workflowSchema,
  route: Schema.Union([
    publicObject({
      kind: Schema.Literal('direct'),
      method: Schema.Literal('direct'),
      precedence: Schema.Literal('pstack'),
      packageName: key,
      reason: key,
    }),
    publicObject({
      kind: Schema.Literal('workflow'),
      method: Schema.Literal('pstack'),
      precedence: Schema.Literal('pstack'),
      packageName: key,
      reason: key,
    }),
  ]),
  'attempt.get': attemptSchema,
  'attempt.admit': AttemptIdSchema,
  'attempt.start': attemptNativeSchema,
  'attempt.inspect': attemptNativeSchema,
  'attempt.reconcile': attemptNativeSchema,
  'brief.acknowledge': briefSchema,
  'result.get': resultSchema,
  'result.discover': Schema.Union([
    publicObject({ kind: Schema.Literal('found'), result: resultSchema }),
    publicObject({ kind: Schema.Literal('pending') }),
  ]),
  'result.record': publicObject({ ...resultSchema.fields, replayed: Schema.Boolean }),
  'result.decide': publicObject({
    id: key,
    resultId: ResultIdSchema,
    briefId: BriefIdSchema,
    decision: Schema.Literals(['accepted', 'rejected']),
    createdAt: TimestampSchema,
    replayed: Schema.Boolean,
  }),
  'board.create': boardThreadSchema,
  'board.post': boardPostSchema,
  'board.list': page(boardThreadSchema),
  'board.read': page(boardPostSchema),
  'board.search': page(boardPostSchema),
  'board.subscribe': publicObject({
    id: key,
    subscriber: boardRecipientSchema,
    threadId: Schema.NullOr(key),
    eventKinds: array(BoardPostKindSchema),
    createdAt: TimestampSchema,
  }),
  'board.unsubscribe': Schema.Boolean,
  'board.mark-read': Schema.Boolean,
  'sql.read': publicObject({
    rows: array(Schema.Record(string, Schema.Union([string, finite, Schema.Boolean, Schema.Null]))),
    truncated: Schema.Boolean,
    bytes: natural,
  }),
  'sql.contribute': boardPostSchema,
  'profile.list': array(profileSchema),
  'profile.configure': publicObject({ revision: positiveInteger, value: profileSchema }),
  'native.register': publicObject({ revision: positiveInteger, value: NativeBindingSchema }),
} satisfies OperationOutputSchemaMap;

export type OperationOutput<Name extends OperationName> =
  (typeof operationOutputSchemas)[Name]['Type'];
export function parseOperationOutput<Name extends OperationName>(
  operation: Name,
  output: unknown,
): OperationOutput<Name> {
  return Schema.decodeUnknownSync(operationOutputSchemas[operation], {
    onExcessProperty: 'preserve',
  })(output);
}
