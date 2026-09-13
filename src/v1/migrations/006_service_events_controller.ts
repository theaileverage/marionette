export const serviceEventsControllerSql = `
CREATE TABLE service_instances (
 project_id TEXT NOT NULL, host_id TEXT NOT NULL, generation TEXT NOT NULL,
 process_identity TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('starting','recovering','ready','draining','stopped','unconfirmed')),
 started_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL, stopped_at TEXT,
 PRIMARY KEY(project_id,generation)
);
CREATE UNIQUE INDEX service_active_owner ON service_instances(project_id,host_id)
 WHERE stopped_at IS NULL;
CREATE TABLE service_action_claims(project_id TEXT NOT NULL,id TEXT PRIMARY KEY,action TEXT NOT NULL,expected_revision INTEGER NOT NULL,revision INTEGER NOT NULL,idempotency_key TEXT NOT NULL,request_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('claimed','completed','unconfirmed')),receipt_json TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(project_id,idempotency_key));
CREATE TABLE controller_native_effects(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,controller_id TEXT NOT NULL,generation INTEGER NOT NULL,effect_json TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'claimed',created_at TEXT NOT NULL);
CREATE TABLE domain_events (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, sequence INTEGER NOT NULL,
 kind TEXT NOT NULL, aggregate_kind TEXT NOT NULL, aggregate_id TEXT NOT NULL,
 aggregate_revision INTEGER NOT NULL, cause_json TEXT NOT NULL, payload_json TEXT NOT NULL,
 dedupe_key TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(project_id,sequence), UNIQUE(project_id,dedupe_key)
);
CREATE TABLE controller_definitions (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE, profile_policy_id TEXT NOT NULL,
 authority_revision INTEGER NOT NULL DEFAULT 1, state_revision INTEGER NOT NULL DEFAULT 1,
 current_generation INTEGER, state TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TABLE controller_incarnations (
 controller_id TEXT NOT NULL REFERENCES controller_definitions(id), generation INTEGER NOT NULL,
 session_id TEXT NOT NULL, session_generation INTEGER NOT NULL,
 adapter_id TEXT NOT NULL, adapter_version TEXT NOT NULL, endpoint_generation TEXT NOT NULL,
 native_identity_json TEXT, state_digest TEXT NOT NULL, route_decision_id TEXT,
 state TEXT NOT NULL CHECK(state IN ('launching','active','settled','unconfirmed','superseded')),
 created_at TEXT NOT NULL, PRIMARY KEY(controller_id,generation)
);
CREATE TABLE controller_inbox_items (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, controller_id TEXT NOT NULL REFERENCES controller_definitions(id),
 event_id TEXT NOT NULL REFERENCES domain_events(id), dedupe_key TEXT NOT NULL,
 priority INTEGER NOT NULL DEFAULT 1, not_before TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','claimed','submitted','acknowledged','superseded','dead-letter')),
 claim_revision INTEGER NOT NULL DEFAULT 0, service_generation TEXT, controller_generation INTEGER, authority_revision INTEGER,
 attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT,
 UNIQUE(controller_id,dedupe_key)
);
CREATE INDEX controller_inbox_due ON controller_inbox_items(controller_id,state,not_before,priority);
CREATE TABLE controller_decision_cycles (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, controller_id TEXT NOT NULL,
 controller_generation INTEGER NOT NULL, decision_key TEXT NOT NULL, decision_digest TEXT NOT NULL,
 receipt_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(controller_id,decision_key)
);
CREATE TABLE controller_inbox_acknowledgements (
 item_id TEXT PRIMARY KEY REFERENCES controller_inbox_items(id), claim_revision INTEGER NOT NULL,
 decision_cycle_id TEXT NOT NULL REFERENCES controller_decision_cycles(id),
 disposition TEXT NOT NULL CHECK(disposition IN ('processed','dismissed','superseded')),
 session_id TEXT NOT NULL, session_generation INTEGER NOT NULL, acknowledged_at TEXT NOT NULL
);
CREATE TRIGGER inbox_ack_requires_receipt BEFORE UPDATE OF state ON controller_inbox_items
 WHEN NEW.state = 'acknowledged' AND NOT EXISTS (
 SELECT 1 FROM controller_inbox_acknowledgements a JOIN controller_decision_cycles c ON c.id=a.decision_cycle_id
 WHERE a.item_id=NEW.id AND a.claim_revision=NEW.claim_revision AND c.controller_id=NEW.controller_id
 AND c.project_id=NEW.project_id AND c.controller_generation=NEW.controller_generation)
 BEGIN SELECT RAISE(ABORT,'inbox acknowledgement requires current decision receipt'); END;
INSERT INTO domain_events
 SELECT 'recovery-' || aggregate_kind || '-' || id,project_id,
 row_number() OVER(PARTITION BY project_id ORDER BY aggregate_kind,id),
 'recovery.snapshot',aggregate_kind,id,revision,'{}',json_object('state',state),
 'migration-006-' || aggregate_kind || '-' || id,strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM (
 SELECT project_id,id,'workflow' AS aggregate_kind,revision,phase AS state FROM workflow_runs WHERE phase NOT IN ('finished','cancelled')
 UNION ALL SELECT project_id,id,'job',current_brief_revision,state FROM jobs WHERE state='open'
 UNION ALL SELECT project_id,id,'attempt',brief_revision,phase FROM attempts WHERE phase NOT IN ('settled','closed')
 );
`;
