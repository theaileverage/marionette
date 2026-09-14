import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { HerdrClient, HerdrError } from '../../src/herdr-sdk.js';

const RequestSchema = z.object({
  id: z.string().uuid(),
  method: z.string(),
  params: z.record(z.unknown()),
});

test('SDK requires an explicit session and bounded deadlines', async () => {
  assert.throws(() => HerdrClient.fromEnv({}), /inside Herdr/);
  assert.throws(
    () => HerdrClient.fromEnv({ HERDR_SOCKET_PATH: '/tmp/example.sock' }),
    /inside Herdr/,
  );
  assert.throws(() => new HerdrClient('relative.sock'), /absolute/);
  assert.doesNotThrow(() => new HerdrClient(String.raw`\\.\pipe\herdr-test`));
  assert.doesNotThrow(() => new HerdrClient(String.raw`\\?\pipe\herdr-test`));
  const client = new HerdrClient('/tmp/not-a-real-herdr.sock');
  await assert.rejects(client.request('ping', {}, { maxResponseBytes: 0 }), /maxResponseBytes/);
  for (const timeout of [0, -1, Number.NaN, Infinity, 2_147_483_648]) {
    await assert.rejects(client.call('ping', {}, timeout), /bounded duration/);
  }
});

test('SDK helpers target the requested resource and retain wire failures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'herdr-v1-sdk-'));
  const socketPath = join(root, 'h.sock');
  const requests: z.infer<typeof RequestSchema>[] = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (data) => {
      buffer += data;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const request = RequestSchema.parse(JSON.parse(buffer.slice(0, newline)));
      buffer = buffer.slice(newline + 1);
      requests.push(request);
      if (request.method === 'timeout') return;
      if (request.method === 'malformed') {
        socket.end('{broken}\n');
        return;
      }
      if (request.method === 'failure') {
        socket.end(
          JSON.stringify({ id: request.id, error: { code: 'pane_not_found', message: 'Gone' } }) +
            '\n',
        );
        return;
      }
      const response = Buffer.from(
        JSON.stringify({ id: request.id, result: { text: 'हेरड 🐑' } }) + '\n',
      );
      const offset = response.indexOf(Buffer.from('🐑')) + 2;
      socket.write(response.subarray(0, offset));
      setImmediate(() => socket.end(response.subarray(offset)));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  try {
    const client = new HerdrClient(socketPath);
    assert.deepEqual(await client.call('unicode'), { text: 'हेरड 🐑' });
    await client.pane.split('w1:p9', {
      direction: 'down',
      cwd: '/tmp/project',
      env: { EXAMPLE: 'literal' },
    });
    assert.deepEqual(requests.at(-1)?.params, {
      focus: false,
      direction: 'down',
      cwd: '/tmp/project',
      env: { EXAMPLE: 'literal' },
      target_pane_id: 'w1:p9',
    });
    await client.tab.create('w1', { cwd: '/tmp/project' });
    assert.deepEqual(requests.at(-1)?.params, {
      focus: false,
      cwd: '/tmp/project',
      workspace_id: 'w1',
    });
    await client.agent.prompt('worker', 'literal text', { timeout_ms: 120_000 });
    assert.deepEqual(requests.at(-1)?.params, {
      target: 'worker',
      text: 'literal text',
      wait: { timeout_ms: 120_000 },
    });
    await assert.rejects(
      client.call('failure'),
      (error) => error instanceof HerdrError && error.code === 'pane_not_found',
    );
    await assert.rejects(
      client.call('malformed'),
      (error) => error instanceof HerdrError && error.code === 'herdr_invalid_response',
    );
    await assert.rejects(
      client.call('timeout', {}, 25),
      (error) => error instanceof HerdrError && error.code === 'herdr_timeout',
    );
    assert.equal(requests.filter((request) => request.method === 'timeout').length, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
