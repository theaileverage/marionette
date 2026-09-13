import { z } from 'zod';
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
  ControlOperationSchema,
  StepRunPhaseSchema,
  WorkflowLimitsSchema,
  WorkflowPackageSnapshotSchema,
  WorkflowPhaseSchema,
  WorkspaceIdSchema,
} from './model.js';
import { NativeBindingSchema, NativeIdentitySchema } from './native.js';
import { type Operation } from './operations.js';
import { profileSchema } from './settings.js';

/** The stable public success-output contract for the v1 operation protocol. */
export const outputContractVersion = 'v1' as const;

/**
 * Output contracts intentionally allow additive fields. The operation protocol
 * commits the fields below, while a newer runtime may expose more detail.
 */
const publicObject = <Fields extends Record<string, z.ZodTypeAny>>(fields: Fields) =>
  z.object(fields).passthrough();

const boardAuthorSchema = publicObject({
  kind: z.enum(['session', 'system', 'user']),
  id: z.string().min(1),
  generation: SessionGenerationSchema.optional(),
});
const boardRecipientSchema = publicObject({
  kind: z.enum(['desktop', 'session', 'user']),
  id: z.string().min(1),
  generation: SessionGenerationSchema.optional(),
});
const boardThreadSchema = publicObject({
  id: z.string().min(1),
  title: z.string().min(1),
  jobId: JobIdSchema.nullable(),
  author: boardAuthorSchema,
  createdAt: TimestampSchema,
});
const boardPostSchema = publicObject({
  id: z.string().min(1),
  threadId: z.string().min(1),
  sequence: z.number().int().positive(),
  body: z.string().min(1),
  kind: BoardPostKindSchema,
  author: boardAuthorSchema,
  replyToPostId: z.string().min(1).nullable(),
  replacesPostId: z.string().min(1).nullable(),
  references: z.array(BoardReferenceSchema),
  createdAt: TimestampSchema,
});
const page = <Item extends z.ZodTypeAny>(item: Item) =>
  publicObject({ entries: z.array(item), nextCursor: z.string().min(1).nullable() });

