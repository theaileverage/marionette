import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'bun:test';
import { HerdrClient, HerdrError } from '../src/herdr-sdk.js';

test('SDK refuses implicit session discovery and invalid deadlines', async () => {
  assert.throws(() => HerdrClient.fromEnv({}), /inside Herdr/);
  assert.throws(
    () => HerdrClient.fromEnv({ HERDR_SOCKET_PATH: '/tmp/example.sock' }),
    /inside Herdr/,
  );
  assert.throws(() => new HerdrClient('relative.sock'), /absolute/);
  assert.doesNotThrow(() => new HerdrClient(String.raw`\\.\pipe\herdr-test`));
  assert.doesNotThrow(() => new HerdrClient(String.raw`\\?\pipe\herdr-test`));
  const h = new HerdrClient('/tmp/not-a-real-herdr.sock');
  await assert.rejects(h.request('ping', {}, { maxResponseBytes: 0 }), /maxResponseBytes/);
  for (const timeout of [0, -1, NaN, Infinity, 2147483648])
    await assert.rejects(h.call('ping', {}, timeout), /bounded duration/);
});

test('SDK helpers encode explicit targets, preserve errors and decode split UTF-8', async () => {
  const root = mkdtempSync(join(tmpdir(), 'herdr-sdk-'));
  const socketPath = join(root, 'h.sock');
  const requests: any[] = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (data) => {
      buffer += data;
      if (!buffer.includes('\n')) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
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
    const h = new HerdrClient(socketPath);
    assert.deepEqual(await h.call('unicode'), { text: 'हेरड 🐑' });
    await h.pane.split('w1:p9', {
      direction: 'down',
      cwd: '/tmp/project',
      env: { EXAMPLE: 'literal' },
    });
    assert.deepEqual(requests.at(-1).params, {
      focus: false,
      direction: 'down',
      cwd: '/tmp/project',
      env: { EXAMPLE: 'literal' },
      target_pane_id: 'w1:p9',
    });
    await h.tab.create('w1', { cwd: '/tmp/project' });
    assert.deepEqual(requests.at(-1).params, {
      focus: false,
      cwd: '/tmp/project',
      workspace_id: 'w1',
    });
    await h.agent.prompt('worker', 'literal text', { timeout_ms: 120000 });
    assert.deepEqual(requests.at(-1).params, {
      target: 'worker',
      text: 'literal text',
      wait: { timeout_ms: 120000 },
    });
    await assert.rejects(
      h.call('failure'),
      (e: any) => e instanceof HerdrError && e.code === 'pane_not_found',
    );
    await assert.rejects(h.call('malformed'), (e: any) => e.code === 'herdr_invalid_response');
    await assert.rejects(h.call('timeout', {}, 25), (e: any) => e.code === 'herdr_timeout');
    assert.equal(requests.filter((r) => r.method === 'timeout').length, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
