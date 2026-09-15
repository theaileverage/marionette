import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Fiber, Layer, Schema } from 'effect';
import { TestClock } from 'effect/testing';

import {
  DelegationDecisionUnavailable,
  DelegationOperations,
  DelegationProviderError,
  delegate,
  marionetteDelegationOperationsLayer,
  type DelegationInput,
  type DelegationOperationsInterface,
} from '../src/v1/delegation.js';
import {
  AgentSessionIdSchema,
  AttemptIdSchema,
  BriefIdSchema,
  DigestSchema,
  HostIdSchema,
  JobIdSchema,
  JobRequestIdSchema,
  ResultIdSchema,
  TimestampSchema,
  WorkspaceIdSchema,
  type Attempt,
  type Result,
} from '../src/v1/model.js';
import { MarionetteService } from '../src/v1/service.js';

const decode = <S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  encoded: S['Encoded'],
): S['Type'] => Schema.decodeSync(schema)(encoded);

const attemptId = decode(AttemptIdSchema, 'attempt-delegation');

const jobId = decode(JobIdSchema, 'job-delegation');

const workspaceId = decode(WorkspaceIdSchema, 'workspace-delegation');

const briefId = decode(BriefIdSchema, 'brief-delegation');

const timestamp = decode(TimestampSchema, '2026-09-14T00:00:00Z');

const job = {
  id: jobId,
  key: 'short-delegation',
  requestId: decode(JobRequestIdSchema, 'request-delegation'),
  currentBriefId: briefId,
  currentBriefRevision: 1,
  workspaceId,
  delivery: 'report' as const,
  origin: { kind: 'direct' as const },
  state: 'open' as const,
  createdAt: timestamp,
};

const attempt = (phase: Attempt['phase']): Attempt => ({
  id: attemptId,
  jobId,
  workflowId: null,
  stepRunId: null,
  briefId,
  briefRevision: 1,
  hostId: decode(HostIdSchema, 'host-delegation'),
  workspaceId,
  sessionId: decode(AgentSessionIdSchema, 'session-delegation'),
  sessionGeneration: 1,
  phase,
  nativeKind: null,
  nativeServerGeneration: null,
  nativeLocator: null,
  createdAt: timestamp,
  settledAt: phase === 'settled' ? timestamp : null,
});

const result: Result = {
  id: decode(ResultIdSchema, 'result-delegation'),
  jobId,
  attemptId,
  briefId,
  briefRevision: 1,
  hostId: decode(HostIdSchema, 'host-delegation'),
  workspaceId,
  inputDigest: decode(DigestSchema, '1'.repeat(64)),
  workspaceDigest: decode(DigestSchema, '2'.repeat(64)),
  content: { kind: 'report', body: 'Ready for review', artifactDigests: [] },
  evidenceClaims: [],
  evidence: [],
  verification: { kind: 'not-requested' },
  createdAt: timestamp,
};

const input: DelegationInput = {
  job: {
    stableKey: 'short-delegation',
    request: { text: 'Check the focused change', digest: decode(DigestSchema, '3'.repeat(64)), inputSnapshots: [] },
    brief: { objective: 'Check the focused change', scope: [], ownership: [], constraints: [], standingOrders: [], inputSnapshots: [] },
    workspaceId,
    delivery: 'report',
    dependencies: [],
    idempotencyKey: 'create-short-delegation',
  },
  attempt: { profile: 'test', nativeWorkspaceId: 'native-test', inputResultIds: [] },
  idempotencyKey: 'short-delegation',
  supervision: { maxChecks: 3, interval: '1 second' },
};