const workspaceSchema = publicObject({
  id: WorkspaceIdSchema,
  projectId: ProjectBindingSchema.shape.id,
  hostId: HostIdSchema,
  kind: z.enum(['isolated', 'existing']),
  path: z.string().min(1),
  repositoryRoot: z.string().min(1),
  baseCommit: z.string().nullable(),
  access: z.enum(['inspect', 'write']),
  writes: z.array(z.string()),
  createdAt: TimestampSchema,
  retiredAt: TimestampSchema.nullable(),
});
const sessionSchema = publicObject({
  id: AgentSessionIdSchema,
  generation: SessionGenerationSchema,
  projectId: ProjectBindingSchema.shape.id,
  hostId: HostIdSchema,
  workspaceId: WorkspaceIdSchema.nullable(),
  role: z.enum(['user', 'controller', 'worker']),
  executionRole: z.string().min(1),
  parentWorkflowId: WorkflowIdSchema.nullable(),
  attemptId: AttemptIdSchema.nullable(),
  state: z.enum(['active', 'settled', 'unconfirmed']),
  nativeKind: z.string().nullable(),
  nativeServerGeneration: z.string().nullable(),
  nativeLocator: z.string().nullable(),
  createdAt: TimestampSchema,
  settledAt: TimestampSchema.nullable(),
});
const jobSchema = publicObject({
  id: JobIdSchema,
  key: z.string().min(1),
  requestId: JobRequestIdSchema,
  currentBriefId: BriefIdSchema,
  currentBriefRevision: RevisionSchema,
  workspaceId: WorkspaceIdSchema,
  delivery: DeliveryKindSchema,
  origin: z.discriminatedUnion('kind', [
    publicObject({ kind: z.literal('direct') }),
    publicObject({
      kind: z.literal('workflow'),
      workflowId: WorkflowIdSchema,
      stepRunId: StepRunIdSchema,
    }),
  ]),
  state: z.enum(['open', 'finished', 'cancelled']),
  createdAt: TimestampSchema,
});
const briefSchema = publicObject({
  id: BriefIdSchema,
  jobId: JobIdSchema,
  revision: RevisionSchema,
  priorBriefId: BriefIdSchema.nullable(),
  content: BriefContentSchema,
  changeReason: z.string().min(1),
  createdAt: TimestampSchema,
});
const workflowSchema = publicObject({
  id: WorkflowIdSchema,
  package: WorkflowPackageSnapshotSchema,
  parentWorkflowId: WorkflowIdSchema.nullable(),
  rootJobId: JobIdSchema,
  currentStepRunId: StepRunIdSchema,
  phase: WorkflowPhaseSchema,
  outcome: z.enum(['succeeded', 'failed']).nullable(),
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
  workflowId: WorkflowIdSchema.nullable(),
  stepRunId: StepRunIdSchema.nullable(),
  briefId: BriefIdSchema,
  briefRevision: RevisionSchema,
  hostId: HostIdSchema,
  workspaceId: WorkspaceIdSchema,
  sessionId: AgentSessionIdSchema,
  sessionGeneration: SessionGenerationSchema,
  phase: AttemptPhaseSchema,
  nativeKind: z.string().nullable(),
  nativeServerGeneration: z.string().nullable(),
  nativeLocator: z.string().nullable(),
  createdAt: TimestampSchema,
  settledAt: TimestampSchema.nullable(),
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
  evidenceClaims: z.array(z.string()),
  evidence: z.array(EvidenceSchema),
  verification: VerificationSchema,
  createdAt: TimestampSchema,
});
const handoffSchema = publicObject({
  id: z.string().min(1),
  result_id: ResultIdSchema,
  target_workspace_id: WorkspaceIdSchema,
  expected_target_state_json: z.string(),
  state: z.enum([
    'pending',
    'integrating',
    'integrated',
    'conflict',
    'unconfirmed',
    'retained',
    'abandoned',
  ]),
  claim_revision: z.number().int().nonnegative(),
  claimed_attempt_id: AttemptIdSchema.nullable(),
  current_claim_id: z.string().nullable(),
  actual_target_state_json: z.string().nullable(),
  checks_json: z.string().nullable(),
  reason: z.string().nullable(),
});
const nativeObservationSchema = z.discriminatedUnion('kind', [
  publicObject({ kind: z.literal('working'), identity: NativeIdentitySchema }),
  publicObject({
    kind: z.literal('blocked'),
    identity: NativeIdentitySchema,
    reason: z.string().min(1),
  }),
  publicObject({
    kind: z.literal('manual-required'),
    identity: NativeIdentitySchema,
    reason: z.string().min(1),
  }),
  publicObject({
    kind: z.literal('settled'),
    identity: NativeIdentitySchema,
    slotReady: z.literal(true),
  }),
  publicObject({ kind: z.literal('unconfirmed'), reason: z.string().min(1) }),
  publicObject({ kind: z.literal('unsupported'), reason: z.string().min(1) }),
  publicObject({ kind: z.literal('submitted'), operationId: z.string().min(1) }),
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
  kind: z.enum(['ready', 'blocked', 'unconfirmed']),
  workspaceId: WorkspaceIdSchema,
  reason: z.string().optional(),
  nativeTargets: z.array(retirementTargetSchema),
  effects: z
    .discriminatedUnion('kind', [
      publicObject({ kind: z.literal('cleanup-native-tab'), ...retirementTargetSchema.shape }),
      publicObject({ kind: z.literal('remove-worktree'), path: z.string() }),
      publicObject({ kind: z.literal('mark-workspace-retired'), workspaceId: WorkspaceIdSchema }),
    ])
    .array(),
  skippedChecks: publicObject({
    kind: z.enum([
      'native-observation',
      'native-cleanup',
      'post-native-cleanup-state',
      'post-worktree-removal',
    ]),
    reason: z.string(),
  }).array(),
});

type OperationName = Operation['operation'];
type OperationOutputSchemaMap = { [Name in OperationName]: z.ZodTypeAny };

