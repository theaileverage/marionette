import { z } from 'zod';
import { Marionette } from './client.js';
import { BoardPostKindSchema, BoardReferenceSchema } from './board.js';
import {
  AttemptIdSchema,
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
import { handoffSchemas } from './handoff.js';

const key = z.string().min(1);
const page = { cursor: z.string().optional(), limit: z.number().int().min(1).max(200).optional() };
const jobInput = {
  stableKey: key,
  request: OriginalRequestSchema,
  brief: BriefContentSchema,
  workspaceId: WorkspaceIdSchema,
  delivery: DeliveryKindSchema,
  idempotencyKey: key,
};

export const operationSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('context') }).strict(),
  z.object({ operation: z.literal('handoff.get'), id: key }).strict(),
  handoffSchemas.create.extend({ operation: z.literal('handoff.create') }),
  handoffSchemas.claim.extend({ operation: z.literal('handoff.claim') }),
  handoffSchemas.check.extend({ operation: z.literal('handoff.check') }),
  handoffSchemas.complete.extend({ operation: z.literal('handoff.complete') }),
  handoffSchemas.resolve.extend({ operation: z.literal('handoff.resolve') }),
  handoffSchemas.replan.extend({ operation: z.literal('handoff.replan') }),

  z
    .object({
      operation: z.literal('workspace.register'),
      id: WorkspaceIdSchema,
      kind: z.enum(['isolated', 'existing']),
      path: z.string().min(1),
      repositoryRoot: z.string().min(1),
      baseCommit: z.string().nullable(),
      access: z.enum(['inspect', 'write']),
      writes: z.array(z.string()),
      idempotencyKey: key,
    })
    .strict(),
  z.object({ operation: z.literal('workspace.get'), id: WorkspaceIdSchema }).strict(),
  z
    .object({
      operation: z.literal('workspace.retire'),
      workspaceId: WorkspaceIdSchema,
      idempotencyKey: key,
    })
    .strict(),
  z
    .object({
      operation: z.literal('input.snapshot'),
      path: z.string().min(1),
      name: key,
      mediaType: z.string().optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('job.create'),
      ...jobInput,
      dependencies: z.array(JobIdSchema).default([]),
    })
    .strict(),
  z.object({ operation: z.literal('job.list') }).strict(),
  z.object({ operation: z.literal('job.get'), id: JobIdSchema }).strict(),
  z
    .object({
      operation: z.literal('job.brief'),
      id: JobIdSchema,
      revision: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('workflow.create'),
      ...jobInput,
      package: key,
      boundary: z.enum(['all', 'design-only']).default('all'),
    })
    .strict(),
  z.object({ operation: z.literal('workflow.list') }).strict(),
  z.object({ operation: z.literal('workflow.get'), id: WorkflowIdSchema }).strict(),
  z
    .object({ operation: z.literal('route'), request: key, package: z.string().optional() })
    .strict(),
  z.object({ operation: z.literal('attempt.get'), id: AttemptIdSchema }).strict(),
  z
    .object({
      operation: z.literal('brief.acknowledge'),
      attemptId: AttemptIdSchema,
      briefRevision: z.number().int().positive(),
      idempotencyKey: key,
    })
    .strict(),
  z.object({ operation: z.literal('result.get'), id: ResultIdSchema }).strict(),
  z
    .object({
      operation: z.literal('result.record'),
      attemptId: AttemptIdSchema,
      content: ResultContentSchema,
      inputDigest: DigestSchema,
      workspaceDigest: DigestSchema,
      evidenceClaims: z.array(z.string()),
      evidence: z.array(EvidenceSchema),
      verification: VerificationSchema,
      upstreamResultIds: z.array(ResultIdSchema),
      idempotencyKey: key,
    })
    .strict(),
  z
    .object({
      operation: z.literal('result.decide'),
      resultId: ResultIdSchema,
      expectedBriefRevision: z.number().int().positive(),
      decision: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('accepted') }),
        z.object({
          kind: z.literal('rejected'),
          issues: z.array(z.string()),
          retainedObservations: z.array(EvidenceSchema),
        }),
      ]),
      idempotencyKey: key,
    })
    .strict(),
  z
    .object({
      operation: z.literal('board.create'),
      title: key,
      idempotencyKey: key,
      jobId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('board.post'),
      threadId: key,
      body: key,
      kind: BoardPostKindSchema,
      idempotencyKey: key,
      references: z.array(BoardReferenceSchema).optional(),
      replyToPostId: z.string().optional(),
      replacesPostId: z.string().optional(),
    })
    .strict(),
  z.object({ operation: z.literal('board.list'), ...page }).strict(),
  z.object({ operation: z.literal('board.read'), threadId: key, ...page }).strict(),
  z.object({ operation: z.literal('board.search'), query: key, ...page }).strict(),
  z
    .object({
      operation: z.literal('board.subscribe'),
      threadId: z.string().optional(),
      eventKinds: z.array(BoardPostKindSchema).optional(),
    })
    .strict(),
  z.object({ operation: z.literal('board.unsubscribe'), threadId: z.string().optional() }).strict(),
  z
    .object({
      operation: z.literal('board.mark-read'),
      threadId: key,
      sequence: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('sql.read'),
      sql: key,
      parameters: z.record(z.union([z.string(), z.number().finite(), z.null()])).optional(),
      timeoutMs: z.number().int().positive().optional(),
      maxRows: z.number().int().positive().optional(),
      maxBytes: z.number().int().positive().optional(),
    })
    .strict(),
  z.object({ operation: z.literal('profile.list') }).strict(),
  z
    .object({
      operation: z.literal('profile.configure'),
      profile: profileSchema,
      expectedRevision: z.number().int().nonnegative(),
      idempotencyKey: key,
    })
    .strict(),
  z
    .object({
      operation: z.literal('native.register'),
      socketPath: key,
      workspaceId: key,
      expectedRevision: z.number().int().nonnegative(),
      idempotencyKey: key,
    })
    .strict(),
  z
    .object({
      operation: z.literal('attempt.admit'),
      jobId: JobIdSchema,
      profile: key,
      nativeWorkspaceId: key,
      inputResultIds: z.array(ResultIdSchema).default([]),
      expectedBriefRevision: z.number().int().positive(),
      idempotencyKey: key,
    })
    .strict(),
  z.object({ operation: z.literal('attempt.start'), id: AttemptIdSchema }).strict(),
  z.object({ operation: z.literal('attempt.inspect'), id: AttemptIdSchema }).strict(),
  z.object({ operation: z.literal('attempt.reconcile'), id: AttemptIdSchema }).strict(),
  z
    .object({
      operation: z.literal('sql.contribute'),
      threadId: key,
      kind: BoardPostKindSchema,
      idempotencyKey: key,
      sql: key,
      parameters: z.record(z.union([z.string(), z.number().finite(), z.null()])).optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
]);

