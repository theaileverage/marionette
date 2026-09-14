import { Effect, Schema } from "effect";

const id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255));
const nonEmptyString = Schema.String.check(Schema.isMinLength(1));
const stringArray = Schema.mutable(Schema.Array(Schema.String));
const nonEmptyStringArray = Schema.mutable(Schema.Array(nonEmptyString));
const integer = Schema.Number.check(
  Schema.makeFilter(Number.isInteger, { expected: "an integer" }),
);

export const ProjectIdSchema = id.pipe(Schema.brand("ProjectId"));
export type ProjectId = typeof ProjectIdSchema.Type;
export const HostIdSchema = id.pipe(Schema.brand("HostId"));
export type HostId = typeof HostIdSchema.Type;
export const WorkspaceIdSchema = id.pipe(Schema.brand("WorkspaceId"));
export type WorkspaceId = typeof WorkspaceIdSchema.Type;
export const AgentSessionIdSchema = id.pipe(Schema.brand("AgentSessionId"));
export type AgentSessionId = typeof AgentSessionIdSchema.Type;
export const JobIdSchema = id.pipe(Schema.brand("JobId"));
export type JobId = typeof JobIdSchema.Type;
export const JobRequestIdSchema = id.pipe(Schema.brand("JobRequestId"));
export type JobRequestId = typeof JobRequestIdSchema.Type;
export const BriefIdSchema = id.pipe(Schema.brand("BriefId"));
export type BriefId = typeof BriefIdSchema.Type;
export const AttemptIdSchema = id.pipe(Schema.brand("AttemptId"));
export type AttemptId = typeof AttemptIdSchema.Type;
export const ReservationIdSchema = id.pipe(Schema.brand("ReservationId"));
export type ReservationId = typeof ReservationIdSchema.Type;
export const ResultIdSchema = id.pipe(Schema.brand("ResultId"));
export type ResultId = typeof ResultIdSchema.Type;
export const WorkflowIdSchema = id.pipe(Schema.brand("WorkflowId"));
export type WorkflowId = typeof WorkflowIdSchema.Type;
export const StepRunIdSchema = id.pipe(Schema.brand("StepRunId"));
export type StepRunId = typeof StepRunIdSchema.Type;
export const TransitionRequestIdSchema = id.pipe(Schema.brand("TransitionRequestId"));
export type TransitionRequestId = typeof TransitionRequestIdSchema.Type;
export const ControlIntentIdSchema = id.pipe(Schema.brand("ControlIntentId"));
export type ControlIntentId = typeof ControlIntentIdSchema.Type;
export const ArtifactIdSchema = id.pipe(Schema.brand("ArtifactId"));
export type ArtifactId = typeof ArtifactIdSchema.Type;
export const DigestSchema = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{64}$/),
).pipe(Schema.brand("Digest"));
export type Digest = typeof DigestSchema.Type;

// Matches Zod 3's default datetime contract: a real calendar date, UTC `Z`,
// minute precision or optional seconds, and arbitrary fractional-second precision.
const timestampPattern =
  /^((\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\d|3[01])|(0[469]|11)-(0[1-9]|[12]\d|30)|(02)-(0[1-9]|1\d|2[0-8])))T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?Z$/;

export const TimestampSchema = Schema.String.check(
  Schema.isPattern(timestampPattern),
).pipe(Schema.brand("Timestamp"));
export type Timestamp = typeof TimestampSchema.Type;
export const RevisionSchema = integer.check(Schema.isGreaterThan(0));
export type Revision = typeof RevisionSchema.Type;
export const SessionGenerationSchema = integer.check(Schema.isGreaterThan(0));
export type SessionGeneration = typeof SessionGenerationSchema.Type;

export const ProjectBindingSchema = Schema.Struct({
  id: ProjectIdSchema,
  hostId: HostIdSchema,
  repositoryRoot: nonEmptyString,
  stateDirectory: nonEmptyString,
});
export type ProjectBinding = typeof ProjectBindingSchema.Type;

export const InputSnapshotSchema = Schema.Struct({
  name: nonEmptyString,
  digest: DigestSchema,
});
export type InputSnapshot = typeof InputSnapshotSchema.Type;

export const OriginalRequestSchema = Schema.Struct({
  text: nonEmptyString,
  digest: DigestSchema,
  inputSnapshots: Schema.mutable(Schema.Array(InputSnapshotSchema)),
});
export type OriginalRequest = typeof OriginalRequestSchema.Type;

export const BriefContentSchema = Schema.Struct({
  objective: nonEmptyString,
  scope: stringArray,
  ownership: stringArray,
  constraints: stringArray,
  standingOrders: stringArray,
  inputSnapshots: Schema.mutable(Schema.Array(InputSnapshotSchema)),
});
export type BriefContent = typeof BriefContentSchema.Type;

