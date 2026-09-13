import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import { composeHerdrAdapter, type HerdrAdapterFactory } from '../../src/v1/adapters/herdr.js';
import {
  HerdrNativeAdapter,
  type NativeBinding,
  type NativeIdentity,
  type NativeJournal,
  type NativeObservation,
  type NativeSubmission,
} from '../../src/v1/native.js';
import { ServiceControls } from '../../src/v1/service/controls.js';
import { ServiceOwnership } from '../../src/v1/service/ownership.js';
import { Store } from '../../src/v1/store.js';
import {
  AgentSessionIdSchema,
  ProjectIdSchema,
  HostIdSchema,
  WorkspaceIdSchema,
  WorkflowPackageSnapshotSchema,
  DigestSchema,
  WorkflowIdSchema,
} from '../../src/v1/model.js';
import { ProjectHierarchy, type ProjectCommand } from '../../src/v1/projects/index.js';
import { projectHierarchySql } from '../../src/v1/migrations/010_project_hierarchy.js';
function project(t: TestContext, id: string, host = 'host') {
  const dir = mkdtempSync(join(tmpdir(), 'hierarchy-'));
  const store = Store.open({
    databasePath: join(dir, 'db'),
    project: {
      id: ProjectIdSchema.parse(id),
      hostId: HostIdSchema.parse(host),
      repositoryRoot: dir,
      stateDirectory: dir,
    },
  });
  if (
    !store.read((db) =>
      db.prepare("SELECT name FROM sqlite_master WHERE name='project_links'").get(),
    )
  )
    store.transaction((db) => db.exec(projectHierarchySql));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const actor = store.registerSession({
    id: AgentSessionIdSchema.parse('user'),
    generation: 1,
    role: 'user',
    executionRole: 'user',
    workspaceId: null,
    tokenHash: 'a'.repeat(64),
    parentWorkflowId: null,
    attemptId: null,
    nativeKind: null,
    nativeLocator: null,
    nativeServerGeneration: null,
  });
  store.registerWorkspace({
    actor,
    id: WorkspaceIdSchema.parse('ws'),
    kind: 'isolated',
    path: dir,
    repositoryRoot: dir,
    baseCommit: 'base',
    access: 'inspect',
    writes: [],
    idempotencyKey: 'ws',
  });
  return new ProjectHierarchy(store, actor);
}
const grant = {
  verbs: [
    'workflow.create',
    'workflow.control',
    'workflow.activate',
    'workflow.status',
    'result.read',
  ] as const,
  workspaceIds: [WorkspaceIdSchema.parse('ws')],
  expiresAt: '2099-01-01T00:00:00.000Z',
};
function link(parent: ProjectHierarchy, child: ProjectHierarchy) {
  const id = parent.proposeLink(child, {
    grant: { ...grant, verbs: [...grant.verbs] },
    budgetAttempts: 4,
    expectedBudgetRevision: 1,
    idempotencyKey: 'propose',
  }).linkId;
  parent.activateLink(child, {
    linkId: id,
    expectedAuthorityRevision: 1,
    idempotencyKey: 'activate',
  });
  return id;
}
function command(): Extract<ProjectCommand, { kind: 'workflow.create' }> {
  return {
    kind: 'workflow.create',
    stableKey: 'work',
    package: WorkflowPackageSnapshotSchema.parse({
      name: 'flow',
      version: '1',
      digest: '0'.repeat(64),
      sourceDigests: [],
      entryStep: 'one',
      steps: [
        {
          name: 'one',
          phase: 'analysis',
          resources: [],
          outputContract: 'report',
          permittedMethods: ['direct'],
          requiredEvidence: [],
          requiresDistinctRole: false,
        },
      ],
      transitions: [{ kind: 'finish', from: 'one' }],
      limits: {
        maxAttempts: 3,
        maxRepeats: 1,
        parallelism: 1,
        deadlineMs: 600000,
        innerLoopDeadlineMs: 30000,
      },
    }),
    request: { text: 'work', digest: DigestSchema.parse('0'.repeat(64)), inputSnapshots: [] },
    brief: {
      objective: 'work',
      scope: [],
      ownership: [],
      constraints: [],
      standingOrders: [],
      inputSnapshots: [],
    },
    workspaceId: WorkspaceIdSchema.parse('ws'),
    delivery: 'report',
    boundary: 'all',
  };
}
function setup(t: TestContext) {
  const parent = project(t, 'parent'),
    child = project(t, 'child');
  parent.configureBudget({ capacity: 10, expectedRevision: 0, idempotencyKey: 'budget' });
  return { parent, child, id: link(parent, child) };
}
test('same-host authenticated replay creates exactly one child-owned workflow and reserves once', (t) => {
  const { parent, child, id } = setup(t);
  const input = {
    linkId: id,
    expectedAuthorityRevision: 1,
    expectedBudgetRevision: 1,
    command: command(),
    idempotencyKey: 'command',
  };
  assert.equal(parent.enqueue(input).sequence, 1);
  assert.equal(parent.enqueue(input).sequence, 1);
  assert.equal(parent.relay(child, id)[0]?.kind, 'applied');
  assert.deepEqual(parent.relay(child, id), []);
  assert.equal(child.store.listWorkflows().length, 1);
  assert.equal(parent.store.listWorkflows().length, 0);
  assert.equal(
    child.store.read(
      (db) => db.prepare('SELECT reserved FROM project_hierarchy_budget').get()?.reserved,
    ),
    3,
  );
  // Kill point simulation: child committed and parent acknowledgment was lost.
  parent.store.transaction((db) =>
    db
      .prepare(
        "UPDATE project_message_outbox SET state='pending',receipt_json=NULL WHERE link_id=?",
      )
      .run(id),
  );
  assert.equal(parent.relay(child, id)[0]?.kind, 'applied');
  assert.equal(child.store.listWorkflows().length, 1);
  assert.equal(
    child.store.read(
      (db) => db.prepare('SELECT reserved FROM project_hierarchy_budget').get()?.reserved,
    ),
    3,
  );
});
test('budget overdraw and out-of-grant work are rejected with durable child receipts', (t) => {
  const { parent, child, id } = setup(t);
  parent.enqueue({
    linkId: id,
    expectedAuthorityRevision: 1,
    expectedBudgetRevision: 1,
    command: command(),
    idempotencyKey: 'first',
  });
  parent.relay(child, id);
  parent.enqueue({
    linkId: id,
    expectedAuthorityRevision: 1,
    expectedBudgetRevision: 1,
    command: { ...command(), stableKey: 'second' },
    idempotencyKey: 'second',
  });
  assert.equal(parent.relay(child, id)[0]?.kind, 'rejected');
  assert.equal(child.store.listWorkflows().length, 1);
});
test('revocation fences queued commands and parent scopes; cross-host and cycles mutate nothing', (t) => {
  const { parent, child, id } = setup(t);
  const remote = project(t, 'remote', 'other');
  assert.throws(
    () =>
      parent.proposeLink(remote, {
        grant: { ...grant, verbs: [...grant.verbs] },
        budgetAttempts: 1,
        expectedBudgetRevision: 2,
        idempotencyKey: 'remote',
      }),
    /Cross-host/,
  );
  assert.equal(remote.list().length, 0);
  assert.throws(
    () =>
      child.proposeLink(parent, {
        grant: { ...grant, verbs: [...grant.verbs] },
        budgetAttempts: 1,
        expectedBudgetRevision: 1,
        idempotencyKey: 'cycle',
      }),
    /cycle/,
  );
  parent.enqueue({
    linkId: id,
    expectedAuthorityRevision: 1,
    expectedBudgetRevision: 1,
    command: command(),
    idempotencyKey: 'first',
  });
  parent.setLinkState(child, {
    linkId: id,
    expectedAuthorityRevision: 1,
    state: 'revoked',
    idempotencyKey: 'revoke',
  });
  assert.equal(parent.relay(child, id)[0]?.kind, 'rejected');
  assert.equal(child.store.listWorkflows().length, 0);
});
test('tampered message signature is rejected before child mutation', (t) => {
  const { parent, child, id } = setup(t);
  parent.enqueue({
    linkId: id,
    expectedAuthorityRevision: 1,
    expectedBudgetRevision: 1,
    command: command(),
    idempotencyKey: 'first',
  });
  parent.store.transaction((db) =>
    db
      .prepare('UPDATE project_message_outbox SET signature=? WHERE link_id=?')
      .run('0'.repeat(64), id),
  );
  assert.throws(() => parent.relay(child, id), /Unauthenticated/);
  assert.equal(child.store.listWorkflows().length, 0);
});
test('delegated attempt admission requires fresh parent lock and leaves no reusable authority scope', (t) => {
  const { parent, child, id } = setup(t);
  parent.enqueue({
    linkId: id,
    expectedAuthorityRevision: 1,
    expectedBudgetRevision: 1,
    command: command(),
    idempotencyKey: 'first',
  });
  parent.relay(child, id);
  const workflow = child.store.listWorkflows()[0]!;
  assert.throws(
    () => child.withWorkflowAuthority(WorkflowIdSchema.parse(workflow.id), [], () => true),
    /Exact parent/,
  );
  assert.equal(
    child.withWorkflowAuthority(workflow.id, [parent], () => true),
    true,
  );
  assert.equal(
    child.store.read(
      (db) => db.prepare('SELECT count(*) AS n FROM project_authority_scopes').get()?.n,
    ),
    0,
  );
  parent.setLinkState(child, {
    linkId: id,
    expectedAuthorityRevision: 1,
    state: 'revoked',
    idempotencyKey: 'revoke',
  });
  assert.throws(() => child.withWorkflowAuthority(workflow.id, [parent], () => true), /inactive/);
});

