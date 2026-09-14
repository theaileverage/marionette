import { Effect, Schema } from 'effect';
import type { Marionette } from './client.js';
import {
  BoardPostKindSchema,
  BoardReferenceSchema,
  BoardSubscriptionStartPolicySchema,
} from './board.js';
import { gitStateSchema } from './git.js';
import {
  AttemptIdSchema,
  AttemptRecoverySchema,
  BriefContentSchema,
  DeliveryKindSchema,
  DigestSchema,
  EvidenceSchema,
  JobIdSchema,
  OriginalRequestSchema,
  ResultContentSchema,
  ResultIdSchema,
  VerificationSchema,
  WorkflowIdSchema,
  WorkspaceIdSchema,
} from './model.js';
import { profileSchema } from './settings.js';

const key = Schema.String.check(Schema.isMinLength(1));
const integer = Schema.Finite.check(
  Schema.makeFilter(Number.isInteger, {
    expected: 'an integer',
    representation: { id: 'effect/schema/isInt', payload: null },
  }),
);
const positiveInteger = integer.check(Schema.isGreaterThanOrEqualTo(1));
const natural = integer.check(Schema.isGreaterThanOrEqualTo(0));
const finite = Schema.Number.check(Schema.isFinite());
const optional = <S extends Schema.Constraint>(schema: S) => Schema.optional(schema);
const array = <S extends Schema.Constraint>(schema: S) => Schema.mutable(Schema.Array(schema));
function strict<const Fields extends Schema.Struct.Fields>(fields: Fields): Schema.Struct<Fields> {
  return Schema.Struct(fields).annotate({ parseOptions: { onExcessProperty: 'error' } });
}
const jobDependencies = array(JobIdSchema).pipe(
  Schema.withDecodingDefault(Effect.succeed([])),
  Schema.annotate({ default: [] }),
);
const workflowBoundary = Schema.Literals(['all', 'design-only']).pipe(
  Schema.withDecodingDefault(Effect.succeed('all')),
  Schema.annotate({ default: 'all' }),
);
const attemptInputResults = array(ResultIdSchema).pipe(
  Schema.withDecodingDefault(Effect.succeed([])),
  Schema.annotate({ default: [] }),
);
const refreshByDefault = Schema.Boolean.pipe(
  Schema.withDecodingDefault(Effect.succeed(true)),
  Schema.annotate({ default: true }),
);

const page = {
  cursor: optional(Schema.String),
  limit: optional(positiveInteger.check(Schema.isLessThanOrEqualTo(200))),
};
const jobInput = {
  stableKey: key,
  request: OriginalRequestSchema,
  brief: BriefContentSchema,
  workspaceId: WorkspaceIdSchema,
  delivery: DeliveryKindSchema,
  idempotencyKey: key,
};
const handoffKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255));
const handoffCreate = {
  resultId: handoffKey,
  consumer: strict({
    kind: Schema.Literals(['session', 'job', 'workflow', 'user']),
    id: handoffKey,
  }),
  targetWorkspaceId: handoffKey,
  expectedTarget: gitStateSchema,
  idempotencyKey: handoffKey,
};
const handoffClaim = {
  handoffId: handoffKey,
  attemptId: handoffKey,
  expectedClaimRevision: natural,
  idempotencyKey: handoffKey,
};
const handoffComplete = {
  handoffId: handoffKey,
  attemptId: handoffKey,
  expectedClaimRevision: positiveInteger,
  state: Schema.Literals(['integrated', 'conflict', 'unconfirmed']),
  reason: key,
  idempotencyKey: handoffKey,
};
const handoffCheck = {
  handoffId: handoffKey,
  attemptId: handoffKey,
  expectedClaimRevision: positiveInteger,
  argv: Schema.mutable(Schema.NonEmptyArray(key)),
  timeoutMs: positiveInteger.check(Schema.isLessThanOrEqualTo(600_000)),
  idempotencyKey: handoffKey,
};
const handoffResolve = {
  handoffId: handoffKey,
  expectedClaimRevision: natural,
  state: Schema.Literals(['retained', 'abandoned']),
  reason: key,
  idempotencyKey: handoffKey,
};
const handoffReplan = {
  handoffId: handoffKey,
  expectedClaimRevision: natural,
  expectedTarget: gitStateSchema,
  reason: key,
  idempotencyKey: handoffKey,
};