export const DeliveryKindSchema = Schema.Literals(["report", "patch", "commit"]);
export type DeliveryKind = typeof DeliveryKindSchema.Type;

export const WorkflowStepPhaseSchema = Schema.Literals([
  "analysis",
  "design",
  "implementation",
  "review",
  "verification",
  "coordination",
]);
export type WorkflowStepPhase = typeof WorkflowStepPhaseSchema.Type;

export const WorkflowStepSchema = Schema.Struct({
  name: nonEmptyString,
  phase: WorkflowStepPhaseSchema,
  resources: nonEmptyStringArray,
  outputContract: nonEmptyString,
  permittedMethods: nonEmptyStringArray,
  requiredEvidence: nonEmptyStringArray,
  requiresDistinctRole: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
    Schema.withConstructorDefault(Effect.succeed(false)),
  ),
});
export type WorkflowStep = typeof WorkflowStepSchema.Type;

export const TransitionKindSchema = Schema.Literals([
  "advance",
  "repeat",
  "route",
  "await-decision",
  "block",
  "finish",
]);
export type TransitionKind = typeof TransitionKindSchema.Type;

export const WorkflowRouteTargetSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("method"), method: nonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("child-workflow"), packageName: nonEmptyString }),
]);
export type WorkflowRouteTarget = typeof WorkflowRouteTargetSchema.Type;

export const WorkflowTransitionRuleSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("advance"),
    from: nonEmptyString,
    to: nonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("repeat"),
    from: nonEmptyString,
    to: nonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("route"),
    from: nonEmptyString,
    targets: Schema.mutable(Schema.NonEmptyArray(WorkflowRouteTargetSchema)),
  }),
  Schema.Struct({ kind: Schema.Literal("await-decision"), from: nonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("block"), from: nonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("finish"), from: nonEmptyString }),
]);
export type WorkflowTransitionRule = typeof WorkflowTransitionRuleSchema.Type;

const finiteLimit = integer.check(Schema.isGreaterThan(0), Schema.isFinite());
export const WorkflowLimitsSchema = Schema.Struct({
  maxAttempts: finiteLimit,
  maxRepeats: finiteLimit,
  deadlineMs: finiteLimit,
  parallelism: finiteLimit,
  innerLoopDeadlineMs: finiteLimit,
});
export type WorkflowLimits = typeof WorkflowLimitsSchema.Type;

export const WorkflowPackageSnapshotSchema = Schema.Struct({
  name: nonEmptyString,
  version: nonEmptyString,
  digest: DigestSchema,
  sourceDigests: Schema.mutable(Schema.Array(DigestSchema)),
  entryStep: nonEmptyString,
  steps: Schema.mutable(Schema.NonEmptyArray(WorkflowStepSchema)),
  transitions: Schema.mutable(Schema.Array(WorkflowTransitionRuleSchema)),
  limits: WorkflowLimitsSchema,
}).check(
  Schema.makeFilter((snapshot) => {
    const issues: Array<Schema.FilterIssue> = [];
    const stepNames = new Set<string>();
    for (const [index, step] of snapshot.steps.entries()) {
      if (stepNames.has(step.name)) {
        issues.push({
          path: ["steps", index, "name"],
          issue: `Duplicate workflow step ${step.name}`,
        });
      }
      stepNames.add(step.name);
    }
    if (!stepNames.has(snapshot.entryStep)) {
      issues.push({
        path: ["entryStep"],
        issue: `Entry step ${snapshot.entryStep} is not defined`,
      });
    }
    return issues;
  }),
);
export type WorkflowPackageSnapshot = typeof WorkflowPackageSnapshotSchema.Type;
export type WorkflowPackage = WorkflowPackageSnapshot;

export const EvidenceSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("file"),
    path: nonEmptyString,
    digest: DigestSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("git-commit"),
    commit: nonEmptyString,
    parent: nonEmptyString,
    paths: nonEmptyStringArray,
  }),
  Schema.Struct({
    kind: Schema.Literal("command"),
    argv: Schema.mutable(
      Schema.TupleWithRest(Schema.Tuple([nonEmptyString]), [Schema.String]),
    ),
    exitCode: integer,
    log: DigestSchema,
  }),
]);
export type Evidence = typeof EvidenceSchema.Type;

export const VerificationSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("not-requested") }),
  Schema.Struct({
    kind: Schema.Literal("passed"),
    checks: Schema.mutable(Schema.Array(EvidenceSchema)),
  }),
  Schema.Struct({
    kind: Schema.Literal("failed"),
    checks: Schema.mutable(Schema.Array(EvidenceSchema)),
  }),
]);
export type Verification = typeof VerificationSchema.Type;

