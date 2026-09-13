import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../../src/v1/store.js';
import {
  AgentSessionIdSchema,
  SessionGenerationSchema,
  ProjectBindingSchema,
} from '../../src/v1/model.js';
import { ControllerStore } from '../../src/v1/controllers/controller-store.js';
import { EventStore } from '../../src/v1/events/event-store.js';
import { ControllerInbox } from '../../src/v1/inbox/controller-inbox.js';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cos-'));
  const project = ProjectBindingSchema.parse({
    id: '2eab264b-1e2d-4315-aee3-a657bc2fcab4',
    hostId: '24c62362-4de5-4633-b620-c297b4c48e01',
    repositoryRoot: root,
    stateDirectory: root,
  });
  const store = Store.open({ databasePath: join(root, 'db'), project });
  const actor = {
    id: AgentSessionIdSchema.parse('user-a'),
    generation: SessionGenerationSchema.parse(1),
  };
  store.registerSession({
    ...actor,
    tokenHash: createHash('sha256').update('token').digest('hex'),
    role: 'user',
    executionRole: 'user',
    workspaceId: null,
    parentWorkflowId: null,
    attemptId: null,
    nativeKind: null,
    nativeServerGeneration: null,
    nativeLocator: null,
  });
  const controllers = new ControllerStore(store);
  controllers.configure({ actor, profilePolicyId: 'default', expectedRevision: 0 });
  const incarnation = controllers.ensure({
    actor,
    expectedRevision: 1,
    adapter: { id: 'fixture', version: 1 },
    endpointGeneration: 'fixture-generation',
    stateDigest: 'digest',
  });
  controllers.reconcile({
    actor,
    controllerId: incarnation.controllerId,
    generation: 1,
    expectedRevision: 2,
    observation: {
      kind: 'active',
      nativeIdentity: { kind: 'fixture', serverGeneration: 'fixture-generation', locator: 'exact' },
    },
  });
  store.transaction((db) =>
    db
      .prepare("INSERT INTO service_instances VALUES(?,?,?,?,'ready',?,?,NULL)")
      .run(
        project.id,
        project.hostId,
        'service-1',
        '{}',
        new Date().toISOString(),
        new Date().toISOString(),
      ),
  );
  return {
    root,
    store,
    actor,
    controllers,
    incarnation,
    events: new EventStore(store),
    inbox: new ControllerInbox(store),
  };
}
test('events project atomically and processing receipt is distinct from submission', () => {
  const f = fixture();
  try {
    const event = {
      kind: 'test',
      aggregate: { kind: 'test', id: 'a', revision: 1 },
      payload: { ok: true },
      dedupeKey: 'event-1',
    };
    assert.equal(f.events.append(event), f.events.append(event));
    assert.throws(() => f.events.append({ ...event, payload: { ok: false } }));
    const [claim] = f.inbox.claim({
      controllerId: f.incarnation.controllerId,
      controllerGeneration: 1,
      serviceGeneration: 'service-1',
    });
    assert.ok(claim);
    f.inbox.markSubmitted(claim);
    assert.equal(f.inbox.read(f.incarnation.controllerId)[0]?.state, 'submitted');
    assert.throws(() =>
      f.inbox.release({ claim, reason: 'timeout', retryAt: new Date().toISOString() }),
    );
    assert.throws(() =>
      f.store.transaction((db) =>
        db
          .prepare("UPDATE controller_inbox_items SET state='acknowledged' WHERE id=?")
          .run(claim.id),
      ),
    );
    const request = {
      actor: f.incarnation.session,
      claims: [claim],
      decisionKey: 'decide-1',
      decision: { kind: 'acknowledge-only', reason: 'seen' },
    };
    assert.throws(() =>
      f.inbox.commitDecision(request, () => {
        throw new Error('crash');
      }),
    );
    assert.equal(f.inbox.read(f.incarnation.controllerId)[0]?.state, 'submitted');
    const first = f.inbox.commitDecision(request, () => ({
      kind: 'dismissed',
      reason: 'no action',
    }));
    assert.equal(
      f.inbox.commitDecision(request, () => {
        throw new Error('must not replay');
      }).cycleId,
      first.cycleId,
    );
    assert.equal(f.inbox.read(f.incarnation.controllerId)[0]?.state, 'acknowledged');
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('claim generations fence takeover and retries are finite', () => {
  const f = fixture();
  try {
    f.events.append({
      kind: 'test',
      aggregate: { kind: 'test', id: 'a', revision: 1 },
      payload: {},
      dedupeKey: 'x',
    });
    for (let n = 0; n < 5; n++) {
      const [claim] = f.inbox.claim({
        controllerId: f.incarnation.controllerId,
        controllerGeneration: 1,
        serviceGeneration: 'service-1',
      });
      assert.ok(claim);
      f.inbox.release({ claim, reason: 'not invoked', retryAt: new Date(0).toISOString() });
      assert.throws(() => f.inbox.markSubmitted(claim));
    }
    assert.equal(f.inbox.read(f.incarnation.controllerId)[0]?.state, 'dead-letter');
    assert.throws(() =>
      f.inbox.claim({
        controllerId: f.incarnation.controllerId,
        controllerGeneration: 1,
        serviceGeneration: 'stale',
      }),
    );
    assert.throws(() =>
      f.controllers.ensure({
        actor: f.actor,
        expectedRevision: 3,
        adapter: { id: 'fixture', version: 1 },
        endpointGeneration: 'fixture',
        stateDigest: 'digest',
      }),
    );
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('controller recovery requires admitted endpoint and restores authenticated authority', () => {
  const f = fixture();
  try {
    const base = { actor: f.actor, controllerId: f.incarnation.controllerId, generation: 1 };
    f.controllers.reconcile({
      ...base,
      expectedRevision: 3,
      observation: { kind: 'unconfirmed', reason: 'native observation failed' },
    });
    assert.throws(() =>
      f.store.authenticateSession({ ...f.incarnation.session, token: f.incarnation.token }),
    );
    assert.throws(() =>
      f.controllers.reconcile({
        ...base,
        expectedRevision: 4,
        observation: {
          kind: 'active',
          nativeIdentity: { kind: 'fixture', serverGeneration: 'another-server', locator: 'exact' },
        },
      }),
    );
    f.controllers.reconcile({
      ...base,
      expectedRevision: 4,
      observation: {
        kind: 'active',
        nativeIdentity: {
          kind: 'fixture',
          serverGeneration: 'fixture-generation',
          locator: 'exact',
        },
      },
    });
    assert.equal(
      f.store.authenticateSession({ ...f.incarnation.session, token: f.incarnation.token }).state,
      'active',
    );
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('confirmed owner retirement recovers pre-submission claims but preserves submitted ambiguity', () => {
  const f = fixture();
  try {
    for (const id of ['a', 'b'])
      f.events.append({
        kind: 'test',
        aggregate: { kind: 'test', id, revision: 1 },
        payload: {},
        dedupeKey: id,
      });
    const claims = f.inbox.claim({
      controllerId: f.incarnation.controllerId,
      controllerGeneration: 1,
      serviceGeneration: 'service-1',
    });
    f.inbox.markSubmitted(claims[0]!);
    assert.equal(f.inbox.recoverClaims('service-1'), 0);
    f.store.transaction((db) => {
      db.prepare(
        "UPDATE service_instances SET stopped_at=?,state='unconfirmed' WHERE generation='service-1'",
      ).run(new Date().toISOString());
      db.prepare("INSERT INTO service_instances VALUES(?,?,?,?,'recovering',?,?,NULL)").run(
        f.store.project.id,
        f.store.project.hostId,
        'service-2',
        '{}',
        new Date().toISOString(),
        new Date().toISOString(),
      );
    });
    assert.equal(f.inbox.recoverClaims('service-2'), 1);
    assert.equal(
      f.inbox.read(f.incarnation.controllerId).filter((i) => i.state === 'submitted').length,
      1,
    );
    assert.throws(() => f.inbox.markSubmitted(claims[1]!));
    const reclaimed = f.inbox.claim({
      controllerId: f.incarnation.controllerId,
      controllerGeneration: 1,
      serviceGeneration: 'service-2',
    });
    assert.equal(reclaimed.length, 1);
    assert.ok(reclaimed[0]!.claimRevision > claims[1]!.claimRevision);
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('controller policy revision fences decisions already claimed under old authority', () => {
  const f = fixture();
  try {
    f.events.append({
      kind: 'test',
      aggregate: { kind: 'test', id: 'a', revision: 1 },
      payload: {},
      dedupeKey: 'a',
    });
    const claims = f.inbox.claim({
      controllerId: f.incarnation.controllerId,
      controllerGeneration: 1,
      serviceGeneration: 'service-1',
    });
    f.controllers.configure({ actor: f.actor, profilePolicyId: 'new-policy', expectedRevision: 3 });
    let invoked = false;
    assert.throws(() =>
      f.inbox.commitDecision(
        { actor: f.incarnation.session, claims, decisionKey: 'stale', decision: {} },
        () => {
          invoked = true;
          return { ok: true };
        },
      ),
    );
    assert.equal(invoked, false);
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('lost controller launch response is durably claimed and ensure replay never relaunches', async () => {
  const f = fixture();
  try {
    const { HarnessCatalog } = await import('../../src/v1/harnesses/index.js');
    const { ControllerRuntime } = await import('../../src/v1/controllers/controller-runtime.js');
    const { HerdrNativeAdapter } = await import('../../src/v1/native.js');
    const catalog = new HarnessCatalog(f.store, f.actor, [
      {
        reference: { id: 'herdr', version: 1 },
        probe: async () => [
          {
            id: 'endpoint',
            hostId: f.store.project.hostId,
            locator: {
              binding: JSON.stringify({
                hostId: f.store.project.hostId,
                socketPath: '/fixture',
                workspaceId: 'w',
                endpoint: {
                  device: 1,
                  inode: 1,
                  birthtimeMs: 1,
                  serverStartToken: 'fixture-generation',
                  protocol: 1,
                },
              }),
            },
            nativeVersion: '1',
            contract: { id: 'herdr', version: 1 },
            generation: 'fixture-generation',
            methods: ['launch'],
            capabilities: ['inspect'],
            models: ['exact'],
            health: 'available',
          },
        ],
      },
    ]);
    catalog.discover(
      { id: 'herdr', provider: { id: 'herdr', version: 1 }, source: { kind: 'builtin' } },
      'discover',
    );
    await catalog.probe('herdr');
    catalog.enable({
      installationId: 'herdr',
      expectedRevision: 1,
      enabled: true,
      idempotencyKey: 'enable',
    });
    catalog.defineProfile({
      profile: {
        id: 'cos',
        endpointId: 'endpoint',
        adapter: { id: 'herdr', version: 1 },
        native: { name: 'cos', kind: 'codex', model: 'exact', args: ['--model', 'exact'] },
        workspaceAccess: 'inspect',
        enabled: true,
      },
      expectedRevision: 0,
      idempotencyKey: 'profile',
    });
    catalog.bind({
      policy: { id: 'default', profileIds: ['cos'], maxProbeAgeMs: 60000 },
      expectedRevision: 0,
      idempotencyKey: 'bind',
    });
    const route = catalog.route(
      {
        role: 'controller',
        methods: ['launch'],
        requiredCapabilities: ['inspect'],
        workspaceAccess: 'inspect',
        modelPreferences: ['exact'],
      },
      'default',
      'route',
    );
    f.controllers.reconcile({
      actor: f.actor,
      controllerId: f.incarnation.controllerId,
      generation: 1,
      expectedRevision: 3,
      observation: { kind: 'settled', reason: 'confirmed old incarnation termination' },
    });
    let launches = 0;
    class LostResponseDriver extends HerdrNativeAdapter {
      override async launch(): Promise<never> {
        launches++;
        throw new Error('response lost after native invocation');
      }
    }
    const runtime = new ControllerRuntime(
      f.store,
      join(f.root, 'binding.json'),
      (journal) => new LostResponseDriver(journal),
    );
    const input = {
      actor: f.actor,
      expectedRevision: 4,
      routeId: route.id,
      idempotencyKey: 'ensure-once',
      binding: {
        hostId: f.store.project.hostId,
        socketPath: '/fixture',
        workspaceId: 'w',
        endpoint: {
          device: 1,
          inode: 1,
          birthtimeMs: 1,
          serverStartToken: 'fixture-generation',
          protocol: 1,
        },
      },
      request: {
        cwd: f.root,
        env: {},
        agentKind: 'codex',
        agentName: 'cos',
        args: ['--model', 'exact'],
      },
    };
    await assert.rejects(runtime.ensure(input), /response lost/);
    assert.equal(launches, 1);
    const replay = await runtime.ensure(input);
    assert.equal(replay.result.kind, 'reconciliation-required');
    assert.equal(launches, 1);
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
