import { Context, Effect, Layer, Ref, Schedule, Schema, type Duration } from 'effect';

import type { Evidence, Result, AttemptId } from './model.js';
import type { Operation } from './operations.js';
import {
  parseOperationOutput,
  type OperationOutput,
} from './output-contracts.js';
import { MarionetteService } from './service.js';

type OperationName = Operation['operation'];

type InputFor<Name extends OperationName> = Omit<
  Extract<Operation, { readonly operation: Name }>,
  'operation'
>;

type JobCreateInput = InputFor<'job.create'>;

type AttemptAdmitInput = InputFor<'attempt.admit'>;

type ResultDecisionInput = InputFor<'result.decide'>;

type AttemptNative = OperationOutput<'attempt.start'>;

type ResultDecision = OperationOutput<'result.decide'>;

const nonEmpty = Schema.String.check(Schema.isMinLength(1));

export class DelegationProviderError extends Schema.TaggedError<DelegationProviderError>()(
  'DelegationProviderError',
  {
    operation: nonEmpty,
    message: nonEmpty,
    cause: Schema.Defect(),
  },
) {}

export class DelegationInputError extends Schema.TaggedError<DelegationInputError>()(
  'DelegationInputError',
  {
    message: nonEmpty,
  },
) {}

export class DelegationDecisionUnavailable extends Schema.TaggedError<DelegationDecisionUnavailable>()(
  'DelegationDecisionUnavailable',
  {
    attemptId: nonEmpty,
    reason: nonEmpty,
  },
) {}

