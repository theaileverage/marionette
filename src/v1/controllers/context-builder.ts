import { payloadDigest, canonicalJson } from '../database.js';
import type { Store } from '../store.js';
export function buildControllerContext(store: Store, controllerId: string, maxBytes = 24000) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 100000)
    throw new Error('invalid context bound');
  const snapshot = store.read((db) => ({
    project: store.project.id,
    controllerId,
    workflows: db
      .prepare(
        'SELECT id,phase,revision,brief_revision,control_revision FROM workflow_runs WHERE project_id=? ORDER BY created_at DESC LIMIT 30',
      )
      .all(store.project.id),
    inbox: db
      .prepare(
        "SELECT id,event_id,claim_revision,state FROM controller_inbox_items WHERE project_id=? AND controller_id=? AND state IN ('pending','claimed','submitted') ORDER BY not_before,id LIMIT 50",
      )
      .all(store.project.id, controllerId),
  }));
  const digest = payloadDigest(snapshot);
  const text = canonicalJson(snapshot);
  return {
    digest,
    text:
      Buffer.byteLength(text) <= maxBytes
        ? text
        : canonicalJson({
            project: store.project.id,
            controllerId,
            digest,
            truncated: true,
            instruction: 'Read canonical inbox and workflow state through public operations.',
          }),
  };
}