function testLayer(overrides: Partial<DelegationOperationsInterface> = {}) {
  const base: DelegationOperationsInterface = {
    createJob: () => Effect.succeed(job),
    admitAttempt: () => Effect.succeed(attemptId),
    startAttempt: () =>
      Effect.succeed({
        attempt: attempt('running'),
        native: { kind: 'submitted', operationId: 'start-1' },
      }),
    reconcileAttempt: () =>
      Effect.succeed({
        attempt: attempt('settled'),
        native: { kind: 'settled', identity: fixtureIdentity, slotReady: true },
      }),
    discoverResult: () => Effect.succeed({ kind: 'found', result }),
    decideResult: (decision) =>
      Effect.succeed({
        id: 'decision-1',
        resultId: decision.resultId,
        briefId,
        decision: decision.decision.kind,
        createdAt: timestamp,
        replayed: false,
      }),
  };

  return Layer.succeed(DelegationOperations, DelegationOperations.of({ ...base, ...overrides }));
}

const fixtureIdentity = {
  binding: {
    hostId: 'host-delegation',
    socketPath: '/fixture/herdr.sock',
    workspaceId: 'native-test',
    endpoint: { device: 1, inode: 2, birthtimeMs: 3, serverStartToken: 'server-1', protocol: 22 },
  },
  tabId: 'tab-1',
  paneId: 'pane-1',
  terminalId: 'terminal-1',
  agentKind: 'test',
  agentName: 'worker-1',
  identityRevision: 1,
  ownedTabId: 'tab-1',
};

test('default live layer discovers results through the public operation', async () => {
  const calls: unknown[] = [];

  const serviceLayer = Layer.succeed(
    MarionetteService,
    MarionetteService.of({
      execute: (request) =>
        Effect.sync(() => {
          calls.push(request);

          return { kind: 'found' as const, result };
        }),
      watch: () =>
        Effect.succeed({
          stopped: true,
          generation: 'test',
          deliveryPasses: 0,
          reconcilePasses: 0,
          reconciliations: 0,
          deliveries: 0,
          wakes: 0,
          wakeEndpoint: null,
        }),
    }),
  );

  const liveLayer = marionetteDelegationOperationsLayer().pipe(Layer.provide(serviceLayer));

  const discovery = await Effect.runPromise(
    Effect.gen(function* () {
      const operations = yield* DelegationOperations;

      return yield* operations.discoverResult(attemptId);
    }).pipe(Effect.provide(liveLayer)),
  );

  assert.deepEqual(discovery, { kind: 'found', result });
  assert.deepEqual(calls, [{ operation: 'result.discover', attemptId }]);
});

test('live layer preserves optional result discovery injection', async () => {
  let publicCalls = 0;

  const serviceLayer = Layer.succeed(
    MarionetteService,
    MarionetteService.of({
      execute: () =>
        Effect.sync(() => {
          publicCalls += 1;

          return { kind: 'pending' as const };
        }),
      watch: () =>
        Effect.succeed({
          stopped: true,
          generation: 'test',
          deliveryPasses: 0,
          reconcilePasses: 0,
          reconciliations: 0,
          deliveries: 0,
          wakes: 0,
          wakeEndpoint: null,
        }),
    }),
  );

  const injectedLayer = marionetteDelegationOperationsLayer(() =>
    Effect.succeed({ kind: 'pending' }),
  ).pipe(Layer.provide(serviceLayer));

  const discovery = await Effect.runPromise(
    Effect.gen(function* () {
      const operations = yield* DelegationOperations;

      return yield* operations.discoverResult(attemptId);
    }).pipe(Effect.provide(injectedLayer)),
  );

  assert.deepEqual(discovery, { kind: 'pending' });
  assert.equal(publicCalls, 0);
});

