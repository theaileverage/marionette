import { existsSync, readFileSync } from 'node:fs';
import { localOwnerLiveness } from '../background.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../database.js';
import type { DatabaseSync } from 'node:sqlite';
import type { Store, SessionIdentity } from '../store.js';
import { ServiceOwnership } from './ownership.js';
import {
  installService,
  startService,
  stopService,
  uninstallService,
  localServiceCommands,
  type ServiceCommandPort,
  type ServiceDefinition,
} from './installers/index.js';

const actionSchema = z.enum(['install', 'start', 'stop', 'uninstall']);
export type ServiceAction = z.infer<typeof actionSchema>;
export interface ServiceActionInput {
  action: ServiceAction;
  expectedRevision: number;
  idempotencyKey: string;
}
const claimSchema = z.object({
  id: z.string(),
  revision: z.number().int(),
  state: z.enum(['claimed', 'completed', 'unconfirmed']),
  request_json: z.string(),
  receipt_json: z.string().nullable(),
  error: z.string().nullable(),
});
export class ServiceLifecycle {
  constructor(
    readonly store: Store,
    readonly definition: ServiceDefinition,
    readonly commands: ServiceCommandPort = localServiceCommands,
    readonly actor?: SessionIdentity,
  ) {}
  private authorize(db: DatabaseSync) {
    if (
      !this.actor ||
      !db
        .prepare(
          "SELECT id FROM agent_sessions WHERE project_id=? AND host_id=? AND id=? AND generation=? AND role='user' AND state='active' AND native_kind IS NULL AND parent_workflow_id IS NULL AND attempt_id IS NULL",
        )
        .get(this.store.project.id, this.store.project.hostId, this.actor.id, this.actor.generation)
    )
      throw new Error('active local user required for service lifecycle');
  }
  status() {
    return {
      revision: this.store.read((db) =>
        Number(
          db
            .prepare(
              'SELECT COALESCE(MAX(revision),0) AS revision FROM service_action_claims WHERE project_id=?',
            )
            .get(this.store.project.id)?.revision,
        ),
      ),
      instance: ServiceOwnership.status(this.store),
      definition: this.definition,
    };
  }
  preview(action: ServiceAction) {
    actionSchema.parse(action);
    return { action, ...this.status() };
  }
  async reconcile(input: { claimId: string; expectedRevision: number }) {
    const snapshot = this.store.read((db) => {
      this.authorize(db);
      const row = db
        .prepare('SELECT * FROM service_action_claims WHERE project_id=? AND id=?')
        .get(this.store.project.id, input.claimId);
      const claim = claimSchema.extend({ action: actionSchema }).parse(row);
      if (
        this.status().revision !== input.expectedRevision ||
        claim.revision !== input.expectedRevision
      )
        throw new Error('service reconciliation revision conflict');
      const request = z
        .object({ definition: z.object({ content: z.string(), path: z.string() }) })
        .parse(JSON.parse(claim.request_json));
      if (
        request.definition.content !== this.definition.content ||
        request.definition.path !== this.definition.path
      )
        throw new Error('service definition changed since claim');
      return claim;
    });
    if (snapshot.state === 'completed') return snapshot;
    const fileMatches =
      existsSync(this.definition.path) &&
      readFileSync(this.definition.path, 'utf8') === this.definition.content;
    let confirmed = snapshot.action === 'install' && fileMatches;
    let evidence = 'exact installed definition';
    if (snapshot.action !== 'install') {
      const owner = ServiceOwnership.status(this.store);
      const absent =
        !owner ||
        owner.stopped_at !== null ||
        (await localOwnerLiveness.confirmAbsent({
          project: this.store.project,
          processIdentity: owner.process_identity,
        }));
      try {
        if (this.definition.platform === 'linux') {
          evidence = await this.commands.run('systemctl', [
            '--user',
            'show',
            this.definition.label + '.service',
            '--property=ActiveState,UnitFileState,FragmentPath',
          ]);
          const properties = new Map(
            evidence
              .trim()
              .split('\n')
              .map((line) => {
                const i = line.indexOf('=');
                return [line.slice(0, i), line.slice(i + 1)];
              }),
          );
          if (snapshot.action === 'start')
            confirmed =
              fileMatches &&
              properties.get('ActiveState') === 'active' &&
              properties.get('FragmentPath') === this.definition.path;
          else
            confirmed =
              absent &&
              properties.get('ActiveState') === 'inactive' &&
              ['disabled', ''].includes(properties.get('UnitFileState') ?? 'unknown') &&
              (snapshot.action !== 'uninstall' || !existsSync(this.definition.path));
        } else if (snapshot.action === 'start') {
          evidence = await this.commands.run('launchctl', [
            'print',
            `gui/${this.definition.uid}/${this.definition.label}`,
          ]);
          const lines = evidence.split('\n').map((line) => line.trim());
          confirmed =
            fileMatches &&
            lines.includes('state = running') &&
            lines.includes('path = ' + this.definition.path);
        } else {
          evidence = await this.commands.run('launchctl', ['print', `gui/${this.definition.uid}`]);
          confirmed =
            absent &&
            !evidence.includes(this.definition.label) &&
            (snapshot.action !== 'uninstall' || !existsSync(this.definition.path));
        }
      } catch {
        confirmed = false;
      }
    }
    return this.store.transaction((db) => {
      this.authorize(db);
      if (this.status().revision !== input.expectedRevision)
        throw new Error('service reconciliation revision changed');
      if (confirmed)
        db.prepare(
          "UPDATE service_action_claims SET state='completed',receipt_json=?,error=NULL,updated_at=? WHERE id=? AND state IN ('claimed','unconfirmed')",
        ).run(
          canonicalJson({ reconciled: true, evidence }),
          new Date().toISOString(),
          input.claimId,
        );
      return claimSchema.parse(
        db.prepare('SELECT * FROM service_action_claims WHERE id=?').get(input.claimId),
      );
    });
  }
  async apply(input: ServiceActionInput) {
    actionSchema.parse(input.action);
    z.number().int().nonnegative().parse(input.expectedRevision);
    z.string().min(1).parse(input.idempotencyKey);
    const request = canonicalJson({
      action: input.action,
      expectedRevision: input.expectedRevision,
      definition: this.definition,
    });
    const claim = this.store.transaction((db) => {
      this.authorize(db);
      const existing = db
        .prepare('SELECT * FROM service_action_claims WHERE project_id=? AND idempotency_key=?')
        .get(this.store.project.id, input.idempotencyKey);
      if (existing) {
        const prior = claimSchema.parse(existing);
        if (prior.request_json !== request) throw new Error('service action idempotency conflict');
        return { record: prior, fresh: false };
      }
      const revision = Number(
        db
          .prepare(
            'SELECT COALESCE(MAX(revision),0) AS revision FROM service_action_claims WHERE project_id=?',
          )
          .get(this.store.project.id)?.revision,
      );
      if (revision !== input.expectedRevision) throw new Error('service action revision conflict');
      if (
        db
          .prepare(
            "SELECT id FROM service_action_claims WHERE project_id=? AND state IN ('claimed','unconfirmed')",
          )
          .get(this.store.project.id)
      )
        throw new Error('prior service action requires reconciliation');
      const id = randomUUID();
      const timestamp = new Date().toISOString();
      db.prepare(
        "INSERT INTO service_action_claims(project_id,id,action,expected_revision,revision,idempotency_key,request_json,state,receipt_json,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'claimed',NULL,NULL,?,?)",
      ).run(
        this.store.project.id,
        id,
        input.action,
        input.expectedRevision,
        revision + 1,
        input.idempotencyKey,
        request,
        timestamp,
        timestamp,
      );
      return {
        record: claimSchema.parse(
          db.prepare('SELECT * FROM service_action_claims WHERE id=?').get(id),
        ),
        fresh: true,
      };
    });
    if (!claim.fresh) return claim.record;
    try {
      let output: string | undefined;
      if (input.action === 'install') output = installService(this.definition);
      else if (input.action === 'start')
        output = await startService(this.definition, this.commands);
      else if (input.action === 'stop') output = await stopService(this.definition, this.commands);
      else await uninstallService(this.definition, this.commands);
      this.store.transaction((db) =>
        db
          .prepare(
            "UPDATE service_action_claims SET state='completed',receipt_json=?,updated_at=? WHERE id=? AND state='claimed'",
          )
          .run(
            canonicalJson({ action: input.action, output: output ?? null }),
            new Date().toISOString(),
            claim.record.id,
          ),
      );
    } catch (error) {
      this.store.transaction((db) =>
        db
          .prepare(
            "UPDATE service_action_claims SET state='unconfirmed',error=?,updated_at=? WHERE id=? AND state='claimed'",
          )
          .run(
            error instanceof Error ? error.message : 'service action outcome unknown',
            new Date().toISOString(),
            claim.record.id,
          ),
      );
    }
    return this.store.read((db) =>
      claimSchema.parse(
        db.prepare('SELECT * FROM service_action_claims WHERE id=?').get(claim.record.id),
      ),
    );
  }
}
