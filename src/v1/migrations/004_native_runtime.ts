export const nativeRuntimeSql = `
ALTER TABLE results ADD COLUMN report_text TEXT;
CREATE TRIGGER result_report_content_insert
BEFORE INSERT ON results
WHEN (NEW.result_kind='report' AND (NEW.report_text IS NULL OR length(trim(NEW.report_text))=0))
  OR (NEW.result_kind<>'report' AND NEW.report_text IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'report content must match result kind'); END;

DROP VIEW public_results;
CREATE VIEW public_results AS
SELECT id,project_id,job_id,attempt_id,brief_revision,host_id,workspace_id,
       result_kind,input_digest,workspace_digest,source_repository,base_commit,
       resulting_tree,resulting_commit,changed_paths_json,artifact_digests_json,
       evidence_claims_json,evidence_json,verification_json,report_text,created_at
FROM results WHERE project_id=marionette_project_id();

CREATE TABLE workflow_package_resources (
  project_id TEXT NOT NULL,
  package_digest TEXT NOT NULL,
  resource_name TEXT NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  path TEXT NOT NULL,
  PRIMARY KEY(project_id,package_digest,resource_name),
  FOREIGN KEY(project_id,package_digest) REFERENCES workflow_packages(project_id,digest)
) STRICT;

CREATE TABLE native_attempts (
  attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  binding_json TEXT NOT NULL CHECK (json_valid(binding_json)),
  profile_json TEXT NOT NULL CHECK (json_valid(profile_json)),
  context_path TEXT NOT NULL,
  expected_control_revision INTEGER,
  phase TEXT NOT NULL CHECK (phase IN ('admitted','launch-claimed','launched','prompt-claimed','active','settled','unconfirmed')),
  identity_json TEXT CHECK (identity_json IS NULL OR json_valid(identity_json)),
  launch_result_json TEXT CHECK (launch_result_json IS NULL OR json_valid(launch_result_json)),
  observed_working INTEGER NOT NULL DEFAULT 0 CHECK (observed_working IN (0,1)),
  last_observation_json TEXT CHECK (last_observation_json IS NULL OR json_valid(last_observation_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE native_effects (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  effect_kind TEXT NOT NULL,
  effect_json TEXT NOT NULL CHECK (json_valid(effect_json)),
  created_at TEXT NOT NULL,
  UNIQUE (attempt_id, effect_kind)
) STRICT;

CREATE INDEX native_attempts_by_phase ON native_attempts(project_id, phase);
`;
