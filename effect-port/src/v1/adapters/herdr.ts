import { Effect, Schema } from 'effect';
import { composeAdapter, defineCapability } from '../adapters.js';
import {
  HerdrNativeAdapter,
  NativeAdoptionLocatorSchema,
  NativeBindingSchema,
  NativeFailureSchema,
  NativeFixtureRecoveryAuthorizationSchema,
  NativeIdentitySchema,
  NativeLaunchLocatorSchema,
  type CleanupResult,
  type LaunchRequest,
  type LaunchResult,
  type NativeBinding,
  type NativeEndpointInspector,
  type NativeFixtureRecoveryAuthorization,
  type NativeIdentity,
  type NativeJournal,
  type NativeLaunchLocator,
  type NativeObservation,
  type NativeProcessInspector,
  type NativeSubmission,
} from '../native.js';
import type { HerdrClient } from '../../herdr-sdk.js';
import { NativeSessionPointerSchema } from '../native-session.js';

const nonEmpty = Schema.String.check(Schema.isMinLength(1));
const positiveInteger = Schema.Finite.check(
  Schema.makeFilter((value) => Number.isInteger(value) && value > 0, { expected: 'a positive integer' }),
);
const nonNegativeInteger = Schema.Finite.check(
  Schema.makeFilter((value) => Number.isInteger(value) && value >= 0, { expected: 'a non-negative integer' }),
);
const reason = nonEmpty;
const failure = Schema.optional(NativeFailureSchema);
const unsupported = Schema.Struct({ kind: Schema.Literal('unsupported'), reason });
export const herdrObservationSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('working'), identity: NativeIdentitySchema }),
  Schema.Struct({ kind: Schema.Literal('blocked'), identity: NativeIdentitySchema, reason, failure }),
  Schema.Struct({ kind: Schema.Literal('manual-required'), identity: NativeIdentitySchema, reason, failure }),
  Schema.Struct({ kind: Schema.Literal('settled'), identity: NativeIdentitySchema, slotReady: Schema.Literal(true), failure }),
  Schema.Struct({
    kind: Schema.Literal('unconfirmed'),
    reason,
    failure,
    candidate: Schema.optional(
      Schema.Struct({ reference: NativeSessionPointerSchema, identityRevision: nonNegativeInteger }),
    ),
  }),
]);
export const herdrSubmissionSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('submitted'), operationId: nonEmpty }),
  Schema.Struct({ kind: Schema.Literal('unconfirmed'), operationId: nonEmpty, reason }),
  unsupported,
]);
export const herdrLaunchSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('launched'), identity: NativeIdentitySchema }),
  Schema.Struct({ kind: Schema.Literal('unconfirmed'), operationId: nonEmpty, reason, locator: Schema.optional(NativeAdoptionLocatorSchema) }),
  unsupported,
]);
export const herdrCleanupSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('cleaned'), operationId: nonEmpty }),
  Schema.Struct({ kind: Schema.Literal('unconfirmed'), operationId: nonEmpty, reason }),
  unsupported,
]);
const registerInput = Schema.Struct({ hostId: nonEmpty, socketPath: nonEmpty, workspaceId: nonEmpty });
const launchRequest = Schema.Struct({
  cwd: nonEmpty,
  env: Schema.Record(Schema.String, Schema.String),
  agentKind: nonEmpty,
  agentName: nonEmpty,
  args: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  timeoutMs: Schema.optional(positiveInteger),
});
export class HerdrDriverError extends Schema.TaggedError<HerdrDriverError>()('HerdrDriverError', {
  cause: Schema.Defect(),
}) {}