const providerError = (operation: string, cause: unknown) =>
  cause instanceof DelegationProviderError
    ? cause
    : new DelegationProviderError({
        operation,
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

export interface DelegationOperationsInterface {
  readonly createJob: (
    input: JobCreateInput,
  ) => Effect.Effect<OperationOutput<'job.create'>, DelegationProviderError>;
  readonly admitAttempt: (
    input: AttemptAdmitInput,
  ) => Effect.Effect<OperationOutput<'attempt.admit'>, DelegationProviderError>;
  readonly startAttempt: (
    attemptId: AttemptId,
  ) => Effect.Effect<AttemptNative, DelegationProviderError>;
  readonly reconcileAttempt: (
    attemptId: AttemptId,
  ) => Effect.Effect<OperationOutput<'attempt.reconcile'>, DelegationProviderError>;
  readonly discoverResult: (
    attemptId: AttemptId,
  ) => Effect.Effect<ResultDiscoveryOutcome, DelegationProviderError>;
  readonly decideResult: (
    input: ResultDecisionInput,
  ) => Effect.Effect<ResultDecision, DelegationProviderError>;
}

/** Public-operation boundary used by the orchestration and by deterministic test layers. */
export class DelegationOperations extends Context.Service<
  DelegationOperations,
  DelegationOperationsInterface
>()('marionette/DelegationOperations') {}

export type ResultDiscovery = (
  attemptId: AttemptId,
) => Effect.Effect<ResultDiscoveryOutcome, unknown>;

export type ResultDiscoveryOutcome =
  | { readonly kind: 'found'; readonly result: Result }
  | { readonly kind: 'pending' }
  | { readonly kind: 'unsupported'; readonly reason: string };

/** Adapts MarionetteService's public operations, with optional deterministic discovery injection. */
export const marionetteDelegationOperationsLayer = (discoverResult?: ResultDiscovery) =>
  Layer.effect(
    DelegationOperations,
    Effect.gen(function* () {
      const marionette = yield* MarionetteService;

      const run = <Name extends OperationName>(
        operation: Name,
        input: Extract<Operation, { readonly operation: Name }>,
      ): Effect.Effect<OperationOutput<Name>, DelegationProviderError> =>
        marionette.execute(input).pipe(
          Effect.flatMap((output) =>
            Effect.try({
              try: () => parseOperationOutput(operation, output),
              catch: (cause) => providerError(operation, cause),
            }),
          ),
          Effect.mapError((cause) => providerError(operation, cause)),
        );

      return DelegationOperations.of({
        createJob: Effect.fn('DelegationOperations.createJob')((input) =>
          run('job.create', { operation: 'job.create', ...input }),
        ),
        admitAttempt: Effect.fn('DelegationOperations.admitAttempt')((input) =>
          run('attempt.admit', { operation: 'attempt.admit', ...input }),
        ),
        startAttempt: Effect.fn('DelegationOperations.startAttempt')((attemptId) =>
          run('attempt.start', { operation: 'attempt.start', id: attemptId }),
        ),
        reconcileAttempt: Effect.fn('DelegationOperations.reconcileAttempt')((attemptId) =>
          run('attempt.reconcile', { operation: 'attempt.reconcile', id: attemptId }),
        ),
        discoverResult: Effect.fn('DelegationOperations.discoverResult')(function* (attemptId) {
          if (discoverResult !== undefined) {
            return yield* discoverResult(attemptId).pipe(
              Effect.mapError((cause) => providerError('result.discover', cause)),
            );
          }

          return yield* run('result.discover', { operation: 'result.discover', attemptId });
        }),
        decideResult: Effect.fn('DelegationOperations.decideResult')((input) =>
          run('result.decide', { operation: 'result.decide', ...input }),
        ),
      });
    }),
  );

export interface DelegationInput {
  readonly job: JobCreateInput;
  readonly attempt: Omit<AttemptAdmitInput, 'jobId' | 'expectedBriefRevision' | 'idempotencyKey'>;
  readonly idempotencyKey: string;
  readonly supervision: {
    readonly maxChecks: number;
    readonly interval: Duration.Input;
  };
}

export type DelegationOutcome =
  | { readonly kind: 'result'; readonly result: Result; readonly last: AttemptNative }
  | { readonly kind: 'blocked'; readonly reason: string; readonly last: AttemptNative }
  | { readonly kind: 'manual-required'; readonly reason: string; readonly last: AttemptNative }
  | { readonly kind: 'unconfirmed'; readonly reason: string; readonly last: AttemptNative }
  | { readonly kind: 'unsupported'; readonly reason: string; readonly last: AttemptNative }
  | { readonly kind: 'awaiting-result'; readonly checks: number; readonly last: AttemptNative }
  | { readonly kind: 'timeout'; readonly checks: number; readonly last: AttemptNative }
  | {
      readonly kind: 'provider-failure';
      readonly operation: string;
      readonly reason: string;
      readonly last: AttemptNative | null;
    };

export interface DelegationHandle {
  readonly job: OperationOutput<'job.create'>;
  readonly attemptId: AttemptId;
  readonly outcome: DelegationOutcome;
  readonly accept: () => Effect.Effect<
    ResultDecision,
    DelegationProviderError | DelegationDecisionUnavailable
  >;
  readonly reject: (
    issues: ReadonlyArray<string>,
    retainedObservations?: ReadonlyArray<Evidence>,
  ) => Effect.Effect<ResultDecision, DelegationProviderError | DelegationDecisionUnavailable>;
}

type Pending = { readonly kind: 'pending'; readonly last: AttemptNative };

type Assessed = DelegationOutcome | Pending;

const isTerminal = (outcome: Assessed): outcome is DelegationOutcome => outcome.kind !== 'pending';

const assess: (
  operations: DelegationOperationsInterface,
  snapshot: AttemptNative,
) => Effect.Effect<Assessed> = Effect.fn('Delegation.assess')(function* (
  operations: DelegationOperationsInterface,
  snapshot: AttemptNative,
) {
  const native = snapshot.native;

  if (native.kind === 'blocked' || native.kind === 'manual-required') {
    return { kind: native.kind, reason: native.reason, last: snapshot };
  }

  if (native.kind === 'unsupported') {
    return { kind: 'unsupported', reason: native.reason, last: snapshot };
  }

  if (native.kind === 'unconfirmed' && snapshot.attempt.phase === 'unconfirmed') {
    return { kind: 'unconfirmed', reason: native.reason, last: snapshot };
  }

  if (snapshot.attempt.phase !== 'settled' && snapshot.attempt.phase !== 'closed') {
    return { kind: 'pending', last: snapshot };
  }

  return yield* operations.discoverResult(snapshot.attempt.id).pipe(
    Effect.map((discovery): Assessed => {
      if (discovery.kind === 'found') {
        return { kind: 'result', result: discovery.result, last: snapshot };
      }

      if (discovery.kind === 'unsupported') {
        return { kind: 'unsupported', reason: discovery.reason, last: snapshot };
      }

      return { kind: 'pending', last: snapshot };
    }),
    Effect.catch((error) =>
      Effect.succeed({
        kind: 'provider-failure',
        operation: error.operation,
        reason: error.message,
        last: snapshot,
      } satisfies DelegationOutcome),
    ),
  );
});

function makeHandle(
  operations: DelegationOperationsInterface,
  job: OperationOutput<'job.create'>,
  attemptId: AttemptId,
  outcome: DelegationOutcome,
  idempotencyKey: string,
): DelegationHandle {
  const decide = Effect.fn('Delegation.decide')(function* (
    decision: ResultDecisionInput['decision'],
    suffix: string,
  ) {
    if (outcome.kind !== 'result') {
      return yield* new DelegationDecisionUnavailable({
        attemptId,
        reason: `Cannot decide a delegation with outcome ${outcome.kind}`,
      });
    }

    return yield* operations.decideResult({
      resultId: outcome.result.id,
      expectedBriefRevision: outcome.result.briefRevision,
      decision,
      idempotencyKey: `${idempotencyKey}/${suffix}`,
    });
  });

  return {
    job,
    attemptId,
    outcome,
    accept: Effect.fn('Delegation.accept')(() => decide({ kind: 'accepted' }, 'accept')),
    reject: Effect.fn('Delegation.reject')((issues, retainedObservations = []) =>
      decide(
        {
          kind: 'rejected',
          issues: [...issues],
          retainedObservations: [...retainedObservations],
        },
        'reject',
      ),
    ),
  };
}

/** Creates, admits, starts once, supervises within a fixed bound, and returns a decision handle. */
export const delegate: (
  input: DelegationInput,
) => Effect.Effect<
  DelegationHandle,
  DelegationInputError | DelegationProviderError,
  DelegationOperations
> = Effect.fn('Delegation.delegate')(function* (input: DelegationInput) {
  if (!Number.isInteger(input.supervision.maxChecks) || input.supervision.maxChecks < 1) {
    return yield* new DelegationInputError({ message: 'supervision.maxChecks must be a positive integer' });
  }

  if (input.idempotencyKey.length === 0) {
    return yield* new DelegationInputError({ message: 'idempotencyKey must not be empty' });
  }

  const operations = yield* DelegationOperations;
  const job = yield* operations.createJob(input.job);

  const attemptId = yield* operations.admitAttempt({
    ...input.attempt,
    jobId: job.id,
    expectedBriefRevision: job.currentBriefRevision,
    idempotencyKey: `${input.idempotencyKey}/admit`,
  });

  const started = yield* operations.startAttempt(attemptId).pipe(
    Effect.map((snapshot) => ({ kind: 'started' as const, snapshot })),
    Effect.catch((error) =>
      Effect.succeed({
        kind: 'failed' as const,
        outcome: {
          kind: 'provider-failure' as const,
          operation: error.operation,
          reason: error.message,
          last: null,
        },
      }),
    ),
  );

  if (started.kind === 'failed') {
    return makeHandle(operations, job, attemptId, started.outcome, input.idempotencyKey);
  }

  const initial = yield* assess(operations, started.snapshot);

  if (isTerminal(initial)) {
    return makeHandle(operations, job, attemptId, initial, input.idempotencyKey);
  }

  const checks = yield* Ref.make(0);
  const latest = yield* Ref.make<Assessed>(initial);

  const pass = Effect.gen(function* () {
    yield* Ref.update(checks, (count) => count + 1);
    const before = yield* Ref.get(latest);

    const reconciled = yield* operations.reconcileAttempt(attemptId).pipe(
      Effect.map((snapshot) => ({ kind: 'reconciled' as const, snapshot })),
      Effect.catch((error) =>
        Effect.succeed({
          kind: 'failed' as const,
          outcome: {
            kind: 'provider-failure' as const,
            operation: error.operation,
            reason: error.message,
            last: before.last,
          } satisfies DelegationOutcome,
        }),
      ),
    );

    const outcome = reconciled.kind === 'failed'
      ? reconciled.outcome
      : yield* assess(operations, reconciled.snapshot);

    yield* Ref.set(latest, outcome);

    return outcome.kind === 'pending';
  });

  yield* pass.pipe(
    Effect.repeat({
      schedule: Schedule.spaced(input.supervision.interval),
      times: input.supervision.maxChecks - 1,
      while: (pending) => pending,
    }),
  );
  const supervised = yield* Ref.get(latest);
  const completedChecks = yield* Ref.get(checks);

  const outcome: DelegationOutcome =
    supervised.kind !== 'pending'
      ? supervised
      : supervised.last.attempt.phase === 'settled' || supervised.last.attempt.phase === 'closed'
        ? { kind: 'awaiting-result', checks: completedChecks, last: supervised.last }
        : { kind: 'timeout', checks: completedChecks, last: supervised.last };

  return makeHandle(operations, job, attemptId, outcome, input.idempotencyKey);
});
