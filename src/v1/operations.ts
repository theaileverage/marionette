import { controlOperations } from './control-operations.js';
import { z } from 'zod';
import { Marionette } from './client.js';
import { BoardPostKindSchema, BoardReferenceSchema } from './board.js';
import {
  TransitionRequestSchema,
  WorkflowLimitsSchema,
  TimestampSchema,
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
  ...controlOperations,
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
  z
    .object({
      operation: z.literal('workflow.activate'),
      workflowId: WorkflowIdSchema,
      expectedWorkflowRevision: z.number().int().positive(),
      expectedBriefRevision: z.number().int().positive(),
      expectedControlRevision: z.number().int().positive(),
      idempotencyKey: key,
    })
    .strict(),
  z
    .object({ operation: z.literal('workflow.transition'), request: TransitionRequestSchema })
    .strict(),
  z
    .object({
      operation: z.literal('workflow.revise'),
      jobId: JobIdSchema,
      expectedBriefRevision: z.number().int().positive(),
      brief: BriefContentSchema,
      changeReason: key,
      idempotencyKey: key,
    })
    .strict(),
  z
    .object({
      operation: z.literal('workflow.pause'),
      workflowId: WorkflowIdSchema,
      expectedWorkflowRevision: z.number().int().positive(),
      expectedControlRevision: z.number().int().positive(),
      mode: z.enum(['drain', 'safe', 'now']),
      idempotencyKey: key,
    })
    .strict(),
  z
    .object({
      operation: z.literal('workflow.cancel'),
      workflowId: WorkflowIdSchema,
      expectedWorkflowRevision: z.number().int().positive(),
      expectedControlRevision: z.number().int().positive(),
      idempotencyKey: key,
    })
    .strict(),
  z
    .object({
      operation: z.literal('workflow.resume'),
      workflowId: WorkflowIdSchema,
      expectedWorkflowRevision: z.number().int().positive(),
      expectedBriefRevision: z.number().int().positive(),
      expectedControlRevision: z.number().int().positive(),
      decision: z.null(),
      idempotencyKey: key,
    })
    .strict(),
  z
    .object({
      operation: z.literal('workflow.extend-limits'),
      workflowId: WorkflowIdSchema,
      expectedLimitsRevision: z.number().int().positive(),
      limits: WorkflowLimitsSchema,
      deadlineAt: TimestampSchema,
      reason: key,
      idempotencyKey: key,
    })
    .strict(),
  z.object({ operation: z.literal('workflow.status'), id: WorkflowIdSchema }).strict(),
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
      routeDecisionId: key.optional(),
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
    case 'service.reconcile':
      return client.reconcileService(payload(input));
    case 'service.install':
      return client.serviceAction({ ...payload(input), action: 'install' });
    case 'service.start':
      return client.serviceAction({ ...payload(input), action: 'start' });
    case 'service.stop':
      return client.serviceAction({ ...payload(input), action: 'stop' });
    case 'service.uninstall':
      return client.serviceAction({ ...payload(input), action: 'uninstall' });
    case 'service.status':
      return client.serviceStatus();
    case 'event.list':
      return client.events(input.after, input.limit);
    case 'controller.configure':
      return client.configureController(payload(input));
    case 'controller.ensure':
      return client.ensureController(payload(input));
    case 'controller.status':
      return client.controllerStatus();
    case 'controller.reconcile':
      return client.reconcileController(payload(input));
    case 'inbox.read':
      return client.readInbox(input.controllerId);
    case 'inbox.ack':
      return client.acknowledgeInbox(payload(input));
    case 'workflow.bind':
      return client.bindWorkflow(payload(input));
    case 'decision.list':
      return client.humanDecisions().list();
    case 'decision.request':
      return client.humanDecisions().request(payload(input));
    case 'decision.resolve':
      return client.humanDecisions().resolve(payload(input));
    case 'approval.list':
      return client.nativeApprovals().list();
    case 'approval.request':
      return client.nativeApprovals().request(payload(input));
    case 'approval.resolve':
      return client.nativeApprovals().resolve(payload(input));
    case 'approval.reconcile':
      return client.nativeApprovals().reconcile(payload(input));
    case 'harness.list':
      return client.harnessCatalog().list();
    case 'harness.discover':
      return client.discoverHarness(payload(input));
    case 'harness.probe':
      return client.probeHarness(payload(input));
    case 'harness.enable':
      return client.harnessCatalog().enable(payload(input));
    case 'profile.define':
      return client.harnessCatalog().defineProfile(payload(input));
    case 'profile.bind':
      return client.harnessCatalog().bind(payload(input));
    case 'profile.route-preview':
      return client.harnessCatalog().route(input.requirement, input.policyId, input.idempotencyKey);
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
    case 'workflow.activate':
      return client.activateWorkflow(payload(input));
    case 'workflow.transition':
      return client.transitionWorkflow(payload(input));
    case 'workflow.revise':
      return client.reviseWorkflow(payload(input));
    case 'workflow.pause':
      return client.controlWorkflow({
        ...payload(input),
        operation: { kind: 'pause', mode: input.mode },
      });
    case 'workflow.cancel':
      return client.controlWorkflow({ ...payload(input), operation: { kind: 'cancel' } });
    case 'workflow.resume':
      return client.resumeWorkflow(payload(input));
    case 'workflow.extend-limits':
      return client.extendWorkflowLimits(payload(input));
    case 'workflow.status':
      return client.workflowStatus(input.id);
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