export interface HerdrPromiseDriver {
  register(input: typeof registerInput.Type): Promise<NativeBinding | { kind: 'unsupported'; reason: string }>;
  launch(binding: NativeBinding, request: LaunchRequest): Promise<LaunchResult>;
  recover(binding: NativeBinding, locator: NativeLaunchLocator): Promise<NativeObservation>;
  adopt(binding: NativeBinding, locator: NativeLaunchLocator, authorization: NativeFixtureRecoveryAuthorization): Promise<NativeObservation>;
  observe(identity: NativeIdentity): Promise<NativeObservation>;
  prompt(identity: NativeIdentity, text: string): Promise<NativeSubmission>;
  interrupt(identity: NativeIdentity): Promise<NativeSubmission>;
  cleanup(identity: NativeIdentity, authorized: boolean): Promise<CleanupResult>;
}
export interface HerdrEffectDriver {
  registerEffect(input: typeof registerInput.Type): Effect.Effect<NativeBinding | { kind: 'unsupported'; reason: string }, HerdrDriverError, never>;
  launchEffect(binding: NativeBinding, request: LaunchRequest): Effect.Effect<LaunchResult, HerdrDriverError, never>;
  recoverEffect(binding: NativeBinding, locator: NativeLaunchLocator): Effect.Effect<NativeObservation, HerdrDriverError, never>;
  adoptEffect(binding: NativeBinding, locator: NativeLaunchLocator, authorization: NativeFixtureRecoveryAuthorization): Effect.Effect<NativeObservation, HerdrDriverError, never>;
  observeEffect(identity: NativeIdentity): Effect.Effect<NativeObservation, HerdrDriverError, never>;
  promptEffect(identity: NativeIdentity, text: string): Effect.Effect<NativeSubmission, HerdrDriverError, never>;
  interruptEffect(identity: NativeIdentity): Effect.Effect<NativeSubmission, HerdrDriverError, never>;
  cleanupEffect(identity: NativeIdentity, authorized: boolean): Effect.Effect<CleanupResult, HerdrDriverError, never>;
}
export type HerdrAdapterDriver = HerdrEffectDriver | HerdrPromiseDriver | (HerdrEffectDriver & HerdrPromiseDriver);

const invokeDriver = <A>(effect: Effect.Effect<A, unknown, never> | undefined, promise: (() => Promise<A>) | undefined) => {
  if (effect) return effect.pipe(Effect.mapError((cause) => cause instanceof HerdrDriverError ? cause : new HerdrDriverError({ cause })));
  if (promise) return Effect.tryPromise({ try: promise, catch: (cause) => new HerdrDriverError({ cause }) });
  return Effect.fail(new HerdrDriverError({ cause: new Error('Native driver operation is unavailable') }));
};
function preferEffect(driver: HerdrAdapterDriver, promiseMethod: keyof HerdrPromiseDriver) {
  return !(driver instanceof HerdrNativeAdapter && promiseMethod in driver && driver[promiseMethod] !== HerdrNativeAdapter.prototype[promiseMethod]);
}