test('one call starts once, discovers a durable result, and waits for explicit acceptance', async () => {
  const calls: string[] = [];
  const decisions: string[] = [];

  const handle = await Effect.runPromise(
    delegate(input).pipe(
      Effect.provide(
        testLayer({
          createJob: (value) =>
            Effect.sync(() => {
              calls.push(`create:${value.idempotencyKey}`);

              return job;
            }),
          admitAttempt: (value) =>
            Effect.sync(() => {
              calls.push(`admit:${value.idempotencyKey}`);

              return attemptId;
            }),
          startAttempt: () =>
            Effect.sync(() => {
              calls.push('start');

              return {
                attempt: attempt('running'),
                native: { kind: 'submitted', operationId: 'start-1' },
              };
            }),
          reconcileAttempt: () =>
            Effect.sync(() => {
              calls.push('reconcile');

              return {
                attempt: attempt('settled'),
                native: { kind: 'settled', identity: fixtureIdentity, slotReady: true },
              };
            }),
          discoverResult: () =>
            Effect.sync(() => {
              calls.push('discover');

              return { kind: 'found' as const, result };
            }),
          decideResult: (value) =>
            Effect.sync(() => {
              decisions.push(value.decision.kind);

              return {
                id: 'decision-1',
                resultId: value.resultId,
                briefId,
                decision: value.decision.kind,
                createdAt: timestamp,
                replayed: false,
              };
            }),
        }),
      ),
    ),
  );

  assert.equal(handle.outcome.kind, 'result');
  assert.deepEqual(calls, ['create:create-short-delegation', 'admit:short-delegation/admit', 'start', 'reconcile', 'discover']);
  assert.deepEqual(decisions, []);
  assert.equal((await Effect.runPromise(handle.accept())).decision, 'accepted');
  assert.deepEqual(decisions, ['accepted']);
});

test('uncertain start is reconciled without replay and bounded by the test clock', async () => {
  let starts = 0;
  let reconciliations = 0;

  const layer = testLayer({
    startAttempt: () =>
      Effect.sync(() => {
        starts += 1;

        return {
          attempt: attempt('running'),
          native: { kind: 'unconfirmed', reason: 'launch pending' },
        };
      }),
    reconcileAttempt: () =>
      Effect.sync(() => {
        reconciliations += 1;

        return {
          attempt: attempt('running'),
          native: { kind: 'working', identity: fixtureIdentity },
        };
      }),
    discoverResult: () => Effect.die(new Error('discovery must not run while working')),
  });

  const handle = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* delegate(input).pipe(Effect.provide(layer), Effect.forkChild);
      yield* TestClock.adjust('3 seconds');

      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  assert.equal(handle.outcome.kind, 'timeout');
  assert.equal(handle.outcome.kind === 'timeout' ? handle.outcome.checks : 0, 3);
  assert.equal(starts, 1);
  assert.equal(reconciliations, 3);
  const error = await Effect.runPromise(handle.accept().pipe(Effect.flip));
  assert.equal(error instanceof DelegationDecisionUnavailable, true);
});

test('manual-required and provider failures remain explicit handle outcomes', async () => {
  const manual = await Effect.runPromise(
    delegate(input).pipe(
      Effect.provide(
        testLayer({
          startAttempt: () =>
            Effect.succeed({
              attempt: attempt('running'),
              native: {
                kind: 'manual-required',
                identity: fixtureIdentity,
                reason: 'approval required',
              },
            }),
        }),
      ),
    ),
  );

  assert.deepEqual(manual.outcome.kind, 'manual-required');

  const failed = await Effect.runPromise(
    delegate(input).pipe(
      Effect.provide(
        testLayer({
          startAttempt: () =>
            Effect.fail(
              new DelegationProviderError({
                operation: 'attempt.start',
                message: 'provider unavailable',
                cause: 'offline',
              }),
            ),
        }),
      ),
    ),
  );

  assert.equal(failed.outcome.kind, 'provider-failure');
  assert.equal(failed.outcome.kind === 'provider-failure' ? failed.outcome.operation : '', 'attempt.start');

  const unsupported = await Effect.runPromise(
    delegate(input).pipe(
      Effect.provide(
        testLayer({
          discoverResult: () =>
            Effect.succeed({ kind: 'unsupported', reason: 'no public result-by-attempt API' }),
        }),
      ),
    ),
  );

  assert.equal(unsupported.outcome.kind, 'unsupported');
});
