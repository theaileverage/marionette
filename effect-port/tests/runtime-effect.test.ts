import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Deferred, Effect, Schema } from 'effect';
import { composeHerdrAdapter, type HerdrEffectDriver } from '../src/v1/adapters/herdr.js';
import { codexThreadBindingSchema } from '../src/v1/adapters/codex-app-server.js';
import { Board } from '../src/v1/board.js';
import { createBinding, localSessionContext } from '../src/v1/context.js';
import {
  AgentSessionIdSchema,
  DigestSchema,
  ProjectBindingSchema,
  WorkspaceIdSchema,
} from '../src/v1/model.js';
import {
  HerdrNativeAdapter,
  NativeBindingSchema,
  NativeIdentitySchema,
  type LaunchRequest,
  type LaunchResult,
  type NativeBinding,
  type NativeJournal,
} from '../src/v1/native.js';
import { Runtime } from '../src/v1/runtime.js';
import { Settings, profileSchema } from '../src/v1/settings.js';
import { Store } from '../src/v1/store.js';
import { Watcher, type DeliveryEffectPort } from '../src/v1/watcher.js';

const decode = <S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  value: unknown,
): S['Type'] => Schema.decodeUnknownSync(schema)(value);

function runtimeFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'marionette-effect-runtime-'));
  const repository = join(root, 'repo');
  mkdirSync(repository);
  const context = createBinding({ repositoryRoot: repository, stateRoot: join(root, 'state') });
  const local = localSessionContext(context);
  const store = Store.open({
    databasePath: context.binding.databasePath,
    project: decode(ProjectBindingSchema, {
      id: context.binding.projectId,
      hostId: context.binding.hostId,
      repositoryRoot: repository,
      stateDirectory: context.binding.stateDirectory,
    }),
  });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const actor = store.registerSession({
    id: decode(AgentSessionIdSchema, local.sessionId),
    generation: local.generation,
    workspaceId: null,
    role: 'user',
    executionRole: 'user',
    tokenHash: createHash('sha256').update(local.token).digest('hex'),
    parentWorkflowId: null,
    attemptId: null,
    nativeKind: null,
    nativeLocator: null,
    nativeServerGeneration: null,
  });
  const workspace = store.registerWorkspace({
    actor,
    id: decode(WorkspaceIdSchema, 'workspace-test'),
    kind: 'existing',
    path: repository,
    repositoryRoot: repository,
    baseCommit: null,
    access: 'inspect',
    writes: [],
    idempotencyKey: 'workspace',
  });
  const requestText = 'Read-only check';
  const job = store.createJob({
    actor,
    stableKey: 'job',
    request: {
      text: requestText,
      digest: decode(DigestSchema, createHash('sha256').update(requestText).digest('hex')),
      inputSnapshots: [],
    },
    brief: {
      objective: requestText,
      scope: [],
      ownership: [],
      constraints: [],
      standingOrders: [],
      inputSnapshots: [],
    },
    workspaceId: workspace.id,
    delivery: 'report',
    origin: { kind: 'direct' },
    dependencies: [],
    idempotencyKey: 'job',
  });
  const settings = new Settings(store, actor);
  settings.set({
    key: 'profile/test',
    value: {
      name: 'test',
      kind: 'agy',
      model: 'configured-model',
      args: ['--model', 'configured-model'],
    },
    schema: profileSchema,
    expectedRevision: 0,
    idempotencyKey: 'profile',
  });
  const binding: NativeBinding = {
    hostId: store.project.hostId,
    socketPath: '/fixture/herdr.sock',
    workspaceId: 'w1',
    endpoint: {
      device: 1,
      inode: 2,
      birthtimeMs: 3,
      serverStartToken: 'server-instance',
      protocol: 22,
    },
  };
  settings.set({
    key: 'native/w1',
    value: binding,
    schema: NativeBindingSchema,
    expectedRevision: 0,
    idempotencyKey: 'native',
  });
  return {
    store,
    actor,
    context,
    binding,
    input: {
      jobId: job.id,
      profile: 'test',
      nativeWorkspaceId: 'w1',
      inputResultIds: [],
      expectedBriefRevision: 1,
      idempotencyKey: 'admit',
    },
  };
}

