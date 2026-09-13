import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { adapterReferenceSchema } from '../adapters.js';
import { canonicalJson, payloadDigest } from '../database.js';
import { profileSchema } from '../settings.js';
import type { Store, SessionIdentity } from '../store.js';
import { requireControlActor } from '../controllers/controller-store.js';

const name = z.string().min(1);
export const harnessManifestSchema = z
  .object({
    id: name,
    provider: adapterReferenceSchema,
    source: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('builtin') }).strict(),
      z
        .object({
          kind: z.literal('allow-listed-manifest'),
          path: name,
          digest: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ]),
  })
  .strict();
export const endpointObservationSchema = z
  .object({
    id: name,
    hostId: name,
    locator: z.record(z.string()),
    nativeVersion: name,
    contract: adapterReferenceSchema,
    generation: name,
    methods: z.array(name),
    capabilities: z.array(name),
    models: z.array(name),
    health: z.enum(['available', 'busy', 'degraded', 'unavailable', 'unconfirmed']),
  })
  .strict();
export const catalogProfileSchema = z
  .object({
    id: name,
    endpointId: name,
    adapter: adapterReferenceSchema,
    native: profileSchema,
    workspaceAccess: z.enum(['inspect', 'write']),
    enabled: z.boolean(),
  })
  .strict();
export const roleRequirementSchema = z
  .object({
    role: name,
    methods: z.array(name),
    requiredCapabilities: z.array(name),
    workspaceAccess: z.enum(['inspect', 'write']),
    modelPreferences: z.array(name).min(1),
    requiresDistinctFrom: z.array(name).default([]),
  })
  .strict();
export const routingPolicySchema = z
  .object({
    id: name,
    profileIds: z.array(name).min(1),
    maxProbeAgeMs: z.number().int().positive().max(3600000),
  })
  .strict();
export type HarnessProvider = {
  reference: z.infer<typeof adapterReferenceSchema>;
  /** Trusted application-supplied read-only probe. Never loaded from the manifest. */
  probe: () => Promise<z.infer<typeof endpointObservationSchema>[]>;
};
type Requirement = z.input<typeof roleRequirementSchema>;
const snapshotSchema = z.object({
  endpointId: name,
  endpointGeneration: name,
  adapter: adapterReferenceSchema,
  profileId: name,
  profileRevision: z.number(),
  installationId: name,
  authorityRevision: z.number(),
  observationDigest: name,
});
const routeSchema = z.object({
  id: name,
  policyId: name,
  policyRevision: z.number(),
  state: z.enum(['selected', 'blocked']),
  selected: snapshotSchema.nullable(),
  candidates: z.array(
    z.object({ profileId: name, eligible: z.boolean(), reasons: z.array(z.string()) }),
  ),
});
const jsonRow = z.object({ value: z.string(), revision: z.number().optional() });

