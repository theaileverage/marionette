export const decisionsApprovalsSql = `
CREATE TABLE human_decision_requests (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
 workflow_id TEXT NOT NULL REFERENCES workflow_runs(id), artifact_result_id TEXT REFERENCES results(id),
 question TEXT NOT NULL, options_json TEXT NOT NULL CHECK(json_valid(options_json)),
 expected_json TEXT NOT NULL CHECK(json_valid(expected_json)),
 state TEXT NOT NULL CHECK(state IN ('pending','resolved','obsolete','cancelled')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE human_decision_resolutions (
 id TEXT PRIMARY KEY, decision_id TEXT NOT NULL UNIQUE REFERENCES human_decision_requests(id),
 option_id TEXT NOT NULL, effects_json TEXT NOT NULL CHECK(json_valid(effects_json)),
 actor_id TEXT NOT NULL, actor_generation INTEGER NOT NULL, workflow_revision INTEGER NOT NULL,
 created_at TEXT NOT NULL, FOREIGN KEY(actor_id,actor_generation) REFERENCES agent_sessions(id,generation)
) STRICT;
CREATE TABLE exact_native_approvals (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
 attempt_id TEXT NOT NULL REFERENCES attempts(id), workflow_id TEXT NOT NULL REFERENCES workflow_runs(id),
 session_id TEXT NOT NULL, session_generation INTEGER NOT NULL,
 operation_id TEXT NOT NULL, operation_fingerprint TEXT NOT NULL, server_generation TEXT NOT NULL,
 display_json TEXT NOT NULL CHECK(json_valid(display_json)), expected_json TEXT NOT NULL CHECK(json_valid(expected_json)),
 state TEXT NOT NULL CHECK(state IN ('pending','forwarding','forwarded','resolved','rejected','obsolete','unconfirmed','manual-required')),
 claim_id TEXT UNIQUE, action TEXT CHECK(action IN ('approve','reject')), receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
 evidence_json TEXT CHECK(evidence_json IS NULL OR json_valid(evidence_json)), reason TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 FOREIGN KEY(session_id,session_generation) REFERENCES agent_sessions(id,generation),
 UNIQUE(attempt_id,operation_id,operation_fingerprint,server_generation)
) STRICT;
UPDATE native_approvals SET state='manual-required' WHERE state='pending';
CREATE TRIGGER exact_approval_identity_immutable BEFORE UPDATE OF project_id,attempt_id,workflow_id,session_id,session_generation,operation_id,operation_fingerprint,server_generation,display_json,expected_json ON exact_native_approvals
 BEGIN SELECT RAISE(ABORT,'approval identity and authority snapshot are immutable'); END;
CREATE TRIGGER human_decision_request_immutable BEFORE UPDATE OF project_id,workflow_id,artifact_result_id,question,options_json,expected_json ON human_decision_requests
 BEGIN SELECT RAISE(ABORT,'human decision request is immutable'); END;
CREATE INDEX human_decisions_pending ON human_decision_requests(project_id,state,created_at);
CREATE INDEX exact_approvals_pending ON exact_native_approvals(project_id,state,created_at);
CREATE TRIGGER immutable_human_resolution_update BEFORE UPDATE ON human_decision_resolutions
 BEGIN SELECT RAISE(ABORT,'human resolutions are immutable'); END;
CREATE TRIGGER immutable_human_resolution_delete BEFORE DELETE ON human_decision_resolutions
 BEGIN SELECT RAISE(ABORT,'human resolutions are immutable'); END;
`;