test('scope interruption after a durable launch claim never invokes launch twice', async (t) => {
  const fixture = runtimeFixture(t);
  const claimed = await Effect.runPromise(Deferred.make<void>());
  const release = await Effect.runPromise(Deferred.make<void>());
  let launches = 0;
  class InterruptibleAdapter extends HerdrNativeAdapter {
    constructor(private readonly effects: NativeJournal) {
      super(effects);
    }
    override readonly launchEffect = Effect.fn('InterruptibleAdapter.launch')(
      function* (this: InterruptibleAdapter, _binding: NativeBinding, _request: LaunchRequest) {
        launches += 1;
        if (!this.effects.prepareEffect)
          return yield* Effect.die(new Error('Effect journal required by interruption fixture'));
        const prepared = yield* this.effects.prepareEffect({
          kind: 'create-tab',
          workspaceId: 'w1',
        });
        assert.equal(prepared.kind, 'prepared');
        yield* Deferred.succeed(claimed, undefined);
        yield* Deferred.await(release);
        throw new Error('boundary outcome remained ambiguous');
      }.bind(this),
    );
    override launch(binding: NativeBinding, request: LaunchRequest): Promise<LaunchResult> {
      return Effect.runPromise(this.launchEffect(binding, request));
    }
  }
  const runtime = new Runtime(fixture.store, fixture.actor, fixture.context, (journal) =>
    composeHerdrAdapter(new InterruptibleAdapter(journal)),
  );
  const attemptId = runtime.admit(fixture.input);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* runtime.startEffect(attemptId).pipe(Effect.forkScoped);
        yield* Deferred.await(claimed);
      }),
    ),
  );
  await Effect.runPromise(Deferred.succeed(release, undefined));
  await runtime.start(attemptId);
  assert.equal(launches, 1);
  assert.equal(fixture.store.getAttempt(attemptId).phase, 'launching');
  const effects = fixture.store.read(
    (db) =>
      db
        .prepare('SELECT count(*) AS count FROM native_effects WHERE attempt_id=?')
        .get(attemptId) as { count: number },
  );
  assert.equal(effects.count, 1);
});

function watcherFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'marionette-effect-watcher-'));
  const store = Store.open({
    databasePath: join(root, 'project.sqlite'),
    project: decode(ProjectBindingSchema, {
      id: 'project-a',
      hostId: 'host-a',
      repositoryRoot: root,
      stateDirectory: root,
    }),
  });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const board = Board.create({ store });
  const thread = board.createThread({
    title: 'Notifications',
    author: { kind: 'system', id: 'controller' },
    idempotencyKey: 'thread',
  });
  board.subscribe({ subscriber: { kind: 'desktop', id: 'lead' }, threadId: thread.id });
  board.post({
    threadId: thread.id,
    author: { kind: 'system', id: 'controller' },
    body: 'Inspect the board.',
    kind: 'question',
    idempotencyKey: 'post',
  });
  const wake = store.read(
    (db) =>
      db
        .prepare('SELECT subscription_id FROM board_subscription_wakes WHERE project_id=?')
        .get('project-a') as {
        subscription_id: string;
      },
  );
  return { store, wakeId: wake.subscription_id };
}

test('scope close marks a claimed delivery uncertain and a replacement never replays it', async (t) => {
  const fixture = watcherFixture(t);
  const invoked = await Effect.runPromise(Deferred.make<void>());
  const never = await Effect.runPromise(Deferred.make<DeliverySubmission>());
  let deliveries = 0;
  const port: DeliveryEffectPort = {
    checkReadyEffect: () => Effect.succeed({ kind: 'ready' }),
    deliverEffect: () =>
      Effect.gen(function* () {
        deliveries += 1;
        yield* Deferred.succeed(invoked, undefined);
        return yield* Deferred.await(never);
      }),
  };
  const options = {
    store: fixture.store,
    deliveryPort: port,
    livenessPort: { confirmAbsentEffect: () => Effect.succeed(false) },
    processIdentity: 'watcher-one',
  };
  const watcher = await Effect.runPromise(Watcher.startEffect(options));
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* watcher.pollOnceEffect().pipe(Effect.forkScoped);
        yield* Deferred.await(invoked);
      }),
    ),
  );
  assert.equal(
    fixture.store.read(
      (db) =>
        (
          db
            .prepare('SELECT state FROM board_subscription_wakes WHERE subscription_id=?')
            .get(fixture.wakeId) as { state: string }
        ).state,
    ),
    'unconfirmed',
  );
  watcher.stop();
  const replacement = await Effect.runPromise(
    Watcher.startEffect({ ...options, processIdentity: 'watcher-two' }),
  );
  assert.equal(await Effect.runPromise(replacement.pollOnceEffect()), 0);
  assert.equal(deliveries, 1);
  replacement.stop();
});