export type Operation = z.infer<typeof operationSchema>;

function payload<T extends { operation: string }>(input: T): Omit<T, 'operation'> {
  const { operation: _operation, ...value } = input;
  return value;
}

export async function execute(client: Marionette, raw: Operation) {
  const input = operationSchema.parse(raw);
  switch (input.operation) {
    case 'handoff.get':
      return client.handoff(input.id);
    case 'handoff.create':
      return client.createHandoff(payload(input));
    case 'handoff.claim':
      return client.claimHandoff(payload(input));
    case 'handoff.check':
      return client.checkHandoff(payload(input));
    case 'handoff.complete':
      return client.completeHandoff(payload(input));
    case 'handoff.resolve':
      return client.resolveHandoff(payload(input));
    case 'handoff.replan':
      return client.replanHandoff(payload(input));
    case 'context':
      return client.context();
    case 'workspace.register':
      return client.registerWorkspace(payload(input));
    case 'workspace.retire':
      return client.retireWorkspace(payload(input));
    case 'workspace.get':
      return client.workspace(input.id);
    case 'input.snapshot':
      return client.snapshot(input);
    case 'job.create':
      return client.createJob({ ...payload(input), origin: { kind: 'direct' } });
    case 'job.list':
      return client.jobs();
    case 'job.get':
      return client.job(input.id);
    case 'job.brief':
      return client.brief(input.id, input.revision);
    case 'workflow.create':
      return client.createWorkflow(payload(input));
    case 'workflow.list':
      return client.workflows();
    case 'workflow.get':
      return client.workflow(input.id);
    case 'route':
      return client.route(input);
    case 'attempt.get':
      return client.attempt(input.id);
    case 'brief.acknowledge':
      return client.acknowledgeBrief(payload(input));
    case 'result.get':
      return client.result(input.id);
    case 'result.record':
      return client.recordResult(payload(input));
    case 'result.decide':
      return client.decideResult(payload(input));
    case 'board.create':
      return client.createThread(input);
    case 'board.post':
      return client.post(input);
    case 'board.list':
      return client.threads(input);
    case 'board.read':
      return client.readThread(input);
    case 'board.search':
      return client.searchBoard(input);
    case 'board.subscribe':
      return client.subscribe(input);
    case 'board.unsubscribe':
      return client.unsubscribe(input);
    case 'board.mark-read':
      return client.markRead(input);
    case 'sql.read':
      return client.query(input);
    case 'profile.list':
      return client.profiles();
    case 'profile.configure':
      return client.configureProfile(input);
    case 'native.register':
      return client.registerNative(payload(input));
    case 'attempt.admit':
      return client.admit(payload(input));
    case 'attempt.start':
      return client.startAttempt(input.id);
    case 'attempt.inspect':
      return client.inspectAttempt(input.id);
    case 'attempt.reconcile':
      return client.reconcileAttempt(input.id);
    case 'sql.contribute':
      return client.contribute(payload(input));
    default: {
      const exhaustive: never = input;
      return exhaustive;
    }
  }
}
