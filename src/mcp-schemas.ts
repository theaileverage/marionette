import { z } from 'zod';

// MCP SDK transport schemas. Application validation uses Effect Schema.
export const leadAgentSchema = z.enum(['codex-desktop', 'codex', 'claude', 'agy']);
export const kindSchema = z.enum(['codex', 'claude', 'agy']);
export const checkSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('file'),
    path: z.string().min(1),
    contains: z.string().optional(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    allowUnchanged: z.boolean().default(false),
  }),
  z.object({
    type: z.literal('command'),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    timeoutMs: z.number().int().min(100).max(120000).default(30000),
  }),
]);
export const assignmentSchema = z.object({
  projectId: z.string(),
  key: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  workstream: z.string().min(1).max(100).default('General'),
  kind: kindSchema,
  outcomeId: z.string().optional(),
  parentId: z.string().optional(),
  required: z.boolean().optional(),
  profileId: z.string().optional(),
  category: z.string().optional(),
  model: z.string().optional(),
  reasoning: z.string().optional(),
  canDelegate: z.boolean().optional(),
  deferStart: z.boolean().optional(),
  expectedTreeRevision: z.number().int().min(1).optional(),
  planReason: z.string().min(1).optional(),
  prompt: z.string().min(1).max(50000),
  cwd: z.string().optional(),
  execution: z
    .discriminatedUnion('mode', [
      z.object({ mode: z.literal('shared') }).strict(),
      z
        .object({ mode: z.literal('worktree'), baseRef: z.string().min(1).max(500).optional() })
        .strict(),
    ])
    .optional(),
  ownership: z.array(z.string().min(1)).min(1),
  dependencies: z.array(z.string()).default([]),
  checks: z.array(checkSchema).min(1),
  maxAttempts: z.number().int().min(1).max(3).default(2),
});
export const credentialsSchema = z.object({
  projectId: z.string(),
  owner: z.string().min(1),
  epoch: z.number().int(),
  token: z.string().min(1),
});
export const criterionSchema = z
  .object({
    id: z.string().min(1).max(100),
    description: z.string().min(1).max(4000),
    requiredEvidence: z.string().min(1).max(4000),
  })
  .strict();
export const outcomeSchema = z.object({
  projectId: z.string(),
  key: z.string().min(1),
  objective: z.string().min(1).max(20000),
  scope: z.array(z.string().min(1)).min(1),
  category: z.enum(['software', 'research', 'analysis', 'decision']).default('software'),
  criteria: z.array(criterionSchema).min(1),
  maxTurns: z.number().int().min(1).max(1000).default(60),
  maxDepth: z.number().int().min(0).max(6).default(3),
});
export const profileSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_-]{1,80}$/),
    name: z.string().min(1),
    kind: kindSchema,
    model: z.string().min(1),
    reasoning: z.string().optional(),
    supportedReasoning: z.array(z.string()).default([]),
    categories: z.array(z.string().min(1)).min(1),
    capabilities: z.array(z.string()).default([]),
    strengths: z.string().min(1),
    canDelegate: z.boolean().default(false),
    maxConcurrency: z.number().int().min(1).max(8).default(2),
    availability: z.enum(['unverified', 'available', 'unavailable']).default('unverified'),
    availabilityEvidence: z.string().default('Not checked on this account'),
  })
  .strict();
export const limitsSchema = z
  .object({
    global: z.number().int().min(1).max(32).default(8),
    project: z.number().int().min(1).max(8).default(3),
    providers: z.record(kindSchema, z.number().int().min(1).max(16)).default({}),
    models: z.record(z.string(), z.number().int().min(1).max(16)).default({}),
  })
  .strict();
export const planPatchSchema = z
  .object({
    prompt: z.string().min(1).max(50000).optional(),
    title: z.string().min(1).max(200).optional(),
    checks: z.array(checkSchema).min(1).optional(),
    dependencies: z.array(z.string()).optional(),
    required: z.boolean().optional(),
    supersededBy: z.string().optional(),
  })
  .strict();
export const strategySchema = z.object({
  outcomeId: z.string(),
  kind: z.enum(['parallel', 'sequential', 'council', 'debate', 'competition', 'review-repair']),
  participants: z.array(z.string()).min(1),
  criteria: z.string().min(1),
  stopCondition: z.string().min(1),
  maxRounds: z.number().int().min(1).max(20).default(3),
  quorum: z.number().int().min(1).optional(),
});
export const waitSchema = z
  .object({
    lease: credentialsSchema,
    key: z.string().min(1),
    outcomeId: z.string(),
    condition: z
      .object({
        tasks: z.array(z.string()).default([]),
        mode: z.enum(['all', 'any', 'quorum']).default('all'),
        quorum: z.number().int().min(1).optional(),
        strategyId: z.string().optional(),
        questionIds: z.array(z.string()).default([]),
        intervention: z.boolean().default(true),
      })
      .strict(),
    adapter: z.discriminatedUnion('type', [
      z.object({ type: z.literal('next-message') }).strict(),
      z
        .object({
          type: z.literal('herdr'),
          paneId: z.string(),
          terminalId: z.string(),
          name: z.string(),
          kind: z.enum(['codex', 'claude', 'agy']),
          nativeSession: z.string().optional(),
        })
        .strict(),
    ]),
    checkpointId: z.string().optional(),
    profileId: z.string().optional(),
    expectedDurationMs: z
      .number()
      .int()
      .min(0)
      .max(30 * 86400000)
      .optional(),
  })
  .strict();
export const cleanupPolicySchema = z
  .object({
    autoRelease: z.boolean().default(true),
    collectAfterHours: z.number().min(0).max(87600).nullable().default(null),
    deleteMergedBranches: z.boolean().default(false),
  })
  .strict();
