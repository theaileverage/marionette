export const controllerAuthoritySql = `
ALTER TABLE controller_incarnations ADD COLUMN authority_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE controller_native_effects ADD COLUMN inbox_claims_json TEXT CHECK(inbox_claims_json IS NULL OR json_valid(inbox_claims_json));
ALTER TABLE controller_native_effects ADD COLUMN receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json));
ALTER TABLE controller_native_effects ADD COLUMN settled_at TEXT;
CREATE TABLE controller_incarnation_retirements (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL,
 controller_id TEXT NOT NULL,
 generation INTEGER NOT NULL,
 disposition TEXT NOT NULL CHECK(disposition IN ('settled','unconfirmed')),
 reason TEXT NOT NULL,
 actor_id TEXT NOT NULL,
 actor_generation INTEGER NOT NULL,
 idempotency_key TEXT,
 request_json TEXT CHECK(request_json IS NULL OR json_valid(request_json)),
 created_at TEXT NOT NULL,
 UNIQUE(controller_id,generation),
 UNIQUE(project_id,idempotency_key),
 FOREIGN KEY(controller_id,generation) REFERENCES controller_incarnations(controller_id,generation),
 FOREIGN KEY(actor_id,actor_generation) REFERENCES agent_sessions(id,generation)
) STRICT;
`;
