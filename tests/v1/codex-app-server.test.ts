import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AppServerRpcError,
  CodexAppServerDeliveryPort,
  type AppServerReply,
  type AppServerRequest,
  type CodexThreadBinding,
  type JsonRpcTransport,
} from '../../src/v1/codex-app-server.js';

function binding(activeTurnId?: string): CodexThreadBinding {
  const result: CodexThreadBinding = {
    projectId: 'project-1',
    executionHostId: 'host-1',
    endpointHostId: 'host-1',
    endpoint: { kind: 'websocket', url: 'ws://127.0.0.1:4500' },
    threadId: 'thread-1',
  };

  if (activeTurnId !== undefined) result.activeTurnId = activeTurnId;

  return result;
}

function noNotifications(): Pick<JsonRpcTransport, 'notify' | 'close'> {
  return { notify() {}, close() {} };
}

test('desktop delivery starts an idle registered thread without changing its settings', async () => {
  const calls: AppServerRequest[] = [];

  const transport: JsonRpcTransport = {
    ...noNotifications(),
    async request(request): Promise<AppServerReply> {
      calls.push(request);

      if (request.method === 'thread/read')
        return { kind: 'thread-read', threadId: 'thread-1', status: 'idle', turns: [] };

      if (request.method === 'turn/start') return { kind: 'turn-started', turnId: 'turn-1' };
      throw new Error(`unexpected ${request.method}`);
    },
  };

  const port = new CodexAppServerDeliveryPort(binding(), transport);

  const result = await port.deliver({
    deliveryId: 'delivery-1',
    project: 'project-1',
    recipient: { kind: 'codex-desktop', id: 'thread-1', generation: 'desktop-1' },
    message: 'A result is ready.',
  });

  assert.deepEqual(result, { kind: 'submitted', turnId: 'turn-1' });
  assert.deepEqual(calls.at(-1), {
    method: 'turn/start',
    params: {
      threadId: 'thread-1',
      clientUserMessageId: 'delivery-1',
      input: [{ type: 'text', text: 'A result is ready.' }],
    },
  });
});

test('desktop delivery steers only the registered active turn and starts after an explicit mismatch reaches idle', async () => {
  let reads = 0;
  const calls: string[] = [];

  const transport: JsonRpcTransport = {
    ...noNotifications(),
    async request(request): Promise<AppServerReply> {
      calls.push(request.method);

      if (request.method === 'thread/read') {
        reads += 1;

        return {
          kind: 'thread-read',
          threadId: 'thread-1',
          status: reads === 1 ? 'active' : 'idle',
          turns: [],
        };
      }

      if (request.method === 'turn/steer')
        throw new AppServerRpcError(-32602, 'expected turn changed');

      if (request.method === 'turn/start') return { kind: 'turn-started', turnId: 'turn-2' };
      throw new Error(`unexpected ${request.method}`);
    },
  };

  const port = new CodexAppServerDeliveryPort(binding('turn-old'), transport);

  const result = await port.deliver({
    deliveryId: 'delivery-2',
    project: 'project-1',
    recipient: { kind: 'codex-desktop', id: 'thread-1', generation: 'desktop-1' },
    message: 'Please inspect the board.',
  });

  assert.deepEqual(result, { kind: 'submitted', turnId: 'turn-2' });
  assert.deepEqual(calls, ['thread/read', 'turn/steer', 'thread/read', 'turn/start']);
});

test('desktop delivery rejects an endpoint registered to another execution host', async () => {
  const port = new CodexAppServerDeliveryPort(
    { ...binding(), endpointHostId: 'host-2' },
    {
      ...noNotifications(),
      async request() {
        throw new Error('must not call');
      },
    },
  );

  const result = await port.deliver({
    deliveryId: 'delivery-3',
    project: 'project-1',
    recipient: { kind: 'codex-desktop', id: 'thread-1', generation: 'desktop-1' },
    message: 'Blocked.',
  });

  assert.equal(result.kind, 'unsupported');
});

test('Codex history reads only the bound thread and applies turn and byte bounds', async () => {
  const calls: AppServerRequest[] = [];

  const transport: JsonRpcTransport = {
    ...noNotifications(),
    async request(request): Promise<AppServerReply> {
      calls.push(request);

      if (request.method !== 'thread/read') throw new Error('inspection must be read-only');

      return {
        kind: 'thread-read',
        threadId: 'thread-1',
        status: 'idle',
        turns: [{ id: 'turn-1' }, { id: 'turn-2' }, { id: 'turn-3' }],
      };
    },
  };

  const result = await new CodexAppServerDeliveryPort(binding('not-a-thread-id'), transport).inspect({
    limit: 2,
    maxBytes: 1024,
  });

  assert.deepEqual(result, {
    kind: 'available',
    threadId: 'thread-1',
    reference: {
      harness: 'codex-app-server',
      kind: 'thread',
      value: 'thread-1',
      source: 'codex-app-server:thread/read',
    },
    status: 'idle',
    turns: [{ id: 'turn-2' }, { id: 'turn-3' }],
    truncated: true,
    bytes: 30,
  });
  assert.deepEqual(calls, [
    { method: 'thread/read', params: { threadId: 'thread-1', includeTurns: true } },
  ]);
});

test('Codex history rejects mismatched thread and endpoint identities without using turn ids', async () => {
  let calls = 0;

  const remote = new CodexAppServerDeliveryPort(
    { ...binding('turn-1'), endpointHostId: 'host-2' },
    {
      ...noNotifications(),
      async request() {
        calls += 1;
        throw new Error('must not call');
      },
    },
  );

  assert.equal((await remote.inspect()).kind, 'unconfirmed');
  assert.equal(calls, 0);

  const mismatched = new CodexAppServerDeliveryPort(binding('thread-other'), {
    ...noNotifications(),
    async request() {
      return {
        kind: 'thread-read',
        threadId: 'thread-other',
        status: 'idle',
        turns: [],
      };
    },
  });

  assert.deepEqual(await mismatched.inspect(), {
    kind: 'unconfirmed',
    reason: 'thread/read returned another thread identity',
  });
});