export const ResultContentSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("report"),
    body: nonEmptyString,
    artifactDigests: Schema.mutable(Schema.Array(DigestSchema)),
  }),
  Schema.Struct({
    kind: Schema.Literal("patch"),
    sourceRepository: nonEmptyString,
    baseCommit: nonEmptyString,
    resultingTree: nonEmptyString,
    changedPaths: nonEmptyStringArray,
    artifactDigests: Schema.mutable(Schema.Array(DigestSchema)),
  }),
  Schema.Struct({
    kind: Schema.Literal("commit"),
    sourceRepository: nonEmptyString,
    baseCommit: nonEmptyString,
    resultingTree: nonEmptyString,
    resultingCommit: nonEmptyString,
    changedPaths: nonEmptyStringArray,
    artifactDigests: Schema.mutable(Schema.Array(DigestSchema)),
  }),
]);
export type ResultContent = typeof ResultContentSchema.Type;

export const AttemptPhaseSchema = Schema.Literals([
  "pending",
  "launching",
  "running",
  "stopping",
  "settled",
  "unconfirmed",
  "closed",
]);
export type AttemptPhase = typeof AttemptPhaseSchema.Type;

export const AttemptRecoverySchema = Schema.Struct({
  expectedBriefRevision: RevisionSchema,
  outcome: Schema.Literals(["failed", "interrupted"]),
  reason: nonEmptyString,
  idempotencyKey: nonEmptyString,
});
export type AttemptRecovery = typeof AttemptRecoverySchema.Type;

export const WorkflowPhaseSchema = Schema.Literals([
  "running",
  "pausing",
  "paused",
  "cancelling",
  "cancelled",
  "finished",
]);
export type WorkflowPhase = typeof WorkflowPhaseSchema.Type;
export const WorkflowOutcomeSchema = Schema.Literals(["succeeded", "failed"]);
export type WorkflowOutcome = typeof WorkflowOutcomeSchema.Type;
export const ExecutionBoundarySchema = Schema.Literals(["all", "design-only"]);
export type ExecutionBoundary = typeof ExecutionBoundarySchema.Type;

export const StepRunPhaseSchema = Schema.Literals([
  "pending",
  "active",
  "blocked",
  "awaiting-decision",
  "succeeded",
  "failed",
  "stale",
  "closed",
]);
export type StepRunPhase = typeof StepRunPhaseSchema.Type;

export const ControlOperationSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("pause"),
    mode: Schema.Literals(["drain", "safe", "now"]),
  }),
  Schema.Struct({ kind: Schema.Literal("cancel") }),
]);
export type ControlOperation = typeof ControlOperationSchema.Type;

const transitionEnvelope = {
  workflowId: WorkflowIdSchema,
  sourceStepRunId: StepRunIdSchema,
  reason: nonEmptyString,
  evidenceResultIds: Schema.mutable(Schema.Array(ResultIdSchema)),
  expectedWorkflowRevision: RevisionSchema,
  expectedBriefRevision: RevisionSchema,
  expectedControlRevision: RevisionSchema,
  idempotencyKey: nonEmptyString,
};

export const TransitionRequestSchema = Schema.Union([
  Schema.Struct({
    ...transitionEnvelope,
    kind: Schema.Literal("advance"),
    targetStep: nonEmptyString,
  }),
  Schema.Struct({
    ...transitionEnvelope,
    kind: Schema.Literal("repeat"),
    targetStep: nonEmptyString,
  }),
  Schema.Struct({
    ...transitionEnvelope,
    kind: Schema.Literal("route"),
    target: WorkflowRouteTargetSchema,
  }),
  Schema.Struct({
    ...transitionEnvelope,
    kind: Schema.Literal("await-decision"),
    artifact: ResultIdSchema,
  }),
  Schema.Struct({
    ...transitionEnvelope,
    kind: Schema.Literal("block"),
    resolutionCondition: nonEmptyString,
  }),
  Schema.Struct({
    ...transitionEnvelope,
    kind: Schema.Literal("finish"),
    result: Schema.Union([
      Schema.Struct({
        outcome: Schema.Literal("succeeded"),
        resultIds: Schema.mutable(Schema.Array(ResultIdSchema)),
      }),
      Schema.Struct({
        outcome: Schema.Literal("failed"),
        failureReason: nonEmptyString,
        retainedResultIds: Schema.mutable(Schema.Array(ResultIdSchema)),
      }),
    ]),
  }),
]);
export type TransitionRequest = typeof TransitionRequestSchema.Type;

export type JobOrigin =
  | { kind: "direct" }
  | { kind: "workflow"; workflowId: WorkflowId; stepRunId: StepRunId };

export type Job = {
  id: JobId;
  key: string;
  requestId: JobRequestId;
  currentBriefId: BriefId;
  currentBriefRevision: Revision;
  workspaceId: WorkspaceId;
  delivery: DeliveryKind;
  origin: JobOrigin;
  state: "open" | "finished" | "cancelled";
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
  jobId: JobId;
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
  content: ResultContent;
  evidenceClaims: string[];
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
