import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { z } from 'zod';
import {
  AdapterError,
  AdapterRegistry,
  composeAdapter,
  defineCapability,
} from '../../src/v1/adapters.js';
import { createCodexAppServerAdapter } from '../../src/v1/adapters/codex-app-server.js';
import type { AppServerRequest, JsonRpcTransport } from '../../src/v1/codex-app-server.js';

const runProcess = promisify(execFile);

function fixtureAdapter() {
  const requests: string[] = [];
  const state = {
    observe: defineCapability({
      input: z.object({ sessionId: z.string().min(1) }).strict(),
      output: z.object({ kind: z.literal('idle') }).strict(),
      effect: 'read',
      summary: 'Read fixture session state.',
      execute: () => ({ kind: 'idle' as const }),
    }),
  };
  const messaging = {
    prompt: defineCapability({
      input: z.object({ sessionId: z.string().min(1), text: z.string().min(1) }).strict(),
      output: z.object({ kind: z.literal('submitted'), sequence: z.number().int() }).strict(),
      effect: 'mutation',
      summary: 'Submit one fixture message.',
      execute: ({ text }) => {
        requests.push(text);
        return { kind: 'submitted' as const, sequence: requests.length };
      },
    }),
  };
  return {
    state,
    messaging,
    requests,
    adapter: composeAdapter({ id: 'fixture-harness', version: 1 }, state, messaging),
  };
}

test('composed capabilities retain their typed inputs, outputs, and offline descriptions', async () => {
  const { adapter, requests } = fixtureAdapter();
  assert.deepEqual(await adapter.invoke('observe', { sessionId: 'session-1' }), { kind: 'idle' });
  const reply = await adapter.invoke('prompt', { sessionId: 'session-1', text: 'work' });
  assert.equal(reply.sequence, 1);
  assert.deepEqual(requests, ['work']);
  assert.deepEqual(
    adapter.describe().capabilities.map(({ name, effect }) => [name, effect]),
    [
      ['observe', 'read'],
      ['prompt', 'mutation'],
    ],
  );
  assert.equal(adapter.describe().apiVersion, 1);
  assert.equal(adapter.describe().capabilities[0]?.input.type, 'object');
  async function compileTimeContract() {
    // @ts-expect-error Capability names remain exact after composition.
    await adapter.invoke('launch', {});
    // @ts-expect-error Prompt requires text as well as the session identity.
    await adapter.invoke('prompt', { sessionId: 'session-1' });
    // @ts-expect-error Prompt result has a numeric sequence.
    const sequence: string = (
      await adapter.invoke('prompt', { sessionId: 'session-1', text: 'work' })
    ).sequence;
    return sequence;
  }
  void compileTimeContract;
});

test('registry lookup is pinned and composition cannot overwrite capabilities', async () => {
  const fixture = fixtureAdapter();
  const v2 = composeAdapter({ id: 'fixture-harness', version: 2 }, fixture.state);
  const registry = new AdapterRegistry([fixture.adapter, v2]);
  assert.equal(registry.describe().length, 2);
  assert.throws(
    () =>
      new AdapterRegistry([{ ...fixture.adapter, reference: { id: '../invalid', version: 1 } }]),
    { code: 'invalid-reference', phase: 'before-invocation' },
  );
  assert.equal(registry.get({ id: 'fixture-harness', version: 2 }), v2);
  assert.throws(() => registry.get({ id: 'fixture-harness', version: 3 }), {
    code: 'adapter-not-found',
  });
  assert.throws(() => new AdapterRegistry([fixture.adapter, fixture.adapter]), {
    code: 'duplicate-adapter',
  });
  assert.throws(
    () => composeAdapter({ id: 'collision', version: 1 }, fixture.state, fixture.state),
    { code: 'duplicate-capability' },
  );
  await assert.rejects(v2.dispatch('prompt', { text: 'not supported' }), {
    code: 'unsupported-capability',
    phase: 'before-invocation',
  });
  assert.deepEqual(fixture.requests, []);
});

