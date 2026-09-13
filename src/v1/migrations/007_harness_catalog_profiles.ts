export const harnessCatalogProfilesSql = `
CREATE TABLE harness_installations (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
 manifest_json TEXT NOT NULL, manifest_digest TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), authority_revision INTEGER NOT NULL DEFAULT 1, probe_revision INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE harness_endpoints (
 id TEXT PRIMARY KEY, installation_id TEXT NOT NULL REFERENCES harness_installations(id),
 observation_json TEXT NOT NULL, observed_at TEXT NOT NULL
) STRICT;
CREATE TABLE harness_endpoint_observations (
 id INTEGER PRIMARY KEY, endpoint_id TEXT NOT NULL REFERENCES harness_endpoints(id),
 observation_json TEXT NOT NULL, observed_at TEXT NOT NULL
) STRICT;
CREATE TABLE harness_profiles (
 id TEXT NOT NULL, revision INTEGER NOT NULL, profile_json TEXT NOT NULL,
 PRIMARY KEY(id, revision)
) STRICT;
CREATE TABLE harness_routing_policies (
 id TEXT NOT NULL, revision INTEGER NOT NULL, policy_json TEXT NOT NULL,
 PRIMARY KEY(id, revision)
) STRICT;
CREATE TABLE harness_route_decisions (
 id TEXT PRIMARY KEY, policy_id TEXT NOT NULL, policy_revision INTEGER NOT NULL,
 requirement_json TEXT NOT NULL, decision_json TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE harness_admission_snapshots (
 id INTEGER PRIMARY KEY, route_id TEXT NOT NULL REFERENCES harness_route_decisions(id),
 snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE harness_attempt_routes (
 attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),
 route_id TEXT NOT NULL REFERENCES harness_route_decisions(id),
 snapshot_json TEXT NOT NULL
) STRICT;
CREATE TABLE harness_legacy_settings (
 key TEXT PRIMARY KEY, revision INTEGER NOT NULL, value_json TEXT NOT NULL
) STRICT;
INSERT INTO harness_legacy_settings SELECT key, revision, value_json FROM project_settings
 WHERE key LIKE 'native/%' OR key LIKE 'profile/%';
INSERT INTO harness_installations(id,project_id,manifest_json,manifest_digest)
 SELECT 'legacy/' || key, project_id,
 json_object('id','legacy/' || key,'provider',json_object('id','herdr','version',1),'source',json_object('kind','builtin')),
 'legacy-unverified'
 FROM project_settings WHERE key LIKE 'native/%';
INSERT INTO harness_endpoints(id,installation_id,observation_json,observed_at)
 SELECT 'legacy/' || key, 'legacy/' || key,
 json_object('id','legacy/' || key,'hostId',coalesce(json_extract(value_json,'$.hostId'),'unconfirmed'),
 'locator',json_object('binding',value_json),'nativeVersion','unconfirmed',
 'contract',json_object('id','herdr','version',1),'generation','legacy-unconfirmed',
 'methods',json('[]'),'capabilities',json('[]'),'models',json('[]'),'health','unconfirmed'),
 '1970-01-01T00:00:00.000Z'
 FROM project_settings WHERE key LIKE 'native/%';
INSERT INTO harness_profiles(id,revision,profile_json)
 SELECT substr(key,9), revision, json_object('legacy',json(value_json),'enabled',json('false'))
 FROM project_settings WHERE key LIKE 'profile/%';
`;
