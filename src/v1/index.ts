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
