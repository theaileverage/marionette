import { canonicalJson } from '../database.js';
import type { StepRun, TransitionRequest, WorkflowRun } from '../model.js';
import { StoreError } from '../store.js';

/** Pure package/revision gate. Evidence and capacity are checked in the applying transaction. */
export function validateTransition(
  workflow: WorkflowRun,
  step: StepRun,
  request: TransitionRequest,
): void {
  if (
    workflow.phase !== 'running' ||
    workflow.revision !== request.expectedWorkflowRevision ||
    workflow.briefRevision !== request.expectedBriefRevision ||
    workflow.controlRevision !== request.expectedControlRevision
  ) {
    throw new StoreError('stale-revision', 'Workflow is stopped or transition revisions changed');
  }
  if (step.id !== workflow.currentStepRunId || step.id !== request.sourceStepRunId) {
    throw new StoreError('invalid-transition', 'Transition source is not the current step');
  }
  const allowed = workflow.package.transitions.some((edge) => {
    if (edge.from !== step.stepName || edge.kind !== request.kind) return false;
    if (
      (edge.kind === 'advance' || edge.kind === 'repeat') &&
      (request.kind === 'advance' || request.kind === 'repeat')
    )
      return edge.to === request.targetStep;
    if (edge.kind === 'route' && request.kind === 'route')
      return edge.targets.some((target) => canonicalJson(target) === canonicalJson(request.target));
    return true;
  });
  if (!allowed) throw new StoreError('invalid-transition', 'Package does not declare this edge');
  if (request.kind === 'advance' || request.kind === 'repeat') {
    const target = workflow.package.steps.find(
      (candidate) => candidate.name === request.targetStep,
    );
    if (!target || (workflow.boundary === 'design-only' && target.phase === 'implementation')) {
      throw new StoreError('invalid-transition', 'Target step violates execution boundary');
    }
  }
}
