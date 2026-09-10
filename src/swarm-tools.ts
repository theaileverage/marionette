import { z } from 'zod';
import { assignmentSchema, checkSchema, credentialsSchema } from './mcp-schemas.js';

const text = z.string().min(1).max(20000);
const id = z.string().min(1).max(200);
const revision = z.number().int().min(1);
const ids = z.array(id).min(1).max(100);
const key = { key: id };
const target = { outcomeId: id };
const versioned = { ...target, expectedRevision: revision };
const entries = z
  .array(z.object({ assignment: assignmentSchema, dependsOn: z.array(text).optional() }))
  .min(1)
  .max(100);

/** Transport schemas mirror the authoritative Effect request decoder; contract tests exercise both. */
export const swarmTools = [
  {
    action: 'intent.get',
    description:
      'Read original user intent, attributed amendments and current outcome revision. Select an explicit outcome when several objectives are active.',
    readOnly: true,
    schema: z.object(target),
  },
  {
    action: 'intent.amend',
    description:
      'Atomically preserve a user correction and send required instructions to affected tasks. Defaults to all nonfailed/noncancelled tasks in the outcome. Invalidates affected evidence; completed tasks pause for explicit resumption. Retry the same key and exact input after uncertain responses.',
    schema: z.object({
      ...versioned,
      ...key,
      text,
      source: text,
      objective: text.optional(),
      taskIds: ids.optional(),
    }),
  },
  {
    action: 'dispatch',
    description:
      'Submit a dependency graph atomically against one outcome revision. dependsOn names other entry assignment keys. All entries roll back on error. Workers launch only after commit. Returns tasks and final treeRevision.',
    schema: z.object({ ...versioned, ...key, entries }),
  },
  {
    action: 'message.send',
    description:
      'Send an ordered durable instruction or selected context to explicit tasks in one outcome. Required messages block completion until recipient acknowledgement. Does not interrupt workers, grant new authority, or revise acceptance criteria; use intent.amend for user changes.',
    schema: z.object({
      ...target,
      ...key,
      taskIds: ids,
      text,
      references: z.array(text).optional(),
      required: z.boolean().optional(),
    }),
  },
  {
    action: 'decision.open',
    description:
      'Preserve a keyed decision independently of task progress. Blocking decisions prevent outcome completion until explicitly answered, superseded or withdrawn.',
    schema: z.object({
      ...target,
      ...key,
      text,
      source: text,
      options: z.array(text),
      taskId: id.optional(),
      blocking: z.boolean().optional(),
    }),
  },
  {
    action: 'decision.resolve',
    description:
      'Resolve a specific decision using its current revision, exact answer and source. Does not imply the answer was delivered to workers; steer affected tasks explicitly.',
    schema: z.object({
      decisionId: id,
      expectedRevision: revision,
      resolution: z.enum(['answered', 'superseded', 'withdrawn']),
      answer: text,
      source: text,
    }),
  },
  {
    action: 'ownership.transfer',
    description:
      'After pausing and settling a coordinator, reserve disjoint writable paths for it while named direct children execute concurrently. Original scope stays the delegation envelope. Resume through task.control; no edits are performed.',
    schema: z.object({
      taskId: id,
      expectedRevision: revision,
      childIds: ids,
      retainedOwnership: z.array(text),
      reason: text,
    }),
  },
  {
    action: 'capacity.configure',
    description:
      'Opt this instance into adaptive capacity, or restore saved fixed limits. Adaptive uses host CPU/memory estimates and gradual growth, with optional explicit ceilings. Outcome turn budgets remain separate. Does not interrupt existing work.',
    schema: z.object({
      policy: z.object({
        mode: z.enum(['fixed', 'adaptive']),
        maxConcurrency: revision.optional(),
        projectConcurrency: revision.optional(),
        providers: z.record(revision).optional(),
        models: z.record(revision).optional(),
        memoryPerWorkerMb: z.number().min(64).default(512),
      }),
      reason: text,
    }),
  },
  {
    action: 'capacity.feedback',
    description:
      'Record observed provider pressure and a bounded cooldown. Supply actual evidence, not an inferred model ranking. Blocks new work on this provider while preserving other providers.',
    schema: z.object({
      provider: z.enum(['codex', 'claude', 'agy', 'omp']),
      retryAfterMs: z.number().min(1000).max(3600000),
      evidence: text,
    }),
  },
  {
    action: 'watch.create',
    description:
      'Register an authorized read-only external condition in the supervisor. Commands run without a shell: exit 0 ready, 1 waiting, other/timeout failure. Conditions can repeat after restart; never register a mutating action as a probe. Captured results remain until acknowledged.',
    schema: z.object({
      ...target,
      ...key,
      description: text,
      condition: checkSchema,
      intervalMs: z.number().int().min(1000).max(86400000),
      taskId: id.optional(),
    }),
  },
  {
    action: 'watch.ack',
    description:
      'Acknowledge the exact captured external result after handling it. Acknowledgement does not execute any action.',
    schema: z.object({ watchId: id, resultId: id }),
  },
  {
    action: 'watch.cancel',
    description:
      'Retire a registered condition and preserve its last result. An already-running bounded probe may finish but cannot publish over cancellation.',
    schema: z.object({ watchId: id, reason: text }),
  },
  {
    action: 'observe',
    description:
      'Read fresh multi-objective state, including activeIntents for every open outcome with its tasks, open decisions and latest checkpoint reference. Also returns changes, pending instructions, watches and supervision/capacity health. Page changes using cursor/hasMore; preserve earlier work when new intent arrives.',
    readOnly: true,
    schema: z.object({ projectId: id, after: z.number().int().min(0).optional() }),
  },
  {
    action: 'trajectory',
    description:
      'Read an outcome trajectory with assignments, amendments, events, evidence and attributed evaluations. Worker credentials are excluded. Page events with nextCursor/hasMore. Usage remains unavailable when not measured.',
    readOnly: true,
    schema: z.object({ ...target, after: z.number().int().min(0).optional() }),
  },
  {
    action: 'experiment.create',
    description:
      'Atomically dispatch independent candidate worktrees with common checks and comparison criteria. Candidates are optional until a verified result is selected. Selection never integrates code or bypasses outcome review.',
    schema: z.object({
      ...versioned,
      ...key,
      criteria: text,
      checks: z.array(checkSchema).min(1),
      entries,
    }),
  },
  {
    action: 'experiment.compare',
    description:
      'Compare candidate artifacts and actual verification. Reports whether the recorded selection is current; makes no automatic quality ranking.',
    readOnly: true,
    schema: z.object({ experimentId: id }),
  },
  {
    action: 'experiment.select',
    description:
      'Select a currently verified candidate using evidence and rationale. Makes it required, preserves alternatives, and requires separate integration. Refresh after any relevant revision or evidence change.',
    schema: z.object({
      experimentId: id,
      expectedRevision: revision,
      taskId: id,
      rationale: text,
      references: z.array(text).min(1),
    }),
  },
  {
    action: 'delivery.configure',
    description:
      'Record delivery expectations and authorization provenance separately from verification. Performs no publication, merge, branch deletion or permission escalation.',
    schema: z.object({
      ...versioned,
      target: z.enum(['local', 'pull-request', 'merge']),
      verification: text,
      authorization: text,
    }),
  },
  {
    action: 'evaluation.record',
    description:
      'Record an attributed benchmark assessment supported by current evidence. Success requires an integrated completed outcome. Captures elapsed time and orchestration turns; provider usage is imported separately and never fabricated.',
    schema: z.object({
      ...versioned,
      ...key,
      scenario: text,
      strategy: text,
      success: z.boolean(),
      regressions: z.number().int().min(0),
      interventions: z.number().int().min(0),
      references: z.array(text).min(1),
      notes: text,
    }),
  },
  {
    action: 'recipe.get',
    description:
      'Load optional guidance by name: diagnose, investigate, compare-approaches, review-repair, deliver, recover, catch-up. Use only at its trigger. Recipes do not add authority or mandatory workflow stages.',
    readOnly: true,
    schema: z.object({ name: id }),
  },
];

export function swarmToolInputs() {
  return swarmTools.map((t) => ({
    ...t,
    input: t.readOnly ? t.schema.shape : { ...t.schema.shape, lease: credentialsSchema },
  }));
}
