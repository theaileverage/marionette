export const coreSql = `
CREATE TABLE hosts (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES hosts(id),
  repository_root TEXT NOT NULL,
  state_directory TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE store_binding (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),
  host_id TEXT NOT NULL REFERENCES hosts(id)
) STRICT;

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  host_id TEXT NOT NULL REFERENCES hosts(id),
  kind TEXT NOT NULL CHECK (kind IN ('isolated', 'existing')),
  path TEXT NOT NULL,
  repository_root TEXT NOT NULL,
  base_commit TEXT,
  access TEXT NOT NULL CHECK (access IN ('inspect', 'write')),
  writes_json TEXT NOT NULL CHECK (json_valid(writes_json)),
  created_at TEXT NOT NULL,
  retired_at TEXT,
  UNIQUE (project_id, id),
  UNIQUE (project_id, host_id, path)
) STRICT;

CREATE TABLE job_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  request_digest TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  created_at TEXT NOT NULL,
  UNIQUE (project_id, id)
) STRICT;

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  stable_key TEXT NOT NULL,
  request_id TEXT NOT NULL REFERENCES job_requests(id),
  current_brief_id TEXT NOT NULL REFERENCES brief_revisions(id) DEFERRABLE INITIALLY DEFERRED,
  current_brief_revision INTEGER NOT NULL CHECK (current_brief_revision >= 1),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  delivery_kind TEXT NOT NULL CHECK (delivery_kind IN ('report', 'patch', 'commit')),
  origin_kind TEXT NOT NULL CHECK (origin_kind IN ('direct', 'workflow')),
  origin_workflow_id TEXT REFERENCES workflow_runs(id) DEFERRABLE INITIALLY DEFERRED,
  origin_step_run_id TEXT REFERENCES step_runs(id) DEFERRABLE INITIALLY DEFERRED,
  state TEXT NOT NULL CHECK (state IN ('open', 'finished', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, stable_key),
  UNIQUE (project_id, id),
  CHECK (
    (origin_kind = 'direct' AND origin_workflow_id IS NULL AND origin_step_run_id IS NULL)
    OR
    (origin_kind = 'workflow' AND origin_workflow_id IS NOT NULL AND origin_step_run_id IS NOT NULL)
  )
) STRICT;

CREATE TABLE brief_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  prior_brief_id TEXT REFERENCES brief_revisions(id),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  change_reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (job_id, revision),
  UNIQUE (project_id, id)
) STRICT;

CREATE TABLE agent_sessions (
  id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  project_id TEXT NOT NULL REFERENCES projects(id),
  host_id TEXT NOT NULL REFERENCES hosts(id),
  workspace_id TEXT REFERENCES workspaces(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'controller', 'worker')),
  token_hash TEXT NOT NULL CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  parent_workflow_id TEXT REFERENCES workflow_runs(id) DEFERRABLE INITIALLY DEFERRED,
  attempt_id TEXT REFERENCES attempts(id) DEFERRABLE INITIALLY DEFERRED,
  native_kind TEXT,
  native_server_generation TEXT,
  native_locator TEXT,
  state TEXT NOT NULL CHECK (state IN ('active', 'settled', 'unconfirmed')),
  created_at TEXT NOT NULL,
  settled_at TEXT,
  PRIMARY KEY (id, generation),
  UNIQUE (project_id, id, generation),
  UNIQUE (project_id, host_id, native_kind, native_server_generation, native_locator)
) STRICT;

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  workflow_id TEXT REFERENCES workflow_runs(id) DEFERRABLE INITIALLY DEFERRED,
  step_run_id TEXT REFERENCES step_runs(id) DEFERRABLE INITIALLY DEFERRED,
  brief_id TEXT NOT NULL REFERENCES brief_revisions(id),
  brief_revision INTEGER NOT NULL CHECK (brief_revision >= 1),
  host_id TEXT NOT NULL REFERENCES hosts(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  session_id TEXT NOT NULL,
  session_generation INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('pending', 'launching', 'running', 'stopping', 'settled', 'unconfirmed', 'closed')),
  native_kind TEXT,
  native_server_generation TEXT,
  native_locator TEXT,
  outcome TEXT CHECK (outcome IN ('succeeded', 'failed', 'interrupted')),
  settlement_reason TEXT,
  created_at TEXT NOT NULL,
  launch_claimed_at TEXT,
  running_at TEXT,
  settled_at TEXT,
  FOREIGN KEY (session_id, session_generation) REFERENCES agent_sessions(id, generation),
  UNIQUE (project_id, id),
  CHECK (
    (workflow_id IS NULL AND step_run_id IS NULL)
    OR
    (workflow_id IS NOT NULL AND step_run_id IS NOT NULL)
  )
) STRICT;

CREATE TABLE execution_reservations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id),
  workflow_id TEXT REFERENCES workflow_runs(id) DEFERRABLE INITIALLY DEFERRED,
  resource_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('held', 'released', 'unconfirmed')),
  created_at TEXT NOT NULL,
  released_at TEXT,
  release_reason TEXT,
  UNIQUE (project_id, resource_key, id)
) STRICT;

CREATE UNIQUE INDEX one_held_execution_reservation
ON execution_reservations(project_id, resource_key)
WHERE state IN ('held', 'unconfirmed');

CREATE TABLE results (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  brief_id TEXT NOT NULL REFERENCES brief_revisions(id),
  brief_revision INTEGER NOT NULL CHECK (brief_revision >= 1),
  host_id TEXT NOT NULL REFERENCES hosts(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  result_kind TEXT NOT NULL CHECK (result_kind IN ('report', 'patch', 'commit')),
  input_digest TEXT NOT NULL,
  workspace_digest TEXT NOT NULL,
  source_repository TEXT,
  base_commit TEXT,
  resulting_tree TEXT,
  resulting_commit TEXT,
  changed_paths_json TEXT NOT NULL CHECK (json_valid(changed_paths_json)),
  artifact_digests_json TEXT NOT NULL CHECK (json_valid(artifact_digests_json)),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  verification_json TEXT NOT NULL CHECK (json_valid(verification_json)),
  created_at TEXT NOT NULL,
  UNIQUE (project_id, id),
  CHECK (
    result_kind = 'report'
    OR (source_repository IS NOT NULL AND base_commit IS NOT NULL AND resulting_tree IS NOT NULL)
  ),
  CHECK (result_kind <> 'commit' OR resulting_commit IS NOT NULL)
) STRICT;

CREATE TABLE result_validity (
  result_id TEXT PRIMARY KEY REFERENCES results(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  state TEXT NOT NULL CHECK (state IN ('eligible', 'stale')),
  stale_by_brief_id TEXT REFERENCES brief_revisions(id),
  reason TEXT,
  updated_at TEXT NOT NULL,
  CHECK (
    (state = 'eligible' AND stale_by_brief_id IS NULL)
    OR
    (state = 'stale' AND stale_by_brief_id IS NOT NULL AND reason IS NOT NULL)
  )
) STRICT;

CREATE TABLE result_acceptances (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  result_id TEXT NOT NULL REFERENCES results(id),
  brief_id TEXT NOT NULL REFERENCES brief_revisions(id),
  decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected')),
  issues_json TEXT NOT NULL CHECK (json_valid(issues_json)),
  retained_observations_json TEXT NOT NULL CHECK (json_valid(retained_observations_json)),
  decided_by_session_id TEXT NOT NULL,
  decided_by_session_generation INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (decided_by_session_id, decided_by_session_generation) REFERENCES agent_sessions(id, generation),
  UNIQUE (result_id, brief_id)
) STRICT;

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  host_id TEXT NOT NULL REFERENCES hosts(id),
  digest TEXT NOT NULL,
  path TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (project_id, digest),
  UNIQUE (project_id, id)
) STRICT;

CREATE TABLE result_artifacts (
  result_id TEXT NOT NULL REFERENCES results(id),
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (result_id, ordinal),
  UNIQUE (result_id, artifact_id)
) STRICT;

CREATE TABLE idempotency_records (
  project_id TEXT NOT NULL REFERENCES projects(id),
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, scope, idempotency_key)
) STRICT;

CREATE TABLE brief_acknowledgements (
  brief_id TEXT NOT NULL REFERENCES brief_revisions(id),
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  session_id TEXT NOT NULL,
  session_generation INTEGER NOT NULL,
  adopted_at TEXT NOT NULL,
  FOREIGN KEY (session_id, session_generation) REFERENCES agent_sessions(id, generation),
  PRIMARY KEY (brief_id, attempt_id)
) STRICT;

CREATE TRIGGER immutable_job_requests_update
BEFORE UPDATE ON job_requests BEGIN SELECT RAISE(ABORT, 'job requests are immutable'); END;
CREATE TRIGGER immutable_job_requests_delete
BEFORE DELETE ON job_requests BEGIN SELECT RAISE(ABORT, 'job requests are immutable'); END;
CREATE TRIGGER immutable_brief_revisions_update
BEFORE UPDATE ON brief_revisions BEGIN SELECT RAISE(ABORT, 'brief revisions are immutable'); END;
CREATE TRIGGER immutable_brief_revisions_delete
BEFORE DELETE ON brief_revisions BEGIN SELECT RAISE(ABORT, 'brief revisions are immutable'); END;
CREATE TRIGGER immutable_results_update
BEFORE UPDATE ON results BEGIN SELECT RAISE(ABORT, 'results are immutable'); END;
CREATE TRIGGER immutable_results_delete
BEFORE DELETE ON results BEGIN SELECT RAISE(ABORT, 'results are immutable'); END;

CREATE INDEX jobs_by_state ON jobs(project_id, state, created_at);
CREATE INDEX attempts_by_workflow_phase ON attempts(project_id, workflow_id, phase);
CREATE INDEX attempts_by_job ON attempts(project_id, job_id, created_at);
CREATE INDEX results_by_job ON results(project_id, job_id, created_at);
`;
