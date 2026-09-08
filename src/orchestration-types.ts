import { z } from 'zod';
import { checkSchema, kindSchema } from './types.js';

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
export interface Assessment {
  criterionId: string;
  rationale: string;
  references: { path: string; digest: string }[];
  revision: number;
  owner: string;
  createdAt: string;
}
export interface Outcome extends Omit<z.infer<typeof outcomeSchema>, 'key'> {
  id: string;
  leadOwner: string;
  revision: number;
  status: 'open' | 'completed';
  turnsUsed: number;
  createdAt: string;
  updatedAt: string;
  assessments: Assessment[];
  integrated?: {
    revision: number;
    summary: string;
    evidence: Assessment['references'];
    owner: string;
    createdAt: string;
  };
}
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
export type Profile = z.infer<typeof profileSchema>;
export const limitsSchema = z
  .object({
    global: z.number().int().min(1).max(32).default(8),
    project: z.number().int().min(1).max(8).default(3),
    providers: z.record(kindSchema, z.number().int().min(1).max(16)).default({}),
    models: z.record(z.string(), z.number().int().min(1).max(16)).default({}),
  })
  .strict();
export type Limits = z.infer<typeof limitsSchema>;
export interface Revision {
  id: string;
  projectId: string;
  outcomeId: string;
  taskId?: string;
  revision: number;
  reason: string;
  evidence: string[];
  owner: string;
  before: unknown;
  after: unknown;
  createdAt: string;
}
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
export interface Strategy extends z.infer<typeof strategySchema> {
  id: string;
  projectId: string;
  revision: number;
  round: number;
  status: 'open' | 'completed';
  entries: {
    taskId: string;
    taskRevision: number;
    round: number;
    claim: string;
    evidence: string[];
    rebuttal?: string;
  }[];
  synthesis?: string;
  disagreements?: string[];
  reason: string;
}
