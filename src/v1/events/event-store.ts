import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../database.js';
import type { Store } from '../store.js';

const EventInput = z.object({
  kind: z.string().min(1),
  aggregate: z.object({
    kind: z.string().min(1),
    id: z.string().min(1),
    revision: z.number().int().nonnegative(),
  }),
  cause: z.record(z.string()).default({}),
  payload: z.unknown(),
  dedupeKey: z.string().min(1),
});
export type AppendEventInput = z.input<typeof EventInput>;
export function eventPriority(kind: string): 0 | 1 | 2 {
  if (/^(approval\.|decision\.|service\.blocked|workflow\.(cancel|pause))/.test(kind)) return 0;
  if (kind === 'recovery.classified') return 2;
  return 1;
}
export class EventStore {
  constructor(readonly store: Store) {}
  append(input: AppendEventInput): string {
    const value = EventInput.parse(input);
    return this.store.transaction((db) => {
      const old = db
        .prepare('SELECT * FROM domain_events WHERE project_id=? AND dedupe_key=?')
        .get(this.store.project.id, value.dedupeKey);
      if (old) {
        if (
          old.kind !== value.kind ||
          old.aggregate_kind !== value.aggregate.kind ||
          old.aggregate_id !== value.aggregate.id ||
          old.aggregate_revision !== value.aggregate.revision ||
          old.cause_json !== canonicalJson(value.cause) ||
          old.payload_json !== canonicalJson(value.payload)
        )
          throw new Error('event dedupe conflict');
        return String(old.id);
      }
      const id = randomUUID();
      const sequence = Number(
        db
          .prepare('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM domain_events WHERE project_id=?')
          .get(this.store.project.id)?.n,
      );
      db.prepare('INSERT INTO domain_events VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
        id,
        this.store.project.id,
        sequence,
        value.kind,
        value.aggregate.kind,
        value.aggregate.id,
        value.aggregate.revision,
        canonicalJson(value.cause),
        canonicalJson(value.payload),
        value.dedupeKey,
        new Date().toISOString(),
      );
      this.project();
      return id;
    });
  }
  project(): number {
    return this.store.transaction((db) => {
      const events = db
        .prepare(
          `SELECT e.id,e.kind,e.created_at,c.id AS controller_id
           FROM domain_events e JOIN controller_definitions c ON c.project_id=e.project_id
           LEFT JOIN controller_inbox_items i ON i.controller_id=c.id AND i.event_id=e.id
           WHERE e.project_id=? AND i.id IS NULL ORDER BY e.sequence`,
        )
        .all(this.store.project.id);
      const insert = db.prepare(
        `INSERT OR IGNORE INTO controller_inbox_items
         (id,project_id,controller_id,event_id,dedupe_key,priority,not_before,state)
         VALUES(lower(hex(randomblob(16))),?,?,?,?,?,?,'pending')`,
      );
      let changes = 0;
      for (const event of events)
        changes += Number(
          insert.run(
            this.store.project.id,
            String(event.controller_id),
            String(event.id),
            String(event.id),
            eventPriority(String(event.kind)),
            String(event.created_at),
          ).changes,
        );
      return changes;
    });
  }
  list(after = 0, limit = 100) {
    z.number().int().nonnegative().parse(after);
    z.number().int().min(1).max(500).parse(limit);
    return this.store.read((db) =>
      db
        .prepare(
          'SELECT * FROM domain_events WHERE project_id=? AND sequence>? ORDER BY sequence LIMIT ?',
        )
        .all(this.store.project.id, after, limit),
    );
  }
}
