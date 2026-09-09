import { Effect, Schema } from 'effect';
export const leadAgentSchema = Schema.Literals(['codex-desktop', 'codex', 'claude', 'agy']);
export type LeadAgent = Schema.Schema.Type<typeof leadAgentSchema>;
export const kindSchema = Schema.Literals(['codex', 'claude', 'agy']);
export const checkSchema = Schema.Union([
  Schema.Struct({
    type: Schema.mutableKey(Schema.Literal('file')),
    path: Schema.mutableKey(Schema.String.check(Schema.isMinLength(1))),
    contains: Schema.mutableKey(Schema.optional(Schema.String)),
    sha256: Schema.mutableKey(
      Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
    ),
    allowUnchanged: Schema.mutableKey(
      Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
    ),
  }),
  Schema.Struct({
    type: Schema.mutableKey(Schema.Literal('command')),
    command: Schema.mutableKey(Schema.String.check(Schema.isMinLength(1))),
    args: Schema.mutableKey(
      Schema.mutable(Schema.Array(Schema.String)).pipe(
        Schema.withDecodingDefault(Effect.succeed([])),
      ),
    ),
    timeoutMs: Schema.mutableKey(
      Schema.Finite.check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(100))
        .check(Schema.isLessThanOrEqualTo(120000))
        .pipe(Schema.withDecodingDefault(Effect.succeed(30000))),
    ),
  }),
]);
export const assignmentSchema = Schema.Struct({
  projectId: Schema.mutableKey(Schema.String),
  key: Schema.mutableKey(Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(200))),
  title: Schema.mutableKey(
    Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(200)),
  ),
  workstream: Schema.mutableKey(
    Schema.String.check(Schema.isMinLength(1))
      .check(Schema.isMaxLength(100))
      .pipe(Schema.withDecodingDefault(Effect.succeed('General'))),
  ),
  kind: Schema.mutableKey(kindSchema),
  outcomeId: Schema.mutableKey(Schema.optional(Schema.String)),
  parentId: Schema.mutableKey(Schema.optional(Schema.String)),
  required: Schema.mutableKey(Schema.optional(Schema.Boolean)),
  profileId: Schema.mutableKey(Schema.optional(Schema.String)),
  category: Schema.mutableKey(Schema.optional(Schema.String)),
  model: Schema.mutableKey(Schema.optional(Schema.String)),
  reasoning: Schema.mutableKey(Schema.optional(Schema.String)),
  canDelegate: Schema.mutableKey(Schema.optional(Schema.Boolean)),
  deferStart: Schema.mutableKey(Schema.optional(Schema.Boolean)),
  expectedTreeRevision: Schema.mutableKey(
    Schema.optional(Schema.Finite.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1))),
  ),
  planReason: Schema.mutableKey(Schema.optional(Schema.String.check(Schema.isMinLength(1)))),
  prompt: Schema.mutableKey(
    Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(50000)),
  ),
  cwd: Schema.mutableKey(Schema.optional(Schema.String)),
  execution: Schema.mutableKey(
    Schema.optional(
      Schema.Union([
        Schema.Struct({ mode: Schema.mutableKey(Schema.Literal('shared')) }).annotate({
          parseOptions: { onExcessProperty: 'error' },
        }),
        Schema.Struct({
          mode: Schema.mutableKey(Schema.Literal('worktree')),
          baseRef: Schema.mutableKey(
            Schema.optional(
              Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(500)),
            ),
          ),
        }).annotate({ parseOptions: { onExcessProperty: 'error' } }),
      ]),
    ),
  ),
  ownership: Schema.mutableKey(
    Schema.mutable(Schema.Array(Schema.String.check(Schema.isMinLength(1)))),
  ),
  readOnly: Schema.mutableKey(Schema.optional(Schema.Boolean)),
  dependencies: Schema.mutableKey(
    Schema.mutable(Schema.Array(Schema.String)).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
    ),
  ),
  checks: Schema.mutableKey(Schema.mutable(Schema.Array(checkSchema)).check(Schema.isMinLength(1))),
  maxAttempts: Schema.mutableKey(
    Schema.Finite.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(3))
      .pipe(Schema.withDecodingDefault(Effect.succeed(2))),
  ),
});
export const credentialsSchema = Schema.Struct({
  projectId: Schema.mutableKey(Schema.String),
  owner: Schema.mutableKey(Schema.String.check(Schema.isMinLength(1))),
  epoch: Schema.mutableKey(Schema.Finite.check(Schema.isInt())),
  token: Schema.mutableKey(Schema.String.check(Schema.isMinLength(1))),
});
export type Credentials = Schema.Schema.Type<typeof credentialsSchema>;
export type Check = Schema.Schema.Type<typeof checkSchema>;
export type Assignment = Schema.Schema.Type<typeof assignmentSchema>;
export type Kind = Schema.Schema.Type<typeof kindSchema>;
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
  trustWorkspaces?: boolean;
  /** Legacy AGY-only opt-in; retained when reading older state. */
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
  /** Absent on legacy runs, which own an exclusive tab. */
  terminalScope?: 'pane';
  creation?: {
    mode: 'tab' | 'pane';
    tabId?: string;
    targetPaneId?: string;
    direction?: 'right' | 'down';
    beforePaneIds?: string[];
  };
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
  agent_session?: {
    value: string;
  };
}
export interface HerdrPort {
  call(
    method: string,
    params?: Record<string, Schema.MutableJson | undefined>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<any>;
}
export const now = () => new Date().toISOString();
export class AppError extends Schema.TaggedError<AppError>()('AppError', {
  code: Schema.String,
  message: Schema.String,
  status: Schema.Finite,
}) {}
