import { Schema } from 'effect';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, jest } from 'bun:test';
import { HerdrClient } from '../src/herdr-sdk.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function fixture(handle: (socket: net.Socket, request: any, remaining: Buffer) => void) {
  const root = mkdtempSync(join(tmpdir(), 'herdr-stream-'));
  const path = join(root, 'h.sock');
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    const initial = (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      socket.off('data', initial);
      handle(
        socket,
        JSON.parse(buffer.subarray(0, newline).toString()),
        buffer.subarray(newline + 1),
      );
    };
    socket.on('data', initial);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  return {
    h: new HerdrClient(path),
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const reply = (socket: net.Socket, id: string, result: Schema.MutableJson) =>
  socket.write(JSON.stringify({ id, result }) + '\n');
const event = (event: string, data: Schema.MutableJson) => JSON.stringify({ event, data }) + '\n';

test('subscriptions preserve coalesced and fragmented events through an async iterator', async () => {
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
    const stream = await f.h.subscribe([
      { type: 'pane.created' },
      { type: 'pane.agent_status_changed', pane_id: 'w1:p1' },
    ]);
    assert.equal((await stream.next()).value.event, 'pane.created');
    const socket = await peer.promise;
    const bytes = Buffer.from(
      event('pane.agent_status_changed', {
        pane_id: 'w1:p1',
        workspace_id: 'w1',
        agent_status: 'blocked',
        title: 'प्रश्न 🐑',
      }),
    );
    const offset = bytes.indexOf(Buffer.from('🐑')) + 2;
    socket.write(bytes.subarray(0, offset));
    setImmediate(() => socket.write(bytes.subarray(offset)));
    for await (const item of stream) {
      assert.equal(item.event, 'pane.agent_status_changed');
      assert.equal(
        Schema.decodeUnknownSync(Schema.Struct({ title: Schema.String }))(item.data).title,
        'प्रश्न 🐑',
      );
      break;
    }
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
      connections++;
      peer.resolve(socket);
      reply(socket, request.id, { type: 'subscription_started' });
    });
    try {
      const abort = new AbortController();
      const stream = await f.h.subscribe([{ type: 'pane.created' }], {
        signal: abort.signal,
        maxQueuedEvents: 1,
        maxQueuedBytes: mode === 'bytes' ? 150 : 4096,
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
      await assert.rejects(stream.closed, (e: any) => e.code === code, mode);
      await assert.rejects(stream.next(), (e: any) => e.code === code, mode);
      assert.equal(connections, 1);
    } finally {
      await f.close();
    }
  }
});

test('closing a subscription wakes an outstanding reader', async () => {
  const f = await fixture((socket, request) =>
    reply(socket, request.id, { type: 'subscription_started' }),
  );
  try {
    const stream = await f.h.subscribe([{ type: 'pane.created' }]);
    const next = stream.next();
    stream.close();
    assert.equal((await next).done, true);
    await stream.closed;
  } finally {
    await f.close();
  }
});

test('one-shot waits honor cancellation and server deadlines', async () => {
  const peer = deferred<{ socket: net.Socket; request: any }>();
  let connects = 0;
  const f = await fixture((socket, request) => {
    connects++;
    peer.resolve({ socket, request });
  });
  try {
    await assert.rejects(
      f.h.request('ping', {}, { signal: AbortSignal.abort() }),
      (e: any) => e.code === 'herdr_aborted',
    );
    assert.equal(connects, 0);
    jest.useFakeTimers();
    const controller = new AbortController();
    const waiting = f.h.request(
      'events.wait',
      { match_event: { event: 'pane_created' }, timeout_ms: 120000 },
      { signal: controller.signal },
    );
    let settled = false;
    void waiting.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await peer.promise;
    jest.advanceTimersByTime(10001);
    await Promise.resolve();
    assert.equal(settled, false, 'A server wait must outlive the generic 10-second deadline');
    controller.abort();
    await assert.rejects(waiting, (e: any) => e.code === 'herdr_aborted');
    assert.equal(connects, 1);
  } finally {
    jest.useRealTimers();
    await f.close();
  }
});

