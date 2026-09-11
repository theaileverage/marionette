import { z } from 'zod';

const id = z.string().min(1).max(255);

export const ProjectIdSchema = id.brand<'ProjectId'>();
export type ProjectId = z.infer<typeof ProjectIdSchema>;
export const HostIdSchema = id.brand<'HostId'>();
export type HostId = z.infer<typeof HostIdSchema>;
export const WorkspaceIdSchema = id.brand<'WorkspaceId'>();
export type WorkspaceId = z.infer<typeof WorkspaceIdSchema>;
export const AgentSessionIdSchema = id.brand<'AgentSessionId'>();
export type AgentSessionId = z.infer<typeof AgentSessionIdSchema>;
export const JobIdSchema = id.brand<'JobId'>();
export type JobId = z.infer<typeof JobIdSchema>;
export const JobRequestIdSchema = id.brand<'JobRequestId'>();
export type JobRequestId = z.infer<typeof JobRequestIdSchema>;
export const BriefIdSchema = id.brand<'BriefId'>();
export type BriefId = z.infer<typeof BriefIdSchema>;
export const AttemptIdSchema = id.brand<'AttemptId'>();
export type AttemptId = z.infer<typeof AttemptIdSchema>;
export const ReservationIdSchema = id.brand<'ReservationId'>();
export type ReservationId = z.infer<typeof ReservationIdSchema>;
export const ResultIdSchema = id.brand<'ResultId'>();
export type ResultId = z.infer<typeof ResultIdSchema>;
export const WorkflowIdSchema = id.brand<'WorkflowId'>();
export type WorkflowId = z.infer<typeof WorkflowIdSchema>;
export const StepRunIdSchema = id.brand<'StepRunId'>();
export type StepRunId = z.infer<typeof StepRunIdSchema>;
export const TransitionRequestIdSchema = id.brand<'TransitionRequestId'>();
export type TransitionRequestId = z.infer<typeof TransitionRequestIdSchema>;
export const ControlIntentIdSchema = id.brand<'ControlIntentId'>();
export type ControlIntentId = z.infer<typeof ControlIntentIdSchema>;
export const ArtifactIdSchema = id.brand<'ArtifactId'>();
export type ArtifactId = z.infer<typeof ArtifactIdSchema>;
export const DigestSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .brand<'Digest'>();
export type Digest = z.infer<typeof DigestSchema>;

export const TimestampSchema = z.string().datetime().brand<'Timestamp'>();
export type Timestamp = z.infer<typeof TimestampSchema>;
export const RevisionSchema = z.number().int().positive();
export type Revision = z.infer<typeof RevisionSchema>;
export const SessionGenerationSchema = z.number().int().positive();
export type SessionGeneration = z.infer<typeof SessionGenerationSchema>;

export const ProjectBindingSchema = z.object({
  id: ProjectIdSchema,
  hostId: HostIdSchema,
  repositoryRoot: z.string().min(1),
  stateDirectory: z.string().min(1),
});
export type ProjectBinding = z.infer<typeof ProjectBindingSchema>;

export const InputSnapshotSchema = z.object({
  name: z.string().min(1),
  digest: DigestSchema,
});
export type InputSnapshot = z.infer<typeof InputSnapshotSchema>;

export const OriginalRequestSchema = z.object({
  text: z.string().min(1),
  digest: DigestSchema,
  inputSnapshots: z.array(InputSnapshotSchema),
});
export type OriginalRequest = z.infer<typeof OriginalRequestSchema>;

export const BriefContentSchema = z.object({
  objective: z.string().min(1),
  scope: z.array(z.string()),
  ownership: z.array(z.string()),
  constraints: z.array(z.string()),
  standingOrders: z.array(z.string()),
  inputSnapshots: z.array(InputSnapshotSchema),
});
export type BriefContent = z.infer<typeof BriefContentSchema>;

export const DeliveryKindSchema = z.enum(['report', 'patch', 'commit']);
export type DeliveryKind = z.infer<typeof DeliveryKindSchema>;

export const WorkflowStepPhaseSchema = z.enum([
  'analysis',
  'design',
  'implementation',
  'review',
  'verification',
  'coordination',
]);
export type WorkflowStepPhase = z.infer<typeof WorkflowStepPhaseSchema>;

export const WorkflowStepSchema = z.object({
  name: z.string().min(1),
  phase: WorkflowStepPhaseSchema,
  resources: z.array(z.string().min(1)),
  outputContract: z.string().min(1),
  permittedMethods: z.array(z.string().min(1)),
});
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