export const operationSchemas = [
  strict({ operation: Schema.Literal('context') }),
  strict({ operation: Schema.Literal('handoff.get'), id: key }),
  strict({ operation: Schema.Literal('handoff.create'), ...handoffCreate }),
  strict({ operation: Schema.Literal('handoff.claim'), ...handoffClaim }),
  strict({ operation: Schema.Literal('handoff.check'), ...handoffCheck }),
  strict({ operation: Schema.Literal('handoff.complete'), ...handoffComplete }),
  strict({ operation: Schema.Literal('handoff.resolve'), ...handoffResolve }),
  strict({ operation: Schema.Literal('handoff.replan'), ...handoffReplan }),
  strict({
    operation: Schema.Literal('workspace.register'),
    id: WorkspaceIdSchema,
    kind: Schema.Literals(['isolated', 'existing']),
    path: key,
    repositoryRoot: key,
    baseCommit: Schema.NullOr(Schema.String),
    access: Schema.Literals(['inspect', 'write']),
    writes: array(Schema.String),
    idempotencyKey: key,
  }),
  strict({ operation: Schema.Literal('workspace.get'), id: WorkspaceIdSchema }),
  strict({
    operation: Schema.Literal('workspace.retire'),
    workspaceId: WorkspaceIdSchema,
    idempotencyKey: key,
  }),
  strict({
    operation: Schema.Literal('input.snapshot'),
    path: key,
    name: key,
    mediaType: optional(Schema.String),
  }),
  strict({ operation: Schema.Literal('job.create'), ...jobInput, dependencies: jobDependencies }),
  strict({ operation: Schema.Literal('job.list') }),
  strict({ operation: Schema.Literal('job.get'), id: JobIdSchema }),
  strict({
    operation: Schema.Literal('job.brief'),
    id: JobIdSchema,
    revision: optional(positiveInteger),
  }),
  strict({
    operation: Schema.Literal('workflow.create'),
    ...jobInput,
    package: key,
    boundary: workflowBoundary,
  }),
  strict({ operation: Schema.Literal('workflow.list') }),
  strict({ operation: Schema.Literal('workflow.get'), id: WorkflowIdSchema }),
  strict({ operation: Schema.Literal('route'), request: key, package: optional(Schema.String) }),
  strict({ operation: Schema.Literal('attempt.get'), id: AttemptIdSchema }),
  strict({
    operation: Schema.Literal('brief.acknowledge'),
    attemptId: AttemptIdSchema,
    briefRevision: positiveInteger,
    idempotencyKey: key,
  }),
  strict({ operation: Schema.Literal('result.get'), id: ResultIdSchema }),
  strict({ operation: Schema.Literal('result.discover'), attemptId: AttemptIdSchema }),
  strict({
    operation: Schema.Literal('result.record'),
    attemptId: AttemptIdSchema,
    content: ResultContentSchema,
    inputDigest: DigestSchema,
    workspaceDigest: DigestSchema,
    evidenceClaims: array(Schema.String),
    evidence: array(EvidenceSchema),
    verification: VerificationSchema,
    upstreamResultIds: array(ResultIdSchema),
    idempotencyKey: key,
  }),
  strict({
    operation: Schema.Literal('result.decide'),
    resultId: ResultIdSchema,
    expectedBriefRevision: positiveInteger,
    decision: Schema.Union([
      strict({ kind: Schema.Literal('accepted') }),
      strict({
        kind: Schema.Literal('rejected'),
        issues: array(Schema.String),
        retainedObservations: array(EvidenceSchema),
      }),
    ]),
    idempotencyKey: key,
  }),
  strict({
    operation: Schema.Literal('board.create'),
    title: key,
    idempotencyKey: key,
    jobId: optional(Schema.String),
  }),
  strict({
    operation: Schema.Literal('board.post'),
    threadId: key,
    body: key,
    kind: BoardPostKindSchema,
    idempotencyKey: key,
    references: optional(array(BoardReferenceSchema)),
    replyToPostId: optional(Schema.String),
    replacesPostId: optional(Schema.String),
  }),
  strict({ operation: Schema.Literal('board.list'), ...page }),
  strict({ operation: Schema.Literal('board.read'), threadId: key, ...page }),
  strict({ operation: Schema.Literal('board.search'), query: key, ...page }),
  strict({ operation: Schema.Literal('board.inbox'), ...page }),
  strict({
    operation: Schema.Literal('board.subscribe'),
    threadId: optional(Schema.String),
    eventKinds: optional(array(BoardPostKindSchema)),
    startPolicy: optional(BoardSubscriptionStartPolicySchema),
  }),
  strict({ operation: Schema.Literal('board.unsubscribe'), threadId: optional(Schema.String) }),
  strict({ operation: Schema.Literal('board.mark-read'), threadId: key, sequence: natural }),
  strict({
    operation: Schema.Literal('sql.read'),
    sql: key,
    parameters: optional(
      Schema.Record(Schema.String, Schema.Union([Schema.String, finite, Schema.Null])),
    ),
    timeoutMs: optional(positiveInteger),
    maxRows: optional(positiveInteger),
    maxBytes: optional(positiveInteger),
  }),
  strict({ operation: Schema.Literal('profile.list') }),
  strict({
    operation: Schema.Literal('profile.configure'),
    profile: profileSchema,
    expectedRevision: natural,
    idempotencyKey: key,
  }),
  strict({
    operation: Schema.Literal('native.register'),
    socketPath: key,
    workspaceId: key,
    expectedRevision: natural,
    idempotencyKey: key,
  }),
  strict({
    operation: Schema.Literal('attempt.admit'),
    jobId: JobIdSchema,
    profile: key,
    nativeWorkspaceId: key,
    inputResultIds: attemptInputResults,
    expectedBriefRevision: positiveInteger,
    idempotencyKey: key,
  }),
  strict({ operation: Schema.Literal('attempt.start'), id: AttemptIdSchema }),
  strict({ operation: Schema.Literal('attempt.inspect'), id: AttemptIdSchema }),
  strict({
    operation: Schema.Literal('attempt.retained-work'),
    id: AttemptIdSchema,
    refresh: refreshByDefault,
    cursor: optional(natural),
    limit: optional(positiveInteger.check(Schema.isLessThanOrEqualTo(200))),
    maxBytes: optional(positiveInteger.check(Schema.isLessThanOrEqualTo(256 * 1024))),
  }),
  strict({
    operation: Schema.Literal('attempt.reconcile'),
    id: AttemptIdSchema,
    recovery: optional(AttemptRecoverySchema),
  }),
  strict({
    operation: Schema.Literal('sql.contribute'),
    threadId: key,
    kind: BoardPostKindSchema,
    idempotencyKey: key,
    sql: key,
    parameters: optional(
      Schema.Record(Schema.String, Schema.Union([Schema.String, finite, Schema.Null])),
    ),
    timeoutMs: optional(positiveInteger),
  }),
] as const;