test('native integer schemas retain legacy Number.isInteger bounds', () => {
  const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;
  const decoded = decode(NativeBindingSchema, {
    hostId: 'host',
    socketPath: '/socket',
    workspaceId: 'workspace',
    endpoint: {
      device: unsafeInteger,
      inode: unsafeInteger,
      birthtimeMs: 0,
      serverStartToken: 'server',
      protocol: unsafeInteger,
    },
  });
  assert.equal(decoded.endpoint.protocol, unsafeInteger);
});

test('owned public schemas accept explicit undefined for legacy optional fields', () => {
  const binding = decode(NativeBindingSchema, {
    hostId: 'host',
    socketPath: '/socket',
    workspaceId: 'workspace',
    endpoint: {
      device: 1,
      inode: 2,
      birthtimeMs: 3,
      serverStartToken: 'server',
      protocol: 1,
      endpointProtocolGeneration: undefined,
    },
  });
  assert.equal(binding.endpoint.endpointProtocolGeneration, undefined);
  const identity = decode(NativeIdentitySchema, {
    binding,
    tabId: 'tab',
    paneId: 'pane',
    terminalId: 'terminal',
    agentKind: 'agy',
    agentName: 'agent',
    nativeSession: undefined,
    foregroundProcess: { pid: 1, startToken: 'process' },
    identityRevision: 1,
    ownedTabId: 'tab',
  });
  assert.equal(identity.nativeSession, undefined);
  const codex = decode(codexThreadBindingSchema, {
    projectId: 'project',
    executionHostId: 'host',
    endpointHostId: 'host',
    endpoint: {
      kind: 'unix',
      socketPath: '/socket',
      requestPath: undefined,
      authorization: undefined,
    },
    threadId: 'thread',
    activeTurnId: undefined,
  });
  assert.equal(codex.activeTurnId, undefined);
});

test('Herdr composition accepts an Effect-only internal driver', async () => {
  const binding = decode(NativeBindingSchema, {
    hostId: 'host',
    socketPath: '/socket',
    workspaceId: 'workspace',
    endpoint: { device: 1, inode: 2, birthtimeMs: 3, serverStartToken: 'server', protocol: 1 },
  });
  const driver: HerdrEffectDriver = {
    registerEffect: () => Effect.succeed(binding),
    launchEffect: () => Effect.succeed({ kind: 'unsupported', reason: 'fixture' }),
    recoverEffect: () => Effect.succeed({ kind: 'unconfirmed', reason: 'fixture' }),
    adoptEffect: () => Effect.succeed({ kind: 'unconfirmed', reason: 'fixture' }),
    observeEffect: () => Effect.succeed({ kind: 'unconfirmed', reason: 'fixture' }),
    promptEffect: () => Effect.succeed({ kind: 'unsupported', reason: 'fixture' }),
    interruptEffect: () => Effect.succeed({ kind: 'unsupported', reason: 'fixture' }),
    cleanupEffect: () => Effect.succeed({ kind: 'unsupported', reason: 'fixture' }),
  };
  const adapter = composeHerdrAdapter(driver);
  assert.deepEqual(
    await Effect.runPromise(
      adapter.invokeEffect('register', {
        hostId: 'host',
        socketPath: '/socket',
        workspaceId: 'workspace',
      }),
    ),
    binding,
  );
  assert.deepEqual(
    await adapter.invoke('register', {
      hostId: 'host',
      socketPath: '/socket',
      workspaceId: 'workspace',
    }),
    binding,
  );
  assert.deepEqual(
    await Effect.runPromise(
      adapter.invokeEffect('launch', {
        binding,
        request: {
          cwd: '/repo',
          env: {},
          agentKind: 'agy',
          agentName: 'agent',
          args: undefined,
          timeoutMs: undefined,
        },
      }),
    ),
    { kind: 'unsupported', reason: 'fixture' },
  );
});

type DeliverySubmission =
  | { readonly kind: 'submitted' }
  | { readonly kind: 'unconfirmed'; readonly reason: string }
  | { readonly kind: 'unsupported'; readonly reason: string };
