import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Store } from '../../src/v1/store.js';
import { AgentSessionIdSchema, ProjectIdSchema, HostIdSchema } from '../../src/v1/model.js';
import { HarnessCatalog, type HarnessProvider } from '../../src/v1/harnesses/index.js';
import { harnessCatalogProfilesSql } from '../../src/v1/migrations/007_harness_catalog_profiles.js';
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'harness-catalog-'));
  const store = Store.open({
    databasePath: join(dir, 'db'),
    project: {
      id: ProjectIdSchema.parse('project_harness'),
      hostId: HostIdSchema.parse('host_harness'),
      repositoryRoot: dir,
      stateDirectory: dir,
    },
  });
  if (
    !store.read((db) =>
      db.prepare("SELECT name FROM sqlite_master WHERE name='harness_installations'").get(),
    )
  )
    store.transaction((db) => db.exec(harnessCatalogProfilesSql));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const actor = store.registerSession({
    id: AgentSessionIdSchema.parse('user_harness'),
    generation: 1,
    workspaceId: null,
    role: 'user',
    executionRole: 'user',
    tokenHash: 'a'.repeat(64),
    parentWorkflowId: null,
    attemptId: null,
    nativeKind: null,
    nativeServerGeneration: null,
    nativeLocator: null,
  });
  let generation = 'one',
    now = new Date('2026-09-13T00:00:00Z');
  const provider: HarnessProvider = {
    reference: { id: 'fixture', version: 1 },
    probe: async () => [
      {
        id: 'endpoint',
        hostId: 'host_harness',
        locator: { socket: '/fixture' },
        nativeVersion: '1',
        contract: { id: 'fixture', version: 1 },
        generation,
        methods: ['launch'],
        capabilities: ['inspect'],
        models: ['exact-model'],
        health: 'available',
      },
    ],
  };
  const catalog = new HarnessCatalog(store, actor, [provider], () => now);
  catalog.discover(
    { id: 'fixture', provider: provider.reference, source: { kind: 'builtin' } },
    'discover',
  );
  catalog.defineProfile({
    profile: {
      id: 'review',
      endpointId: 'endpoint',
      adapter: provider.reference,
      native: {
        name: 'review',
        kind: 'fixture',
        model: 'exact-model',
        args: ['--model', 'exact-model'],
      },
      workspaceAccess: 'inspect',
      enabled: true,
    },
    expectedRevision: 0,
    idempotencyKey: 'profile',
  });
  catalog.bind({
    policy: { id: 'default', profileIds: ['review'], maxProbeAgeMs: 1000 },
    expectedRevision: 0,
    idempotencyKey: 'policy',
  });
  const requirement = {
    role: 'review',
    methods: ['launch'],
    requiredCapabilities: ['inspect'],
    workspaceAccess: 'inspect' as const,
    modelPreferences: ['exact-model'],
  };
  return {
    catalog,
    actor,
    provider,
    store,
    requirement,
    changeGeneration: () => {
      generation = 'two';
    },
    age: () => {
      now = new Date(now.getTime() + 2000);
    },
  };
}
test('allow-listed read-only discovery is disabled until explicit authority revision enablement', async (t) => {
  const { catalog, requirement } = fixture(t);
  assert.throws(
    () =>
      catalog.discover(
        { id: 'untrusted', provider: { id: 'unknown', version: 1 }, source: { kind: 'builtin' } },
        'bad',
      ),
    /allow-listed/,
  );
  await catalog.probe('fixture');
  assert.equal(catalog.route(requirement, 'default', 'blocked').state, 'blocked');
  catalog.enable({
    installationId: 'fixture',
    expectedRevision: 1,
    enabled: true,
    idempotencyKey: 'enable',
  });
  const route = catalog.route(requirement, 'default', 'route');
  assert.equal(route.state, 'selected');
  assert.equal(catalog.admissionSnapshot(route.id).endpointGeneration, 'one');
  assert.deepEqual(catalog.route(requirement, 'default', 'route'), route);
});
test('admission rechecks endpoint generation, fresh probe, policy and exact requested model', async (t) => {
  const { catalog, requirement, changeGeneration, age } = fixture(t);
  await catalog.probe('fixture');
  catalog.enable({
    installationId: 'fixture',
    expectedRevision: 1,
    enabled: true,
    idempotencyKey: 'enable',
  });
  const route = catalog.route(requirement, 'default', 'route');
  assert.equal(
    catalog.route({ ...requirement, modelPreferences: ['missing-model'] }, 'default', 'missing')
      .state,
    'blocked',
  );
  changeGeneration();
  await catalog.probe('fixture');
  assert.throws(() => catalog.admissionSnapshot(route.id), /stale/);
  const newRoute = catalog.route(requirement, 'default', 'new');
  age();
  assert.throws(() => catalog.admissionSnapshot(newRoute.id), /stale/);
});
test('revoke between route and admission fails closed and retains reasons', async (t) => {
  const { catalog, requirement, store } = fixture(t);
  await catalog.probe('fixture');
  catalog.enable({
    installationId: 'fixture',
    expectedRevision: 1,
    enabled: true,
    idempotencyKey: 'enable',
  });
  const route = catalog.route(requirement, 'default', 'route');
  catalog.enable({
    installationId: 'fixture',
    expectedRevision: 2,
    enabled: false,
    idempotencyKey: 'disable',
  });
  assert.throws(() => catalog.admissionSnapshot(route.id), /stale/);
  assert.equal(
    store.read(
      (db) => db.prepare('SELECT count(*) AS n FROM harness_admission_snapshots').get()?.n,
    ),
    0,
  );
  assert.match(
    JSON.stringify(catalog.route(requirement, 'default', 'blocked').candidates),
    /disabled/,
  );
});

test('older concurrent probe cannot overwrite a newer endpoint generation', async (t) => {
  const f = fixture(t);
  let finish!: (value: Awaited<ReturnType<HarnessProvider['probe']>>) => void;
  const oldCatalog = new HarnessCatalog(f.store, f.actor, [
    {
      reference: f.provider.reference,
      probe: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
  ]);
  const oldProbe = oldCatalog.probe('fixture');
  await f.catalog.probe('fixture');
  finish((await f.provider.probe()).map((o) => ({ ...o, generation: 'obsolete' })));
  await assert.rejects(oldProbe, /probe generation changed/);
  const raw = f.store.read((db) =>
    db.prepare("SELECT observation_json FROM harness_endpoints WHERE id='endpoint'").get(),
  );
  assert.match(String(raw?.observation_json), /"generation":"one"/);
});
