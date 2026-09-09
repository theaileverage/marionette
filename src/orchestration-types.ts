import { Effect, Schema } from 'effect';
import { checkSchema, kindSchema, type Task } from './types.js';
export const criterionSchema = Schema.Struct({
  id: Schema.mutableKey(Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(100))),
  description: Schema.mutableKey(
    Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(4000)),
  ),
  requiredEvidence: Schema.mutableKey(
    Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(4000)),
  ),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export const outcomeSchema = Schema.Struct({
  projectId: Schema.mutableKey(Schema.String),
  key: Schema.mutableKey(Schema.String.check(Schema.isMinLength(1))),
  objective: Schema.mutableKey(
    Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(20000)),
  ),
  originalRequest: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(20000)),
  ),
  requestSource: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(20000)),
  ),
  scope: Schema.mutableKey(
    Schema.mutable(Schema.Array(Schema.String.check(Schema.isMinLength(1)))).check(
      Schema.isMinLength(1),
    ),
  ),
  category: Schema.mutableKey(
    Schema.Literals(['software', 'research', 'analysis', 'decision']).pipe(
      Schema.withDecodingDefault(Effect.succeed('software')),
    ),
  ),
  criteria: Schema.mutableKey(
    Schema.mutable(Schema.Array(criterionSchema)).check(Schema.isMinLength(1)),
  ),
  maxTurns: Schema.mutableKey(
    Schema.Finite.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(1000))
      .pipe(Schema.withDecodingDefault(Effect.succeed(60))),
  ),
  maxDepth: Schema.mutableKey(
    Schema.Finite.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(0))
      .check(Schema.isLessThanOrEqualTo(6))
      .pipe(Schema.withDecodingDefault(Effect.succeed(3))),
  ),
});
export interface Assessment {
  criterionId: string;
  rationale: string;
  references: {
    path: string;
    digest: string;
  }[];
  revision: number;
  owner: string;
  createdAt: string;
}
export interface Outcome extends Omit<Schema.Schema.Type<typeof outcomeSchema>, 'key'> {
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
export const profileSchema = Schema.Struct({
  id: Schema.mutableKey(Schema.String.check(Schema.isPattern(/^[a-z0-9_-]{1,80}$/))),
  name: Schema.mutableKey(Schema.String.check(Schema.isMinLength(1))),
  kind: Schema.mutableKey(kindSchema),
  model: Schema.mutableKey(Schema.String.check(Schema.isMinLength(1))),
  reasoning: Schema.mutableKey(Schema.optional(Schema.String)),
  supportedReasoning: Schema.mutableKey(
    Schema.mutable(Schema.Array(Schema.String)).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
    ),
  ),
  categories: Schema.mutableKey(
    Schema.mutable(Schema.Array(Schema.String.check(Schema.isMinLength(1)))).check(
      Schema.isMinLength(1),
    ),
  ),
  capabilities: Schema.mutableKey(
    Schema.mutable(Schema.Array(Schema.String)).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
    ),
  ),
  strengths: Schema.mutableKey(Schema.String.check(Schema.isMinLength(1))),
  canDelegate: Schema.mutableKey(
    Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  ),
  maxConcurrency: Schema.mutableKey(
    Schema.Finite.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(8))
      .pipe(Schema.withDecodingDefault(Effect.succeed(2))),
  ),
  availability: Schema.mutableKey(
    Schema.Literals(['unverified', 'available', 'unavailable']).pipe(
      Schema.withDecodingDefault(Effect.succeed('unverified')),
    ),
  ),
  availabilityEvidence: Schema.mutableKey(
    Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed('Not checked on this account'))),
  ),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type Profile = Schema.Schema.Type<typeof profileSchema>;
export const limitsSchema = Schema.Struct({
  global: Schema.mutableKey(
    Schema.Finite.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(32))
      .pipe(Schema.withDecodingDefault(Effect.succeed(8))),
  ),
  project: Schema.mutableKey(
    Schema.Finite.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(8))
      .pipe(Schema.withDecodingDefault(Effect.succeed(3))),
  ),
  providers: Schema.mutableKey(
    Schema.Record(
      kindSchema,
      Schema.mutableKey(
        Schema.optionalKey(
          Schema.Finite.check(Schema.isInt())
            .check(Schema.isGreaterThanOrEqualTo(1))
            .check(Schema.isLessThanOrEqualTo(16)),
        ),
      ),
    ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  ),
  models: Schema.mutableKey(
    Schema.Record(
      Schema.String,
      Schema.mutableKey(
        Schema.Finite.check(Schema.isInt())
          .check(Schema.isGreaterThanOrEqualTo(1))
          .check(Schema.isLessThanOrEqualTo(16)),
      ),
    ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  ),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type Limits = Schema.Schema.Type<typeof limitsSchema>;
export interface Revision {
  id: string;
  projectId: string;
  outcomeId: string;
  taskId?: string;
  revision: number;
  reason: string;
  evidence: string[];
  owner: string;
  before: Task | Outcome | { outcome: Outcome; affected: Task[] } | null | undefined;
  after: Task | Outcome;
  createdAt: string;
}
export const planPatchSchema = Schema.Struct({
  prompt: Schema.mutableKey(
    Schema.optional(Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(50000))),
  ),
  title: Schema.mutableKey(
    Schema.optional(Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(200))),
  ),
  checks: Schema.mutableKey(
    Schema.optional(Schema.mutable(Schema.Array(checkSchema)).check(Schema.isMinLength(1))),
  ),
  dependencies: Schema.mutableKey(Schema.optional(Schema.mutable(Schema.Array(Schema.String)))),
  required: Schema.mutableKey(Schema.optional(Schema.Boolean)),
  supersededBy: Schema.mutableKey(Schema.optional(Schema.String)),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export const strategySchema = Schema.Struct({
  outcomeId: Schema.mutableKey(Schema.String),
  kind: Schema.mutableKey(
    Schema.Literals([
      'parallel',
      'sequential',
      'council',
      'debate',
      'competition',
      'review-repair',
    ]),
  ),
  participants: Schema.mutableKey(
    Schema.mutable(Schema.Array(Schema.String)).check(Schema.isMinLength(1)),
  ),
  criteria: Schema.mutableKey(Schema.String.check(Schema.isMinLength(1))),
  stopCondition: Schema.mutableKey(Schema.String.check(Schema.isMinLength(1))),
  maxRounds: Schema.mutableKey(
    Schema.Finite.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(20))
      .pipe(Schema.withDecodingDefault(Effect.succeed(3))),
  ),
  quorum: Schema.mutableKey(
    Schema.optional(Schema.Finite.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1))),
  ),
});
export interface Strategy extends Schema.Schema.Type<typeof strategySchema> {
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
