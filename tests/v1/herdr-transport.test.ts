import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { HerdrError, socketRequest } from '../../src/herdr-transport.js';

const RequestSchema = z.object({ id: z.string().uuid(), method: z.string() });

test('transport handles fragmented correlated NDJSON and rejects silent delivery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'herdr-v1-transport-'));
  const socketPath = join(root, 'h.sock');

  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (data) => {
      buffer += data;
      const newline = buffer.indexOf('\n');

      if (newline < 0) return;
      const request = RequestSchema.parse(JSON.parse(buffer.slice(0, newline)));

      if (request.method === 'silent') {
        socket.end();

        return;
      }

      socket.write(JSON.stringify({ id: 'unrelated', result: { wrong: true } }) + '\n');

      const response =
        JSON.stringify({ id: request.id, result: { type: 'pong', protocol: 20 } }) + '\n';

      socket.write(response.slice(0, 15));
      setImmediate(() => socket.end(response.slice(15)));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });

  try {
    assert.deepEqual(await socketRequest(socketPath, 'ping', {}), { type: 'pong', protocol: 20 });
    await assert.rejects(
      socketRequest(socketPath, 'silent', {}),
      (error) => error instanceof HerdrError && error.code === 'herdr_disconnected',
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
