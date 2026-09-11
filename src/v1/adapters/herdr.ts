import { z } from 'zod';
import { composeAdapter, defineCapability } from '../adapters.js';
import {
  HerdrNativeAdapter,
  NativeAdoptionLocatorSchema,
  NativeBindingSchema,
  NativeFixtureRecoveryAuthorizationSchema,
  NativeIdentitySchema,
  NativeLaunchLocatorSchema,
  type NativeBinding,
  type NativeIdentity,
  type NativeLaunchLocator,
  type NativeFixtureRecoveryAuthorization,
  type NativeJournal,
  type NativeEndpointInspector,
  type NativeProcessInspector,
  type LaunchRequest,
  type LaunchResult,
  type NativeObservation,
  type NativeSubmission,
  type CleanupResult,
} from '../native.js';
import type { HerdrClient } from '../../herdr-sdk.js';

const reason = z.string().min(1);
const unsupported = z.object({ kind: z.literal('unsupported'), reason }).strict();
export const herdrObservationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('working'), identity: NativeIdentitySchema }).strict(),
  z.object({ kind: z.literal('blocked'), identity: NativeIdentitySchema, reason }).strict(),
  z.object({ kind: z.literal('manual-required'), identity: NativeIdentitySchema, reason }).strict(),
  z
    .object({
      kind: z.literal('settled'),
      identity: NativeIdentitySchema,
      slotReady: z.literal(true),
    })
    .strict(),
  z.object({ kind: z.literal('unconfirmed'), reason }).strict(),
]);
export const herdrSubmissionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('submitted'), operationId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('unconfirmed'), operationId: z.string().min(1), reason }).strict(),
  unsupported,
]);
export const herdrLaunchSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('launched'), identity: NativeIdentitySchema }).strict(),
  z
    .object({
      kind: z.literal('unconfirmed'),
      operationId: z.string().min(1),
      reason,
      locator: NativeAdoptionLocatorSchema.optional(),
    })
    .strict(),
  unsupported,
]);
export const herdrCleanupSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cleaned'), operationId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('unconfirmed'), operationId: z.string().min(1), reason }).strict(),
  unsupported,
]);
const registerInput = z
  .object({
    hostId: z.string().min(1),
    socketPath: z.string().min(1),
    workspaceId: z.string().min(1),
  })
  .strict();
const launchRequest = z
  .object({
    cwd: z.string().min(1),
    env: z.record(z.string()),
    agentKind: z.string().min(1),
    agentName: z.string().min(1),
    args: z.array(z.string()).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export interface HerdrAdapterDriver {
  register(
    input: z.infer<typeof registerInput>,
  ): Promise<NativeBinding | { kind: 'unsupported'; reason: string }>;
  launch(binding: NativeBinding, request: LaunchRequest): Promise<LaunchResult>;
  recover(binding: NativeBinding, locator: NativeLaunchLocator): Promise<NativeObservation>;
  adopt(
    binding: NativeBinding,
    locator: NativeLaunchLocator,
    authorization: NativeFixtureRecoveryAuthorization,
  ): Promise<NativeObservation>;
  observe(identity: NativeIdentity): Promise<NativeObservation>;
  prompt(identity: NativeIdentity, text: string): Promise<NativeSubmission>;
  interrupt(identity: NativeIdentity): Promise<NativeSubmission>;
  cleanup(identity: NativeIdentity, authorized: boolean): Promise<CleanupResult>;
}

export function createHerdrCapabilities(driver: HerdrAdapterDriver) {
  const registration = {
    register: defineCapability({
      input: registerInput,
      output: z.union([NativeBindingSchema, unsupported]),
      effect: 'read',
      summary: 'Verify a Herdr endpoint and workspace identity.',
      execute: (input) => driver.register(input),
    }),
  };
  const execution = {
    launch: defineCapability({
      input: z.object({ binding: NativeBindingSchema, request: launchRequest }).strict(),
      output: herdrLaunchSchema,
      effect: 'mutation',
      summary: 'Launch an agent after durable admission and per-effect claims.',
      execute: ({ binding, request }) => driver.launch(binding, request),
    }),
    recover: defineCapability({
      input: z
        .object({ binding: NativeBindingSchema, locator: NativeLaunchLocatorSchema })
        .strict(),
      output: herdrObservationSchema,
      effect: 'read',
      summary: 'Match an existing launch without replaying native effects.',
      execute: ({ binding, locator }) => driver.recover(binding, locator),
    }),
    adopt: defineCapability({
      input: z
        .object({
          binding: NativeBindingSchema,
          locator: NativeAdoptionLocatorSchema,
          authorization: NativeFixtureRecoveryAuthorizationSchema,
        })
        .strict(),
      output: herdrObservationSchema,
      effect: 'read',
      summary: 'Inspect an explicitly authorized disposable fixture.',
      execute: ({ binding, locator, authorization }) =>
        driver.adopt(binding, locator, authorization),
    }),
    observe: defineCapability({
      input: z.object({ identity: NativeIdentitySchema }).strict(),
      output: herdrObservationSchema,
      effect: 'read',
      summary: 'Observe the exact registered native session.',
      execute: ({ identity }) => driver.observe(identity),
    }),
  };
  const messaging = {
    prompt: defineCapability({
      input: z.object({ identity: NativeIdentitySchema, text: z.string() }).strict(),
      output: herdrSubmissionSchema,
      effect: 'mutation',
      summary: 'Submit one prompt under the caller-owned durable effect claim.',
      execute: ({ identity, text }) => driver.prompt(identity, text),
    }),
  };
  const control = {
    interrupt: defineCapability({
      input: z.object({ identity: NativeIdentitySchema }).strict(),
      output: herdrSubmissionSchema,
      effect: 'mutation',
      summary: 'Interrupt an identified session under a durable effect claim.',
      execute: ({ identity }) => driver.interrupt(identity),
    }),
    cleanup: defineCapability({
      input: z.object({ identity: NativeIdentitySchema, authorized: z.boolean() }).strict(),
      output: herdrCleanupSchema,
      effect: 'mutation',
      summary: 'Clean up an owned idle native tab after caller authorization.',
      execute: ({ identity, authorized }) => driver.cleanup(identity, authorized),
    }),
  };
  return { registration, execution, messaging, control };
}

export function composeHerdrAdapter(driver: HerdrAdapterDriver) {
  const capabilities = createHerdrCapabilities(driver);
  return composeAdapter(
    { id: 'herdr', version: 1 },
    capabilities.registration,
    capabilities.execution,
    capabilities.messaging,
    capabilities.control,
  );
}

export type HerdrAdapter = ReturnType<typeof composeHerdrAdapter>;
export type HerdrAdapterFactory = (journal: NativeJournal) => HerdrAdapter;
export type HerdrAdapterOptions = {
  endpointInspector?: NativeEndpointInspector;
  clientFor?: (socketPath: string) => HerdrClient;
  processInspector?: NativeProcessInspector;
};
export function createHerdrAdapter(
  journal: NativeJournal,
  options: HerdrAdapterOptions = {},
): HerdrAdapter {
  return composeHerdrAdapter(
    new HerdrNativeAdapter(
      journal,
      options.endpointInspector,
      options.clientFor,
      options.processInspector,
    ),
  );
}

export { NativeBindingSchema, NativeIdentitySchema, NativeLaunchLocatorSchema };
export type {
  NativeBinding,
  NativeIdentity,
  NativeJournal,
  NativeEffect,
  NativeEndpointInspector,
  NativeProcessInspector,
} from '../native.js';
