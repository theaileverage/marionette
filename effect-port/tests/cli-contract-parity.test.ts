import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { Effect, Schema } from 'effect';

import { operationSchema as baselineOperationSchema } from '../../src/v1/operations.js';
import { operationDescriptions as baselineOperationDescriptions } from '../../src/v1/schema.js';
import { CliError, operationInput } from '../src/v1/arguments.js';
import type { Marionette } from '../src/v1/client.js';
import { commands, commandMetadata, exitCodes } from '../src/v1/command-registry.js';
import {
  decodeOperation,
  execute,
  executeEffect,
  OperationError,
  operationSchemas,
} from '../src/v1/operations.js';
import { parseOperationOutput } from '../src/v1/output-contracts.js';
import { describeSchema, operationDescriptions } from '../src/v1/schema.js';

function operation(name: string) {
  const description = operationDescriptions().find((entry) => entry.operation === name);
  assert.ok(description, `missing ${name}`);
  return description;
}

test('ports the baseline registry plus result discovery and retained-work inspection', () => {
  const baselineNames = baselineOperationSchema.options.map<string>(
    (schema) => schema.shape.operation.value,
  );

  const resultRecordIndex = baselineNames.indexOf('result.record');

  assert.notEqual(resultRecordIndex, -1);

  const withDiscovery = baselineNames.toSpliced(resultRecordIndex, 0, 'result.discover');
  const inspectIndex = withDiscovery.indexOf('attempt.reconcile');
  const expectedNames = withDiscovery.toSpliced(inspectIndex, 0, 'attempt.retained-work');

  assert.deepEqual(
    operationDescriptions().map((entry) => entry.operation),
    expectedNames,
  );
  assert.equal(operationSchemas.length, baselineNames.length + 2);
  assert.deepEqual(
    commands.map((command) => command.name),
    expectedNames,
  );
  assert.deepEqual(exitCodes, { success: 0, operationFailed: 1, invalidInput: 2 });

  for (const file of [
    'operations.ts',
    'output-contracts.ts',
    'schema-description.ts',
    'schema.ts',
    'command-registry.ts',
    'arguments.ts',
    'output.ts',
    'cli.ts',
  ]) {
    const source = readFileSync(
      join(process.env.MARIONETTE_PARITY_SCRATCH ?? process.cwd(), 'src', 'v1', file),
      'utf8',
    );
    assert.doesNotMatch(source, /from ['"](?:\.\.\/)+src\/v1\//);
    assert.doesNotMatch(source, /from ['"]zod['"]/);
  }
});

test('decodes strict operations with static defaults and original integer semantics', () => {
  const job = decodeOperation({
    operation: 'job.create',
    stableKey: 'job',
    request: { text: 'request', digest: 'a'.repeat(64), inputSnapshots: [] },
    brief: {
      objective: 'objective',
      scope: [],
      ownership: [],
      constraints: [],
      standingOrders: [],
      inputSnapshots: [],
    },
    workspaceId: 'workspace',
    delivery: 'report',
    idempotencyKey: 'key',
    dependencies: undefined,
  });
  if (job.operation !== 'job.create') throw new Error('wrong operation');
  assert.deepEqual(job.dependencies, []);
  const workflow = decodeOperation({
    operation: 'workflow.create',
    stableKey: 'job',
    request: { text: 'request', digest: 'a'.repeat(64), inputSnapshots: [] },
    brief: {
      objective: 'objective',
      scope: [],
      ownership: [],
      constraints: [],
      standingOrders: [],
      inputSnapshots: [],
    },
    workspaceId: 'workspace',
    delivery: 'report',
    idempotencyKey: 'key',
    package: 'default',
    boundary: undefined,
  });
  if (workflow.operation !== 'workflow.create') throw new Error('wrong operation');
  assert.equal(workflow.boundary, 'all');
  assert.throws(() => decodeOperation({ operation: 'context', extra: true }));
  const marked = decodeOperation({
    operation: 'board.mark-read',
    threadId: 'thread',
    sequence: 9_007_199_254_740_992,
  });
  if (marked.operation !== 'board.mark-read') throw new Error('wrong operation');
  assert.equal(marked.sequence, 9_007_199_254_740_992);
  assert.deepEqual(
    decodeOperation({ operation: 'board.list', cursor: undefined, limit: undefined }),
    { operation: 'board.list', cursor: undefined, limit: undefined },
  );
});

test('derives descriptions from Effect AST without executing checks or defaults', () => {
  let checkCalls = 0;
  let defaultCalls = 0;
  const schema = Schema.Struct({
    constrained: Schema.String.check(
      Schema.makeFilter(() => {
        checkCalls += 1;
        return true;
      }),
    ),
    generated: Schema.String.pipe(
      Schema.withDecodingDefaultKey(
        Effect.sync(() => {
          defaultCalls += 1;
          return 'generated';
        }),
      ),
    ),
    exact: Schema.Array(Schema.String).check(Schema.isLengthBetween(2, 2)),
  }).annotate({ parseOptions: { onExcessProperty: 'error' } });
  assert.deepEqual(describeSchema(schema), {
    type: 'object',
    required: true,
    unknownKeys: 'strict',
    fields: {
      constrained: {
        type: 'string',
        required: true,
        effects: [{ kind: 'refinement', executable: false }],
      },
      generated: { type: 'string', required: false, defaultStatus: 'not-evaluated' },
      exact: {
        type: 'array',
        items: { type: 'string', required: true },
        exactItems: 2,
        required: true,
      },
    },
  });
  assert.equal(checkCalls, 0);
  assert.equal(defaultCalls, 0);
});

test('preserves discoverable defaults, bounds, watcher and dry-run metadata', () => {
  const baseline = baselineOperationDescriptions();
  assert.deepEqual(
    operation('job.create').fields.dependencies.default,
    baseline.find((entry) => entry.operation === 'job.create')?.fields.dependencies.default,
  );
  assert.deepEqual(operation('attempt.admit').fields.inputResultIds.default, []);
  assert.deepEqual(operation('workflow.create').fields.boundary.default, 'all');
  assert.deepEqual(operation('result.discover').fields.attemptId, {
    type: 'string',
    minLength: 1,
    maxLength: 255,
    required: true,
  });
  assert.deepEqual(operation('board.list').fields.limit, {
    type: 'number',
    integer: true,
    minimum: { value: 1, inclusive: true },
    maximum: { value: 200, inclusive: true },
    required: false,
  });
  assert.equal(commandMetadata['board.post'].watcher, true);
  assert.equal(commandMetadata['workspace.retire'].effect, 'destructive');
  assert.equal(commandMetadata['result.discover'].effect, 'read');
});

test('preserves argument conflict ordering and additive output fields', () => {
  assert.throws(
    () => operationInput('board.create', { input: 'request.json', title: 'title' }),
    (error) => error instanceof CliError && error.code === 'conflicting-input',
  );
  const value = parseOperationOutput('board.create', {
    id: 'thread',
    title: 'Title',
    jobId: null,
    author: { kind: 'user', id: 'user', generation: undefined },
    createdAt: '2026-09-14T00:00:00.000Z',
    future: true,
  });
  assert.equal(Object.hasOwn(value, 'future'), true);
  assert.equal(Object.hasOwn(value.author, 'generation'), true);

  assert.deepEqual(parseOperationOutput('result.discover', { kind: 'pending', future: true }), {
    kind: 'pending',
    future: true,
  });
});

test('keeps operation failures typed in Effect and unwraps them for the Promise API', async () => {
  const cause = new Error('context failed');
  const client = {
    context: () => {
      throw cause;
    },
  } as unknown as Marionette;
  const failure = await Effect.runPromise(
    Effect.flip(executeEffect(client, { operation: 'context' })),
  );
  assert.equal(failure instanceof OperationError, true);
  assert.equal(failure.operation, 'context');
  assert.equal(failure.message, 'context failed');
  assert.equal(failure.cause, cause);
  await assert.rejects(
    () => execute(client, { operation: 'context' }),
    (error) => error === cause,
  );
});
