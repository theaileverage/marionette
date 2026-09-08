import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'bun:test';
import { Herdr } from '../src/herdr.js';
import { inputScreen } from '../src/supervisor.js';

test('socket transport handles fragmented correlated NDJSON and refuses silent delivery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mrd-')),
    socketPath = join(root, 'h.sock');
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (data) => {
      buffer += data;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline));
      buffer = '';
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
  await new Promise<void>((r) => server.listen(socketPath, r));
  try {
    const h = new Herdr(socketPath);
    assert.deepEqual(await h.call('ping'), { type: 'pong', protocol: 20 });
    await assert.rejects(h.call('silent'), /before acknowledgement/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
});
test('native approval detection supplements Herdr status without treating prose as approval', () => {
  assert.equal(
    inputScreen(
      'Allow access to this file?\n> 1. Yes, allow access\n2. Always allow\n↑/↓ Navigate\nesc to cancel',
    ),
    true,
  );
  assert.equal(
    inputScreen('Allow creation of this file?\n> 1. Yes, allow creation\nesc to cancel'),
    true,
  );
  assert.equal(
    inputScreen(
      'Implemented a page containing the phrase Allow access to this file? Tests passed.',
    ),
    false,
  );
  assert.equal(
    inputScreen('Do you trust the files in this folder?\n❯ 1. Yes\nPress enter to continue'),
    true,
  );
});
