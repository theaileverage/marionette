export { Marionette, connect, type ConnectOptions } from './client.js';
export { execute, operationSchema, type Operation } from './operations.js';
export * from './model.js';
export { route, loadPackage, importModelConfig } from './packages.js';
export { captureGitState, assertGitState, exportCommit } from './git.js';
export {
  describeSchema,
  operationDescriptions,
  type OperationDescription,
  type SchemaDescription,
} from './schema.js';
export {
  retirementPreviewOutputSchema,
  operationOutputSchemas,
  outputContractVersion,
  parseOperationOutput,
} from './output-contracts.js';

export {
  adapterApiVersion,
  adapterReferenceSchema,
  adapterValueSchema,
  defineCapability,
  composeAdapter,
  AdapterRegistry,
  AdapterError,
  type Adapter,
  type AdapterHandle,
  type AdapterReference,
  type AdapterValue,
  type AdapterCapabilities,
  type AdapterCapability,
  type AdapterDescription,
  type AdapterInput,
  type AdapterOutput,
  type AdapterCallOptions,
  type AdapterEffect,
  type AdapterFailureCode,
} from './adapters.js';
export {
  createHerdrCapabilities,
  createHerdrAdapter,
  composeHerdrAdapter,
  type HerdrAdapter,
  type HerdrAdapterFactory,
  type HerdrAdapterDriver,
  type HerdrAdapterOptions,
} from './adapters/herdr.js';
export {
  createCodexAppServerCapabilities,
  createCodexAppServerAdapter,
  type CodexAppServerAdapter,
} from './adapters/codex-app-server.js';
export { executeEffect } from './operations.js';
export { MarionetteService, acquireMarionette, marionetteLayer } from './service.js';
export {
  DelegationOperations,
  DelegationProviderError,
  DelegationInputError,
  DelegationDecisionUnavailable,
  marionetteDelegationOperationsLayer,
  delegate,
  type DelegationOperationsInterface,
  type ResultDiscovery,
  type ResultDiscoveryOutcome,
  type DelegationInput,
  type DelegationOutcome,
  type DelegationHandle,
} from './delegation.js';
export * from '../extensions.js';
export { OperationError } from './operations.js';
export { ClientOperationError } from './client.js';
export { RuntimeError } from './runtime.js';
export { NativeBoundaryError } from './native.js';
export { WatcherError } from './watcher.js';
export { BackgroundError } from './background.js';
export { SqlQueryError } from './sql.js';
export { HandoffOperationError } from './handoff.js';
export { RetirementOperationError, WorkspaceRetirementError } from './retirement.js';
export { RuntimeRetirementOperationError, RuntimeRetirementError } from './runtime-retirement.js';
export { StoreError } from './store.js';
export { DatabaseOperationError, MigrationError } from './database.js';
export { AppServerInvocationError, AppServerRpcError } from './codex-app-server.js';
export {
  HerdrDriverError,
  type HerdrEffectDriver,
  type HerdrPromiseDriver,
} from './adapters/herdr.js';
