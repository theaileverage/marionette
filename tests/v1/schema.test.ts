import assert from 'node:assert/strict';
import test from 'node:test';
import { operationSchema } from '../../src/v1/operations.js';
import {
  describeSchema,
  operationDescriptions,
  type OperationDescription,
  type SchemaDescription,
} from '../../src/v1/schema.js';
import { z } from 'zod';

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
  assert.equal(inputSnapshots.items.fields.digest.type, 'string');
  assert.equal(inputSnapshots.items.fields.digest.required, true);
  assert.equal(job.fields.dependencies.type, 'array');
  assert.equal(job.fields.dependencies.required, false);
  assert.deepEqual(job.fields.dependencies.default, []);
  assert.equal(job.fields.dependencies.items.type, 'string');

  const attempt = operation(operationDescriptions(), 'attempt.admit');
  assert.deepEqual(attempt.fields.inputResultIds.default, []);

  const workflow = operation(operationDescriptions(), 'workflow.create');
  assert.deepEqual(workflow.fields.boundary, {
    type: 'string',
    enum: ['all', 'design-only'],
    required: false,
    default: 'all',
  });

  const board = operation(operationDescriptions(), 'board.list');
  assert.deepEqual(board.fields.limit, {
    type: 'number',
    integer: true,
    minimum: { value: 1, inclusive: true },
    maximum: { value: 200, inclusive: true },
    required: false,
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
  assert.deepEqual(argv.items, [{ type: 'string', minLength: 1, required: true }]);
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
  assert.deepEqual(profile.effects, [{ kind: 'refinement', executable: false }]);
});

test('describes static Zod constraints without executing user functions', () => {
  assert.deepEqual(describeSchema(z.string().min(1).max(5).regex(/a+b/gi)), {
    type: 'string',
    required: true,
    minLength: 1,
    maxLength: 5,
    pattern: { source: 'a+b', flags: 'gi' },
  });
  assert.deepEqual(describeSchema(z.number().int().gt(0).lte(12).finite()), {
    type: 'number',
    required: true,
    integer: true,
    minimum: { value: 0, inclusive: false },
    maximum: { value: 12, inclusive: true },
    finite: true,
  });
  assert.deepEqual(describeSchema(z.array(z.string()).min(1).max(3).length(2)), {
    type: 'array',
    required: true,
    minItems: 1,
    maxItems: 3,
    exactItems: 2,
    items: { type: 'string', required: true },
  });
  assert.deepEqual(describeSchema(z.object({ value: z.string() }).strict()), {
    type: 'object',
    required: true,
    unknownKeys: 'strict',
    fields: { value: { type: 'string', required: true } },
  });
  let refinementCalls = 0;
  const refined = z.string().superRefine(() => {
    refinementCalls++;
  });
  assert.deepEqual(describeSchema(refined), {
    type: 'string',
    required: true,
    effects: [{ kind: 'refinement', executable: false }],
  });
  assert.equal(refinementCalls, 0);

  let defaultCalls = 0;
  const dynamicDefault = z.string().default(() => {
    defaultCalls++;
    return 'computed';
  });
  assert.deepEqual(describeSchema(dynamicDefault), {
    type: 'string',
    required: false,
    defaultStatus: 'not-evaluated',
  });
  assert.equal(defaultCalls, 0);
});
