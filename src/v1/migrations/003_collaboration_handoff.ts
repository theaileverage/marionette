export const collaborationHandoffSql = `
CREATE TABLE board_threads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  job_id TEXT REFERENCES jobs(id),
  title TEXT NOT NULL,
  source_author_kind TEXT NOT NULL CHECK (source_author_kind IN ('user', 'session', 'system')),
  source_author_id TEXT NOT NULL,
  source_author_generation INTEGER,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, source_author_kind, source_author_id, idempotency_key),
  UNIQUE (project_id, id)
) STRICT;

CREATE TABLE board_posts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  thread_id TEXT NOT NULL REFERENCES board_threads(id),
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  source_author_kind TEXT NOT NULL CHECK (source_author_kind IN ('user', 'session', 'system')),
  source_author_id TEXT NOT NULL,
  source_author_generation INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('question', 'blocker', 'result', 'finding', 'decision', 'progress')),
  body TEXT NOT NULL,
  reply_to_post_id TEXT REFERENCES board_posts(id),
  replaces_post_id TEXT REFERENCES board_posts(id),
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (thread_id, sequence),
  UNIQUE (project_id, source_author_kind, source_author_id, idempotency_key),
  UNIQUE (project_id, id)
) STRICT;

CREATE TABLE board_post_refs (
  post_id TEXT NOT NULL REFERENCES board_posts(id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  ref_kind TEXT NOT NULL,
  ref_value TEXT NOT NULL,
  PRIMARY KEY (post_id, ordinal)
) STRICT;

CREATE TABLE board_subscriptions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  subscriber_kind TEXT NOT NULL CHECK (subscriber_kind IN ('session', 'user', 'desktop')),
  subscriber_id TEXT NOT NULL,
  subscriber_generation INTEGER,
  thread_id TEXT REFERENCES board_threads(id),
  event_kinds_json TEXT NOT NULL CHECK (json_valid(event_kinds_json)),
  created_at TEXT NOT NULL,
  deactivated_at TEXT,
  UNIQUE (project_id, subscriber_kind, subscriber_id, subscriber_generation, thread_id),
  UNIQUE (project_id, id)
) STRICT;

CREATE TABLE board_read_cursors (
  project_id TEXT NOT NULL REFERENCES projects(id),
  reader_kind TEXT NOT NULL CHECK (reader_kind IN ('session', 'user', 'desktop')),
  reader_id TEXT NOT NULL,
  reader_generation INTEGER NOT NULL DEFAULT 0,
  thread_id TEXT NOT NULL REFERENCES board_threads(id),
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, reader_kind, reader_id, reader_generation, thread_id)
) STRICT;

CREATE TABLE notification_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  post_id TEXT NOT NULL REFERENCES board_posts(id),
  subscription_id TEXT NOT NULL REFERENCES board_subscriptions(id),
  event_kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (post_id, subscription_id, event_kind),
  UNIQUE (project_id, id)
) STRICT;

CREATE TABLE watcher_owners (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  generation TEXT NOT NULL,
  process_identity TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  settled_at TEXT
) STRICT;

CREATE TABLE notification_deliveries (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE REFERENCES notification_events(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('session', 'user', 'desktop')),
  recipient_id TEXT NOT NULL,
  recipient_generation INTEGER,
  state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'acknowledged', 'unconfirmed')),
  claim_revision INTEGER NOT NULL DEFAULT 0 CHECK (claim_revision >= 0),
  owner_generation TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  claimed_at TEXT,
  attempted_at TEXT,
  acknowledged_at TEXT,
  unconfirmed_at TEXT,
  last_error TEXT,
  UNIQUE (project_id, id)
) STRICT;

CREATE TABLE handoffs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  result_id TEXT NOT NULL REFERENCES results(id),
  consumer_kind TEXT NOT NULL CHECK (consumer_kind IN ('session', 'job', 'workflow', 'user')),
  consumer_id TEXT NOT NULL,
  target_host_id TEXT NOT NULL REFERENCES hosts(id),
  target_workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  expected_target_state_json TEXT NOT NULL CHECK (json_valid(expected_target_state_json)),
  state TEXT NOT NULL CHECK (state IN ('pending', 'integrating', 'integrated', 'conflict', 'unconfirmed', 'retained', 'abandoned')),
  claim_revision INTEGER NOT NULL DEFAULT 0 CHECK (claim_revision >= 0),
  claimed_attempt_id TEXT REFERENCES attempts(id),
  current_claim_id TEXT REFERENCES handoff_claims(id) DEFERRABLE INITIALLY DEFERRED,
  actual_target_state_json TEXT CHECK (actual_target_state_json IS NULL OR json_valid(actual_target_state_json)),
  checks_json TEXT CHECK (checks_json IS NULL OR json_valid(checks_json)),
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, id)
) STRICT;

CREATE TABLE handoff_claims (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  handoff_id TEXT NOT NULL REFERENCES handoffs(id),
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  claim_revision INTEGER NOT NULL CHECK (claim_revision >= 1),
  state TEXT NOT NULL CHECK (state IN ('active', 'settled', 'unconfirmed')),
  created_at TEXT NOT NULL,
  settled_at TEXT,
  UNIQUE (handoff_id, claim_revision),
  UNIQUE (project_id, id)
) STRICT;

CREATE TABLE writer_reservations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  target_workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  handoff_id TEXT NOT NULL REFERENCES handoffs(id),
  claim_id TEXT NOT NULL REFERENCES handoff_claims(id),
  owner_attempt_id TEXT NOT NULL REFERENCES attempts(id),
  state TEXT NOT NULL CHECK (state IN ('held', 'released', 'unconfirmed')),
  created_at TEXT NOT NULL,
  released_at TEXT,
  release_reason TEXT,
  UNIQUE (project_id, id)
) STRICT;

CREATE UNIQUE INDEX one_held_writer_reservation
ON writer_reservations(project_id, target_workspace_id)
WHERE state IN ('held', 'unconfirmed');

CREATE TABLE workspace_retirements (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  expected_host_id TEXT NOT NULL REFERENCES hosts(id),
  expected_path TEXT NOT NULL,
  expected_workspace_created_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'native-closing', 'worktree-removing', 'completed', 'unconfirmed', 'blocked')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  last_error TEXT,
  UNIQUE (project_id, workspace_id, idempotency_key),
  UNIQUE (project_id, id)
) STRICT;

CREATE UNIQUE INDEX one_active_workspace_retirement
ON workspace_retirements(project_id, workspace_id)
WHERE state <> 'completed';

CREATE VIEW public_agent_sessions AS
SELECT id, generation, project_id, host_id, workspace_id, role, execution_role, native_kind,
       native_server_generation, native_locator, state, created_at, settled_at
FROM agent_sessions
WHERE project_id = marionette_project_id();

CREATE VIEW public_board_threads AS
SELECT id, project_id, job_id, title, source_author_kind, source_author_id,
       source_author_generation, created_at
FROM board_threads
WHERE project_id = marionette_project_id();

CREATE VIEW public_board_posts AS
SELECT id, project_id, thread_id, sequence, source_author_kind, source_author_id,
       source_author_generation, kind, body, reply_to_post_id, replaces_post_id, created_at
FROM board_posts
WHERE project_id = marionette_project_id();

CREATE VIEW public_jobs AS
SELECT id, project_id, stable_key, current_brief_revision, workspace_id,
       delivery_kind, origin_kind, origin_workflow_id, origin_step_run_id, state,
       created_at, updated_at
FROM jobs
WHERE project_id = marionette_project_id();

CREATE VIEW public_results AS
SELECT id, project_id, job_id, attempt_id, brief_revision, host_id, workspace_id,
       result_kind, input_digest, workspace_digest, source_repository, base_commit,
       resulting_tree, resulting_commit, changed_paths_json, artifact_digests_json,
       evidence_claims_json, evidence_json, verification_json, created_at
FROM results
WHERE project_id = marionette_project_id();

CREATE VIEW public_notification_events AS
SELECT id, project_id, post_id, subscription_id, event_kind, created_at
FROM notification_events
WHERE project_id = marionette_project_id();

CREATE INDEX board_posts_by_thread ON board_posts(project_id, thread_id, sequence);
CREATE INDEX subscriptions_by_project ON board_subscriptions(project_id, deactivated_at, created_at);
CREATE INDEX notification_events_by_project ON notification_events(project_id, created_at, id);
CREATE INDEX notification_deliveries_by_state ON notification_deliveries(project_id, state, claimed_at);
CREATE INDEX handoffs_by_state ON handoffs(project_id, state, updated_at);
`;