export const TransitionKindSchema = z.enum([
  'advance',
  'repeat',
  'route',
  'await-decision',
  'block',
  'finish',
]);
export type TransitionKind = z.infer<typeof TransitionKindSchema>;

export const WorkflowRouteTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('method'), method: z.string().min(1) }),
  z.object({ kind: z.literal('child-workflow'), packageName: z.string().min(1) }),
]);
export type WorkflowRouteTarget = z.infer<typeof WorkflowRouteTargetSchema>;

export const WorkflowTransitionRuleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('advance'), from: z.string().min(1), to: z.string().min(1) }),
  z.object({ kind: z.literal('repeat'), from: z.string().min(1), to: z.string().min(1) }),
  z.object({
    kind: z.literal('route'),
    from: z.string().min(1),
    targets: z.array(WorkflowRouteTargetSchema).min(1),
  }),
  z.object({ kind: z.literal('await-decision'), from: z.string().min(1) }),
  z.object({ kind: z.literal('block'), from: z.string().min(1) }),
  z.object({ kind: z.literal('finish'), from: z.string().min(1) }),
]);
export type WorkflowTransitionRule = z.infer<typeof WorkflowTransitionRuleSchema>;

const finiteLimit = z.number().int().positive().finite();
export const WorkflowLimitsSchema = z.object({
  maxAttempts: finiteLimit,
  maxRepeats: finiteLimit,
  deadlineMs: finiteLimit,
  parallelism: finiteLimit,
  innerLoopDeadlineMs: finiteLimit,
});
export type WorkflowLimits = z.infer<typeof WorkflowLimitsSchema>;

export const WorkflowPackageSnapshotSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  digest: DigestSchema,
  sourceDigests: z.array(DigestSchema),
  steps: z.array(WorkflowStepSchema).min(1),
  transitions: z.array(WorkflowTransitionRuleSchema),
  limits: WorkflowLimitsSchema,
});
export type WorkflowPackageSnapshot = z.infer<typeof WorkflowPackageSnapshotSchema>;
export type WorkflowPackage = WorkflowPackageSnapshot;

export const EvidenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), path: z.string().min(1), digest: DigestSchema }),
  z.object({
    kind: z.literal('git-commit'),
    commit: z.string().min(1),
    parent: z.string().min(1),
    paths: z.array(z.string().min(1)),
  }),
  z.object({
    kind: z.literal('command'),
    argv: z.tuple([z.string().min(1)]).rest(z.string()),
    exitCode: z.number().int(),
    log: DigestSchema,
  }),
]);
export type Evidence = z.infer<typeof EvidenceSchema>;

export const VerificationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('not-requested') }),
  z.object({ kind: z.literal('passed'), checks: z.array(EvidenceSchema) }),
  z.object({ kind: z.literal('failed'), checks: z.array(EvidenceSchema) }),
]);
export type Verification = z.infer<typeof VerificationSchema>;

export const AttemptPhaseSchema = z.enum([
  'pending',
  'launching',
  'running',
  'stopping',
  'settled',
  'unconfirmed',
  'closed',
]);
export type AttemptPhase = z.infer<typeof AttemptPhaseSchema>;

export const WorkflowPhaseSchema = z.enum([
  'running',
  'pausing',
  'paused',
  'cancelling',
  'cancelled',
  'finished',
]);
export type WorkflowPhase = z.infer<typeof WorkflowPhaseSchema>;
export const WorkflowOutcomeSchema = z.enum(['succeeded', 'failed']);
export type WorkflowOutcome = z.infer<typeof WorkflowOutcomeSchema>;
export const ExecutionBoundarySchema = z.enum(['all', 'design-only']);
export type ExecutionBoundary = z.infer<typeof ExecutionBoundarySchema>;

export const StepRunPhaseSchema = z.enum([
  'pending',
  'active',
  'blocked',
  'awaiting-decision',
  'succeeded',
  'failed',
  'stale',
  'closed',
]);
export type StepRunPhase = z.infer<typeof StepRunPhaseSchema>;

export const ControlOperationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pause'), mode: z.enum(['drain', 'safe', 'now']) }),
  z.object({ kind: z.literal('cancel') }),
]);
export type ControlOperation = z.infer<typeof ControlOperationSchema>;

