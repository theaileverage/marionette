import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { StoreError, type Store } from '../store.js';
import {
  WorkflowIdSchema,
  StepRunIdSchema,
  type AttemptId,
  type WorkflowId,
  type StepRunId,
} from '../model.js';

export function dueSchedules(store: Store) {
  return store.read((db) =>
    db
      .prepare(
        `SELECT s.* FROM workflow_schedule_intents s JOIN workflow_runs w ON w.id=s.workflow_id
 WHERE s.project_id=? AND s.state='pending' AND w.activated=1 AND w.phase='running' AND w.revision=s.workflow_revision
 AND w.control_revision=s.control_revision AND w.brief_revision=s.brief_revision AND w.limits_revision=s.limits_revision ORDER BY s.created_at,s.id`,
      )
      .all(store.project.id)
      .map((row) =>
        z
          .object({
            id: z.string(),
            workflow_id: WorkflowIdSchema,
            step_run_id: StepRunIdSchema,
            workflow_revision: z.number(),
            brief_revision: z.number(),
            control_revision: z.number(),
            limits_revision: z.number(),
          })
          .parse(row),
      ),
  );
}
/** Called inside admission before workflow revision increments. No adapter invocation here. */
export function recordWorkflowAdmission(
  db: DatabaseSync,
  store: Store,
  workflowId: WorkflowId,
  stepId: StepRunId,
  attemptId: AttemptId,
  now: string,
) {
  const w = db.prepare('SELECT activated,revision FROM workflow_runs WHERE id=?').get(workflowId);
  if (w?.activated === 1) {
    const intent = db
      .prepare(
        "SELECT id FROM workflow_schedule_intents WHERE workflow_id=? AND step_run_id=? AND workflow_revision=? AND state='pending'",
      )
      .get(workflowId, stepId, w.revision);
    if (!intent)
      throw new StoreError('stale-revision', 'Activated workflow has no current pending schedule');
    db.prepare("UPDATE workflow_schedule_intents SET state='admitted',attempt_id=? WHERE id=?").run(
      attemptId,
      intent.id,
    );
  }
  const ancestors = db
    .prepare(
      `WITH RECURSIVE a(id,parent_workflow_id,limits_revision,inner_loop_deadline_ms,deadline_at,phase) AS (SELECT id,parent_workflow_id,limits_revision,inner_loop_deadline_ms,deadline_at,phase FROM workflow_runs WHERE id=? UNION ALL SELECT w.id,w.parent_workflow_id,w.limits_revision,w.inner_loop_deadline_ms,w.deadline_at,w.phase FROM workflow_runs w JOIN a ON a.parent_workflow_id=w.id) SELECT * FROM a`,
    )
    .all(workflowId);
  let deadline = Infinity;
  for (const a of ancestors) {
    if (a.phase !== 'running') throw new StoreError('stale-revision', 'Ancestor is stopped');
    deadline = Math.min(
      deadline,
      new Date(String(a.deadline_at)).getTime(),
      new Date(now).getTime() + Number(a.inner_loop_deadline_ms),
    );
    db.prepare('INSERT INTO workflow_budget_ledger VALUES(?,?,?,?,?)').run(
      attemptId,
      a.id,
      a.limits_revision,
      1,
      now,
    );
  }
  db.prepare("INSERT INTO workflow_attempt_deadlines VALUES(?,?,'pending')").run(
    attemptId,
    new Date(deadline).toISOString(),
  );
}
/** Deadline expiry records a control request; expiry never claims native settlement. */
export function requestExpiredDeadlines(store: Store, now: string): number {
  return store.transaction((db) => {
    const rows = db
      .prepare(
        `SELECT d.attempt_id FROM workflow_attempt_deadlines d JOIN attempts a ON a.id=d.attempt_id WHERE a.project_id=? AND d.state='pending' AND d.deadline_at<=? AND a.phase IN ('launching','running','stopping','unconfirmed')`,
      )
      .all(store.project.id, now);
    for (const row of rows) {
      db.prepare(
        `INSERT OR IGNORE INTO attempt_control_intents(id,project_id,attempt_id,cause_kind,cause_id,operation,state,created_at,settled_at) VALUES(?,?,?,'workflow-control',?,'now','requested',?,NULL)`,
      ).run(
        `deadline_${String(row.attempt_id)}`,
        store.project.id,
        row.attempt_id,
        `deadline_${String(row.attempt_id)}`,
        now,
      );
      db.prepare("UPDATE workflow_attempt_deadlines SET state='requested' WHERE attempt_id=?").run(
        row.attempt_id,
      );
    }
    return rows.length;
  });
}
