import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { before, test, type TestContext } from 'node:test';
import { build } from 'esbuild';
import { z } from 'zod';
import { Marionette } from '../../src/v1/client.js';
import { execute, operationSchema, type Operation } from '../../src/v1/operations.js';
import { parseOperationOutput } from '../../src/v1/output-contracts.js';
import { Store } from '../../src/v1/store.js';
import { WorkspaceIdSchema, DigestSchema, WorkflowIdSchema } from '../../src/v1/model.js';
import { ControllerStore } from '../../src/v1/controllers/controller-store.js';
import { ControllerInbox } from '../../src/v1/inbox/controller-inbox.js';
import { EventStore } from '../../src/v1/events/event-store.js';
import { ServiceOwnership } from '../../src/v1/service/ownership.js';
import { writeSessionContext } from '../../src/v1/context.js';
import { loadPackage } from '../../src/v1/packages.js';
const sourceRoot = process.cwd();
const bundleCliPath = join(sourceRoot, '.v1-test', 'chief-api', 'cli.mjs');
const bundleSdkPath = join(sourceRoot, '.v1-test', 'chief-api', 'index.mjs');
const cliPath = process.env.MARIONETTE_CHIEF_PACKAGE_ROOT
  ? join(process.env.MARIONETTE_CHIEF_PACKAGE_ROOT, 'dist/v1/cli.js')
  : bundleCliPath;
const sdkPath = process.env.MARIONETTE_CHIEF_PACKAGE_ROOT
  ? join(process.env.MARIONETTE_CHIEF_PACKAGE_ROOT, 'dist/v1/index.js')
  : bundleSdkPath;