export function createHerdrCapabilities(driver: HerdrAdapterDriver) {
  const effect = driver as Partial<HerdrEffectDriver>;
  const promise = driver as Partial<HerdrPromiseDriver>;
  const run = {
    register: (input: typeof registerInput.Type) => invokeDriver(preferEffect(driver, 'register') ? effect.registerEffect?.(input) : undefined, promise.register ? () => promise.register!(input) : undefined),
    launch: (binding: NativeBinding, request: LaunchRequest) => invokeDriver(preferEffect(driver, 'launch') ? effect.launchEffect?.(binding, request) : undefined, promise.launch ? () => promise.launch!(binding, request) : undefined),
    recover: (binding: NativeBinding, locator: NativeLaunchLocator) => invokeDriver(preferEffect(driver, 'recover') ? effect.recoverEffect?.(binding, locator) : undefined, promise.recover ? () => promise.recover!(binding, locator) : undefined),
    adopt: (binding: NativeBinding, locator: NativeLaunchLocator, authorization: NativeFixtureRecoveryAuthorization) => invokeDriver(preferEffect(driver, 'adopt') ? effect.adoptEffect?.(binding, locator, authorization) : undefined, promise.adopt ? () => promise.adopt!(binding, locator, authorization) : undefined),
    observe: (identity: NativeIdentity) => invokeDriver(preferEffect(driver, 'observe') ? effect.observeEffect?.(identity) : undefined, promise.observe ? () => promise.observe!(identity) : undefined),
    prompt: (identity: NativeIdentity, text: string) => invokeDriver(preferEffect(driver, 'prompt') ? effect.promptEffect?.(identity, text) : undefined, promise.prompt ? () => promise.prompt!(identity, text) : undefined),
    interrupt: (identity: NativeIdentity) => invokeDriver(preferEffect(driver, 'interrupt') ? effect.interruptEffect?.(identity) : undefined, promise.interrupt ? () => promise.interrupt!(identity) : undefined),
    cleanup: (identity: NativeIdentity, authorized: boolean) => invokeDriver(preferEffect(driver, 'cleanup') ? effect.cleanupEffect?.(identity, authorized) : undefined, promise.cleanup ? () => promise.cleanup!(identity, authorized) : undefined),
  };
  return {
    registration: {
      register: defineCapability({ input: registerInput, output: Schema.Union([NativeBindingSchema, unsupported]), effect: 'read', summary: 'Verify a Herdr endpoint and workspace identity.', execute: (input) => Effect.runPromise(run.register(input)), executeEffect: run.register }),
    },
    execution: {
      launch: defineCapability({ input: Schema.Struct({ binding: NativeBindingSchema, request: launchRequest }), output: herdrLaunchSchema, effect: 'mutation', summary: 'Launch an agent after durable admission and per-effect claims.', execute: ({ binding, request }) => Effect.runPromise(run.launch(binding, request)), executeEffect: ({ binding, request }) => run.launch(binding, request) }),
      recover: defineCapability({ input: Schema.Struct({ binding: NativeBindingSchema, locator: NativeLaunchLocatorSchema }), output: herdrObservationSchema, effect: 'read', summary: 'Match an existing launch without replaying native effects.', execute: ({ binding, locator }) => Effect.runPromise(run.recover(binding, locator)), executeEffect: ({ binding, locator }) => run.recover(binding, locator) }),
      adopt: defineCapability({ input: Schema.Struct({ binding: NativeBindingSchema, locator: NativeAdoptionLocatorSchema, authorization: NativeFixtureRecoveryAuthorizationSchema }), output: herdrObservationSchema, effect: 'read', summary: 'Inspect an explicitly authorized disposable fixture.', execute: ({ binding, locator, authorization }) => Effect.runPromise(run.adopt(binding, locator, authorization)), executeEffect: ({ binding, locator, authorization }) => run.adopt(binding, locator, authorization) }),
      observe: defineCapability({ input: Schema.Struct({ identity: NativeIdentitySchema }), output: herdrObservationSchema, effect: 'read', summary: 'Observe the exact registered native session.', execute: ({ identity }) => Effect.runPromise(run.observe(identity)), executeEffect: ({ identity }) => run.observe(identity) }),
    },
    messaging: {
      prompt: defineCapability({ input: Schema.Struct({ identity: NativeIdentitySchema, text: Schema.String }), output: herdrSubmissionSchema, effect: 'mutation', summary: 'Submit one prompt under the caller-owned durable effect claim.', execute: ({ identity, text }) => Effect.runPromise(run.prompt(identity, text)), executeEffect: ({ identity, text }) => run.prompt(identity, text) }),
    },
    control: {
      interrupt: defineCapability({ input: Schema.Struct({ identity: NativeIdentitySchema }), output: herdrSubmissionSchema, effect: 'mutation', summary: 'Interrupt an identified session under a durable effect claim.', execute: ({ identity }) => Effect.runPromise(run.interrupt(identity)), executeEffect: ({ identity }) => run.interrupt(identity) }),
      cleanup: defineCapability({ input: Schema.Struct({ identity: NativeIdentitySchema, authorized: Schema.Boolean }), output: herdrCleanupSchema, effect: 'mutation', summary: 'Clean up an owned idle native tab after caller authorization.', execute: ({ identity, authorized }) => Effect.runPromise(run.cleanup(identity, authorized)), executeEffect: ({ identity, authorized }) => run.cleanup(identity, authorized) }),
    },
  };
}

export function composeHerdrAdapter(driver: HerdrAdapterDriver) {
  const capabilities = createHerdrCapabilities(driver);
  return composeAdapter({ id: 'herdr', version: 1 }, capabilities.registration, capabilities.execution, capabilities.messaging, capabilities.control);
}
export type HerdrAdapter = ReturnType<typeof composeHerdrAdapter>;
export type HerdrAdapterFactory = (journal: NativeJournal) => HerdrAdapter;
export type HerdrAdapterOptions = { endpointInspector?: NativeEndpointInspector; clientFor?: (socketPath: string) => HerdrClient; processInspector?: NativeProcessInspector };
export function createHerdrAdapter(journal: NativeJournal, options: HerdrAdapterOptions = {}): HerdrAdapter {
  return composeHerdrAdapter(new HerdrNativeAdapter(journal, options.endpointInspector, options.clientFor, options.processInspector));
}
export { NativeBindingSchema, NativeFailureSchema, NativeIdentitySchema, NativeLaunchLocatorSchema };
export type { NativeBinding, NativeEffect, NativeEndpointInspector, NativeFailure, NativeFailureEvidence, NativeIdentity, NativeJournal, NativeObservation, NativeProcessInspector } from '../native.js';