const transitionEnvelope = {
  workflowId: WorkflowIdSchema,
  sourceStepRunId: StepRunIdSchema,
  reason: z.string().min(1),
  evidenceResultIds: z.array(ResultIdSchema),
  expectedWorkflowRevision: RevisionSchema,
  expectedBriefRevision: RevisionSchema,
  expectedControlRevision: RevisionSchema,
  idempotencyKey: z.string().min(1),
};

export const TransitionRequestSchema = z.discriminatedUnion('kind', [
  z.object({ ...transitionEnvelope, kind: z.literal('advance'), targetStep: z.string().min(1) }),
  z.object({ ...transitionEnvelope, kind: z.literal('repeat'), targetStep: z.string().min(1) }),
  z.object({ ...transitionEnvelope, kind: z.literal('route'), target: WorkflowRouteTargetSchema }),
  z.object({ ...transitionEnvelope, kind: z.literal('await-decision'), artifact: ResultIdSchema }),
  z.object({
    ...transitionEnvelope,
    kind: z.literal('block'),
    resolutionCondition: z.string().min(1),
  }),
  z.object({
    ...transitionEnvelope,
    kind: z.literal('finish'),
    result: z.discriminatedUnion('outcome', [
      z.object({ outcome: z.literal('succeeded'), resultIds: z.array(ResultIdSchema) }),
      z.object({
        outcome: z.literal('failed'),
        failureReason: z.string().min(1),
        retainedResultIds: z.array(ResultIdSchema),
      }),
    ]),
  }),
]);
export type TransitionRequest = z.infer<typeof TransitionRequestSchema>;

export type JobOrigin =
  { kind: 'direct' } | { kind: 'workflow'; workflowId: WorkflowId; stepRunId: StepRunId };

export type Job = {
  id: JobId;
  key: string;
  requestId: JobRequestId;
  currentBriefId: BriefId;
  currentBriefRevision: Revision;
  workspaceId: WorkspaceId;
  delivery: DeliveryKind;
  origin: JobOrigin;
  state: 'open' | 'finished' | 'cancelled';
  createdAt: Timestamp;
};

export type BriefRevision = {
  id: BriefId;
  jobId: JobId;
  revision: Revision;
  priorBriefId: BriefId | null;
  content: BriefContent;
  changeReason: string;
  createdAt: Timestamp;
};

export type WorkflowRun = {
  id: WorkflowId;
  package: WorkflowPackageSnapshot;
  parentWorkflowId: WorkflowId | null;
  rootJobId: JobId;
  currentStepRunId: StepRunId;
  phase: WorkflowPhase;
  outcome: WorkflowOutcome | null;
  boundary: ExecutionBoundary;
  revision: Revision;
  briefRevision: Revision;
  controlRevision: Revision;
  limits: WorkflowLimits;
  deadlineAt: Timestamp;
  createdAt: Timestamp;
};

export type StepRun = {
  id: StepRunId;
  workflowId: WorkflowId;
  stepName: string;
  ordinal: Revision;
  phase: StepRunPhase;
  inputWorkflowRevision: Revision;
  inputBriefRevision: Revision;
  createdAt: Timestamp;
};

export type Attempt = {
  id: AttemptId;
  jobId: JobId;
  workflowId: WorkflowId | null;
  stepRunId: StepRunId | null;
  briefId: BriefId;
  briefRevision: Revision;
  hostId: HostId;
  workspaceId: WorkspaceId;
  sessionId: AgentSessionId;
  sessionGeneration: SessionGeneration;
  phase: AttemptPhase;
  nativeKind: string | null;
  nativeServerGeneration: string | null;
  nativeLocator: string | null;
  createdAt: Timestamp;
  settledAt: Timestamp | null;
};

export type Result = {
  id: ResultId;
  jobId: JobId;
  attemptId: AttemptId;
  briefId: BriefId;
  briefRevision: Revision;
  hostId: HostId;
  workspaceId: WorkspaceId;
  inputDigest: Digest;
  workspaceDigest: Digest;
  evidence: Evidence[];
  verification: Verification;
  createdAt: Timestamp;
};

export type TransitionDecision = {
  requestId: TransitionRequestId;
  workflowId: WorkflowId;
  workflowRevision: Revision;
  createdStepRun: StepRun | null;
  replayed: boolean;
};

export type ControlIntent = {
  id: ControlIntentId;
  workflowId: WorkflowId;
  operation: ControlOperation;
  controlRevision: Revision;
  affectedWorkflowIds: WorkflowId[];
  affectedAttemptIds: AttemptId[];
  createdAt: Timestamp;
  replayed: boolean;
};
