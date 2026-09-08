import { z } from 'zod';

export const leadAgentSchema = z.enum(['codex-desktop', 'codex', 'claude', 'agy']);
export type LeadAgent = z.infer<typeof leadAgentSchema>;
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
export type Credentials = z.infer<typeof credentialsSchema>;
export type Check = z.infer<typeof checkSchema>;
export type Assignment = z.infer<typeof assignmentSchema>;
export type Kind = z.infer<typeof kindSchema>;
export type Status =
  | 'waiting'
  | 'yielding'
  | 'queued'
  | 'preparing'
  | 'running'
  | 'blocked'
  | 'paused'
  | 'redirecting'
  | 'cancelling'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'uncertain';
export interface Project {
  id: string;
  name: string;
  root: string;
  session: string;
  socketPath: string;
  workspaceId: string;
  maxConcurrency: number;
  agentArgs: Partial<Record<Kind, string[]>>;
  trustAgyWorkspaces?: boolean;
  createdAt: string;
}
export interface Lead {
  agent?: LeadAgent;
  projectId: string;
  owner: string;
  epoch: number;
  tokenHash: string;
  changedAt: string;
  reason: string;
}
export interface Task extends Omit<Assignment, 'key'> {
  archiveId?: string;
  id: string;
  cwd: string;
  worktree?: ManagedWorktree;
  resolvedProfile?: import('./orchestration-types.js').Profile;
  supersededBy?: string;
  strategyId?: string;
  waitForChildren?: string[];
  resumePending?: boolean;
  status: Status;
  revision: number;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  leadOwner: string;
  runId?: string;
  error?: string;
  waitReason?: string;
  blockKind?: 'question' | 'native' | 'missing-report' | 'startup';
  output: string;
  receipt?: Receipt;
  verification?: Verification[];
}
export interface ManagedWorktree {
  state: 'planned' | 'creating' | 'ready';
  repositoryRoot: string;
  commonDir: string;
  sourceCwd: string;
  path: string;
  cwd: string;
  branch: string;
  baseCommit: string;
}
export interface Run {
  cleanup?: {
    state: 'closing' | 'closed' | 'uncertain' | 'retained';
    reason: string;
    updatedAt: string;
    output?: string;
    error?: string;
  };
  id: string;
  taskId: string;
  attempt: number;
  revision: number;
  agentName: string;
  kind: Kind;
  tokenHash: string;
  phase: 'creating' | 'starting' | 'prompting' | 'running' | 'stopped';
  paneId?: string;
  tabId?: string;
  terminalId?: string;
  nativeSession?: string;
  startedAt: string;
  lastStatus?: string;
  baselineSeq?: number;
  resolvedModel?: string;
  resolvedArgs?: string[];
  turns?: number;
  seenWork: boolean;
  baseline: Record<string, string | null>;
  settledAt?: number;
  disconnectedAt?: number;
  lastError?: string;
}
export interface Receipt {
  revision: number;
  summary: string;
  artifacts: string[];
  evidence: string[];
  receivedAt: string;
}
export interface Verification {
  check: Check;
  passed: boolean;
  detail: string;
  checkedAt: string;
  digest?: string;
}
export interface Question {
  id: string;
  projectId: string;
  taskId: string;
  text: string;
  native: boolean;
  createdAt: string;
  answer?: string;
  answeredAt?: string;
}
export interface Decision {
  id: string;
  projectId: string;
  text: string;
  rationale: string;
  owner: string;
  createdAt: string;
}
export interface Operation {
  id: string;
  taskId: string;
  projectId: string;
  type: 'redirect' | 'pause' | 'cancel' | 'reply' | 'keys';
  text?: string;
  keys?: string[];
  checks?: Check[];
  phase: 'pending' | 'interrupting' | 'sending' | 'done' | 'failed';
  createdAt: string;
  interruptedAt?: number;
  error?: string;
  revision: number;
}
export interface Event {
  id: number;
  projectId: string;
  type: string;
  message: string;
  taskId?: string;
  createdAt: string;
  data?: unknown;
}
export interface AgentInfo {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  name?: string;
  agent?: string;
  agent_status: string;
  state_change_seq?: number;
  interactive_ready?: boolean;
  launch_pending?: boolean;
  agent_session?: { value: string };
}
export interface HerdrPort {
  call(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<any>;
}
export const now = () => new Date().toISOString();
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