export const operationSchema = Schema.Union(operationSchemas);
export type Operation = (typeof operationSchemas)[number]['Type'];
const operationDecoders = {
  context: Schema.decodeUnknownSync(operationSchemas[0]),
  'handoff.get': Schema.decodeUnknownSync(operationSchemas[1]),
  'handoff.create': Schema.decodeUnknownSync(operationSchemas[2]),
  'handoff.claim': Schema.decodeUnknownSync(operationSchemas[3]),
  'handoff.check': Schema.decodeUnknownSync(operationSchemas[4]),
  'handoff.complete': Schema.decodeUnknownSync(operationSchemas[5]),
  'handoff.resolve': Schema.decodeUnknownSync(operationSchemas[6]),
  'handoff.replan': Schema.decodeUnknownSync(operationSchemas[7]),
  'workspace.register': Schema.decodeUnknownSync(operationSchemas[8]),
  'workspace.get': Schema.decodeUnknownSync(operationSchemas[9]),
  'workspace.retire': Schema.decodeUnknownSync(operationSchemas[10]),
  'input.snapshot': Schema.decodeUnknownSync(operationSchemas[11]),
  'job.create': Schema.decodeUnknownSync(operationSchemas[12]),
  'job.list': Schema.decodeUnknownSync(operationSchemas[13]),
  'job.get': Schema.decodeUnknownSync(operationSchemas[14]),
  'job.brief': Schema.decodeUnknownSync(operationSchemas[15]),
  'workflow.create': Schema.decodeUnknownSync(operationSchemas[16]),
  'workflow.list': Schema.decodeUnknownSync(operationSchemas[17]),
  'workflow.get': Schema.decodeUnknownSync(operationSchemas[18]),
  route: Schema.decodeUnknownSync(operationSchemas[19]),
  'attempt.get': Schema.decodeUnknownSync(operationSchemas[20]),
  'brief.acknowledge': Schema.decodeUnknownSync(operationSchemas[21]),
  'result.get': Schema.decodeUnknownSync(operationSchemas[22]),
  'result.discover': Schema.decodeUnknownSync(operationSchemas[23]),
  'result.record': Schema.decodeUnknownSync(operationSchemas[24]),
  'result.decide': Schema.decodeUnknownSync(operationSchemas[25]),
  'board.create': Schema.decodeUnknownSync(operationSchemas[26]),
  'board.post': Schema.decodeUnknownSync(operationSchemas[27]),
  'board.list': Schema.decodeUnknownSync(operationSchemas[28]),
  'board.read': Schema.decodeUnknownSync(operationSchemas[29]),
  'board.search': Schema.decodeUnknownSync(operationSchemas[30]),
  'board.inbox': Schema.decodeUnknownSync(operationSchemas[31]),
  'board.subscribe': Schema.decodeUnknownSync(operationSchemas[32]),
  'board.unsubscribe': Schema.decodeUnknownSync(operationSchemas[33]),
  'board.mark-read': Schema.decodeUnknownSync(operationSchemas[34]),
  'sql.read': Schema.decodeUnknownSync(operationSchemas[35]),
  'profile.list': Schema.decodeUnknownSync(operationSchemas[36]),
  'profile.configure': Schema.decodeUnknownSync(operationSchemas[37]),
  'native.register': Schema.decodeUnknownSync(operationSchemas[38]),
  'attempt.admit': Schema.decodeUnknownSync(operationSchemas[39]),
  'attempt.start': Schema.decodeUnknownSync(operationSchemas[40]),
  'attempt.inspect': Schema.decodeUnknownSync(operationSchemas[41]),
  'attempt.retained-work': Schema.decodeUnknownSync(operationSchemas[42]),
  'attempt.reconcile': Schema.decodeUnknownSync(operationSchemas[43]),
  'sql.contribute': Schema.decodeUnknownSync(operationSchemas[44]),
};
function isOperationName(value: string): value is keyof typeof operationDecoders {
  return Object.hasOwn(operationDecoders, value);
}
export function decodeOperation(raw: unknown): Operation {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('operation' in raw) ||
    typeof raw.operation !== 'string'
  ) {
    return operationDecoders.context(raw);
  }
  if (!isOperationName(raw.operation)) return operationDecoders.context(raw);
  return operationDecoders[raw.operation](raw);
}