before(async () => {
  await build({
    entryPoints: ['src/v1/cli.ts'],
    outfile: bundleCliPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
  });
  await build({
    entryPoints: ['src/v1/index.ts'],
    outfile: bundleSdkPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
  });
});
function fixture(t: TestContext) {
  const root = mkdtempSync('/private/tmp/ca-');
  const repositoryRoot = join(root, 'r'),
    stateHome = join(root, 's');
  mkdirSync(repositoryRoot);
  assert.equal(spawnSync('git', ['init', '-q', repositoryRoot]).status, 0);
  const client = Marionette.init({ repositoryRoot, stateHome });
  t.after(() => {
    client.close();
    rmSync(root, { recursive: true, force: true });
  });
  const context = client.context();
  const store = Store.open({
    databasePath: join(context.project.stateDirectory, 'project.sqlite'),
    project: context.project,
  });
  t.after(() => store.close());
  const env: NodeJS.ProcessEnv = { ...process.env, MARIONETTE_STATE_HOME: stateHome };
  delete env.MARIONETTE_CONTEXT;
  const cli = (operation: Operation) => {
    const [group, action] = operation.operation.split('.');
    const { operation: _, ...input } = operation;
    void _;
    const result = spawnSync(
      process.execPath,
      [cliPath, group, action, '--json', JSON.stringify(input), '--output', 'json'],
      { cwd: repositoryRoot, env, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    return parseOperationOutput(operation.operation, JSON.parse(result.stdout));
  };
  const workspaceId = WorkspaceIdSchema.parse('main');
  client.registerWorkspace({
    id: workspaceId,
    kind: 'existing',
    path: repositoryRoot,
    repositoryRoot,
    baseCommit: null,
    access: 'write',
    writes: ['**'],
    idempotencyKey: 'workspace',
  });
  function workflow(key = 'wf') {
    return client.createWorkflow({
      stableKey: key,
      package: join(sourceRoot, 'workflows/direct.json'),
      request: {
        text: 'Bounded fixture',
        digest: DigestSchema.parse('0'.repeat(64)),
        inputSnapshots: [],
      },
      brief: {
        objective: 'Bounded fixture',
        scope: ['**'],
        ownership: ['**'],
        constraints: [],
        standingOrders: [],
        inputSnapshots: [],
      },
      workspaceId,
      delivery: 'report',
      boundary: 'all',
      idempotencyKey: key,
    });
  }
  return { root, repositoryRoot, stateHome, client, context, store, env, cli, workflow };
}
async function checked(client: Marionette, input: Operation) {
  const value = await execute(client, operationSchema.parse(input));
  parseOperationOutput(input.operation, value);
  return value;
}
test('source CLI service preview and bounded service run share durable SDK state', async (t) => {
  const f = fixture(t);
  const preview = f.cli({
    operation: 'service.install',
    expectedRevision: 0,
    idempotencyKey: 'preview',
    dryRun: true,
  });
  assert.equal(z.object({ revision: z.number() }).parse(preview).revision, 0);
  assert.equal(
    f.store.read((db) => db.prepare('SELECT count(*) AS n FROM service_action_claims').get()?.n),
    0,
  );
  const output = spawnSync(
    process.execPath,
    [cliPath, 'service', 'run', '--stop-after', '50', '--output', 'json'],
    { cwd: f.repositoryRoot, env: f.env, encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(output.status, 0, output.stderr);
  assert.equal(JSON.parse(output.stdout).stopped, true);
  const status = await checked(f.client, { operation: 'service.status' });
  assert.equal(
    z.object({ instance: z.object({ state: z.string(), stopped_at: z.string() }) }).parse(status)
      .instance.state,
    'stopped',
  );
  const unbound = f.workflow('unbound-service-route');
  f.client.activateWorkflow({
    workflowId: unbound.id,
    expectedWorkflowRevision: unbound.revision,
    expectedBriefRevision: unbound.briefRevision,
    expectedControlRevision: unbound.controlRevision,
    idempotencyKey: 'unbound-activate',
  });
  const controller = new AbortController();
  const service = f.client.runService({ signal: controller.signal, watchdogMs: 10 });
  const deadline = Date.now() + 2_000;
  while (
    !f.client.events().some((event) => {
      if (event.kind !== 'service.blocked') return false;
      return JSON.parse(String(event.payload_json)).reason.includes('No execution route is bound');
    }) &&
    Date.now() < deadline
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await service;
  assert.equal(
    f.store.read(
      (db) =>
        db.prepare('SELECT count(*) AS n FROM service_instances WHERE stopped_at IS NULL').get()?.n,
    ),
    0,
  );
  assert.ok(
    f.client.events().some((event) => {
      if (event.kind !== 'service.blocked') return false;
      return JSON.parse(String(event.payload_json)).reason.includes('No execution route is bound');
    }),
  );
});
test('source workflow facade controls, revisions, limits and transition parse real contracts', async (t) => {
  const f = fixture(t);
  let w = f.workflow();
  await checked(f.client, {
    operation: 'workflow.activate',
    workflowId: w.id,
    expectedWorkflowRevision: w.revision,
    expectedBriefRevision: w.briefRevision,
    expectedControlRevision: w.controlRevision,
    idempotencyKey: 'activate',
  });
  await checked(f.client, {
    operation: 'workflow.pause',
    workflowId: w.id,
    expectedWorkflowRevision: w.revision,
    expectedControlRevision: w.controlRevision,
    mode: 'drain',
    idempotencyKey: 'pause',
  });
  w = f.client.workflow(w.id);
  assert.equal(w.phase, 'paused');
  await checked(f.client, {
    operation: 'workflow.resume',
    workflowId: w.id,
    expectedWorkflowRevision: w.revision,
    expectedBriefRevision: w.briefRevision,
    expectedControlRevision: w.controlRevision,
    decision: null,
    idempotencyKey: 'resume',
  });
  w = f.client.workflow(w.id);
  assert.equal(w.phase, 'running');
  await checked(f.client, {
    operation: 'workflow.extend-limits',
    workflowId: w.id,
    expectedLimitsRevision: 1,
    limits: { ...w.limits, maxAttempts: w.limits.maxAttempts + 1 },
    deadlineAt: w.deadlineAt,
    reason: 'One more fixture attempt',
    idempotencyKey: 'limits',
  });
  w = f.client.workflow(w.id);
  assert.equal(
    f.store.read(
      (db) =>
        db.prepare('SELECT limits_revision FROM workflow_runs WHERE id=?').get(w.id)
          ?.limits_revision,
    ),
    2,
  );
  const oldBrief = f.client.brief(w.rootJobId);
  await checked(f.client, {
    operation: 'workflow.revise',
    jobId: w.rootJobId,
    expectedBriefRevision: oldBrief.revision,
    brief: { ...oldBrief.content, objective: 'Revised fixture' },
    changeReason: 'User revision',
    idempotencyKey: 'revise',
  });
  w = f.client.workflow(w.id);
  assert.equal(w.briefRevision, 2);
  await checked(f.client, {
    operation: 'workflow.transition',
    request: {
      kind: 'block',
      workflowId: w.id,
      sourceStepRunId: w.currentStepRunId,
      expectedWorkflowRevision: w.revision,
      expectedBriefRevision: w.briefRevision,
      expectedControlRevision: w.controlRevision,
      reason: 'Fixture blocked',
      resolutionCondition: 'Human decision',
      evidenceResultIds: [],
      idempotencyKey: 'transition',
    },
  });
  w = f.client.workflow(w.id);
  await checked(f.client, { operation: 'workflow.status', id: w.id });
  await checked(f.client, {
    operation: 'workflow.cancel',
    workflowId: w.id,
    expectedWorkflowRevision: w.revision,
    expectedControlRevision: w.controlRevision,
    idempotencyKey: 'cancel',
  });
  assert.equal(f.client.workflow(w.id).phase, 'cancelled');
});
test('approval and decision list facades parse actual stored-service return values', async (t) => {
  const f = fixture(t);
  await checked(f.client, { operation: 'approval.list' });
  await checked(f.client, { operation: 'decision.list' });
  f.cli({ operation: 'approval.list' });
});
test('public project hierarchy operations link, relay and roll up across CLI and SDK', async (t) => {
  const f = fixture(t);
  const childRepository = join(f.root, 'child');
  mkdirSync(childRepository);
  assert.equal(spawnSync('git', ['init', '-q', childRepository]).status, 0);
  const child = Marionette.init({ repositoryRoot: childRepository, stateHome: f.stateHome });
  t.after(() => child.close());
  child.registerWorkspace({
    id: WorkspaceIdSchema.parse('main'),
    kind: 'existing',
    path: childRepository,
    repositoryRoot: childRepository,
    baseCommit: null,
    access: 'write',
    writes: ['**'],
    idempotencyKey: 'child-workspace',
  });
  const childBindingPath = child.context().bindingPath;
  await checked(f.client, {
    operation: 'project.budget-configure',
    capacity: 30,
    expectedRevision: 0,
    idempotencyKey: 'root-capacity',
  });
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const proposal = f.cli({
    operation: 'project.link-propose',
    childBindingPath,
    grant: {
      verbs: ['workflow.create', 'workflow.status'],
      workspaceIds: [WorkspaceIdSchema.parse('main')],
      expiresAt,
    },
    budgetAttempts: 20,
    expectedBudgetRevision: 1,
    idempotencyKey: 'link-proposal',
  });
  const linkId = z.object({ linkId: z.string() }).parse(proposal).linkId;
  await checked(f.client, {
    operation: 'project.link-activate',
    childBindingPath,
    linkId,
    expectedAuthorityRevision: 1,
    idempotencyKey: 'link-activate',
  });
  await checked(f.client, {
    operation: 'project.authority-grant',
    childBindingPath,
    linkId,
    expectedAuthorityRevision: 1,
    grant: {
      verbs: ['workflow.create', 'workflow.status', 'result.read'],
      workspaceIds: [WorkspaceIdSchema.parse('main')],
      expiresAt,
    },
    idempotencyKey: 'link-grant',
  });
  await checked(f.client, {
    operation: 'project.budget-allocate',
    childBindingPath,
    linkId,
    expectedBudgetRevision: 1,
    expectedProjectBudgetRevision: 2,
    budgetAttempts: 25,
    idempotencyKey: 'link-budget',
  });
  const grandchildRepository = join(f.root, 'grandchild');
  mkdirSync(grandchildRepository);
  assert.equal(spawnSync('git', ['init', '-q', grandchildRepository]).status, 0);
  const grandchild = Marionette.init({
    repositoryRoot: grandchildRepository,
    stateHome: f.stateHome,
  });
  t.after(() => grandchild.close());
  grandchild.registerWorkspace({
    id: WorkspaceIdSchema.parse('main'),
    kind: 'existing',
    path: grandchildRepository,
    repositoryRoot: grandchildRepository,
    baseCommit: null,
    access: 'write',
    writes: ['**'],
    idempotencyKey: 'grandchild-workspace',
  });
  const grandchildBindingPath = grandchild.context().bindingPath;
  const grandchildLink = z.object({ linkId: z.string() }).parse(
    await checked(child, {
      operation: 'project.link-propose',
      childBindingPath: grandchildBindingPath,
      grant: {
        verbs: ['workflow.create'],
        workspaceIds: [WorkspaceIdSchema.parse('main')],
        expiresAt,
      },
      budgetAttempts: 5,
      expectedBudgetRevision: 2,
      idempotencyKey: 'grandchild-proposal',
    }),
  ).linkId;
  await checked(child, {
    operation: 'project.link-activate',
    childBindingPath: grandchildBindingPath,
    linkId: grandchildLink,
    expectedAuthorityRevision: 1,
    idempotencyKey: 'grandchild-activate',
  });
  const command = {
    kind: 'workflow.create' as const,
    stableKey: 'delegated',
    package: loadPackage(join(sourceRoot, 'workflows/direct.json')),
    request: {
      text: 'Delegated fixture',
      digest: DigestSchema.parse('1'.repeat(64)),
      inputSnapshots: [],
    },
    brief: {
      objective: 'Delegated fixture',
      scope: ['**'],
      ownership: ['**'],
      constraints: [],
      standingOrders: [],
      inputSnapshots: [],
    },
    workspaceId: WorkspaceIdSchema.parse('main'),
    delivery: 'report' as const,
    boundary: 'all' as const,
  };
  await checked(f.client, {
    operation: 'project.command-enqueue',
    linkId,
    expectedAuthorityRevision: 2,
    expectedBudgetRevision: 2,
    command,
    idempotencyKey: 'child-workflow',
  });
  const commandAbort = new AbortController();
  const commandService = f.client.runService({ signal: commandAbort.signal, watchdogMs: 10 });
  const commandDeadline = Date.now() + 2_000;
  while (!child.workflows().some((workflow) => workflow.rootJobId) && Date.now() < commandDeadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  commandAbort.abort();
  await commandService;
  const relayed = f.cli({
    operation: 'project.command-relay',
    childBindingPath,
    linkId,
  });
  const receipt = z
    .array(
      z.object({
        kind: z.enum(['applied', 'rejected']),
        value: z.unknown(),
        reason: z.string().optional(),
      }),
    )
    .parse(relayed)[0];
  assert.equal(receipt, undefined);
  const workflowId = child.workflows().find((workflow) => workflow.rootJobId)?.id;
  assert.ok(workflowId);
  await checked(child, {
    operation: 'project.event-enqueue',
    linkId,
    expectedAuthorityRevision: 2,
    expectedBudgetRevision: 2,
    event: { kind: 'workflow.status', workflowId: WorkflowIdSchema.parse(workflowId) },
    idempotencyKey: 'child-status',
  });
  const eventAbort = new AbortController();
  const eventService = child.runService({ signal: eventAbort.signal, watchdogMs: 10 });
  const eventDeadline = Date.now() + 2_000;
  while (f.client.projectRollups(linkId).length === 0 && Date.now() < eventDeadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  eventAbort.abort();
  await eventService;
  const alreadyRelayed = await checked(child, {
    operation: 'project.event-relay',
    parentBindingPath: f.context.bindingPath,
    linkId,
  });
  assert.deepEqual(alreadyRelayed, []);
  const rollups = f.cli({ operation: 'project.rollup-read', linkId });
  assert.equal(
    z.array(z.object({ sequence: z.number(), projection: z.unknown() })).parse(rollups).length,
    1,
  );
  assert.equal(
    z.array(z.unknown()).parse(await checked(f.client, { operation: 'project.link-list' })).length,
    1,
  );
  const revoked = await checked(f.client, {
    operation: 'project.link-revoke',
    childBindingPath,
    linkId,
    expectedAuthorityRevision: 2,
    idempotencyKey: 'root-revoke',
  });
  assert.equal(
    z.object({ settlement: z.literal('unconfirmed') }).parse(revoked).settlement,
    'unconfirmed',
  );
  const propagationAbort = new AbortController();
  const propagationService = child.runService({
    signal: propagationAbort.signal,
    watchdogMs: 10,
  });
  const propagationDeadline = Date.now() + 2_000;
  while (
    z
      .array(z.object({ id: z.string(), state: z.string() }))
      .parse(await checked(child, { operation: 'project.link-list' }))
      .some((link) => link.id === grandchildLink && link.state !== 'revoked') &&
    Date.now() < propagationDeadline
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  propagationAbort.abort();
  await propagationService;
  assert.equal(
    z
      .array(z.object({ id: z.string(), state: z.string() }))
      .parse(await checked(child, { operation: 'project.link-list' }))
      .find((link) => link.id === grandchildLink)?.state,
    'revoked',
  );
});
test('controller context can acknowledge a closed decision exactly once through SDK', async (t) => {
  const f = fixture(t);
  const configured = await checked(f.client, {
    operation: 'controller.configure',
    profilePolicyId: 'fixture-policy',
    expectedRevision: 0,
    idempotencyKey: 'configure',
  });
  const id = z.object({ id: z.string() }).parse(configured).id;
  const controllers = new ControllerStore(f.store);
  const incarnation = controllers.ensure({
    actor: f.context.session,
    expectedRevision: 1,
    adapter: { id: 'fixture', version: 1 },
    endpointGeneration: 'fixture-server',
    stateDigest: 'fixture-digest',
  });
  controllers.reconcile({
    actor: f.context.session,
    controllerId: id,
    generation: incarnation.generation,
    expectedRevision: 2,
    observation: {
      kind: 'active',
      nativeIdentity: {
        kind: 'fixture',
        serverGeneration: 'fixture-server',
        locator: 'fixture-only',
      },
    },
  });
  const owner = await ServiceOwnership.acquire({
    store: f.store,
    processIdentity: JSON.stringify({ pid: process.pid, startToken: 'fixture-identity' }),
    livenessPort: { confirmAbsent: async () => false },
  });
  owner.heartbeat();
  new EventStore(f.store).append({
    kind: 'fixture.decision',
    aggregate: { kind: 'fixture', id: 'one', revision: 1 },
    payload: { message: 'Dismiss fixture' },
    dedupeKey: 'fixture',
  });
  const claims = new ControllerInbox(f.store).claim({
    controllerId: id,
    controllerGeneration: incarnation.generation,
    serviceGeneration: owner.generation,
  });
  assert.ok(claims.length > 0);
  const contextPath = writeSessionContext({
    stateDirectory: f.context.project.stateDirectory,
    context: {
      version: 1,
      bindingPath: f.context.bindingPath,
      projectId: f.context.project.id,
      hostId: f.context.project.hostId,
      sessionId: incarnation.session.id,
      generation: incarnation.session.generation,
      token: incarnation.token,
    },
  });
  const managed = Marionette.connect({
    cwd: f.repositoryRoot,
    env: { MARIONETTE_STATE_HOME: f.stateHome, MARIONETTE_CONTEXT: contextPath },
  });
  const operation = {
    operation: 'inbox.ack' as const,
    claims,
    decision: { kind: 'acknowledge-only' as const, reason: 'Fixture intentionally dismissed' },
    decisionKey: 'dismiss',
  };
  const first = await checked(managed, operation),
    second = await checked(managed, operation);
  assert.equal(z.object({ replayed: z.boolean() }).parse(first).replayed, false);
  assert.equal(z.object({ replayed: z.boolean() }).parse(second).replayed, true);
  assert.ok(managed.readInbox(id).every((row) => row.state === 'acknowledged'));
  assert.throws(
    () =>
      operationSchema.parse({
        ...operation,
        decision: { kind: 'unrestricted-sql', sql: 'DELETE FROM jobs' },
      }),
    /invalid_union_discriminator/,
  );
  managed.close();
  owner.stop();
});

// Set MARIONETTE_CHIEF_PACKAGE_ROOT to the unpacked, installed package root to run these CLI/SDK checks against its artifacts.
test('artifact SDK opens the same state and executes public controller operations', (t) => {
  const f = fixture(t);
  const script = `import assert from 'node:assert/strict';import {Marionette} from ${JSON.stringify(pathToFileURL(sdkPath).href)};
 const client=Marionette.connect({cwd:process.argv[1],env:{MARIONETTE_STATE_HOME:process.argv[2]}});
 try {const configured=client.configureController({profilePolicyId:'artifact-policy',expectedRevision:0,idempotencyKey:'artifact-configure'});assert.equal(client.controllerStatus().id,configured.id);assert.equal(client.serviceStatus().revision,0);assert.deepEqual(client.nativeApprovals().list(),{exact:[],legacy:[]});console.log(JSON.stringify({controllerId:configured.id}));} finally {client.close();}`;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', script, f.repositoryRoot, f.stateHome],
    { cwd: f.repositoryRoot, env: f.env, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).controllerId, f.client.controllerStatus()?.id);
});