test('mirrored mutations converge after the child commits and the parent transaction aborts', (t) => {
  const parent = project(t, 'parent'),
    child = project(t, 'child');
  parent.configureBudget({ capacity: 10, expectedRevision: 0, idempotencyKey: 'budget' });
  const id = parent.proposeLink(child, {
    grant: { ...grant, verbs: [...grant.verbs] },
    budgetAttempts: 4,
    expectedBudgetRevision: 1,
    idempotencyKey: 'propose',
  }).linkId;
  const failNextParentUpdate = () =>
    parent.store.transaction((db) =>
      db.exec(
        "CREATE TRIGGER fail_parent_link_update BEFORE UPDATE ON project_links BEGIN SELECT RAISE(ABORT,'crash after child commit'); END",
      ),
    );
  const recoverParent = () =>
    parent.store.transaction((db) => db.exec('DROP TRIGGER fail_parent_link_update'));

  failNextParentUpdate();
  assert.throws(
    () =>
      parent.activateLink(child, {
        linkId: id,
        expectedAuthorityRevision: 1,
        idempotencyKey: 'activate',
      }),
    /crash after child commit/,
  );
  recoverParent();
  assert.equal(
    parent.activateLink(child, {
      linkId: id,
      expectedAuthorityRevision: 1,
      idempotencyKey: 'activate',
    }).state,
    'active',
  );

  const narrowed = { ...grant, verbs: ['workflow.status', 'result.read'] as const };
  failNextParentUpdate();
  assert.throws(
    () =>
      parent.updateGrant(child, {
        linkId: id,
        expectedAuthorityRevision: 1,
        grant: { ...narrowed, verbs: [...narrowed.verbs] },
        idempotencyKey: 'grant-2',
      }),
    /crash after child commit/,
  );
  recoverParent();
  assert.equal(
    parent.updateGrant(child, {
      linkId: id,
      expectedAuthorityRevision: 1,
      grant: { ...narrowed, verbs: [...narrowed.verbs] },
      idempotencyKey: 'grant-2',
    }).revision,
    2,
  );

  failNextParentUpdate();
  assert.throws(
    () =>
      parent.allocateBudget(child, {
        linkId: id,
        expectedBudgetRevision: 1,
        expectedProjectBudgetRevision: 2,
        budgetAttempts: 5,
        idempotencyKey: 'allocate-2',
      }),
    /crash after child commit/,
  );
  recoverParent();
  assert.equal(
    parent.allocateBudget(child, {
      linkId: id,
      expectedBudgetRevision: 1,
      expectedProjectBudgetRevision: 2,
      budgetAttempts: 5,
      idempotencyKey: 'allocate-2',
    }).revision,
    2,
  );

  failNextParentUpdate();
  assert.throws(
    () =>
      parent.setLinkState(child, {
        linkId: id,
        expectedAuthorityRevision: 2,
        state: 'paused',
        idempotencyKey: 'pause',
      }),
    /crash after child commit/,
  );
  recoverParent();
  assert.equal(
    parent.setLinkState(child, {
      linkId: id,
      expectedAuthorityRevision: 2,
      state: 'paused',
      idempotencyKey: 'pause',
    }).revision,
    3,
  );
});

