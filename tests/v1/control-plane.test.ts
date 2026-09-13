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
import { ControllerRuntime } from '../../src/v1/controllers/controller-runtime.js';
import {
  HerdrNativeAdapter,
  type NativeIdentity,
  type NativeJournal,
} from '../../src/v1/native.js';
import { operationSchema } from '../../src/v1/operations.js';
import { HarnessCatalog } from '../../src/v1/harnesses/index.js';
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
  const nativeIdentity: NativeIdentity = {
    binding: {
      hostId: project.hostId,
      socketPath: '/fixture/controller.sock',
      workspaceId: 'controller-workspace',
      endpoint: {
        device: 1,
        inode: 2,
        birthtimeMs: 3,
        serverStartToken: 'fixture-generation',
        protocol: 22,
      },
    },
    tabId: 'controller-workspace:tab',
    paneId: 'controller-workspace:pane',
    terminalId: 'controller-terminal',
    agentKind: 'herdr',
    agentName: 'fixture-controller',
    nativeSession: 'fixture-controller-session',
    identityRevision: 1,
    ownedTabId: 'controller-workspace:tab',
  };
  const incarnation = controllers.ensure({
    actor,
    expectedRevision: 1,
    adapter: { id: 'herdr', version: 1 },
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
      nativeIdentity: {
        kind: 'herdr',
        serverGeneration: 'fixture-generation',
        locator: JSON.stringify(nativeIdentity),
      },
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
    nativeIdentity,
  };
}