const operationErrorField = Schema.String.check(Schema.isMinLength(1));
export class OperationError extends Schema.TaggedError<OperationError>()('OperationError', {
  operation: operationErrorField,
  message: operationErrorField,
  cause: Schema.Defect(),
}) {}

function operationName(raw: unknown): string {
  return typeof raw === 'object' &&
    raw !== null &&
    'operation' in raw &&
    typeof raw.operation === 'string'
    ? raw.operation
    : 'decode';
}

function operationError(operation: string, cause: unknown): OperationError {
  if (cause instanceof OperationError) return cause;
  return new OperationError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

function payload<T extends { readonly operation: string }>(input: T): Omit<T, 'operation'> {
  const { operation: _operation, ...value } = input;
  return value;
}

export function executeEffect(client: Marionette, raw: unknown) {
  let activeOperation = operationName(raw);
  const invoke = <A>(evaluate: () => A): Effect.Effect<A, OperationError> =>
    Effect.try({
      try: evaluate,
      catch: (cause) => operationError(activeOperation, cause),
    });
  return Effect.gen(function* () {
    const input = yield* invoke(() => decodeOperation(raw));
    activeOperation = input.operation;
    switch (input.operation) {
      case 'handoff.get':
        return yield* invoke(() => client.handoff(input.id));
      case 'handoff.create':
        return yield* invoke(() => client.createHandoff(payload(input)));
      case 'handoff.claim':
        return yield* invoke(() => client.claimHandoff(payload(input)));
      case 'handoff.check':
        return yield* client.checkHandoffEffect(payload(input));
      case 'handoff.complete':
        return yield* invoke(() => client.completeHandoff(payload(input)));
      case 'handoff.resolve':
        return yield* invoke(() => client.resolveHandoff(payload(input)));
      case 'handoff.replan':
        return yield* invoke(() => client.replanHandoff(payload(input)));
      case 'context':
        return yield* invoke(() => client.context());
      case 'workspace.register':
        return yield* invoke(() => client.registerWorkspace(payload(input)));
      case 'workspace.retire':
        return yield* client.retireWorkspaceEffect(payload(input));
      case 'workspace.get':
        return yield* invoke(() => client.workspace(input.id));
      case 'input.snapshot':
        return yield* invoke(() => client.snapshot(input));
      case 'job.create':
        return yield* invoke(() =>
          client.createJob({ ...payload(input), origin: { kind: 'direct' } }),
        );
      case 'job.list':
        return yield* invoke(() => client.jobs());
      case 'job.get':
        return yield* invoke(() => client.job(input.id));
      case 'job.brief':
        return yield* invoke(() => client.brief(input.id, input.revision));
      case 'workflow.create':
        return yield* invoke(() => client.createWorkflow(payload(input)));
      case 'workflow.list':
        return yield* invoke(() => client.workflows());
      case 'workflow.get':
        return yield* invoke(() => client.workflow(input.id));
      case 'route':
        return yield* invoke(() => client.route(input));
      case 'attempt.get':
        return yield* invoke(() => client.attempt(input.id));
      case 'brief.acknowledge':
        return yield* invoke(() => client.acknowledgeBrief(payload(input)));
      case 'result.get':
        return yield* invoke(() => client.result(input.id));
      case 'result.discover':
        return yield* invoke(() => client.discoverResult(input.attemptId));
      case 'result.record':
        return yield* invoke(() => client.recordResult(payload(input)));
      case 'result.decide':
        return yield* invoke(() => client.decideResult(payload(input)));
      case 'board.create':
        return yield* invoke(() => client.createThread(input));
      case 'board.post':
        return yield* client.postEffect(payload(input));
      case 'board.list':
        return yield* invoke(() => client.threads(input));
      case 'board.read':
        return yield* invoke(() => client.readThread(input));
      case 'board.search':
        return yield* invoke(() => client.searchBoard(input));
      case 'board.inbox':
        return yield* invoke(() => client.inbox(input));
      case 'board.subscribe':
        return yield* client.subscribeEffect(payload(input));
      case 'board.unsubscribe':
        return yield* invoke(() => client.unsubscribe(input));
      case 'board.mark-read':
        return yield* client.markReadEffect(payload(input));
      case 'sql.read':
        return yield* client.queryEffect(input);
      case 'profile.list':
        return yield* invoke(() => client.profiles());
      case 'profile.configure':
        return yield* invoke(() => client.configureProfile(input));
      case 'native.register':
        return yield* client.registerNativeEffect(payload(input));
      case 'attempt.admit':
        return yield* invoke(() => client.admit(payload(input)));
      case 'attempt.start':
        return yield* client.startAttemptEffect(input.id);
      case 'attempt.inspect':
        return yield* client.inspectAttemptEffect(input.id);
      case 'attempt.retained-work':
        return yield* client.inspectRetainedWorkEffect(input.id, payload(input));
      case 'attempt.reconcile':
        return input.recovery === undefined
          ? yield* client.reconcileAttemptEffect(input.id)
          : yield* client.recoverAttemptEffect({
              attemptId: input.id,
              ...input.recovery,
            });
      case 'sql.contribute':
        return yield* client.contributeEffect(payload(input));
    }
  }).pipe(Effect.mapError((cause) => operationError(activeOperation, cause)));
}

export async function execute(client: Marionette, raw: unknown) {
  try {
    return await Effect.runPromise(executeEffect(client, raw));
  } catch (error) {
    if (error instanceof OperationError) throw error.cause;
    throw error;
  }
}
