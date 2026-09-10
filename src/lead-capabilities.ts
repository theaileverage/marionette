import { Schema } from 'effect';
import type { Service } from './service.js';
import { AppError, type Credentials } from './types.js';

/** Explicit default-deny surface; adding an administrative action never exposes it to leads. */
export const leadActions = new Set([
  'project.briefing',
  'project.inspect',
  'task.submit',
  'task.get',
  'task.control',
  'task.retry',
  'task.reconcile',
  'decision.record',
  'inbox.read',
  'inbox.ack',
  'outcome.create',
  'outcome.get',
  'outcome.list',
  'board.get',
  'plan.get',
  'outcome.revise',
  'outcome.assess',
  'outcome.integrate',
  'outcome.complete',
  'plan.revise',
  'role.list',
  'authority.get',
  'lead.wait',
  'lead.waits',
  'lead.wait-ack',
  'lead.wait-reconcile',
  'adapter.capabilities',
  'checkpoint.save',
  'checkpoint.get',
  'usage.import',
  'strategy.create',
  'strategy.contribute',
  'strategy.advance',
  'strategy.reopen',
  'strategy.finish',
  'swarm.intent.get',
  'swarm.intent.amend',
  'swarm.dispatch',
  'swarm.message.send',
  'swarm.decision.open',
  'swarm.decision.resolve',
  'swarm.ownership.transfer',
  'swarm.capacity.feedback',
  'swarm.watch.create',
  'swarm.watch.ack',
  'swarm.watch.cancel',
  'swarm.observe',
  'swarm.trajectory',
  'swarm.recipe.get',
  'swarm.evaluation.record',
  'swarm.experiment.create',
  'swarm.experiment.compare',
  'swarm.experiment.select',
]);

const object = Schema.Record(Schema.String, Schema.Unknown);
const recordKinds = new Map(
  Object.entries({
    taskId: 'task',
    parentId: 'task',
    taskIds: 'task',
    childIds: 'task',
    dependencies: 'task',
    outcomeId: 'outcome',
    strategyId: 'strategy',
    revisionId: 'revision',
    checkpointId: 'checkpoint',
    waitId: 'lead-wait',
    decisionId: 'swarm-decision',
    watchId: 'swarm-watch',
    experimentId: 'swarm-experiment',
  }),
);

export function scopeLeadInput<Input>(
  s: Service,
  credentials: Credentials,
  action: string,
  raw: Input,
) {
  const lease = s.guard(credentials);
  if (!leadActions.has(action))
    throw new AppError({
      code: 'lead_capability',
      message: `The coordinator cannot call ${action}. Use the user CLI for configuration or authority changes.`,
      status: 403,
    });
  const input = Schema.decodeUnknownSync(object)(raw);
  if (
    s.project(lease.projectId).coordinatorOnly &&
    action === 'task.control' &&
    input.type === 'keys'
  )
    throw new AppError({
      code: 'lead_capability',
      message:
        'Coordinator sessions cannot send raw terminal keys. Use scoped worker instructions or the user CLI.',
      status: 403,
    });
  const check = <Value>(value: Value): void => {
    if (Array.isArray(value)) {
      value.forEach(check);
      return;
    }
    if (!Schema.is(object)(value)) return;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'lease') continue;
      if (key === 'projectId' && item !== lease.projectId)
        throw new AppError({
          code: 'project_mismatch',
          message: 'Lead capability belongs to another project',
          status: 403,
        });
      const kind = recordKinds.get(key);
      if (kind) {
        const ids = Schema.is(Schema.String)(item)
          ? [item]
          : Schema.is(Schema.Array(Schema.String))(item)
            ? item
            : [];
        for (const id of ids) {
          const record = s.store.get<{ projectId: string }>(kind, id);
          if (!record || record.projectId !== lease.projectId)
            throw new AppError({
              code: 'project_mismatch',
              message: `${key} is not in this lead project`,
              status: 403,
            });
        }
      }
      check(item);
    }
  };
  check(input);
  // Waits derive project identity from the checked outcome and lease. Their
  // strict transport schema deliberately rejects a top-level projectId.
  if (action === 'lead.wait') return { ...input, lease };
  return { ...input, projectId: lease.projectId, lease };
}