test('child events use a signed reverse outbox and immutable parent rollups', (t) => {
  const { parent, child, id } = setup(t);
  parent.enqueue({
    linkId: id,
    expectedAuthorityRevision: 1,
    expectedBudgetRevision: 1,
    command: command(),
    idempotencyKey: 'create',
  });
  parent.relay(child, id);
  const workflow = child.store.listWorkflows()[0]!;
  assert.equal(
    child.enqueueEvent({
      linkId: id,
      expectedAuthorityRevision: 1,
      expectedBudgetRevision: 1,
      event: { kind: 'workflow.status', workflowId: workflow.id },
      idempotencyKey: 'status',
    }).sequence,
    1,
  );
  assert.equal(child.relayEvents(parent, id)[0]?.kind, 'applied');
  assert.deepEqual(child.relayEvents(parent, id), []);
  const rollups = parent.rollups(id);
  assert.equal(rollups.length, 1);
  assert.equal(rollups[0]?.sequence, 1);
  assert.equal(rollups[0]?.projection.kind, 'workflow.status');
});

test('actual delegated attempt admission debits the child and every parent link exactly once', async (t) => {
  const { parent, child, id } = setup(t);
  parent.enqueue({
    linkId: id,
    expectedAuthorityRevision: 1,
    expectedBudgetRevision: 1,
    command: command(),
    idempotencyKey: 'create',
  });
  parent.relay(child, id);
  let workflow = child.store.listWorkflows()[0]!;
  parent.enqueue({
    linkId: id,
    expectedAuthorityRevision: 1,
    expectedBudgetRevision: 1,
    command: {
      kind: 'workflow.activate',
      workflowId: workflow.id,
      expectedWorkflowRevision: workflow.revision,
      expectedBriefRevision: workflow.briefRevision,
      expectedControlRevision: workflow.controlRevision,
    },
    idempotencyKey: 'activate-workflow',
  });
  parent.relay(child, id);
  workflow = child.store.getWorkflow(workflow.id);
  const worker = child.store.registerSession({
    id: AgentSessionIdSchema.parse('worker'),
    generation: 1,
    role: 'worker',
    executionRole: 'implementation',
    workspaceId: WorkspaceIdSchema.parse('ws'),
    tokenHash: 'b'.repeat(64),
    parentWorkflowId: workflow.id,
    attemptId: null,
    nativeKind: null,
    nativeLocator: null,
    nativeServerGeneration: null,
  });
  const admit = () =>
    child.withWorkflowAuthority(workflow.id, [parent], () =>
      child.store.admitAttempt({
        actor: child.actor,
        jobId: workflow.rootJobId,
        session: worker,
        resourceKey: 'session:worker',
        inputResultIds: [],
        expectedBriefRevision: workflow.briefRevision,
        workflow: {
          kind: 'managed',
          workflowId: workflow.id,
          stepRunId: workflow.currentStepRunId,
          expectedWorkflowRevision: workflow.revision,
          expectedControlRevision: workflow.controlRevision,
        },
        idempotencyKey: 'admit',
      }),
    );
  parent.store.transaction((db) =>
    db.exec(
      "CREATE TRIGGER fail_parent_debit BEFORE INSERT ON project_link_attempt_debits BEGIN SELECT RAISE(ABORT,'crash before ancestor debit'); END",
    ),
  );
  assert.throws(admit, /crash before ancestor debit/);
  assert.equal(child.store.listAttempts({ workflowId: workflow.id }).length, 1);
  assert.equal(
    parent.store.read(
      (db) => db.prepare('SELECT count(*) AS n FROM project_link_attempt_debits').get()?.n,
    ),
    0,
  );
  parent.store.transaction((db) => db.exec('DROP TRIGGER fail_parent_debit'));
  child.withWorkflowAuthority(workflow.id, [parent], () => true);
  const first = admit();
  assert.equal(admit().attempt.id, first.attempt.id);
  const childBudget = child.store.read((db) =>
    db.prepare('SELECT reserved,consumed FROM project_hierarchy_budget').get(),
  );
  assert.equal(childBudget?.reserved, 2);
  assert.equal(childBudget?.consumed, 1);
  assert.throws(
    () =>
      child.settleWorkflowAllocation({
        workflowId: workflow.id,
        expectedBudgetRevision: 1,
        idempotencyKey: 'settle-too-early',
      }),
    /before every effect is confirmed/,
  );
  child.withWorkflowAuthority(workflow.id, [parent], () =>
    child.store.claimAttemptLaunch({
      actor: child.actor,
      attemptId: first.attempt.id,
      expectedBriefRevision: workflow.briefRevision,
      expectedControlRevision: workflow.controlRevision,
      idempotencyKey: 'claim-launch',
    }),
  );
  child.store.observeAttemptRunning({
    actor: child.actor,
    attemptId: first.attempt.id,
    nativeKind: 'herdr-pane',
    nativeServerGeneration: 'server-1',
    nativeLocator: 'pane-1',
    idempotencyKey: 'observe-running',
  });
  const binding: NativeBinding = {
    hostId: child.store.project.hostId,
    socketPath: '/fixture/herdr.sock',
    workspaceId: 'ws',
    endpoint: {
      device: 1,
      inode: 2,
      birthtimeMs: 3,
      serverStartToken: 'server-1',
      protocol: 22,
    },
  };
  const identity: NativeIdentity = {
    binding,
    tabId: 'tab-1',
    paneId: 'pane-1',
    terminalId: 'terminal-1',
    agentKind: 'agy',
    agentName: 'worker',
    nativeSession: 'session-1',
    identityRevision: 1,
    ownedTabId: 'tab-1',
  };
  child.store.transaction((db) =>
    db
      .prepare(
        "INSERT INTO native_attempts(attempt_id,project_id,binding_json,profile_json,context_path,expected_control_revision,phase,identity_json,created_at,updated_at) VALUES (?,?,?,?,?,?,'active',?,?,?)",
      )
      .run(
        first.attempt.id,
        child.store.project.id,
        JSON.stringify(binding),
        '{}',
        '/fixture/context',
        workflow.controlRevision,
        JSON.stringify(identity),
        new Date().toISOString(),
        new Date().toISOString(),
      ),
  );
  assert.equal(
    parent.store.read(
      (db) => db.prepare('SELECT count(*) AS n FROM project_link_attempt_debits').get()?.n,
    ),
    1,
  );
  parent.setLinkState(child, {
    linkId: id,
    expectedAuthorityRevision: 1,
    state: 'revoked',
    idempotencyKey: 'revoke-for-control',
  });
  assert.throws(() => child.withWorkflowAuthority(workflow.id, [parent], () => true), /inactive/);
  let interrupts = 0;
  const adapterFor: HerdrAdapterFactory = (journal) => {
    class Adapter extends HerdrNativeAdapter {
      constructor(effects: NativeJournal) {
        super(effects);
      }
      override async observe(nativeIdentity: NativeIdentity): Promise<NativeObservation> {
        return { kind: 'working', identity: nativeIdentity };
      }
      override async interrupt(nativeIdentity: NativeIdentity): Promise<NativeSubmission> {
        const prepared = await journal.prepare({
          kind: 'interrupt',
          paneId: nativeIdentity.paneId,
        });
        assert.equal(prepared.kind, 'prepared');
        interrupts++;
        return { kind: 'submitted', operationId: prepared.operationId };
      }
    }
    return composeHerdrAdapter(new Adapter(journal));
  };
  const owner = await ServiceOwnership.acquire({
    store: child.store,
    processIdentity: JSON.stringify({ pid: 42, startToken: 'hierarchy-control' }),
    livenessPort: {
      async confirmAbsent() {
        return false;
      },
    },
  });
  const controls = new ServiceControls(
    owner,
    child.actor,
    adapterFor,
    (controlledWorkflowId, input, effect) => {
      assert.equal(controlledWorkflowId, workflow.id);
      return child.withWorkflowControlAuthority(workflow.id, [parent], input, effect);
    },
  );
  await controls.scan();
  assert.equal(interrupts, 1);
  assert.equal(
    child.store.read(
      (db) =>
        db
          .prepare("SELECT count(*) AS n FROM native_effects WHERE effect_kind LIKE 'control/%'")
          .get()?.n,
    ),
    1,
  );
  owner.stop();
});

