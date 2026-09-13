export const projectHierarchySql = `
CREATE TABLE project_hierarchy_budget (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL,
 capacity INTEGER NOT NULL CHECK(capacity>=0), allocated INTEGER NOT NULL DEFAULT 0 CHECK(allocated>=0),
 reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved>=0), consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed>=0),
 CHECK(allocated+reserved+consumed<=capacity)
) STRICT;
CREATE TABLE project_links (
 id TEXT PRIMARY KEY, side TEXT NOT NULL CHECK(side IN ('parent','child')),
 parent_project_id TEXT NOT NULL, child_project_id TEXT NOT NULL, host_id TEXT NOT NULL,
 root_project_id TEXT NOT NULL, ancestry_json TEXT NOT NULL, principal_json TEXT NOT NULL,
 child_actor_json TEXT NOT NULL, secret TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('proposed','active','paused','revoked','unconfirmed')),
 authority_revision INTEGER NOT NULL, budget_revision INTEGER NOT NULL,
 budget_attempts INTEGER NOT NULL CHECK(budget_attempts>=0), grant_json TEXT NOT NULL,
 next_sequence INTEGER NOT NULL DEFAULT 1, received_sequence INTEGER NOT NULL DEFAULT 0,
 CHECK(parent_project_id<>child_project_id)
) STRICT;
CREATE UNIQUE INDEX project_one_parent ON project_links(side) WHERE side='child';
CREATE TABLE project_link_grants (
 link_id TEXT NOT NULL REFERENCES project_links(id), revision INTEGER NOT NULL,
 principal_json TEXT NOT NULL CHECK(json_valid(principal_json)),
 grant_json TEXT NOT NULL CHECK(json_valid(grant_json)), created_at TEXT NOT NULL, PRIMARY KEY(link_id,revision)
) STRICT;
CREATE TRIGGER project_link_grants_immutable_update BEFORE UPDATE ON project_link_grants
BEGIN SELECT RAISE(ABORT,'project link grants are immutable'); END;
CREATE TRIGGER project_link_grants_immutable_delete BEFORE DELETE ON project_link_grants
BEGIN SELECT RAISE(ABORT,'project link grants are immutable'); END;
CREATE TABLE project_link_allocations (
 link_id TEXT NOT NULL REFERENCES project_links(id), revision INTEGER NOT NULL,
 attempts INTEGER NOT NULL CHECK(attempts>=0),
 consumed_attempts INTEGER NOT NULL DEFAULT 0 CHECK(consumed_attempts>=0 AND consumed_attempts<=attempts),
 state TEXT NOT NULL CHECK(state IN ('active','settled')),
 created_at TEXT NOT NULL, settled_at TEXT,
 PRIMARY KEY(link_id,revision),
 CHECK((state='active' AND settled_at IS NULL) OR (state='settled' AND settled_at IS NOT NULL))
) STRICT;
CREATE TRIGGER project_link_allocations_immutable_update BEFORE UPDATE ON project_link_allocations
BEGIN SELECT RAISE(ABORT,'project link allocations are immutable'); END;
CREATE TRIGGER project_link_allocations_immutable_delete BEFORE DELETE ON project_link_allocations
BEGIN SELECT RAISE(ABORT,'project link allocations are immutable'); END;
CREATE TABLE project_message_outbox (
 link_id TEXT NOT NULL REFERENCES project_links(id), sequence INTEGER NOT NULL,
 envelope_json TEXT NOT NULL, signature TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','acknowledged')),
 receipt_json TEXT, PRIMARY KEY(link_id,sequence)
) STRICT;
CREATE TABLE project_message_inbox (
 link_id TEXT NOT NULL REFERENCES project_links(id), sequence INTEGER NOT NULL,
 digest TEXT NOT NULL, receipt_json TEXT NOT NULL, PRIMARY KEY(link_id,sequence)
) STRICT;
CREATE TABLE project_workflow_owners (
 workflow_id TEXT PRIMARY KEY REFERENCES workflow_runs(id), link_id TEXT NOT NULL REFERENCES project_links(id),
 reserved_attempts INTEGER NOT NULL CHECK(reserved_attempts>=1), authority_revision INTEGER NOT NULL, budget_revision INTEGER NOT NULL,
 consumed_attempts INTEGER NOT NULL DEFAULT 0 CHECK(consumed_attempts>=0 AND consumed_attempts<=reserved_attempts),
 allocation_state TEXT NOT NULL DEFAULT 'reserved' CHECK(allocation_state IN ('reserved','settled')),
 settled_at TEXT
) STRICT;
CREATE TABLE project_attempt_debits (
 attempt_id TEXT PRIMARY KEY REFERENCES attempts(id), workflow_id TEXT NOT NULL REFERENCES workflow_runs(id),
 link_id TEXT NOT NULL REFERENCES project_links(id), budget_revision INTEGER NOT NULL,
 units INTEGER NOT NULL CHECK(units=1), created_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER project_attempt_debits_immutable_update BEFORE UPDATE ON project_attempt_debits
BEGIN SELECT RAISE(ABORT,'project attempt debits are immutable'); END;
CREATE TABLE project_link_attempt_debits (
 link_id TEXT NOT NULL REFERENCES project_links(id), child_attempt_id TEXT NOT NULL,
 child_workflow_id TEXT NOT NULL, budget_revision INTEGER NOT NULL,
 units INTEGER NOT NULL CHECK(units=1), created_at TEXT NOT NULL,
 PRIMARY KEY(link_id,child_attempt_id)
) STRICT;
CREATE TRIGGER project_link_attempt_debits_immutable_update BEFORE UPDATE ON project_link_attempt_debits
BEGIN SELECT RAISE(ABORT,'project link attempt debits are immutable'); END;
CREATE TRIGGER project_link_attempt_debits_immutable_delete BEFORE DELETE ON project_link_attempt_debits
BEGIN SELECT RAISE(ABORT,'project link attempt debits are immutable'); END;
CREATE TRIGGER project_attempt_debits_immutable_delete BEFORE DELETE ON project_attempt_debits
BEGIN SELECT RAISE(ABORT,'project attempt debits are immutable'); END;
CREATE TABLE project_authority_scopes (
 link_id TEXT PRIMARY KEY REFERENCES project_links(id), authority_revision INTEGER NOT NULL, budget_revision INTEGER NOT NULL
) STRICT;
CREATE TABLE project_control_authority_scopes (
 link_id TEXT NOT NULL REFERENCES project_links(id), attempt_id TEXT NOT NULL REFERENCES attempts(id),
 control_intent_id TEXT NOT NULL REFERENCES attempt_control_intents(id),
 authority_revision INTEGER NOT NULL, budget_revision INTEGER NOT NULL,
 PRIMARY KEY(link_id,attempt_id,control_intent_id)
) STRICT;
CREATE TABLE project_child_rollups (
 link_id TEXT NOT NULL REFERENCES project_links(id), source_sequence INTEGER NOT NULL,
 event_kind TEXT NOT NULL CHECK(event_kind IN ('workflow.status','result.report','allocation.settled')),
 projection_json TEXT NOT NULL CHECK(json_valid(projection_json)), received_at TEXT NOT NULL,
 PRIMARY KEY(link_id,source_sequence)
) STRICT;
CREATE TRIGGER project_child_rollups_immutable_update BEFORE UPDATE ON project_child_rollups
BEGIN SELECT RAISE(ABORT,'project child rollups are immutable'); END;
CREATE TRIGGER project_child_rollups_immutable_delete BEFORE DELETE ON project_child_rollups
BEGIN SELECT RAISE(ABORT,'project child rollups are immutable'); END;
CREATE TRIGGER project_delegated_attempt_authority BEFORE INSERT ON attempts
WHEN EXISTS(
 WITH RECURSIVE ancestors(id,parent_workflow_id) AS (
  SELECT id,parent_workflow_id FROM workflow_runs WHERE id=NEW.workflow_id
  UNION ALL SELECT w.id,w.parent_workflow_id FROM workflow_runs w JOIN ancestors a ON a.parent_workflow_id=w.id
 ) SELECT 1 FROM ancestors a JOIN project_workflow_owners o ON o.workflow_id=a.id
)
BEGIN
 SELECT CASE WHEN NOT EXISTS(
 WITH RECURSIVE ancestors(id,parent_workflow_id) AS (
  SELECT id,parent_workflow_id FROM workflow_runs WHERE id=NEW.workflow_id
  UNION ALL SELECT w.id,w.parent_workflow_id FROM workflow_runs w JOIN ancestors a ON a.parent_workflow_id=w.id
 ) SELECT 1 FROM ancestors a JOIN project_workflow_owners o ON o.workflow_id=a.id JOIN project_links l ON l.id=o.link_id
 JOIN project_authority_scopes s ON s.link_id=l.id
 WHERE l.state='active'
 AND s.authority_revision=l.authority_revision AND s.budget_revision=l.budget_revision
 ) THEN RAISE(ABORT,'Delegated admission requires current parent authority scope') END;
END;
CREATE TRIGGER project_delegated_native_authority BEFORE INSERT ON native_effects
WHEN NEW.effect_kind NOT IN ('interrupt','cleanup') AND EXISTS(
 WITH RECURSIVE ancestors(id,parent_workflow_id) AS (
  SELECT w.id,w.parent_workflow_id FROM attempts a JOIN workflow_runs w ON w.id=a.workflow_id WHERE a.id=NEW.attempt_id
  UNION ALL SELECT w.id,w.parent_workflow_id FROM workflow_runs w JOIN ancestors x ON x.parent_workflow_id=w.id
 ) SELECT 1 FROM ancestors x JOIN project_workflow_owners o ON o.workflow_id=x.id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(
 WITH RECURSIVE ancestors(id,parent_workflow_id) AS (
  SELECT w.id,w.parent_workflow_id FROM attempts a JOIN workflow_runs w ON w.id=a.workflow_id WHERE a.id=NEW.attempt_id
  UNION ALL SELECT w.id,w.parent_workflow_id FROM workflow_runs w JOIN ancestors x ON x.parent_workflow_id=w.id
 ) SELECT 1 FROM ancestors x JOIN project_workflow_owners o ON o.workflow_id=x.id
 JOIN project_links l ON l.id=o.link_id JOIN project_authority_scopes s ON s.link_id=l.id
 WHERE l.state='active' AND s.authority_revision=l.authority_revision
 AND s.budget_revision=l.budget_revision
 ) AND NOT EXISTS(
 WITH RECURSIVE ancestors(id,parent_workflow_id) AS (
  SELECT w.id,w.parent_workflow_id FROM attempts a JOIN workflow_runs w ON w.id=a.workflow_id WHERE a.id=NEW.attempt_id
  UNION ALL SELECT w.id,w.parent_workflow_id FROM workflow_runs w JOIN ancestors x ON x.parent_workflow_id=w.id
 ) SELECT 1 FROM ancestors x JOIN project_workflow_owners o ON o.workflow_id=x.id
 JOIN project_links l ON l.id=o.link_id JOIN project_control_authority_scopes s ON s.link_id=l.id
 JOIN attempt_control_intents c ON c.id=s.control_intent_id AND c.attempt_id=s.attempt_id
 WHERE s.attempt_id=NEW.attempt_id AND NEW.effect_kind='control/'||c.id
 AND c.state IN ('requested','unconfirmed') AND l.state IN ('active','paused','revoked')
 AND s.authority_revision=l.authority_revision AND s.budget_revision=l.budget_revision
 ) THEN RAISE(ABORT,'Delegated native effect requires current parent authority scope') END;
END;
CREATE TRIGGER project_delegated_limits BEFORE UPDATE OF max_attempts ON workflow_runs
WHEN EXISTS(
 WITH RECURSIVE ancestors(id,parent_workflow_id) AS (
  SELECT NEW.id,NEW.parent_workflow_id
  UNION ALL SELECT w.id,w.parent_workflow_id FROM workflow_runs w JOIN ancestors a ON a.parent_workflow_id=w.id
 ) SELECT 1 FROM ancestors a JOIN project_workflow_owners o ON o.workflow_id=a.id
 WHERE o.reserved_attempts<NEW.max_attempts
)
BEGIN SELECT RAISE(ABORT,'Delegated workflow cannot exceed its reserved allocation'); END;
`;