export class HarnessCatalog {
  constructor(
    private readonly store: Store,
    private readonly actor: SessionIdentity,
    private readonly providers: readonly HarnessProvider[] = [],
    private readonly clock: () => Date = () => new Date(),
  ) {}
  private authorize() {
    this.store.read((db) => requireControlActor(this.store, db, this.actor));
  }
  discover(manifest: z.infer<typeof harnessManifestSchema>, idempotencyKey: string) {
    const parsed = harnessManifestSchema.parse(manifest);
    if (!this.providers.some((p) => canonicalJson(p.reference) === canonicalJson(parsed.provider)))
      throw new Error('Harness provider is not allow-listed at this exact version');
    return this.store.idempotent(
      'harness.discover',
      idempotencyKey,
      parsed,
      z.object({ id: name }),
      (db) => {
        this.authorize();
        db.prepare(
          'INSERT INTO harness_installations(id,project_id,manifest_json,manifest_digest) VALUES (?,?,?,?)',
        ).run(parsed.id, this.store.project.id, canonicalJson(parsed), payloadDigest(parsed));
        return { id: parsed.id };
      },
    ).value;
  }
  list() {
    return this.store.read((db) => ({
      installations: db.prepare('SELECT * FROM harness_installations ORDER BY id').all(),
      endpoints: db.prepare('SELECT * FROM harness_endpoints ORDER BY id').all(),
    }));
  }
  async probe(installationId: string) {
    this.authorize();
    const installation = this.installation(installationId);
    const manifest = harnessManifestSchema.parse(JSON.parse(installation.manifest_json));
    const provider = this.providers.find(
      (p) => canonicalJson(p.reference) === canonicalJson(manifest.provider),
    );
    if (!provider) throw new Error('No allow-listed exact-version probe');
    // A failed or incomplete probe must not leave a prior healthy observation routable.
    const probeRevision = this.store.transaction((db) => {
      this.authorize();
      db.prepare('UPDATE harness_installations SET probe_revision=probe_revision+1 WHERE id=?').run(
        installationId,
      );
      db.prepare(
        "UPDATE harness_endpoints SET observation_json=json_set(observation_json,'$.health','unconfirmed') WHERE installation_id=?",
      ).run(installationId);
      db.prepare(
        'INSERT INTO harness_endpoint_observations(endpoint_id,observation_json,observed_at) SELECT id,observation_json,? FROM harness_endpoints WHERE installation_id=?',
      ).run(this.clock().toISOString(), installationId);
      return this.installation(installationId).probe_revision;
    });
    const observations = z.array(endpointObservationSchema).parse(await provider.probe());
    for (const observation of observations) {
      if (
        observation.hostId !== this.store.project.hostId ||
        canonicalJson(observation.contract) !== canonicalJson(manifest.provider)
      )
        throw new Error('Probe host or adapter version mismatch');
    }
    return this.store.transaction((db) => {
      this.authorize();
      const currentInstallation = this.installation(installationId);
      if (
        currentInstallation.authority_revision !== installation.authority_revision ||
        currentInstallation.probe_revision !== probeRevision
      )
        throw new Error('Installation or probe generation changed during probe');
      for (const observation of observations) {
        const previous = db
          .prepare('SELECT installation_id FROM harness_endpoints WHERE id=?')
          .get(observation.id);
        if (previous && previous.installation_id !== installationId)
          throw new Error('Endpoint belongs to another installation');
        const encoded = canonicalJson(observation),
          now = this.clock().toISOString();
        db.prepare(
          'INSERT INTO harness_endpoints VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET observation_json=excluded.observation_json, observed_at=excluded.observed_at',
        ).run(observation.id, installationId, encoded, now);
        db.prepare(
          'INSERT INTO harness_endpoint_observations(endpoint_id,observation_json,observed_at) VALUES (?,?,?)',
        ).run(observation.id, encoded, now);
      }
      return observations;
    });
  }
  private installation(id: string) {
    return z
      .object({
        manifest_json: z.string(),
        enabled: z.number(),
        authority_revision: z.number(),
        probe_revision: z.number(),
      })
      .parse(
        this.store.read((db) =>
          db
            .prepare('SELECT * FROM harness_installations WHERE id=? AND project_id=?')
            .get(id, this.store.project.id),
        ),
      );
  }
  enable(input: {
    installationId: string;
    expectedRevision: number;
    enabled: boolean;
    idempotencyKey: string;
  }) {
    return this.store.idempotent(
      'harness.enable',
      input.idempotencyKey,
      input,
      z.object({ revision: z.number() }),
      (db) => {
        this.authorize();
        const old = this.installation(input.installationId);
        if (old.authority_revision !== input.expectedRevision)
          throw new Error('Installation authority revision is stale');
        const revision = input.expectedRevision + 1;
        db.prepare(
          'UPDATE harness_installations SET enabled=?,authority_revision=? WHERE id=?',
        ).run(input.enabled ? 1 : 0, revision, input.installationId);
        return { revision };
      },
    ).value;
  }
  defineProfile(input: {
    profile: z.infer<typeof catalogProfileSchema>;
    expectedRevision: number;
    idempotencyKey: string;
  }) {
    const profile = catalogProfileSchema.parse(input.profile);
    return this.version(
      'harness_profiles',
      profile.id,
      profile,
      input.expectedRevision,
      input.idempotencyKey,
    );
  }
  bind(input: {
    policy: z.infer<typeof routingPolicySchema>;
    expectedRevision: number;
    idempotencyKey: string;
  }) {
    const policy = routingPolicySchema.parse(input.policy);
    return this.version(
      'harness_routing_policies',
      policy.id,
      policy,
      input.expectedRevision,
      input.idempotencyKey,
    );
  }
  private version(
    table: 'harness_profiles' | 'harness_routing_policies',
    id: string,
    value: z.infer<typeof catalogProfileSchema> | z.infer<typeof routingPolicySchema>,
    expectedRevision: number,
    key: string,
  ) {
    return this.store.idempotent(
      table,
      key,
      { id, value, expectedRevision },
      z.object({ revision: z.number() }),
      (db) => {
        this.authorize();
        const latest = db
          .prepare(`SELECT max(revision) AS revision FROM ${table} WHERE id=?`)
          .get(id);
        if ((latest?.revision ?? 0) !== expectedRevision)
          throw new Error('Catalog revision is stale');
        db.prepare(`INSERT INTO ${table} VALUES (?,?,?)`).run(
          id,
          expectedRevision + 1,
          canonicalJson(value),
        );
        return { revision: expectedRevision + 1 };
      },
    ).value;
  }
  private latest(table: 'harness_profiles' | 'harness_routing_policies', id: string) {
    const column = table === 'harness_profiles' ? 'profile_json' : 'policy_json';
    return this.store.read((db) => {
      const row = db
        .prepare(
          `SELECT ${column} AS value,revision FROM ${table} WHERE id=? ORDER BY revision DESC LIMIT 1`,
        )
        .get(id);
      return row ? jsonRow.parse(row) : null;
    });
  }
  route(requirement: Requirement, policyId: string, idempotencyKey: string) {
    const parsed = roleRequirementSchema.parse(requirement);
    return this.store.idempotent(
      'harness.route',
      idempotencyKey,
      { requirement: parsed, policyId },
      routeSchema,
      (db) => {
        this.authorize();
        const decision = this.select(parsed, policyId);
        db.prepare('INSERT INTO harness_route_decisions VALUES (?,?,?,?,?,?)').run(
          decision.id,
          policyId,
          decision.policyRevision,
          canonicalJson(parsed),
          canonicalJson(decision),
          this.clock().toISOString(),
        );
        return decision;
      },
    ).value;
  }
  private select(requirement: z.infer<typeof roleRequirementSchema>, policyId: string) {
    const stored = this.latest('harness_routing_policies', policyId);
    if (!stored) throw new Error('Routing policy missing');
    const policy = routingPolicySchema.parse(JSON.parse(stored.value));
    let selected: z.infer<typeof snapshotSchema> | null = null;
    const candidates = policy.profileIds.map((profileId) => {
      const reasons: string[] = [];
      const current = this.latest('harness_profiles', profileId);
      const profile = current ? catalogProfileSchema.safeParse(JSON.parse(current.value)) : null;
      if (!profile?.success)
        return {
          profileId,
          eligible: false,
          reasons: ['Profile missing or legacy profile requires explicit definition'],
        };
      const p = profile.data;
      const raw = this.store.read((db) =>
        db.prepare('SELECT * FROM harness_endpoints WHERE id=?').get(p.endpointId),
      );
      if (!raw) return { profileId, eligible: false, reasons: ['Endpoint has not been probed'] };
      const endpoint = z
        .object({ installation_id: name, observation_json: name, observed_at: name })
        .parse(raw);
      const observation = endpointObservationSchema.parse(JSON.parse(endpoint.observation_json));
      const installation = this.installation(endpoint.installation_id);
      if (!installation.enabled) reasons.push('Installation is disabled');
      if (!p.enabled) reasons.push('Profile is disabled');
      if (observation.health !== 'available') reasons.push(`Endpoint is ${observation.health}`);
      const age = this.clock().getTime() - Date.parse(endpoint.observed_at);
      if (age < 0 || age > policy.maxProbeAgeMs) reasons.push('Probe is stale');
      if (canonicalJson(p.adapter) !== canonicalJson(observation.contract))
        reasons.push('Exact adapter version mismatch');
      if (observation.hostId !== this.store.project.hostId) reasons.push('Execution host mismatch');
      if (!requirement.methods.every((m) => observation.methods.includes(m)))
        reasons.push('Required methods unavailable');
      if (!requirement.requiredCapabilities.every((m) => observation.capabilities.includes(m)))
        reasons.push('Required capabilities unavailable');
      if (requirement.workspaceAccess === 'write' && p.workspaceAccess !== 'write')
        reasons.push('Write access unavailable');
      if (
        !requirement.modelPreferences.includes(p.native.model) ||
        !observation.models.includes(p.native.model)
      )
        reasons.push('Exact requested model unavailable');
      if (requirement.requiresDistinctFrom.includes(profileId))
        reasons.push('Independent role requires a distinct profile');
      if (!reasons.length && selected === null)
        selected = {
          endpointId: p.endpointId,
          endpointGeneration: observation.generation,
          adapter: p.adapter,
          profileId,
          profileRevision: current?.revision ?? 0,
          installationId: endpoint.installation_id,
          authorityRevision: installation.authority_revision,
          observationDigest: payloadDigest(observation),
        };
      return { profileId, eligible: reasons.length === 0, reasons };
    });
    return {
      id: randomUUID(),
      policyId,
      policyRevision: stored.revision ?? 0,
      state: selected ? ('selected' as const) : ('blocked' as const),
      selected,
      candidates,
    };
  }
  /** Revalidate under the caller's admission/effect transaction. No external side effects. */
  validateRoute(routeId: string) {
    this.authorize();
    const row = this.store.read((db) =>
      z
        .object({ requirement_json: name, decision_json: name })
        .parse(db.prepare('SELECT * FROM harness_route_decisions WHERE id=?').get(routeId)),
    );
    const old = routeSchema.parse(JSON.parse(row.decision_json));
    if (!old.selected) throw new Error('Route is blocked');
    const current = this.select(
      roleRequirementSchema.parse(JSON.parse(row.requirement_json)),
      old.policyId,
    );
    if (
      current.policyRevision !== old.policyRevision ||
      canonicalJson(current.selected) !== canonicalJson(old.selected)
    )
      throw new Error('Route snapshot is stale; explicit rerouting is required before admission');
    const profile = catalogProfileSchema.parse(
      JSON.parse(this.latest('harness_profiles', old.selected.profileId)!.value),
    );
    const endpoint = this.store.read((db) =>
      z
        .object({ observation_json: name })
        .parse(
          db
            .prepare('SELECT observation_json FROM harness_endpoints WHERE id=?')
            .get(old.selected!.endpointId),
        ),
    );
    return {
      ...old.selected,
      routeDecisionId: routeId,
      policyRevision: old.policyRevision,
      profile,
      observation: endpointObservationSchema.parse(JSON.parse(endpoint.observation_json)),
    };
  }
  admissionSnapshot(routeId: string) {
    return this.store.transaction((db) => {
      const snapshot = this.validateRoute(routeId);
      db.prepare(
        'INSERT INTO harness_admission_snapshots(route_id,snapshot_json,created_at) VALUES (?,?,?)',
      ).run(routeId, canonicalJson(snapshot), this.clock().toISOString());
      return snapshot;
    });
  }
}
