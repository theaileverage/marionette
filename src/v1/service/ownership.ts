import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Store } from '../store.js';
import type { OwnerLivenessPort } from '../watcher.js';

const instanceSchema = z.object({
  generation: z.string(),
  process_identity: z.string(),
  state: z.enum(['starting', 'recovering', 'ready', 'draining', 'stopped', 'unconfirmed']),
  heartbeat_at: z.string(),
  stopped_at: z.string().nullable(),
});
export type ServiceInstance = z.infer<typeof instanceSchema>;
export interface OwnershipOptions {
  store: Store;
  processIdentity: string;
  livenessPort: OwnerLivenessPort;
}

/** Heartbeats diagnose stalls; only positive process absence permits takeover. */
export class ServiceOwnership {
  private constructor(
    readonly store: Store,
    readonly generation: string,
    readonly processIdentity: string,
  ) {}
  static status(store: Store): ServiceInstance | null {
    return store.read((db) => {
      const row = db
        .prepare(
          'SELECT * FROM service_instances WHERE project_id=? AND host_id=? ORDER BY rowid DESC LIMIT 1',
        )
        .get(store.project.id, store.project.hostId);
      return row ? instanceSchema.parse(row) : null;
    });
  }
  static async acquire(options: OwnershipOptions): Promise<ServiceOwnership> {
    const { store, processIdentity, livenessPort } = options;
    z.object({ pid: z.number().int().positive(), startToken: z.string().min(1) })
      .strict()
      .parse(JSON.parse(processIdentity));
    const prior = ServiceOwnership.status(store);
    if (prior && prior.stopped_at === null) {
      // Even the same process must not create two service loops.
      if (
        prior.process_identity === processIdentity ||
        !(await livenessPort.confirmAbsent({
          project: store.project,
          processIdentity: prior.process_identity,
        }))
      )
        throw new Error('service takeover requires confirmed former process absence');
    }
    const generation = randomUUID();
    store.transaction((db) => {
      const row = db
        .prepare(
          'SELECT * FROM service_instances WHERE project_id=? AND host_id=? AND stopped_at IS NULL',
        )
        .get(store.project.id, store.project.hostId);
      const current = row ? instanceSchema.parse(row) : null;
      if (
        current &&
        (current.generation !== prior?.generation ||
          current.process_identity !== prior.process_identity)
      )
        throw new Error('service owner changed during takeover');
      const timestamp = new Date().toISOString();
      if (current)
        db.prepare(
          "UPDATE service_instances SET state='unconfirmed',stopped_at=? WHERE generation=?",
        ).run(timestamp, current.generation);
      db.prepare(
        "INSERT INTO service_instances(project_id,host_id,generation,process_identity,state,started_at,heartbeat_at,stopped_at) VALUES(?,?,?,?,'starting',?,?,NULL)",
      ).run(
        store.project.id,
        store.project.hostId,
        generation,
        processIdentity,
        timestamp,
        timestamp,
      );
    });
    return new ServiceOwnership(store, generation, processIdentity);
  }
  assertCurrent(db: DatabaseSync) {
    const row = db
      .prepare(
        "SELECT generation FROM service_instances WHERE project_id=? AND host_id=? AND generation=? AND process_identity=? AND stopped_at IS NULL AND state IN ('starting','recovering','ready','draining')",
      )
      .get(this.store.project.id, this.store.project.hostId, this.generation, this.processIdentity);
    if (!row) throw new Error('service generation no longer owns this project');
  }
  heartbeat(state: 'recovering' | 'ready' | 'draining' = 'ready') {
    this.store.transaction((db) => {
      this.assertCurrent(db);
      db.prepare('UPDATE service_instances SET state=?,heartbeat_at=? WHERE generation=?').run(
        state,
        new Date().toISOString(),
        this.generation,
      );
    });
  }
  stop() {
    this.store.transaction((db) => {
      this.assertCurrent(db);
      const timestamp = new Date().toISOString();
      db.prepare(
        "UPDATE service_instances SET state='stopped',heartbeat_at=?,stopped_at=? WHERE generation=?",
      ).run(timestamp, timestamp, this.generation);
    });
  }
}
