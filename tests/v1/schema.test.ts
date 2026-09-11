import assert from 'node:assert/strict';
import test from 'node:test';
import { operationSchema } from '../../src/v1/operations.js';
import {
  operationDescriptions,
  type OperationDescription,
  type SchemaDescription,
} from '../../src/v1/schema.js';

function operation(
  descriptions: readonly OperationDescription[],
  name: string,
): OperationDescription {
  const description = descriptions.find((entry) => entry.operation === name);
  assert.ok(description, `missing ${name}`);
  return description;
}

function field(description: SchemaDescription, name: string): SchemaDescription {
  assert.equal(description.type, 'object');
  const value = description.fields[name];
  assert.ok(value, `missing ${name}`);
  return value;
}

function option(description: SchemaDescription, value: string): SchemaDescription {
  assert.equal(description.type, 'union');
  const match = description.options.find(
    (entry) => entry.type === 'object' && literalValue(field(entry, 'kind')) === value,
  );
  assert.ok(match, `missing ${value} variant`);
  return match;
}

function literalValue(description: SchemaDescription) {
  assert.equal(description.type, 'literal');
  assert.ok(description.enum);
  return description.enum[0];
}

test('describes every operation with JSON-compatible output', () => {
  const descriptions = operationDescriptions();
  assert.deepEqual(
    descriptions.map((description) => description.operation),
    operationSchema.options.map((option) => option.shape.operation.value),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(descriptions)), descriptions);
});

test('describes nested job fields and operation defaults', () => {
  const job = operation(operationDescriptions(), 'job.create');
  const request = job.fields.request;
  assert.equal(request.type, 'object');
  const inputSnapshots = request.fields.inputSnapshots;
  assert.equal(inputSnapshots.type, 'array');
  assert.equal(inputSnapshots.items.type, 'object');
  assert.deepEqual(inputSnapshots.items.fields.digest, { type: 'string', required: true });
  assert.deepEqual(job.fields.dependencies, {
    type: 'array',
    items: { type: 'string', required: true },
    required: false,
    default: [],
  });

  const workflow = operation(operationDescriptions(), 'workflow.create');
  assert.deepEqual(workflow.fields.boundary, {
    type: 'string',
    enum: ['all', 'design-only'],
    required: false,
    default: 'all',
  });
});

test('describes nested result variants, tuples, and defaults', () => {
  const result = operation(operationDescriptions(), 'result.record');
  const content = result.fields.content;
  const report = option(content, 'report');
  assert.equal(field(report, 'artifactDigests').type, 'array');

  const verification = result.fields.verification;
  const passed = option(verification, 'passed');
  const checks = field(passed, 'checks');
  assert.equal(checks.type, 'array');
  const command = option(checks.items, 'command');
  const argv = field(command, 'argv');
  assert.equal(argv.type, 'tuple');
  assert.deepEqual(argv.items, [{ type: 'string', required: true }]);
  assert.deepEqual(argv.rest, { type: 'string', required: true });

  const decide = operation(operationDescriptions(), 'result.decide');
  const rejected = option(decide.fields.decision, 'rejected');
  assert.equal(field(rejected, 'retainedObservations').type, 'array');
});

test('keeps nullable, record, and refinement input structures discoverable', () => {
  const workspace = operation(operationDescriptions(), 'workspace.register');
  const baseCommit = workspace.fields.baseCommit;
  assert.equal(baseCommit.type, 'union');
  assert.deepEqual(
    baseCommit.options.map((entry) => entry.type),
    ['string', 'null'],
  );
  assert.equal(baseCommit.required, true);

  const sql = operation(operationDescriptions(), 'sql.read');
  const parameters = sql.fields.parameters;
  assert.equal(parameters.type, 'record');
  assert.equal(parameters.required, false);
  assert.equal(parameters.values.type, 'union');
  assert.deepEqual(
    parameters.values.options.map((entry) => entry.type),
    ['string', 'number', 'null'],
  );

  const profile = operation(operationDescriptions(), 'profile.configure').fields.profile;
  assert.equal(profile.type, 'object');
  assert.equal(profile.fields.args.type, 'array');
});