async function controllerPromptRoute(f: ReturnType<typeof fixture>) {
  const catalog = new HarnessCatalog(f.store, f.actor, [
    {
      reference: { id: 'herdr', version: 1 },
      probe: async () => [
        {
          id: 'controller-endpoint',
          hostId: f.store.project.hostId,
          locator: { binding: JSON.stringify(f.nativeIdentity.binding) },
          nativeVersion: '1',
          contract: { id: 'herdr', version: 1 },
          generation: 'fixture-generation',
          methods: ['launch', 'prompt'],
          capabilities: ['inspect'],
          models: ['exact'],
          health: 'available' as const,
        },
      ],
    },
  ]);
  catalog.discover(
    { id: 'controller-herdr', provider: { id: 'herdr', version: 1 }, source: { kind: 'builtin' } },
    'discover-controller',
  );
  await catalog.probe('controller-herdr');
  catalog.enable({
    installationId: 'controller-herdr',
    expectedRevision: 1,
    enabled: true,
    idempotencyKey: 'enable-controller',
  });
  catalog.defineProfile({
    profile: {
      id: 'controller-profile',
      endpointId: 'controller-endpoint',
      adapter: { id: 'herdr', version: 1 },
      native: {
        name: 'controller',
        kind: 'herdr',
        model: 'exact',
        args: ['--model', 'exact'],
      },
      workspaceAccess: 'inspect',
      enabled: true,
    },
    expectedRevision: 0,
    idempotencyKey: 'controller-profile',
  });
  catalog.bind({
    policy: {
      id: 'controller-policy',
      profileIds: ['controller-profile'],
      maxProbeAgeMs: 60_000,
    },
    expectedRevision: 0,
    idempotencyKey: 'controller-policy',
  });
  const route = catalog.route(
    {
      role: 'controller',
      methods: ['prompt'],
      requiredCapabilities: ['inspect'],
      workspaceAccess: 'inspect',
      modelPreferences: ['exact'],
    },
    'controller-policy',
    'controller-route',
  );
  f.store.transaction((db) =>
    db
      .prepare(
        'UPDATE controller_incarnations SET route_decision_id=? WHERE controller_id=? AND generation=?',
      )
      .run(route.id, f.incarnation.controllerId, f.incarnation.generation),
  );
  return route;
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
    assert.equal(
      f.inbox.read(f.incarnation.controllerId, { ids: [claim.id] })[0]?.state,
      'acknowledged',
    );
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
    assert.equal(
      f.inbox.read(f.incarnation.controllerId, { afterSequence: 0 })[0]?.state,
      'dead-letter',
    );
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
          nativeIdentity: {
            kind: 'herdr',
            serverGeneration: 'another-server',
            locator: JSON.stringify(f.nativeIdentity),
          },
        },
      }),
    );
    f.controllers.reconcile({
      ...base,
      expectedRevision: 4,
      observation: {
        kind: 'active',
        nativeIdentity: {
          kind: 'herdr',
          serverGeneration: 'fixture-generation',
          locator: JSON.stringify(f.nativeIdentity),
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

test('policy changes revoke old controller authority without claiming its native process stopped', () => {
  const f = fixture();
  try {
    f.events.append({
      kind: 'test.old-submitted',
      aggregate: { kind: 'fixture', id: 'old-submitted', revision: 1 },
      payload: {},
      dedupeKey: 'old-submitted',
    });
    const [oldClaim] = f.inbox.claim({
      controllerId: f.incarnation.controllerId,
      controllerGeneration: f.incarnation.generation,
      serviceGeneration: 'service-1',
    });
    assert.ok(oldClaim);
    f.inbox.markSubmitted(oldClaim);
    f.store.transaction((db) =>
      db
        .prepare(
          "INSERT INTO controller_native_effects(id,project_id,controller_id,generation,effect_json,state,created_at,inbox_claims_json,receipt_json,settled_at) VALUES(?,?,?,?,?,'claimed',?,?,NULL,NULL)",
        )
        .run(
          'ambiguous-old-effect',
          f.store.project.id,
          f.incarnation.controllerId,
          f.incarnation.generation,
          JSON.stringify({ kind: 'prompt' }),
          new Date().toISOString(),
          JSON.stringify([{ id: oldClaim.id, claimRevision: oldClaim.claimRevision }]),
        ),
    );
    f.controllers.configure({
      actor: f.actor,
      profilePolicyId: 'replacement',
      expectedRevision: 3,
    });
    assert.throws(() =>
      f.store.authenticateSession({ ...f.incarnation.session, token: f.incarnation.token }),
    );
    const state = f.store.read((db) => ({
      incarnation: db
        .prepare('SELECT state FROM controller_incarnations WHERE controller_id=? AND generation=?')
        .get(f.incarnation.controllerId, f.incarnation.generation),
      session: db
        .prepare('SELECT state FROM agent_sessions WHERE id=? AND generation=?')
        .get(f.incarnation.session.id, f.incarnation.session.generation),
      retirement: db.prepare('SELECT disposition FROM controller_incarnation_retirements').get(),
      effect: db.prepare('SELECT state FROM controller_native_effects').get(),
    }));
    assert.equal(state.incarnation?.state, 'superseded');
    assert.equal(state.session?.state, 'unconfirmed');
    assert.equal(state.retirement?.disposition, 'unconfirmed');
    assert.equal(state.effect?.state, 'claimed');
    assert.equal(
      f.inbox.read(f.incarnation.controllerId, { ids: [oldClaim.id] })[0]?.state,
      'superseded',
    );
    const next = f.controllers.ensure({
      actor: f.actor,
      expectedRevision: 4,
      adapter: { id: 'herdr', version: 1 },
      endpointGeneration: 'next-endpoint',
      stateDigest: 'next-digest',
    });
    assert.equal(next.generation, 2);
    const nextIdentity = {
      ...f.nativeIdentity,
      binding: {
        ...f.nativeIdentity.binding,
        endpoint: { ...f.nativeIdentity.binding.endpoint, serverStartToken: 'next-endpoint' },
      },
      nativeSession: 'next-controller-session',
    };
    f.controllers.reconcile({
      actor: f.actor,
      controllerId: next.controllerId,
      generation: next.generation,
      expectedRevision: 5,
      observation: {
        kind: 'active',
        nativeIdentity: {
          kind: 'herdr',
          serverGeneration: 'next-endpoint',
          locator: JSON.stringify(nextIdentity),
        },
      },
    });
    f.events.append({
      kind: 'test.new-authority',
      aggregate: { kind: 'fixture', id: 'new-authority', revision: 1 },
      payload: {},
      dedupeKey: 'new-authority',
    });
    const nextClaims = f.inbox.claim({
      controllerId: next.controllerId,
      controllerGeneration: next.generation,
      serviceGeneration: 'service-1',
    });
    assert.ok(nextClaims.some((claim) => claim.id !== oldClaim.id));
    const resolution = f.controllers.resolveEffect({
      actor: f.actor,
      effectId: 'ambiguous-old-effect',
      expectedAuthorityRevision: 2,
      reason: 'Explicitly abandon the superseded controller prompt',
    });
    assert.equal(resolution.effectId, 'ambiguous-old-effect');
    assert.equal(resolution.state, 'settled');
    assert.match(resolution.settledAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(
      f.controllers.resolveEffect({
        actor: f.actor,
        effectId: 'ambiguous-old-effect',
        expectedAuthorityRevision: 2,
        reason: 'A replay must preserve the first settlement evidence',
      }),
      resolution,
    );
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('projector assigns priority and a service claim batch reserves background fairness', () => {
  const f = fixture();
  try {
    for (const event of [
      { kind: 'recovery.classified', id: 'background' },
      { kind: 'test.normal', id: 'normal' },
      { kind: 'approval.requested', id: 'urgent' },
    ])
      f.events.append({
        kind: event.kind,
        aggregate: { kind: 'fixture', id: event.id, revision: 1 },
        payload: {},
        dedupeKey: event.id,
      });
    const rows = f.inbox.read(f.incarnation.controllerId);
    const priorities = new Map(rows.map((row) => [String(row.kind), Number(row.priority)]));
    assert.equal(priorities.get('approval.requested'), 0);
    assert.equal(priorities.get('test.normal'), 1);
    assert.equal(priorities.get('recovery.classified'), 2);
    const claims = f.inbox.claim({
      controllerId: f.incarnation.controllerId,
      controllerGeneration: f.incarnation.generation,
      serviceGeneration: 'service-1',
      limit: 2,
    });
    assert.deepEqual(
      claims.map((claim) => rows.find((row) => row.id === claim.id)?.kind),
      ['approval.requested', 'recovery.classified'],
    );
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('current claims remain readable after more than 500 terminal inbox records', () => {
  const f = fixture();
  try {
    const timestamp = new Date().toISOString();
    f.store.transaction((db) => {
      const event = db.prepare('INSERT INTO domain_events VALUES(?,?,?,?,?,?,?,?,?,?,?)');
      const item = db.prepare(
        "INSERT INTO controller_inbox_items(id,project_id,controller_id,event_id,dedupe_key,priority,not_before,state) VALUES(?,?,?,?,?,?,?,'superseded')",
      );
      for (let sequence = 1; sequence <= 501; sequence++) {
        const id = `history-${sequence}`;
        event.run(
          id,
          f.store.project.id,
          sequence,
          'test.history',
          'fixture',
          id,
          1,
          '{}',
          '{}',
          id,
          timestamp,
        );
        item.run(
          `item-${id}`,
          f.store.project.id,
          f.incarnation.controllerId,
          id,
          id,
          1,
          timestamp,
        );
      }
    });
    f.events.append({
      kind: 'test.current',
      aggregate: { kind: 'fixture', id: 'current', revision: 1 },
      payload: { current: true },
      dedupeKey: 'current',
    });
    const current = f.inbox.read(f.incarnation.controllerId);
    assert.equal(current.length, 1);
    assert.equal(current[0]?.kind, 'test.current');
    assert.equal(
      f.inbox.read(f.incarnation.controllerId, { ids: ['item-history-1'] })[0]?.kind,
      'test.history',
    );
    assert.equal(f.inbox.read(f.incarnation.controllerId, { afterSequence: 500 }).length, 2);
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('failures before native claim retry finitely and dead-letter without a prompt effect', async () => {
  const f = fixture();
  try {
    f.events.append({
      kind: 'test.pre-invocation',
      aggregate: { kind: 'fixture', id: 'pre-invocation', revision: 1 },
      payload: {},
      dedupeKey: 'pre-invocation',
    });
    class BeforeClaimFailure extends HerdrNativeAdapter {
      override async prompt(): Promise<never> {
        throw new Error('fixture failed before journal claim');
      }
    }
    const runtime = new ControllerRuntime(
      f.store,
      join(f.root, 'binding.json'),
      (journal) => new BeforeClaimFailure(journal),
    );
    for (let attempt = 0; attempt < 5; attempt++) {
      const [claim] = f.inbox.claim({
        controllerId: f.incarnation.controllerId,
        controllerGeneration: f.incarnation.generation,
        serviceGeneration: 'service-1',
      });
      assert.ok(claim);
      await assert.rejects(
        runtime.submit({ actor: f.actor, claims: [claim], expectedRevision: 3 }),
        /before journal claim/,
      );
      assert.equal(f.inbox.read(f.incarnation.controllerId)[0]?.state, 'claimed');
      f.inbox.release({
        claim,
        reason: 'pre-invocation failure',
        retryAt: new Date(0).toISOString(),
      });
    }
    assert.equal(
      f.inbox.read(f.incarnation.controllerId, { afterSequence: 0 })[0]?.state,
      'dead-letter',
    );
    assert.equal(
      f.store.read(
        (db) => db.prepare('SELECT count(*) AS n FROM controller_native_effects').get()?.n,
      ),
      0,
    );
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('prompt effect claim and submitted state are atomic; ambiguity cannot send a second prompt', async () => {
  const f = fixture();
  try {
    await controllerPromptRoute(f);
    f.events.append({
      kind: 'test.prompt',
      aggregate: { kind: 'fixture', id: 'prompt', revision: 1 },
      payload: {},
      dedupeKey: 'prompt-event',
    });
    const [claim] = f.inbox.claim({
      controllerId: f.incarnation.controllerId,
      controllerGeneration: f.incarnation.generation,
      serviceGeneration: 'service-1',
    });
    assert.ok(claim);
    let prompts = 0;
    let atomic = false;
    class AmbiguousPrompt extends HerdrNativeAdapter {
      constructor(private readonly effects: NativeJournal) {
        super(effects);
      }
      override async prompt(identity: NativeIdentity, text: string): Promise<never> {
        const prepared = await this.effects.prepare({
          kind: 'prompt',
          paneId: identity.paneId,
          textDigest: createHash('sha256').update(text).digest('hex'),
        });
        assert.equal(prepared.kind, 'prepared');
        prompts++;
        atomic = f.store.read((db) => {
          const effect = db
            .prepare('SELECT inbox_claims_json FROM controller_native_effects WHERE id=?')
            .get(prepared.operationId);
          const item = db
            .prepare('SELECT state FROM controller_inbox_items WHERE id=?')
            .get(claim.id);
          return Boolean(effect?.inbox_claims_json) && item?.state === 'submitted';
        });
        throw new Error('fixture response lost after prompt invocation');
      }
    }
    const runtime = new ControllerRuntime(
      f.store,
      join(f.root, 'binding.json'),
      (journal) => new AmbiguousPrompt(journal),
    );
    await assert.rejects(
      runtime.submit({ actor: f.actor, claims: [claim], expectedRevision: 3 }),
      /response lost after prompt invocation/,
    );
    assert.equal(atomic, true);
    await assert.rejects(
      runtime.submit({ actor: f.actor, claims: [claim], expectedRevision: 3 }),
      /requires reconciliation/,
    );
    assert.equal(prompts, 1);
    f.store.transaction((db) => {
      db.prepare(
        "UPDATE service_instances SET state='unconfirmed',stopped_at=? WHERE generation='service-1'",
      ).run(new Date().toISOString());
      db.prepare("INSERT INTO service_instances VALUES(?,?,?,?,'ready',?,?,NULL)").run(
        f.store.project.id,
        f.store.project.hostId,
        'service-2',
        '{}',
        new Date().toISOString(),
        new Date().toISOString(),
      );
    });
    assert.equal(f.inbox.recoverClaims('service-2'), 0);
    assert.equal(f.inbox.read(f.incarnation.controllerId)[0]?.state, 'submitted');
    f.inbox.commitDecision(
      {
        actor: f.incarnation.session,
        claims: [claim],
        decisionKey: 'prompt-decision',
        decision: { kind: 'dismiss', reason: 'fixture processed' },
      },
      () => ({ processed: true }),
    );
    const effect = f.store.read((db) =>
      db.prepare('SELECT state,receipt_json FROM controller_native_effects').get(),
    );
    assert.equal(effect?.state, 'settled');
    assert.match(String(effect?.receipt_json), /decisionCycleId/);
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('explicit replacement requires exact idle observation and revokes the old token durably', async () => {
  const f = fixture();
  try {
    await controllerPromptRoute(f);
    f.events.append({
      kind: 'test.before-replacement',
      aggregate: { kind: 'fixture', id: 'before-replacement', revision: 1 },
      payload: {},
      dedupeKey: 'before-replacement',
    });
    const [oldClaim] = f.inbox.claim({
      controllerId: f.incarnation.controllerId,
      controllerGeneration: f.incarnation.generation,
      serviceGeneration: 'service-1',
    });
    assert.ok(oldClaim);
    class AmbiguousPrompt extends HerdrNativeAdapter {
      constructor(private readonly effects: NativeJournal) {
        super(effects);
      }
      override async prompt(identity: NativeIdentity, text: string): Promise<never> {
        const prepared = await this.effects.prepare({
          kind: 'prompt',
          paneId: identity.paneId,
          textDigest: createHash('sha256').update(text).digest('hex'),
        });
        assert.equal(prepared.kind, 'prepared');
        throw new Error('fixture lost prompt response');
      }
    }
    await assert.rejects(
      new ControllerRuntime(
        f.store,
        join(f.root, 'binding.json'),
        (journal) => new AmbiguousPrompt(journal),
      ).submit({ actor: f.actor, claims: [oldClaim], expectedRevision: 3 }),
      /lost prompt response/,
    );
    const oldEffect = f.store.read((db) =>
      db.prepare("SELECT * FROM controller_native_effects WHERE state='claimed'").get(),
    );
    assert.ok(oldEffect);
    class IdleController extends HerdrNativeAdapter {
      override async observe(identity: NativeIdentity) {
        return { kind: 'settled' as const, identity, slotReady: true as const };
      }
    }
    const runtime = new ControllerRuntime(
      f.store,
      join(f.root, 'binding.json'),
      (journal) => new IdleController(journal),
    );
    const request = {
      controllerId: f.incarnation.controllerId,
      generation: f.incarnation.generation,
      expectedRevision: 3,
      reason: 'Explicit fixture replacement',
      idempotencyKey: 'replace-controller',
    };
    assert.equal((await runtime.replace({ ...request, actor: f.actor })).generation, 1);
    assert.throws(() =>
      f.store.authenticateSession({ ...f.incarnation.session, token: f.incarnation.token }),
    );
    assert.equal(
      f.store.read(
        (db) =>
          db.prepare('SELECT disposition FROM controller_incarnation_retirements').get()
            ?.disposition,
      ),
      'settled',
    );
    assert.equal(
      f.store.read((db) => db.prepare('SELECT state FROM controller_native_effects').get()?.state),
      'claimed',
    );
    assert.equal(
      f.store.read(
        (db) =>
          db.prepare('SELECT state FROM controller_inbox_items WHERE id=?').get(oldClaim.id)?.state,
      ),
      'superseded',
    );
    const next = f.controllers.ensure({
      actor: f.actor,
      expectedRevision: 4,
      adapter: { id: 'herdr', version: 1 },
      endpointGeneration: 'replacement-endpoint',
      stateDigest: 'replacement-digest',
    });
    const nextIdentity: NativeIdentity = {
      ...f.nativeIdentity,
      binding: {
        ...f.nativeIdentity.binding,
        endpoint: {
          ...f.nativeIdentity.binding.endpoint,
          serverStartToken: 'replacement-endpoint',
        },
      },
      paneId: 'replacement-pane',
    };
    f.controllers.reconcile({
      actor: f.actor,
      controllerId: next.controllerId,
      generation: next.generation,
      expectedRevision: 5,
      observation: {
        kind: 'active',
        nativeIdentity: {
          kind: 'herdr',
          serverGeneration: 'replacement-endpoint',
          locator: JSON.stringify(nextIdentity),
        },
      },
    });
    f.events.append({
      kind: 'test.after-replacement',
      aggregate: { kind: 'fixture', id: 'after-replacement', revision: 1 },
      payload: {},
      dedupeKey: 'after-replacement',
    });
    const nextClaims = f.inbox.claim({
      controllerId: next.controllerId,
      controllerGeneration: next.generation,
      serviceGeneration: 'service-1',
    });
    assert.ok(nextClaims.some((claim) => claim.id !== oldClaim.id));
    const resolution = f.controllers.resolveEffect({
      actor: f.actor,
      effectId: String(oldEffect.id),
      expectedAuthorityRevision: 2,
      reason: 'Explicitly settle the replaced controller prompt',
    });
    assert.equal(resolution.effectId, oldEffect.id);
    assert.equal(resolution.state, 'settled');
    assert.doesNotThrow(() =>
      operationSchema.parse({
        operation: 'controller.replace',
        ...request,
      }),
    );
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('confirmed controller launch settles only its launch effects with exact identity evidence', async () => {
  const f = fixture();
  try {
    const route = await controllerPromptRoute(f);
    f.controllers.reconcile({
      actor: f.actor,
      controllerId: f.incarnation.controllerId,
      generation: f.incarnation.generation,
      expectedRevision: 3,
      observation: { kind: 'settled', reason: 'old fixture controller is idle' },
    });
    class SuccessfulLaunch extends HerdrNativeAdapter {
      constructor(private readonly effects: NativeJournal) {
        super(effects);
      }
      override async launch() {
        const created = await this.effects.prepare({
          kind: 'create-tab',
          workspaceId: f.nativeIdentity.binding.workspaceId,
        });
        assert.equal(created.kind, 'prepared');
        const started = await this.effects.prepare({
          kind: 'start-agent',
          paneId: f.nativeIdentity.paneId,
          agentKind: f.nativeIdentity.agentKind,
        });
        assert.equal(started.kind, 'prepared');
        return { kind: 'launched' as const, identity: f.nativeIdentity };
      }
    }
    const runtime = new ControllerRuntime(
      f.store,
      join(f.root, 'binding.json'),
      (journal) => new SuccessfulLaunch(journal),
    );
    const result = await runtime.ensure({
      actor: f.actor,
      expectedRevision: 4,
      routeId: route.id,
      idempotencyKey: 'successful-launch',
      binding: f.nativeIdentity.binding,
      request: {
        cwd: f.root,
        env: {},
        agentKind: 'herdr',
        agentName: 'controller',
        args: ['--model', 'exact'],
      },
    });
    assert.equal(result.result.kind, 'launched');
    const effects = f.store.read((db) =>
      db
        .prepare('SELECT state,receipt_json FROM controller_native_effects ORDER BY created_at,id')
        .all(),
    );
    assert.equal(effects.length, 2);
    assert.ok(effects.every((effect) => effect.state === 'settled'));
    assert.ok(effects.every((effect) => String(effect.receipt_json).includes('identity')));
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