test('invalid input and pre-cancelled calls cannot reach a harness', async () => {
  const { adapter, requests } = fixtureAdapter();
  await assert.rejects(
    adapter.dispatch('prompt', { sessionId: 's', text: 42, token: 'SECRET_SENTINEL' }),
    (error: Error) => {
      assert.ok(error instanceof AdapterError);
      assert.equal(error.code, 'invalid-input');
      assert.equal(error.phase, 'before-invocation');
      assert.ok(error.fields.includes('text'));
      assert.doesNotMatch(error.message, /SECRET_SENTINEL/);
      return true;
    },
  );
  await assert.rejects(
    adapter.dispatch('prompt', { sessionId: 's', text: 'work', number: Infinity }),
    { code: 'invalid-input', phase: 'before-invocation' },
  );
  await assert.rejects(
    adapter.invoke('prompt', { sessionId: 's', text: 'work' }, { signal: AbortSignal.abort() }),
    { code: 'aborted', phase: 'before-invocation' },
  );
  type CyclicFixture = { self?: CyclicFixture };
  const cycle: CyclicFixture = {};
  cycle.self = cycle;
  await assert.rejects(adapter.invoke('prompt', { sessionId: 's', text: 'work', ...cycle }), {
    code: 'invalid-input',
    phase: 'before-invocation',
  });
  assert.deepEqual(requests, []);
});

test('validation and cancellation failures after invocation never retry a harness', async () => {
  let calls = 0;
  const malformed = composeAdapter(
    { id: 'malformed', version: 1 },
    {
      prompt: defineCapability({
        input: z.object({}).strict(),
        output: z.object({ status: z.string().min(1) }).strict(),
        effect: 'mutation',
        summary: 'Return a malformed fixture reply.',
        execute: () => {
          calls++;
          return { status: '' };
        },
      }),
    },
  );
  await assert.rejects(malformed.invoke('prompt', {}), {
    code: 'invalid-output',
    phase: 'after-invocation',
  });
  assert.equal(calls, 1);
  const started = Promise.withResolvers<void>();
  const cancelled = composeAdapter(
    { id: 'cancelled', version: 1 },
    {
      prompt: defineCapability({
        input: z.object({}).strict(),
        output: z.literal('submitted'),
        effect: 'mutation',
        summary: 'Observe cancellation in a running fixture.',
        execute: async (_, { signal }) => {
          calls++;
          started.resolve();
          await new Promise<void>((_, reject) =>
            signal?.addEventListener('abort', () => reject(new Error('SECRET_BACKEND_ERROR')), {
              once: true,
            }),
          );
          return 'submitted' as const;
        },
      }),
    },
  );
  const controller = new AbortController();
  const pending = cancelled.invoke('prompt', {}, { signal: controller.signal });
  await started.promise;
  controller.abort();
  await assert.rejects(pending, (error: Error) => {
    assert.ok(error instanceof AdapterError);
    assert.equal(error.phase, 'after-invocation');
    assert.doesNotMatch(error.message, /SECRET_BACKEND_ERROR/);
    return true;
  });
  assert.equal(calls, 2);
});

test('async input validation is described offline and fails before harness execution', async () => {
  let validations = 0;
  let executions = 0;
  const adapter = composeAdapter(
    { id: 'validated', version: 1 },
    {
      prompt: defineCapability({
        input: z.string().refine(async () => {
          validations++;
          throw new Error('SECRET_VALIDATOR_INPUT');
        }),
        output: z.string(),
        effect: 'mutation',
        summary: 'Exercise a failing async validator.',
        execute: (input) => {
          executions++;
          return input;
        },
      }),
    },
  );
  assert.equal(adapter.describe().capabilities.length, 1);
  assert.equal(validations, 0);
  await assert.rejects(adapter.invoke('prompt', 'message'), (error: Error) => {
    assert.ok(error instanceof AdapterError);
    assert.equal(error.phase, 'before-invocation');
    assert.equal(error.code, 'invalid-input');
    assert.doesNotMatch(error.message, /SECRET_VALIDATOR_INPUT/);
    return true;
  });
  assert.equal(validations, 1);
  assert.equal(executions, 0);
});

