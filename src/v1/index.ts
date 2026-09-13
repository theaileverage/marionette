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