/** One schema per operation. All schemas cover a successful raw `execute` value. */
export const operationOutputSchemas = {
  'project.link-list': z.array(z.record(z.unknown())),
  'project.rollup-read': z.array(
    publicObject({ sequence: RevisionSchema, projection: z.unknown() }),
  ),
  'project.budget-configure': publicObject({ revision: RevisionSchema }),
  'project.link-propose': publicObject({ linkId: z.string().min(1) }),
  'project.link-activate': publicObject({
    linkId: z.string().min(1),
    state: z.literal('active'),
  }),
  'project.authority-grant': publicObject({
    revision: RevisionSchema,
    state: z.literal('active'),
  }),
  'project.budget-allocate': publicObject({
    revision: RevisionSchema,
    budgetAttempts: z.number().int().nonnegative(),
  }),
  'project.command-enqueue': publicObject({ sequence: RevisionSchema }),
  'project.command-relay': z.array(
    publicObject({ kind: z.enum(['applied', 'rejected']), value: z.unknown() }),
  ),
  'project.event-enqueue': publicObject({ sequence: RevisionSchema }),
  'project.event-relay': z.array(
    publicObject({ kind: z.enum(['applied', 'rejected']), value: z.unknown() }),
  ),
  'project.link-pause': publicObject({
    revision: RevisionSchema,
    state: z.literal('paused'),
    settlement: z.enum(['confirmed', 'unconfirmed']),
  }),
  'project.link-revoke': publicObject({
    revision: RevisionSchema,
    state: z.literal('revoked'),
    settlement: z.enum(['confirmed', 'unconfirmed']),
  }),
  'project.workflow-allocation-settle': publicObject({
    releasedAttempts: z.number().int().nonnegative(),
    consumedAttempts: z.number().int().nonnegative(),
    projectBudgetRevision: RevisionSchema,
    sequence: RevisionSchema,
  }),
  'project.link-allocation-settle': publicObject({
    revision: RevisionSchema,
    releasedAttempts: z.number().int().nonnegative(),
    consumedAttempts: z.number().int().nonnegative(),
  }),
  'harness.list': publicObject({
    installations: z.array(z.record(z.unknown())),
    endpoints: z.array(z.record(z.unknown())),
  }),
  'harness.discover': publicObject({ id: z.string() }),
  'harness.probe': z.array(
    publicObject({ id: z.string(), generation: z.string(), health: z.string() }),
  ),
  'harness.enable': publicObject({ revision: RevisionSchema }),
  'profile.define': publicObject({ revision: RevisionSchema }),
  'profile.bind': publicObject({ revision: RevisionSchema }),
  'profile.route-preview': publicObject({
    id: z.string(),
    state: z.enum(['selected', 'blocked']),
    policyRevision: RevisionSchema,
    candidates: z.array(
      publicObject({ profileId: z.string(), eligible: z.boolean(), reasons: z.array(z.string()) }),
    ),
  }),
  'service.status': publicObject({
    revision: z.number().int().nonnegative(),
    instance: z.record(z.unknown()).nullable(),
    definition: publicObject({ path: z.string(), content: z.string() }),
  }),
  'event.list': z.array(
    publicObject({ id: z.string(), sequence: z.number().int().positive(), kind: z.string() }),
  ),
  'controller.configure': z.record(z.unknown()).nullable(),
  'controller.status': z.record(z.unknown()).nullable(),
  'controller.ensure': publicObject({
    controllerId: z.string(),
    generation: z.number().int().positive(),
  }),
  'controller.reconcile': publicObject({ kind: z.string() }),
  'controller.replace': publicObject({
    id: z.string().min(1),
    controllerId: z.string().min(1),
    generation: z.number().int().positive(),
    createdAt: TimestampSchema,
  }),
  'controller.effect-resolve': publicObject({
    effectId: z.string().min(1),
    state: z.literal('settled'),
    settledAt: TimestampSchema,
  }),
  'inbox.read': z.array(
    publicObject({ id: z.string(), state: z.string(), claim_revision: z.number() }),
  ),
  'inbox.release': publicObject({ released: z.literal(true) }),
  'inbox.ack': publicObject({ cycleId: z.string(), receipt: z.unknown(), replayed: z.boolean() }),
  'workflow.bind': publicObject({ revision: RevisionSchema, value: z.record(z.string()) }),
  'service.install': z.union([
    publicObject({
      id: z.string(),
      revision: RevisionSchema,
      state: z.enum(['claimed', 'completed', 'unconfirmed']),
    }),
    publicObject({
      action: z.string(),
      revision: z.number().int().nonnegative(),
      definition: publicObject({ path: z.string(), content: z.string() }),
    }),
  ]),
  'service.start': z.union([
    publicObject({
      id: z.string(),
      revision: RevisionSchema,
      state: z.enum(['claimed', 'completed', 'unconfirmed']),
    }),
    publicObject({
      action: z.string(),
      revision: z.number().int().nonnegative(),
      definition: publicObject({ path: z.string(), content: z.string() }),
    }),
  ]),
  'service.stop': z.union([
    publicObject({
      id: z.string(),
      revision: RevisionSchema,
      state: z.enum(['claimed', 'completed', 'unconfirmed']),
    }),
    publicObject({
      action: z.string(),
      revision: z.number().int().nonnegative(),
      definition: publicObject({ path: z.string(), content: z.string() }),
    }),
  ]),
  'service.uninstall': z.union([
    publicObject({
      id: z.string(),
      revision: RevisionSchema,
      state: z.enum(['claimed', 'completed', 'unconfirmed']),
    }),
    publicObject({
      action: z.string(),
      revision: z.number().int().nonnegative(),
      definition: publicObject({ path: z.string(), content: z.string() }),
    }),
  ]),
  'decision.list': z.array(z.record(z.unknown())),
  'decision.request': z.record(z.unknown()),
  'decision.resolve': z.record(z.unknown()),
  'approval.list': publicObject({
    exact: z.array(z.record(z.unknown())),
    legacy: z.array(z.record(z.unknown())),
  }),
  'approval.request': z.record(z.unknown()),
  'approval.resolve': z.record(z.unknown()),
  'approval.reconcile': z.record(z.unknown()),
  'service.reconcile': publicObject({
    id: z.string(),
    revision: RevisionSchema,
    state: z.enum(['claimed', 'completed', 'unconfirmed']),
  }),
  context: publicObject({
    project: ProjectBindingSchema,
    bindingPath: z.string().min(1),
    session: sessionSchema,
    authentication: publicObject({
      source: z.enum(['managed-context-file', 'local-session-file']),
      projectId: ProjectBindingSchema.shape.id,
      role: sessionSchema.shape.role,
      workspaceId: WorkspaceIdSchema.nullable(),
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
  'workspace.retire': z.discriminatedUnion('kind', [
    publicObject({
      kind: z.literal('completed'),
      retirementId: z.string().min(1),
      workspaceId: WorkspaceIdSchema,
      revision: RevisionSchema,
    }),
    publicObject({
      kind: z.literal('blocked'),
      retirementId: z.string().min(1),
      workspaceId: WorkspaceIdSchema,
      revision: RevisionSchema,
      reason: z.string().min(1),
    }),
    publicObject({
      kind: z.literal('unconfirmed'),
      retirementId: z.string().min(1),
      workspaceId: WorkspaceIdSchema,
      revision: RevisionSchema,
      reason: z.string().min(1),
    }),
  ]),
  'workspace.get': workspaceSchema,
  'input.snapshot': publicObject({
    id: z.string().min(1),
    name: z.string().min(1),
    ...artifactSchema.shape,
  }),
  'job.create': jobSchema,
  'job.list': z.array(jobSchema),
  'job.get': jobSchema,
  'job.brief': briefSchema,
  'workflow.create': workflowSchema,
  'workflow.activate': workflowSchema,
  'workflow.transition': publicObject({
    requestId: z.string(),
    workflowId: WorkflowIdSchema,
    workflowRevision: RevisionSchema,
    createdStepRun: publicObject({ id: StepRunIdSchema, phase: StepRunPhaseSchema }).nullable(),
    replayed: z.boolean(),
  }),
  'workflow.revise': briefSchema,
  'workflow.pause': publicObject({
    id: z.string(),
    workflowId: WorkflowIdSchema,
    operation: ControlOperationSchema,
    controlRevision: RevisionSchema,
    affectedWorkflowIds: WorkflowIdSchema.array(),
    affectedAttemptIds: AttemptIdSchema.array(),
    createdAt: TimestampSchema,
    replayed: z.boolean(),
  }),
  'workflow.cancel': publicObject({
    id: z.string(),
    workflowId: WorkflowIdSchema,
    operation: ControlOperationSchema,
    controlRevision: RevisionSchema,
    affectedWorkflowIds: WorkflowIdSchema.array(),
    affectedAttemptIds: AttemptIdSchema.array(),
    createdAt: TimestampSchema,
    replayed: z.boolean(),
  }),
  'workflow.resume': workflowSchema,
  'workflow.extend-limits': workflowSchema,
  'workflow.status': publicObject({ workflow: workflowSchema }),
  'workflow.list': z.array(workflowSchema),
  'workflow.get': workflowSchema,
  route: z.discriminatedUnion('kind', [
    publicObject({
      kind: z.literal('direct'),
      method: z.literal('direct'),
      precedence: z.literal('pstack'),
      packageName: z.string().min(1),
      reason: z.string().min(1),
    }),
    publicObject({
      kind: z.literal('workflow'),
      method: z.literal('pstack'),
      precedence: z.literal('pstack'),
      packageName: z.string().min(1),
      reason: z.string().min(1),
    }),
  ]),
  'attempt.get': attemptSchema,
  'attempt.admit': AttemptIdSchema,
  'attempt.start': attemptNativeSchema,
  'attempt.inspect': attemptNativeSchema,
  'attempt.reconcile': attemptNativeSchema,
  'brief.acknowledge': briefSchema,
  'result.get': resultSchema,
  'result.record': publicObject({ ...resultSchema.shape, replayed: z.boolean() }),
  'result.decide': publicObject({
    id: z.string().min(1),
    resultId: ResultIdSchema,
    briefId: BriefIdSchema,
    decision: z.enum(['accepted', 'rejected']),
    createdAt: TimestampSchema,
    replayed: z.boolean(),
  }),
  'board.create': boardThreadSchema,
  'board.post': boardPostSchema,
  'board.list': page(boardThreadSchema),
  'board.read': page(boardPostSchema),
  'board.search': page(boardPostSchema),
  'board.subscribe': publicObject({
    id: z.string().min(1),
    subscriber: boardRecipientSchema,
    threadId: z.string().min(1).nullable(),
    eventKinds: z.array(BoardPostKindSchema),
    createdAt: TimestampSchema,
  }),
  'board.unsubscribe': z.boolean(),
  'board.mark-read': z.boolean(),
  'sql.read': publicObject({
    rows: z.array(z.record(z.union([z.string(), z.number().finite(), z.boolean(), z.null()]))),
    truncated: z.boolean(),
    bytes: z.number().int().nonnegative(),
  }),
  'sql.contribute': boardPostSchema,
  'profile.list': z.array(profileSchema),
  'profile.configure': publicObject({
    revision: z.number().int().positive(),
    value: profileSchema,
  }),
  'native.register': publicObject({
    revision: z.number().int().positive(),
    value: NativeBindingSchema,
  }),
} satisfies OperationOutputSchemaMap;

export type OperationOutput<Name extends OperationName> = z.infer<
  (typeof operationOutputSchemas)[Name]
>;

type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { [key: string]: JsonValue };

export function parseOperationOutput<Name extends OperationName>(
  operation: Name,
  output: JsonValue,
): OperationOutput<Name> {
  // SAFETY: `satisfies OperationOutputSchemaMap` ensures this index always selects a schema.
  return operationOutputSchemas[operation].parse(output) as OperationOutput<Name>;
}