test('adapter outputs cannot lose a class prototype while retaining a class return type', async () => {
  class Result {
    value = 'result';
  }
  const adapter = composeAdapter(
    { id: 'class-result', version: 1 },
    {
      run: defineCapability({
        input: z.object({}).strict(),
        output: z.object({}).transform(() => new Result()),
        effect: 'read',
        summary: 'Produce a non-JSON fixture.',
        execute: () => ({}),
      }),
    },
  );
  await assert.rejects(adapter.invoke('run', {}), {
    code: 'invalid-output',
    phase: 'after-invocation',
  });
});

test('a composed local-process harness works without Herdr identity fields', async () => {
  const adapter = composeAdapter(
    { id: 'local-process-fixture', version: 1 },
    {
      run: defineCapability({
        input: z.object({ text: z.string().max(100) }).strict(),
        output: z
          .object({
            text: z.string(),
            pid: z.number().int().positive(),
            optional: z.string().optional(),
          })
          .strict(),
        effect: 'mutation',
        summary: 'Run a disposable Node process.',
        execute: async ({ text }, { signal }) => {
          const result = await runProcess(
            process.execPath,
            [
              '-e',
              'process.stdout.write(JSON.stringify({text:process.argv[1],pid:process.pid}))',
              text,
            ],
            { signal, timeout: 5000, maxBuffer: 4096 },
          );
          const parsed = z
            .object({ text: z.string(), pid: z.number() })
            .parse(JSON.parse(result.stdout));
          return { ...parsed, optional: undefined };
        },
      }),
    },
  );
  const result = await adapter.invoke('run', { text: 'adapter process proof' });
  assert.equal(result.text, 'adapter process proof');
  assert.notEqual(result.pid, process.pid);
  assert.equal(Object.hasOwn(result, 'optional'), false);
});

test('Codex app-server composes only messaging and retains its expected-turn checks', async () => {
  const calls: AppServerRequest[] = [];
  const transport: JsonRpcTransport = {
    notify() {},
    close() {},
    async request(request) {
      calls.push(request);
      if (request.method === 'thread/read')
        return { kind: 'thread-read', threadId: 't', status: 'active', turns: [] };
      if (request.method === 'turn/steer') return { kind: 'turn-steered', turnId: 'turn-1' };
      throw new Error('Unexpected fixture request');
    },
  };
  const adapter = createCodexAppServerAdapter({
    binding: {
      projectId: 'p',
      executionHostId: 'h',
      endpointHostId: 'h',
      endpoint: {
        kind: 'websocket',
        url: 'ws://127.0.0.1:4500',
        authorization: 'SECRET_CREDENTIAL',
      },
      threadId: 't',
      activeTurnId: 'turn-1',
    },
    transport,
  });
  assert.deepEqual(
    adapter.describe().capabilities.map(({ name }) => name),
    ['inspect', 'deliver'],
  );
  assert.doesNotMatch(JSON.stringify(adapter.describe()), /SECRET_CREDENTIAL/);
  const result = await adapter.invoke('deliver', {
    deliveryId: 'd',
    project: 'p',
    recipient: { kind: 'codex-desktop', id: 't', generation: '1' },
    message: 'result ready',
  });
  assert.deepEqual(result, { kind: 'submitted', turnId: 'turn-1' });
  assert.deepEqual(
    calls.map(({ method }) => method),
    ['thread/read', 'turn/steer'],
  );
  const steer = calls[1];
  assert.equal(steer?.method, 'turn/steer');
  if (steer?.method === 'turn/steer') assert.equal(steer.params.expectedTurnId, 'turn-1');
  await assert.rejects(adapter.dispatch('launch', {}), { code: 'unsupported-capability' });
  assert.equal(calls.length, 2);
});
