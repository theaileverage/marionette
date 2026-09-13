export const workflowControlPlaneSql = `
ALTER TABLE workflow_runs ADD COLUMN activated INTEGER NOT NULL DEFAULT 0 CHECK(activated IN (0,1));
ALTER TABLE control_workflows ADD COLUMN expected_control_revision INTEGER;
CREATE TABLE workflow_schedule_intents (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), workflow_id TEXT NOT NULL REFERENCES workflow_runs(id),
 step_run_id TEXT NOT NULL REFERENCES step_runs(id), workflow_revision INTEGER NOT NULL, brief_revision INTEGER NOT NULL,
 control_revision INTEGER NOT NULL, limits_revision INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','admitted','superseded')),
 attempt_id TEXT REFERENCES attempts(id), created_at TEXT NOT NULL, UNIQUE(workflow_id,step_run_id,workflow_revision)
) STRICT;
CREATE TABLE workflow_transition_decisions (
 request_id TEXT PRIMARY KEY REFERENCES transition_requests(id), project_id TEXT NOT NULL REFERENCES projects(id),
 workflow_revision INTEGER NOT NULL, actor_id TEXT NOT NULL, actor_generation INTEGER NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE workflow_repair_cycles (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), workflow_id TEXT NOT NULL REFERENCES workflow_runs(id),
 request_id TEXT NOT NULL UNIQUE REFERENCES transition_requests(id), issue_result_ids_json TEXT NOT NULL CHECK(json_valid(issue_result_ids_json)),
 target_step_run_id TEXT NOT NULL REFERENCES step_runs(id), created_at TEXT NOT NULL
) STRICT;
CREATE TABLE workflow_brief_revision_causes (
 brief_id TEXT PRIMARY KEY REFERENCES brief_revisions(id), actor_id TEXT NOT NULL, actor_generation INTEGER NOT NULL,
 cause TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE workflow_attempt_deadlines (
 attempt_id TEXT PRIMARY KEY REFERENCES attempts(id), deadline_at TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','requested','settled'))
) STRICT;
CREATE TABLE workflow_budget_ledger (
 attempt_id TEXT NOT NULL REFERENCES attempts(id), workflow_id TEXT NOT NULL REFERENCES workflow_runs(id),
 limits_revision INTEGER NOT NULL, units INTEGER NOT NULL CHECK(units=1), created_at TEXT NOT NULL,
 PRIMARY KEY(attempt_id,workflow_id)
) STRICT;
CREATE TRIGGER workflow_budget_immutable_update BEFORE UPDATE ON workflow_budget_ledger BEGIN SELECT RAISE(ABORT,'budget debit immutable'); END;
CREATE TRIGGER workflow_budget_immutable_delete BEFORE DELETE ON workflow_budget_ledger BEGIN SELECT RAISE(ABORT,'budget debit immutable'); END;
CREATE INDEX workflow_schedule_due ON workflow_schedule_intents(project_id,state,created_at);
CREATE INDEX workflow_deadline_due ON workflow_attempt_deadlines(state,deadline_at);
CREATE TRIGGER workflow_decisions_immutable_update BEFORE UPDATE ON workflow_transition_decisions BEGIN SELECT RAISE(ABORT,'workflow decisions immutable'); END;
CREATE TRIGGER workflow_decisions_immutable_delete BEFORE DELETE ON workflow_transition_decisions BEGIN SELECT RAISE(ABORT,'workflow decisions immutable'); END;
CREATE TRIGGER workflow_schedule_admission_fence BEFORE UPDATE OF state ON workflow_schedule_intents
WHEN NEW.state='admitted' AND NOT EXISTS (
 SELECT 1 FROM workflow_runs w WHERE w.id=NEW.workflow_id AND w.project_id=NEW.project_id AND w.activated=1 AND w.phase='running'
 AND w.revision=NEW.workflow_revision AND w.brief_revision=NEW.brief_revision AND w.control_revision=NEW.control_revision AND w.limits_revision=NEW.limits_revision
) BEGIN SELECT RAISE(ABORT,'stale schedule admission'); END;
`;
