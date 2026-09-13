import { z } from 'zod';
import { createHerdrAdapter, type HerdrAdapterOptions } from '../adapters/herdr.js';
import { payloadDigest } from '../database.js';
import { NativeBindingSchema } from '../native.js';
import { profileSchema, Settings } from '../settings.js';
import type { Store, SessionIdentity } from '../store.js';
import { HarnessCatalog, type HarnessProvider } from './index.js';

/** Models require explicit operator evidence: register verifies endpoint identity, not model availability. */
export function createHerdrProvider(
  input: {
    hostId: string;
    socketPath: string;
    workspaceId: string;
    endpointId: string;
    verifiedModels: string[];
  },
  options: HerdrAdapterOptions = {},
): HarnessProvider {
  const adapter = createHerdrAdapter(
    { prepare: async () => ({ kind: 'rejected', reason: 'Discovery is read-only' }) },
    options,
  );
  return {
    reference: { id: 'herdr', version: 1 },
    probe: async () => {
      const binding = await adapter.invoke('register', {
        hostId: input.hostId,
        socketPath: input.socketPath,
        workspaceId: input.workspaceId,
      });
      if ('kind' in binding) throw new Error(binding.reason);
      return [
        {
          id: input.endpointId,
          hostId: binding.hostId,
          locator: {
            socketPath: binding.socketPath,
            workspaceId: binding.workspaceId,
            binding: JSON.stringify(binding),
          },
          nativeVersion: `protocol-${binding.endpoint.protocol}`,
          contract: { id: 'herdr', version: 1 },
          generation: payloadDigest(binding.endpoint),
          methods: adapter.describe().capabilities.map((c) => c.name),
          capabilities: ['inspect', 'write', 'interrupt'],
          models: z.array(z.string().min(1)).parse(input.verifiedModels),
          health: 'available',
        },
      ];
    },
  };
}

/** Explicit migration of settings into disabled catalog profiles; no probing or enablement. */
export function importHerdrSettings(
  store: Store,
  actor: SessionIdentity,
  input: {
    nativeWorkspaceId: string;
    profileNames: string[];
    policyId: string;
    idempotencyKey: string;
  },
) {
  const settings = new Settings(store, actor);
  const configured = settings.get(`native/${input.nativeWorkspaceId}`, NativeBindingSchema);
  if (!configured) throw new Error('Native workspace is not configured');
  const endpointId = `herdr/${input.nativeWorkspaceId}`;
  const provider = createHerdrProvider({ ...configured.value, endpointId, verifiedModels: [] });
  const catalog = new HarnessCatalog(store, actor, [provider]);
  return store.idempotent(
    'harness.import-settings',
    input.idempotencyKey,
    input,
    z.object({ installationId: z.string(), endpointId: z.string(), policyId: z.string() }),
    () => {
      catalog.discover(
        { id: endpointId, provider: provider.reference, source: { kind: 'builtin' } },
        `${input.idempotencyKey}/discover`,
      );
      for (const name of input.profileNames) {
        const legacy = settings.get(`profile/${name}`, profileSchema);
        if (!legacy) throw new Error(`Profile ${name} is not configured`);
        const current = store.read((db) =>
          db.prepare('SELECT max(revision) AS revision FROM harness_profiles WHERE id=?').get(name),
        );
        catalog.defineProfile({
          profile: {
            id: name,
            endpointId,
            adapter: provider.reference,
            native: legacy.value,
            workspaceAccess: 'inspect',
            enabled: false,
          },
          expectedRevision: z.number().nullable().parse(current?.revision) ?? 0,
          idempotencyKey: `${input.idempotencyKey}/profile/${name}`,
        });
      }
      catalog.bind({
        policy: { id: input.policyId, profileIds: input.profileNames, maxProbeAgeMs: 30000 },
        expectedRevision: 0,
        idempotencyKey: `${input.idempotencyKey}/policy`,
      });
      return { installationId: endpointId, endpointId, policyId: input.policyId };
    },
  ).value;
}
