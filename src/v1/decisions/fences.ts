import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { SessionIdentity, Store } from '../store.js';
import { requireControlActor } from '../controllers/controller-store.js';
export const DecisionExpectedSchema = z
  .object({
    workflow: z.number().int().positive(),
    brief: z.number().int().positive(),
    control: z.number().int().positive(),
    authority: z.number().int().positive(),
    budget: z.number().int().positive(),
  })
  .strict();
export type DecisionExpected = z.infer<typeof DecisionExpectedSchema>;
export function assertDecisionActor(
  db: DatabaseSync,
  store: Store,
  actor: SessionIdentity,
  human = false,
) {
  return requireControlActor(store, db, actor, human);
}
export function decisionFence(
  db: DatabaseSync,
  store: Store,
  actor: SessionIdentity,
  workflowId: string,
  expected: DecisionExpected,
): boolean {
  const session = assertDecisionActor(db, store, actor);
  const workflow = db
    .prepare('SELECT * FROM workflow_runs WHERE project_id=? AND id=?')
    .get(store.project.id, workflowId);
  if (!workflow) throw new Error('Workflow not found');
  // Decision snapshots use the project controller grant revision; an unconfigured project has user authority revision 1.
  const controller = db
    .prepare(
      'SELECT id,authority_revision,current_generation FROM controller_definitions WHERE project_id=?',
    )
    .get(store.project.id);
  const authority = controller ? Number(controller.authority_revision) : 1;
  if (
    session.role === 'controller' &&
    (!controller ||
      !db
        .prepare(
          "SELECT 1 FROM controller_incarnations WHERE controller_id=? AND generation=? AND session_id=? AND session_generation=? AND state='active'",
        )
        .get(controller.id, controller.current_generation, actor.id, actor.generation))
  )
    throw new Error('Current managed controller incarnation required');
  const stoppedAncestor = db
    .prepare(
      `WITH RECURSIVE ancestors(id,parent_workflow_id,phase,deadline_at) AS (SELECT id,parent_workflow_id,phase,deadline_at FROM workflow_runs WHERE id=? UNION ALL SELECT w.id,w.parent_workflow_id,w.phase,w.deadline_at FROM workflow_runs w JOIN ancestors a ON w.id=a.parent_workflow_id) SELECT 1 FROM ancestors WHERE phase<>'running' OR deadline_at<=? LIMIT 1`,
    )
    .get(workflowId, new Date().toISOString());
  return (
    !stoppedAncestor &&
    workflow.phase === 'running' &&
    workflow.revision === expected.workflow &&
    workflow.brief_revision === expected.brief &&
    workflow.control_revision === expected.control &&
    workflow.limits_revision === expected.budget &&
    authority === expected.authority &&
    String(workflow.deadline_at) > new Date().toISOString()
  );
}
