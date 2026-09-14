export const workflowsSql = `
CREATE TABLE workflow_packages (
  project_id TEXT NOT NULL REFERENCES projects(id),
  digest TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, digest)
) STRICT;

CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  package_digest TEXT NOT NULL,
  parent_workflow_id TEXT REFERENCES workflow_runs(id),
  root_job_id TEXT NOT NULL REFERENCES jobs(id) DEFERRABLE INITIALLY DEFERRED,
  current_step_run_id TEXT NOT NULL REFERENCES step_runs(id) DEFERRABLE INITIALLY DEFERRED,
  phase TEXT NOT NULL CHECK (phase IN ('running', 'pausing', 'paused', 'cancelling', 'cancelled', 'finished')),
  outcome TEXT CHECK (outcome IN ('succeeded', 'failed')),
  execution_boundary TEXT NOT NULL CHECK (execution_boundary IN ('all', 'design-only')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  brief_revision INTEGER NOT NULL CHECK (brief_revision >= 1),
  control_revision INTEGER NOT NULL CHECK (control_revision >= 1),
  limits_revision INTEGER NOT NULL CHECK (limits_revision >= 1),
  max_attempts INTEGER NOT NULL CHECK (max_attempts >= 1),
  max_repeats INTEGER NOT NULL CHECK (max_repeats >= 1),
  parallelism INTEGER NOT NULL CHECK (parallelism >= 1),
  inner_loop_deadline_ms INTEGER NOT NULL CHECK (inner_loop_deadline_ms >= 1),
  deadline_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id, package_digest) REFERENCES workflow_packages(project_id, digest),
  UNIQUE (project_id, id)
) STRICT;

CREATE TABLE step_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  workflow_id TEXT NOT NULL REFERENCES workflow_runs(id),
  job_id TEXT REFERENCES jobs(id),
  step_name TEXT NOT NULL,
  step_phase TEXT NOT NULL CHECK (step_phase IN ('analysis', 'design', 'implementation', 'review', 'verification', 'coordination')),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  phase TEXT NOT NULL CHECK (phase IN ('pending', 'active', 'blocked', 'awaiting-decision', 'succeeded', 'failed', 'stale', 'closed')),
  input_workflow_revision INTEGER NOT NULL CHECK (input_workflow_revision >= 1),
  input_brief_revision INTEGER NOT NULL CHECK (input_brief_revision >= 1),
  source_transition_request_id TEXT REFERENCES transition_requests(id) DEFERRABLE INITIALLY DEFERRED,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workflow_id, ordinal),
  UNIQUE (project_id, id)
) STRICT;

CREATE TABLE job_dependencies (
  job_id TEXT NOT NULL REFERENCES jobs(id),
  depends_on_job_id TEXT NOT NULL REFERENCES jobs(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, depends_on_job_id),
  CHECK (job_id <> depends_on_job_id)
) STRICT;

CREATE TABLE step_run_inputs (
  step_run_id TEXT NOT NULL REFERENCES step_runs(id),
  brief_id TEXT NOT NULL REFERENCES brief_revisions(id),
  result_id TEXT REFERENCES results(id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (step_run_id, ordinal)
) STRICT;

CREATE TABLE attempt_input_results (
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  result_id TEXT NOT NULL REFERENCES results(id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (attempt_id, ordinal),
  UNIQUE (attempt_id, result_id)
) STRICT;

CREATE TABLE result_dependencies (
  result_id TEXT NOT NULL REFERENCES results(id),
  upstream_result_id TEXT NOT NULL REFERENCES results(id),
  PRIMARY KEY (result_id, upstream_result_id),
  CHECK (result_id <> upstream_result_id)
) STRICT;

CREATE TABLE transition_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  workflow_id TEXT NOT NULL REFERENCES workflow_runs(id),
  source_step_run_id TEXT NOT NULL REFERENCES step_runs(id),
  kind TEXT NOT NULL CHECK (kind IN ('advance', 'repeat', 'route', 'await-decision', 'block', 'finish')),
  expected_workflow_revision INTEGER NOT NULL CHECK (expected_workflow_revision >= 1),
  expected_brief_revision INTEGER NOT NULL CHECK (expected_brief_revision >= 1),
  expected_control_revision INTEGER NOT NULL CHECK (expected_control_revision >= 1),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_digest TEXT NOT NULL,
  created_step_run_id TEXT REFERENCES step_runs(id) DEFERRABLE INITIALLY DEFERRED,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, id)
) STRICT;

CREATE TABLE control_intents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  workflow_id TEXT NOT NULL REFERENCES workflow_runs(id),
  kind TEXT NOT NULL CHECK (kind IN ('pause', 'cancel')),
  pause_mode TEXT CHECK (pause_mode IN ('drain', 'safe', 'now')),
  control_revision INTEGER NOT NULL CHECK (control_revision >= 1),
  payload_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK ((kind = 'pause' AND pause_mode IS NOT NULL) OR (kind = 'cancel' AND pause_mode IS NULL)),
  UNIQUE (project_id, id)
) STRICT;

CREATE TABLE control_workflows (
  control_intent_id TEXT NOT NULL REFERENCES control_intents(id),
  workflow_id TEXT NOT NULL REFERENCES workflow_runs(id),
  PRIMARY KEY (control_intent_id, workflow_id)
) STRICT;

CREATE TABLE attempt_control_intents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  cause_kind TEXT NOT NULL CHECK (cause_kind IN ('workflow-control', 'brief-revision')),
  cause_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('drain', 'safe', 'now', 'cancel', 'supersede')),
  state TEXT NOT NULL CHECK (state IN ('requested', 'confirmed', 'unconfirmed')),
  created_at TEXT NOT NULL,
  settled_at TEXT,
  UNIQUE (attempt_id, cause_kind, cause_id)
) STRICT;

CREATE TABLE limit_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  workflow_id TEXT NOT NULL REFERENCES workflow_runs(id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  max_attempts INTEGER NOT NULL CHECK (max_attempts >= 1),
  max_repeats INTEGER NOT NULL CHECK (max_repeats >= 1),
  parallelism INTEGER NOT NULL CHECK (parallelism >= 1),
  inner_loop_deadline_ms INTEGER NOT NULL CHECK (inner_loop_deadline_ms >= 1),
  deadline_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  authorized_by_session_id TEXT NOT NULL,
  authorized_by_session_generation INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (authorized_by_session_id, authorized_by_session_generation) REFERENCES agent_sessions(id, generation),
  UNIQUE (workflow_id, revision)
) STRICT;

CREATE TABLE brief_impacts (
  brief_id TEXT NOT NULL REFERENCES brief_revisions(id),
  affected_job_id TEXT NOT NULL REFERENCES jobs(id),
  PRIMARY KEY (brief_id, affected_job_id)
) STRICT;

CREATE TABLE native_approvals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  session_id TEXT NOT NULL,
  session_generation INTEGER NOT NULL,
  operation TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'forwarded', 'resolved', 'obsolete', 'unconfirmed', 'manual-required')),
  expected_brief_revision INTEGER NOT NULL CHECK (expected_brief_revision >= 1),
  expected_control_revision INTEGER NOT NULL CHECK (expected_control_revision >= 1),
  expected_native_server_generation TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id, session_generation) REFERENCES agent_sessions(id, generation),
  UNIQUE (project_id, attempt_id, operation, expected_native_server_generation)
) STRICT;

CREATE TRIGGER immutable_transition_requests_update
BEFORE UPDATE ON transition_requests BEGIN SELECT RAISE(ABORT, 'transition requests are immutable'); END;
CREATE TRIGGER immutable_transition_requests_delete
BEFORE DELETE ON transition_requests BEGIN SELECT RAISE(ABORT, 'transition requests are immutable'); END;
CREATE TRIGGER immutable_control_intents_update
BEFORE UPDATE ON control_intents BEGIN SELECT RAISE(ABORT, 'control intents are immutable'); END;
CREATE TRIGGER immutable_control_intents_delete
BEFORE DELETE ON control_intents BEGIN SELECT RAISE(ABORT, 'control intents are immutable'); END;
CREATE TRIGGER immutable_limit_revisions_update
BEFORE UPDATE ON limit_revisions BEGIN SELECT RAISE(ABORT, 'limit revisions are immutable'); END;
CREATE TRIGGER immutable_limit_revisions_delete
BEFORE DELETE ON limit_revisions BEGIN SELECT RAISE(ABORT, 'limit revisions are immutable'); END;

CREATE INDEX workflow_children ON workflow_runs(project_id, parent_workflow_id);
CREATE INDEX workflow_phase ON workflow_runs(project_id, phase, updated_at);
CREATE INDEX step_runs_by_workflow ON step_runs(workflow_id, ordinal);
CREATE INDEX job_dependencies_reverse ON job_dependencies(depends_on_job_id, job_id);
CREATE INDEX attempt_controls_by_state ON attempt_control_intents(project_id, state, created_at);
CREATE INDEX approvals_by_state ON native_approvals(project_id, state, created_at);
`;
