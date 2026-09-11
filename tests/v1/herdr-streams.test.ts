import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { HerdrClient, HerdrError } from '../../src/herdr-sdk.js';

const RequestSchema = z.object({ id: z.string().uuid(), method: z.string() });
type Request = z.infer<typeof RequestSchema>;
type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };
const GraphicsHeaderSchema = z.object({
  file: z.object({ path: z.string() }).optional(),
  data_length: z.number().int().positive().optional(),
  sequence: z.number().int().optional(),
  revision: z.number().int().optional(),
});
type GraphicsHeader = z.infer<typeof GraphicsHeaderSchema>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function fixture(handle: (socket: net.Socket, request: Request, remaining: Buffer) => void) {
  const root = mkdtempSync(join(tmpdir(), 'herdr-v1-stream-'));
  const path = join(root, 'h.sock');
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    const receiveInitial = (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      socket.off('data', receiveInitial);
      handle(
        socket,
        RequestSchema.parse(JSON.parse(buffer.subarray(0, newline).toString())),
        buffer.subarray(newline + 1),
      );
    };
    socket.on('data', receiveInitial);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  return {
    client: new HerdrClient(path),
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function reply(socket: net.Socket, id: string, result: JsonValue) {
  socket.write(JSON.stringify({ id, result }) + '\n');
}

function event(name: string, data: JsonValue) {
  return JSON.stringify({ event: name, data }) + '\n';
}

test('subscriptions preserve coalesced and fragmented UTF-8 events', async () => {
  const peer = deferred<net.Socket>();
  const f = await fixture((socket, request) => {
    peer.resolve(socket);
    socket.write(
      JSON.stringify({ id: request.id, result: { type: 'subscription_started' } }) +
        '\n' +
        event('pane.created', { pane: { pane_id: 'w1:p1' } }),
    );
  });
  try {
    const stream = await f.client.subscribe([{ type: 'pane.created' }]);
    assert.equal((await stream.next()).value?.event, 'pane.created');
    const socket = await peer.promise;
    const bytes = Buffer.from(event('pane.agent_status_changed', { title: 'प्रश्न 🐑' }));
    const offset = bytes.indexOf(Buffer.from('🐑')) + 2;
    socket.write(bytes.subarray(0, offset));
    setImmediate(() => socket.write(bytes.subarray(offset)));
    const next = await stream.next();
    assert.equal(next.value?.event, 'pane.agent_status_changed');
    assert.equal(z.object({ title: z.string() }).parse(next.value?.data).title, 'प्रश्न 🐑');
    stream.close();
    await stream.closed;
    assert.equal((await stream.next()).done, true);
  } finally {
    await f.close();
  }
});

test('subscriptions fail on overflow, EOF, and abort without reconnecting', async () => {
  for (const mode of ['overflow', 'bytes', 'eof', 'abort'] as const) {
    let connections = 0;
    const peer = deferred<net.Socket>();
    const f = await fixture((socket, request) => {
      connections += 1;
      peer.resolve(socket);
      reply(socket, request.id, { type: 'subscription_started' });
    });
    try {
      const abort = new AbortController();
      const stream = await f.client.subscribe([{ type: 'pane.created' }], {
        signal: abort.signal,
        maxQueuedEvents: 1,
        maxQueuedBytes: mode === 'bytes' ? 150 : 4_096,
      });
      const socket = await peer.promise;
      if (mode === 'overflow') socket.write(event('pane.created', {}) + event('pane.created', {}));
      if (mode === 'bytes') socket.write(event('pane.created', { text: 'x'.repeat(200) }));
      if (mode === 'eof') socket.end();
      if (mode === 'abort') abort.abort();
      const code =
        mode === 'abort'
          ? 'herdr_aborted'
          : mode === 'eof'
            ? 'herdr_disconnected'
            : 'herdr_stream_overflow';
      await assert.rejects(
        stream.closed,
        (error) => error instanceof HerdrError && error.code === code,
      );
      await assert.rejects(
        stream.next(),
        (error) => error instanceof HerdrError && error.code === code,
      );
      assert.equal(connections, 1);
    } finally {
      await f.close();
    }
  }
});

test('graphics streams preserve bytes and correlate immutable file-frame acknowledgements', async () => {
  const inline = deferred<{ header: GraphicsHeader; bytes: Buffer }>();
  const file = deferred<GraphicsHeader>();
  const f = await fixture((socket, request, remaining) => {
    assert.equal(request.method, 'pane.graphics.stream');
    reply(socket, request.id, { type: 'ok' });
    let input = remaining;
    let header: GraphicsHeader | undefined;
    const consume = (data: Buffer) => {
      input = Buffer.concat([input, data]);
      while (true) {
        if (header === undefined) {
          const newline = input.indexOf(10);
          if (newline < 0) return;
          header = GraphicsHeaderSchema.parse(JSON.parse(input.subarray(0, newline).toString()));
          input = input.subarray(newline + 1);
        }
        if (header.file !== undefined) {
          file.resolve(header);
          reply(socket, `${request.id}:file:${header.sequence}`, {
            type: 'pane_graphics_frame_ack',
            sequence: z.number().parse(header.sequence),
            revision: z.number().parse(header.revision),
          });
        } else {
          if (header.data_length === undefined || input.length < header.data_length) return;
          inline.resolve({
            header,
            bytes: Buffer.from(input.subarray(0, header.data_length)),
          });
          input = input.subarray(header.data_length);
        }
        header = undefined;
      }
    };
    socket.on('data', consume);
    consume(Buffer.alloc(0));
  });
  try {
    const stream = await f.client.graphicsStream({ pane_id: 'w1:p1', layer_id: 'test' });
    const bytes = Buffer.from([0, 10, 255, 127]);
    const sent = stream.frame({ format: 'rgba', image_width: 1, image_height: 1 }, bytes);
    bytes.fill(42);
    await assert.rejects(
      stream.frame({ format: 'rgba', image_width: 1, image_height: 1 }, bytes),
      (error) => error instanceof HerdrError && error.code === 'herdr_stream_busy',
    );
    await sent;
    assert.deepEqual((await inline.promise).bytes, Buffer.from([0, 10, 255, 127]));
    const frame = {
      format: 'rgba' as const,
      image_width: 1,
      image_height: 1,
      file: { path: '/tmp/immutable-frame.rgba' },
      sequence: 12,
      revision: 3,
    };
    const pendingAck = stream.fileFrame(frame);
    frame.sequence = 13;
    frame.revision = 4;
    const ack = await pendingAck;
    assert.deepEqual(ack, { type: 'pane_graphics_frame_ack', sequence: 12, revision: 3 });
    assert.equal((await file.promise).data_length, undefined);
    stream.close();
    await stream.closed;
  } finally {
    await f.close();
  }
});