test('graphics streams serialize exact binary bytes and correlate file-frame acknowledgements', async () => {
  const inline = deferred<{ header: any; bytes: Buffer }>();
  const file = deferred<any>();
  const f = await fixture((socket, request, remaining) => {
    assert.equal(request.method, 'pane.graphics.stream');
    reply(socket, request.id, { type: 'ok' });
    let input = remaining;
    let header: any;
    const consume = (data: Buffer) => {
      input = Buffer.concat([input, data]);
      for (;;) {
        if (!header) {
          const newline = input.indexOf(10);
          if (newline < 0) return;
          header = JSON.parse(input.subarray(0, newline).toString());
          input = input.subarray(newline + 1);
        }
        if (header.file) {
          file.resolve(header);
          reply(socket, `${request.id}:file:${header.sequence}`, {
            type: 'pane_graphics_frame_ack',
            sequence: header.sequence,
            revision: header.revision,
          });
        } else {
          if (input.length < header.data_length) return;
          inline.resolve({ header, bytes: Buffer.from(input.subarray(0, header.data_length)) });
          input = input.subarray(header.data_length);
        }
        header = undefined;
      }
    };
    socket.on('data', consume);
    consume(Buffer.alloc(0));
  });
  try {
    const stream = await f.h.graphicsStream({ pane_id: 'w1:p1', layer_id: 'test' });
    const bytes = Buffer.from([0, 10, 255, 127]);
    const sent = stream.frame({ format: 'rgba', image_width: 1, image_height: 1 }, bytes);
    bytes.fill(42);
    await assert.rejects(
      stream.frame({ format: 'rgba', image_width: 1, image_height: 1 }, bytes),
      (e: any) => e.code === 'herdr_stream_busy',
    );
    await sent;
    assert.deepEqual((await inline.promise).bytes, Buffer.from([0, 10, 255, 127]));
    assert.equal((await inline.promise).header.data_length, 4);
    const fileFrame = {
      format: 'rgba' as const,
      image_width: 1,
      image_height: 1,
      file: { path: '/tmp/immutable-frame.rgba' },
      sequence: 12,
      revision: 3,
    };
    const pendingAck = stream.fileFrame(fileFrame);
    fileFrame.sequence = 13;
    fileFrame.revision = 4;
    const ack = await pendingAck;
    assert.deepEqual(ack, { type: 'pane_graphics_frame_ack', sequence: 12, revision: 3 });
    assert.equal((await file.promise).data_length, undefined);
    await assert.rejects(
      stream.frame({ format: 'rgba', image_width: 1, image_height: 1 }, Buffer.alloc(0)),
      /1 byte/,
    );
    stream.close();
    await stream.closed;
  } finally {
    await f.close();
  }
});

test('graphics stream surfaces server errors, wrong ACKs and lost ACKs without replay', async () => {
  for (const mode of ['error', 'wrong', 'timeout'] as const) {
    let frames = 0;
    const received = deferred<void>();
    const f = await fixture((socket, request) => {
      reply(socket, request.id, { type: 'ok' });
      socket.once('data', (data) => {
        frames++;
        const header = JSON.parse(data.toString());
        received.resolve();
        if (mode === 'error')
          socket.end(
            JSON.stringify({
              id: request.id,
              error: { code: 'stream_conflict', message: 'Layer unavailable' },
            }) + '\n',
          );
        if (mode === 'wrong')
          reply(socket, `${request.id}:file:${header.sequence}`, {
            type: 'pane_graphics_frame_ack',
            sequence: header.sequence,
            revision: 999,
          });
      });
    });
    try {
      const stream = await f.h.graphicsStream({ pane_id: 'w1:p1' });
      if (mode === 'timeout') jest.useFakeTimers();
      const sent = stream.fileFrame(
        {
          format: 'rgba',
          image_width: 1,
          image_height: 1,
          file: { path: '/tmp/frame.rgba' },
          sequence: 1,
          revision: 1,
        },
        100,
      );
      const rejected = assert.rejects(
        sent,
        (e: any) =>
          e.code ===
          (mode === 'error'
            ? 'stream_conflict'
            : mode === 'wrong'
              ? 'herdr_invalid_response'
              : 'herdr_timeout'),
      );
      await received.promise;
      if (mode === 'timeout') jest.advanceTimersByTime(101);
      await rejected;
      await assert.rejects(stream.closed);
      assert.equal(frames, 1);
    } finally {
      jest.useRealTimers();
      await f.close();
    }
  }
});
