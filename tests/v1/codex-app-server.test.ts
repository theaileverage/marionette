import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AppServerRpcError,
  CodexAppServerDeliveryPort,
  type CodexThreadBinding,
  type JsonRpcTransport,
} from '../../src/v1/codex-app-server.js';

function binding(activeTurnId?: string): CodexThreadBinding {
  return {
    projectId: 'project-1',
    executionHostId: 'host-1',
    endpointHostId: 'host-1',
    endpoint: { kind: 'websocket', url: 'ws://127.0.0.1:4500' },
    threadId: 'thread-1',
    ...(activeTurnId === undefined ? {} : { activeTurnId }),
  };
}

test('desktop delivery starts an idle registered thread without changing its settings', async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const transport: JsonRpcTransport = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/read') return { thread: { status: { type: 'idle' } } };
      if (method === 'turn/start') return { turn: { id: 'turn-1' } };
      throw new Error(`unexpected ${method}`);
    },
    notify() {},
    close() {},
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
    async request(method) {
      calls.push(method);
      if (method === 'thread/read') {
        reads += 1;
        return { thread: { status: { type: reads === 1 ? 'active' : 'idle' } } };
      }
      if (method === 'turn/steer') throw new AppServerRpcError(-32602, 'expected turn changed');
      if (method === 'turn/start') return { turn: { id: 'turn-2' } };
      throw new Error(`unexpected ${method}`);
    },
    notify() {},
    close() {},
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
      async request() {
        throw new Error('must not call');
      },
      notify() {},
      close() {},
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