test('revoking a portfolio with active child links remains unconfirmed', (t) => {
  const parent = project(t, 'parent'),
    child = project(t, 'child'),
    grandchild = project(t, 'grandchild');
  parent.configureBudget({ capacity: 10, expectedRevision: 0, idempotencyKey: 'parent-budget' });
  const parentLink = link(parent, child);
  const childLink = child.proposeLink(grandchild, {
    grant: { ...grant, verbs: [...grant.verbs] },
    budgetAttempts: 1,
    expectedBudgetRevision: 1,
    idempotencyKey: 'child-link',
  }).linkId;
  child.activateLink(grandchild, {
    linkId: childLink,
    expectedAuthorityRevision: 1,
    idempotencyKey: 'child-activate',
  });
  assert.equal(
    parent.setLinkState(child, {
      linkId: parentLink,
      expectedAuthorityRevision: 1,
      state: 'revoked',
      idempotencyKey: 'root-revoke',
    }).settlement,
    'unconfirmed',
  );
});

test('a logical controller grant follows only its current active incarnation', (t) => {
  const parent = project(t, 'parent'),
    child = project(t, 'child');
  parent.configureBudget({ capacity: 10, expectedRevision: 0, idempotencyKey: 'budget' });
  const controllerOne = parent.store.registerSession({
    id: AgentSessionIdSchema.parse('controller'),
    generation: 1,
    role: 'controller',
    executionRole: 'controller',
    workspaceId: null,
    tokenHash: 'c'.repeat(64),
    parentWorkflowId: null,
    attemptId: null,
    nativeKind: null,
    nativeLocator: null,
    nativeServerGeneration: null,
  });
  parent.store.transaction((db) => {
    db.prepare(
      "INSERT INTO controller_definitions(id,project_id,profile_policy_id,current_generation,state,created_at) VALUES ('chief',?,'policy',1,'idle',?)",
    ).run(parent.store.project.id, new Date().toISOString());
    db.prepare(
      "INSERT INTO controller_incarnations(controller_id,generation,session_id,session_generation,adapter_id,adapter_version,endpoint_generation,state_digest,state,created_at) VALUES ('chief',1,?,1,'test','1','endpoint','digest','active',?)",
    ).run(controllerOne.id, new Date().toISOString());
  });
  const id = parent.proposeLink(child, {
    principal: { kind: 'controller', controllerId: 'chief', projectId: parent.store.project.id },
    grant: { ...grant, verbs: [...grant.verbs] },
    budgetAttempts: 4,
    expectedBudgetRevision: 1,
    idempotencyKey: 'propose',
  }).linkId;
  parent.activateLink(child, {
    linkId: id,
    expectedAuthorityRevision: 1,
    idempotencyKey: 'activate',
  });
  const first = new ProjectHierarchy(parent.store, controllerOne);
  assert.equal(
    first.enqueue({
      linkId: id,
      expectedAuthorityRevision: 1,
      expectedBudgetRevision: 1,
      command: command(),
      idempotencyKey: 'controller-one',
    }).sequence,
    1,
  );
  const controllerTwo = parent.store.registerSession({
    ...controllerOne,
    generation: 2,
    tokenHash: 'd'.repeat(64),
  });
  parent.store.transaction((db) => {
    db.prepare(
      "UPDATE controller_incarnations SET state='superseded' WHERE controller_id='chief'",
    ).run();
    db.prepare(
      "INSERT INTO controller_incarnations(controller_id,generation,session_id,session_generation,adapter_id,adapter_version,endpoint_generation,state_digest,state,created_at) VALUES ('chief',2,?,2,'test','1','endpoint','digest','active',?)",
    ).run(controllerTwo.id, new Date().toISOString());
    db.prepare("UPDATE controller_definitions SET current_generation=2 WHERE id='chief'").run();
  });
  assert.throws(
    () =>
      first.enqueue({
        linkId: id,
        expectedAuthorityRevision: 1,
        expectedBudgetRevision: 1,
        command: { ...command(), stableKey: 'stale' },
        idempotencyKey: 'stale-controller',
      }),
    /active logical controller incarnation/,
  );
  const second = new ProjectHierarchy(parent.store, controllerTwo);
  assert.equal(
    second.enqueue({
      linkId: id,
      expectedAuthorityRevision: 1,
      expectedBudgetRevision: 1,
      command: { ...command(), stableKey: 'current' },
      idempotencyKey: 'controller-two',
    }).sequence,
    2,
  );
});
