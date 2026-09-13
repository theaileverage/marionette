import {
  HumanDecisionRequestSchema,
  HumanDecisionResolveSchema,
} from './decisions/human-decisions.js';
import {
  NativeApprovalRequestSchema,
  NativeApprovalResolveSchema,
  NativeApprovalReconcileSchema,
} from './decisions/native-approvals.js';
import { TransitionRequestSchema, WorkflowIdSchema } from './model.js';
import { z } from 'zod';
import {
  catalogProfileSchema,
  roleRequirementSchema,
  routingPolicySchema,
} from './harnesses/index.js';
const key = z.string().min(1);
const mutation = { expectedRevision: z.number().int().nonnegative(), idempotencyKey: key };
export const inboxClaimSchema = z
  .object({
    id: key,
    claimRevision: z.number().int().positive(),
    controllerId: key,
    controllerGeneration: z.number().int().positive(),
    serviceGeneration: key,
  })
  .strict();
export const inboxDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workflow-transition'), request: TransitionRequestSchema }).strict(),
  z
    .object({ kind: z.literal('request-human-decision'), request: HumanDecisionRequestSchema })
    .strict(),
  z.object({ kind: z.literal('acknowledge-only'), reason: key }).strict(),
]);
export const controlOperations = [
  z
    .object({
      operation: z.literal('service.reconcile'),
      claimId: key,
      expectedRevision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('service.install'),
      ...mutation,
      dryRun: z.boolean().optional(),
    })
    .strict(),
  z
    .object({ operation: z.literal('service.start'), ...mutation, dryRun: z.boolean().optional() })
    .strict(),
  z
    .object({ operation: z.literal('service.stop'), ...mutation, dryRun: z.boolean().optional() })
    .strict(),
  z
    .object({
      operation: z.literal('service.uninstall'),
      ...mutation,
      dryRun: z.boolean().optional(),
    })
    .strict(),
  z.object({ operation: z.literal('service.status') }).strict(),
  z
    .object({
      operation: z.literal('event.list'),
      after: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().max(500).optional(),
    })
    .strict(),
  z
    .object({ operation: z.literal('controller.configure'), profilePolicyId: key, ...mutation })
    .strict(),
  z.object({ operation: z.literal('controller.status') }).strict(),
  z.object({ operation: z.literal('controller.ensure'), routeId: key, ...mutation }).strict(),
  z
    .object({
      operation: z.literal('controller.reconcile'),
      controllerId: key,
      generation: z.number().int().positive(),
      ...mutation,
    })
    .strict(),
  z.object({ operation: z.literal('inbox.read'), controllerId: key }).strict(),
  z
    .object({
      operation: z.literal('inbox.ack'),
      claims: z.array(inboxClaimSchema).min(1).max(50),
      decision: inboxDecisionSchema,
      decisionKey: key,
    })
    .strict(),
  z
    .object({
      operation: z.literal('workflow.bind'),
      workflowId: WorkflowIdSchema,
      stepName: key,
      profile: key,
      nativeWorkspaceId: key,
      routeDecisionId: key,
      ...mutation,
    })
    .strict(),
  HumanDecisionRequestSchema.extend({ operation: z.literal('decision.request') }),
  HumanDecisionResolveSchema.extend({ operation: z.literal('decision.resolve') }),
  z.object({ operation: z.literal('decision.list') }).strict(),
  NativeApprovalRequestSchema.extend({ operation: z.literal('approval.request') }),
  NativeApprovalResolveSchema.extend({ operation: z.literal('approval.resolve') }),
  NativeApprovalReconcileSchema.extend({ operation: z.literal('approval.reconcile') }),
  z.object({ operation: z.literal('approval.list') }).strict(),
  z.object({ operation: z.literal('harness.list') }).strict(),
  z
    .object({
      operation: z.literal('harness.discover'),
      socketPath: key,
      workspaceId: key,
      endpointId: key,
      verifiedModels: z.array(key),
      idempotencyKey: key,
    })
    .strict(),
  z
    .object({
      operation: z.literal('harness.probe'),
      installationId: key,
      socketPath: key,
      workspaceId: key,
      endpointId: key,
      verifiedModels: z.array(key),
    })
    .strict(),
  z
    .object({
      operation: z.literal('harness.enable'),
      installationId: key,
      enabled: z.boolean(),
      ...mutation,
    })
    .strict(),
  z
    .object({ operation: z.literal('profile.define'), profile: catalogProfileSchema, ...mutation })
    .strict(),
  z
    .object({ operation: z.literal('profile.bind'), policy: routingPolicySchema, ...mutation })
    .strict(),
  z
    .object({
      operation: z.literal('profile.route-preview'),
      requirement: roleRequirementSchema,
      policyId: key,
      idempotencyKey: key,
    })
    .strict(),
] as const;
