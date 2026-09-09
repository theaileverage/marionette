import { Effect, Schema } from 'effect';
import { assignmentSchema, checkSchema } from './types.js';

const text = Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(20000));
const id = Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(200));
const revision = Schema.Finite.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1));
const ids = Schema.mutable(Schema.Array(id))
  .check(Schema.isMinLength(1))
  .check(Schema.isMaxLength(100));
const strings = Schema.mutable(Schema.Array(text));
const optional = Schema.optionalKey;
const key = { key: id };
const target = { outcomeId: id };
const versioned = { ...target, expectedRevision: revision };
const entry = Schema.Struct({ assignment: assignmentSchema, dependsOn: optional(strings) });
const entries = Schema.mutable(Schema.Array(entry))
  .check(Schema.isMinLength(1))
  .check(Schema.isMaxLength(100));
export const capacityPolicySchema = Schema.Struct({
  mode: Schema.Literals(['fixed', 'adaptive']),
  maxConcurrency: optional(revision),
  projectConcurrency: optional(revision),
  providers: optional(Schema.Record(Schema.String, revision)),
  models: optional(Schema.Record(Schema.String, revision)),
  memoryPerWorkerMb: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(64)).pipe(
    Schema.withDecodingDefault(Effect.succeed(512)),
  ),
});
export interface CapacityPolicy extends Schema.Schema.Type<typeof capacityPolicySchema> {}

export const swarmRequestSchema = Schema.Union([
  Schema.Struct({ action: Schema.Literal('intent.get'), ...target }),
  Schema.Struct({
    action: Schema.Literal('intent.amend'),
    ...versioned,
    ...key,
    text,
    source: text,
    objective: optional(text),
    taskIds: optional(ids),
  }),
  Schema.Struct({ action: Schema.Literal('dispatch'), ...versioned, ...key, entries }),
  Schema.Struct({
    action: Schema.Literal('message.send'),
    ...target,
    ...key,
    taskIds: ids,
    text,
    references: optional(strings),
    required: optional(Schema.Boolean),
  }),
  Schema.Struct({
    action: Schema.Literal('decision.open'),
    ...target,
    ...key,
    text,
    source: text,
    options: strings,
    taskId: optional(id),
    blocking: optional(Schema.Boolean),
  }),
  Schema.Struct({
    action: Schema.Literal('decision.resolve'),
    decisionId: id,
    expectedRevision: revision,
    resolution: Schema.Literals(['answered', 'superseded', 'withdrawn']),
    answer: text,
    source: text,
  }),
  Schema.Struct({
    action: Schema.Literal('ownership.transfer'),
    taskId: id,
    expectedRevision: revision,
    childIds: ids,
    retainedOwnership: strings,
    reason: text,
  }),
  Schema.Struct({
    action: Schema.Literal('capacity.configure'),
    policy: capacityPolicySchema,
    reason: text,
  }),
  Schema.Struct({
    action: Schema.Literal('capacity.feedback'),
    provider: Schema.Literals(['codex', 'claude', 'agy']),
    retryAfterMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1000)).check(
      Schema.isLessThanOrEqualTo(3600000),
    ),
    evidence: text,
  }),
  Schema.Struct({
    action: Schema.Literal('watch.create'),
    ...target,
    ...key,
    description: text,
    condition: checkSchema,
    intervalMs: Schema.Finite.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1000))
      .check(Schema.isLessThanOrEqualTo(86400000)),
    taskId: optional(id),
  }),
  Schema.Struct({ action: Schema.Literal('watch.ack'), watchId: id, resultId: id }),
  Schema.Struct({ action: Schema.Literal('watch.cancel'), watchId: id, reason: text }),
  Schema.Struct({
    action: Schema.Literal('observe'),
    projectId: id,
    after: optional(Schema.Finite.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))),
  }),
  Schema.Struct({
    action: Schema.Literal('trajectory'),
    ...target,
    after: optional(Schema.Finite.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))),
  }),
  Schema.Struct({
    action: Schema.Literal('experiment.create'),
    ...versioned,
    ...key,
    criteria: text,
    checks: Schema.mutable(Schema.Array(checkSchema)).check(Schema.isMinLength(1)),
    entries,
  }),
  Schema.Struct({ action: Schema.Literal('experiment.compare'), experimentId: id }),
  Schema.Struct({
    action: Schema.Literal('experiment.select'),
    experimentId: id,
    expectedRevision: revision,
    taskId: id,
    rationale: text,
    references: strings.check(Schema.isMinLength(1)),
  }),
  Schema.Struct({
    action: Schema.Literal('delivery.configure'),
    ...versioned,
    target: Schema.Literals(['local', 'pull-request', 'merge']),
    verification: text,
    authorization: text,
  }),
  Schema.Struct({
    action: Schema.Literal('evaluation.record'),
    ...versioned,
    ...key,
    scenario: text,
    strategy: text,
    success: Schema.Boolean,
    regressions: Schema.Finite.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)),
    interventions: Schema.Finite.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)),
    references: strings.check(Schema.isMinLength(1)),
    notes: text,
  }),
  Schema.Struct({ action: Schema.Literal('recipe.get'), name: id }),
]);
export type SwarmRequest = Schema.Schema.Type<typeof swarmRequestSchema>;
export interface Intent {
  outcomeId: string;
  projectId: string;
  original: string;
  originalSource: string;
  version: number;
  amendments: {
    id: string;
    version: number;
    text: string;
    source: string;
    createdAt: string;
    taskIds: string[];
  }[];
}
export interface Message {
  id: string;
  projectId: string;
  outcomeId: string;
  from: string;
  taskId: string;
  text: string;
  references: { path: string; digest: string }[];
  required: boolean;
  intentVersion?: number;
  createdAt: string;
  acknowledgedAt?: string;
  acknowledgedRunId?: string;
  acknowledgedRevision?: number;
}
export interface SwarmDecision {
  id: string;
  projectId: string;
  outcomeId: string;
  taskId?: string;
  text: string;
  source: string;
  options: string[];
  blocking: boolean;
  revision: number;
  createdAt: string;
  resolution?: 'answered' | 'superseded' | 'withdrawn';
  answer?: string;
  answerSource?: string;
  resolvedAt?: string;
}
export interface Watch {
  id: string;
  projectId: string;
  outcomeId: string;
  taskId?: string;
  description: string;
  condition: Schema.Schema.Type<typeof checkSchema>;
  intervalMs: number;
  nextAt: number;
  state: 'waiting' | 'checking' | 'ready' | 'failed' | 'acknowledged' | 'cancelled';
  createdAt: string;
  result?: { id: string; observedAt: string; detail: string; passed: boolean };
}
export interface Activity {
  taskId: string;
  runId: string;
  state: 'busy' | 'idle' | 'external-wait';
  source: 'worker-report';
  detail: string;
  observedAt: number;
  until?: number;
}
export interface Experiment {
  id: string;
  projectId: string;
  outcomeId: string;
  criteria: string;
  taskIds: string[];
  checks: Schema.Schema.Type<typeof checkSchema>[];
  createdAt: string;
  selection?: {
    taskId: string;
    rationale: string;
    outcomeRevision: number;
    taskRevisions: Record<string, number>;
    references: { path: string; digest: string }[];
  };
}
