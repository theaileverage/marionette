export const nativeSessionReferencesSql = `
CREATE TABLE native_session_reference_observations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  session_id TEXT NOT NULL,
  session_generation INTEGER NOT NULL CHECK (session_generation >= 1),
  host_id TEXT NOT NULL REFERENCES hosts(id),
  native_kind TEXT NOT NULL,
  native_server_generation TEXT NOT NULL,
  harness TEXT NOT NULL,
  reference_kind TEXT NOT NULL CHECK (reference_kind IN ('id','path','thread','legacy')),
  reference_value TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('confirmed','unconfirmed','legacy-untyped')),
  binding_json TEXT NOT NULL CHECK (json_valid(binding_json)),
  rejection_reason TEXT,
  observed_at TEXT NOT NULL,
  FOREIGN KEY (session_id, session_generation) REFERENCES agent_sessions(id, generation),
  CHECK ((status='unconfirmed' AND rejection_reason IS NOT NULL)
      OR (status<>'unconfirmed' AND rejection_reason IS NULL)),
  UNIQUE (project_id, attempt_id, native_server_generation, harness, reference_kind,
          reference_value, source, status, binding_json)
) STRICT;

INSERT INTO native_session_reference_observations
  (id,project_id,attempt_id,session_id,session_generation,host_id,native_kind,
   native_server_generation,harness,reference_kind,reference_value,source,status,
   binding_json,rejection_reason,observed_at)
SELECT 'legacy-native-session-' || a.id,
       a.project_id,a.id,a.session_id,a.session_generation,a.host_id,a.native_kind,
       a.native_server_generation,'unknown','legacy',
       json_extract(n.identity_json,'$.nativeSession'),'legacy-nativeSession','legacy-untyped',
       json_object(
         'workspaceId',json_extract(n.identity_json,'$.binding.workspaceId'),
         'tabId',json_extract(n.identity_json,'$.tabId'),
         'paneId',json_extract(n.identity_json,'$.paneId'),
         'terminalId',json_extract(n.identity_json,'$.terminalId'),
         'identityRevision',COALESCE(json_extract(n.identity_json,'$.identityRevision'),0)
       ),
       NULL,n.updated_at
FROM native_attempts n
JOIN attempts a ON a.project_id=n.project_id AND a.id=n.attempt_id
WHERE a.native_kind IS NOT NULL
  AND a.native_server_generation IS NOT NULL
  AND json_type(n.identity_json,'$.nativeSession')='text';

CREATE TRIGGER immutable_native_session_reference_observations_update
BEFORE UPDATE ON native_session_reference_observations
BEGIN SELECT RAISE(ABORT, 'native session reference observations are immutable'); END;

CREATE TRIGGER immutable_native_session_reference_observations_delete
BEFORE DELETE ON native_session_reference_observations
BEGIN SELECT RAISE(ABORT, 'native session reference observations are immutable'); END;

CREATE INDEX native_session_references_by_attempt
ON native_session_reference_observations(project_id, attempt_id, observed_at, id);

CREATE VIEW public_native_session_references AS
SELECT id,project_id,attempt_id,session_id,session_generation,host_id,native_kind,
       native_server_generation,harness,reference_kind,reference_value,source,status,
       binding_json,rejection_reason,observed_at
FROM native_session_reference_observations
WHERE project_id=marionette_project_id();
`;
