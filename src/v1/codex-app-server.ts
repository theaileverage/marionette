import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import { Effect, Result, Schema } from 'effect';
import { codexAppServerThreadPointer, type NativeSessionPointer } from './native-session.js';

export type AppServerEndpoint =
  | { kind: 'websocket'; url: string; authorization?: string }
  | { kind: 'unix'; socketPath: string; requestPath?: string; authorization?: string };

export type CodexThreadBinding = {
  projectId: string;
  executionHostId: string;
  endpointHostId: string;
  endpoint: AppServerEndpoint;
  threadId: string;
  activeTurnId?: string;
};

export type CodexDelivery =
  | { kind: 'submitted'; turnId: string }
  | { kind: 'unconfirmed'; reason: string }
  | { kind: 'unsupported'; reason: string };

export type CodexThreadHistory =
  | { kind: 'unconfirmed'; reason: string }
  | { kind: 'session-missing'; reason: string }
  | {
      kind: 'available';
      threadId: string;
      reference: NativeSessionPointer;
      status: 'active' | 'idle';
      turns: unknown[];
      truncated: boolean;
      bytes: number;
    };

export interface CodexAppServerPort {
  deliver(input: {
    deliveryId: string;
    project: string;
    recipient: { kind: 'codex-desktop'; id: string; generation: string };
    message: string;
  }): Promise<CodexDelivery>;
  inspect(options?: { limit?: number; maxBytes?: number }): Promise<CodexThreadHistory>;
}

export type AppServerRequest =
  | {
      method: 'initialize';
      params: { clientInfo: { name: string; title: string; version: string } };
    }
  | { method: 'thread/read'; params: { threadId: string; includeTurns: boolean } }
  | {
      method: 'turn/steer';
      params: {
        threadId: string;
        expectedTurnId: string;
        clientUserMessageId: string;
        input: readonly [{ type: 'text'; text: string }];
      };
    }
  | {
      method: 'turn/start';
      params: {
        threadId: string;
        clientUserMessageId: string;
        input: readonly [{ type: 'text'; text: string }];
      };
    };

export type AppServerNotification = { method: 'initialized'; params: object };

export type AppServerReply =
  | { kind: 'initialized' }
  | { kind: 'thread-read'; threadId: string; status: 'active' | 'idle' | 'notLoaded'; turns: unknown[] }
  | { kind: 'turn-steered'; turnId: string }
  | { kind: 'turn-started'; turnId: string };

export interface JsonRpcTransport {
  request(request: AppServerRequest): Promise<AppServerReply>;
  notify(notification: AppServerNotification): void;
  close(): void;
}

export class AppServerRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'AppServerRpcError';
  }
}

type Pending = {
  request: AppServerRequest;
  resolve: (value: AppServerReply) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type DecodedReply = { id: number; reply: AppServerReply };

const integer = Schema.Number.check(Schema.makeFilter(Number.isInteger));

const rpcErrorSchema = Schema.Struct({ code: integer, message: Schema.NonEmptyString });

const rpcEnvelopeSchema = Schema.Struct({
  id: integer,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(rpcErrorSchema),
}).annotate({ parseOptions: { onExcessProperty: 'preserve' } });

const initializedResultSchema = Schema.Struct({}).annotate({
  parseOptions: { onExcessProperty: 'preserve' },
});

const threadReadResultSchema = Schema.Struct({
  thread: Schema.Struct({
    id: Schema.NonEmptyString,
    status: Schema.Struct({ type: Schema.Literals(['active', 'idle', 'notLoaded']) }).annotate({
      parseOptions: { onExcessProperty: 'preserve' },
    }),
    turns: Schema.Array(Schema.Unknown),
  }),
});

const turnSteerResultSchema = Schema.Struct({ turnId: Schema.NonEmptyString });

const turnStartResultSchema = Schema.Struct({ turn: Schema.Struct({ id: Schema.NonEmptyString }) });

function errorText(error: Error) {
  return error.message;
}

function maskedFrame(text: string) {
  const data = Buffer.from(text);
  const mask = randomBytes(4);
  let header: Buffer;

  if (data.length < 126) header = Buffer.from([0x81, 0x80 | data.length]);
  else if (data.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0xfe;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0xff;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }

  const payload = Buffer.alloc(data.length);

  for (let index = 0; index < data.length; index += 1)
    payload[index] = data[index] ^ mask[index % 4];

  return Buffer.concat([header, mask, payload]);
}

function unmaskedFrame(opcode: number, payload: Buffer) {
  const length = payload.length;

  if (length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, length]), payload]);

  if (length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);

    return Buffer.concat([header, payload]);
  }

  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);

  return Buffer.concat([header, payload]);
}

function decodeReply(request: AppServerRequest, text: string): DecodedReply {
  let decoded: unknown;

  try {
    decoded = JSON.parse(text);
  } catch {
    throw new Error('Codex app-server sent invalid JSON');
  }

  const envelope = Schema.decodeUnknownResult(rpcEnvelopeSchema)(decoded);

  if (Result.isFailure(envelope))
    throw new Error('Codex app-server sent an invalid JSON-RPC response');

  if (envelope.success.error)
    throw new AppServerRpcError(envelope.success.error.code, envelope.success.error.message);

  if (envelope.success.result === undefined)
    throw new Error('Codex app-server response lacked result');

  if (request.method === 'initialize') {
    if (
      !Result.isSuccess(
        Schema.decodeUnknownResult(initializedResultSchema)(envelope.success.result),
      )
    )
      throw new Error('initialize returned an invalid result');

    return { id: envelope.success.id, reply: { kind: 'initialized' } };
  }

  if (request.method === 'thread/read') {
    const result = Schema.decodeUnknownResult(threadReadResultSchema)(envelope.success.result);

    if (Result.isFailure(result)) throw new Error('thread/read returned an invalid result');

    return {
      id: envelope.success.id,
      reply: {
        kind: 'thread-read',
        threadId: result.success.thread.id,
        status: result.success.thread.status.type,
        turns: [...result.success.thread.turns],
      },
    };
  }

  if (request.method === 'turn/steer') {
    const result = Schema.decodeUnknownResult(turnSteerResultSchema)(envelope.success.result);

    if (Result.isFailure(result)) throw new Error('turn/steer returned an invalid result');

    return {
      id: envelope.success.id,
      reply: { kind: 'turn-steered', turnId: result.success.turnId },
    };
  }

  const result = Schema.decodeUnknownResult(turnStartResultSchema)(envelope.success.result);

  if (Result.isFailure(result)) throw new Error('turn/start returned an invalid result');

  return {
    id: envelope.success.id,
    reply: { kind: 'turn-started', turnId: result.success.turn.id },
  };
}

/** A small JSON-RPC 2.0 client for a registered app-server WebSocket or Unix-socket endpoint. */
export class AppServerWebSocketTransport implements JsonRpcTransport {
  private constructor(private readonly socket: net.Socket) {
    socket.on('data', (data) => this.receive(data));
    socket.on('error', (error) => this.failAll(error));
    socket.on('close', () => this.failAll(new Error('Codex app-server disconnected')));
  }

  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, Pending>();
  private closed = false;

  static async connect(endpoint: AppServerEndpoint) {
    const socket = await AppServerWebSocketTransport.open(endpoint);
    await AppServerWebSocketTransport.upgrade(socket, endpoint);
    const transport = new AppServerWebSocketTransport(socket);
    await transport.request({
      method: 'initialize',
      params: { clientInfo: { name: 'marionette-v1', title: 'Marionette', version: '1.0.0' } },
    });
    transport.notify({ method: 'initialized', params: {} });

    return transport;
  }

  private static open(endpoint: AppServerEndpoint) {
    return new Promise<net.Socket>((resolve, reject) => {
      const socket =
        endpoint.kind === 'unix'
          ? net.createConnection({ path: endpoint.socketPath })
          : (() => {
              const url = new URL(endpoint.url);

              if (url.protocol !== 'ws:') throw new Error('Only ws: app-server URLs are supported');

              return net.createConnection({ host: url.hostname, port: Number(url.port || '80') });
            })();

      const failed = (error: Error) => {
        socket.destroy();
        reject(error);
      };

      socket.once('error', failed);
      socket.once('connect', () => {
        socket.off('error', failed);
        resolve(socket);
      });
    });
  }

  private static upgrade(socket: net.Socket, endpoint: AppServerEndpoint) {
    const key = randomBytes(16).toString('base64');

    const target =
      endpoint.kind === 'unix'
        ? (endpoint.requestPath ?? '/')
        : new URL(endpoint.url).pathname || '/';

    const host = endpoint.kind === 'unix' ? 'localhost' : new URL(endpoint.url).host;

    const authorization = endpoint.authorization
      ? `Authorization: Bearer ${endpoint.authorization}\r\n`
      : '';

    const request =
      `GET ${target} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${authorization}\r\n`;

    const accepted = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');

    return new Promise<void>((resolve, reject) => {
      let response = Buffer.alloc(0);
      const failed = (error: Error) => reject(error);

      const received = (data: Buffer) => {
        response = Buffer.concat([response, data]);
        const end = response.indexOf('\r\n\r\n');

        if (end < 0) return;
        socket.off('error', failed);
        socket.off('data', received);
        const header = response.subarray(0, end).toString('utf8');

        if (
          !header.startsWith('HTTP/1.1 101') ||
          !header.toLowerCase().includes(`sec-websocket-accept: ${accepted.toLowerCase()}`)
        ) {
          socket.destroy();
          reject(new Error('Codex app-server rejected WebSocket upgrade'));

          return;
        }

        const remaining = response.subarray(end + 4);

        if (remaining.length > 0) socket.unshift(remaining);
        resolve();
      };

      socket.once('error', failed);
      socket.on('data', received);
      socket.write(request, (error) => {
        if (error) failed(error);
      });
    });
  }

  request(request: AppServerRequest) {
    if (this.closed) return Promise.reject(new Error('Codex app-server transport is closed'));
    const id = this.nextId++;

    return new Promise<AppServerReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${request.method} acknowledgement is unknown after timeout`));
      }, 10000);

      this.pending.set(id, { request, resolve, reject, timer });
      this.send(JSON.stringify({ jsonrpc: '2.0', id, ...request }));
    });
  }

  notify(notification: AppServerNotification) {
    if (!this.closed) this.send(JSON.stringify({ jsonrpc: '2.0', ...notification }));
  }

  private send(message: string) {
    this.socket.write(maskedFrame(message), (error) => {
      if (error) this.failAll(error);
    });
  }

  private receive(data: Buffer) {
    this.buffer = Buffer.concat([this.buffer, data]);

    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      let offset = 2;
      let length = second & 0x7f;

      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const value = this.buffer.readBigUInt64BE(2);

        if (value > BigInt(Number.MAX_SAFE_INTEGER))
          return this.failAll(new Error('App-server frame is too large'));
        length = Number(value);
        offset = 10;
      }

      if ((second & 0x80) !== 0) return this.failAll(new Error('App-server sent a masked frame'));

      if (this.buffer.length < offset + length) return;
      const payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);

      if (opcode === 0x8) return this.close();

      if (opcode === 0x9) {
        this.socket.write(unmaskedFrame(0x0a, payload));
        continue;
      }

      if (opcode !== 0x1 || (first & 0x80) === 0)
        return this.failAll(new Error('Unsupported fragmented app-server frame'));
      this.receiveJson(payload.toString('utf8'));
    }
  }

  private receiveJson(text: string) {
    let envelope: Result.Result<typeof rpcEnvelopeSchema.Type, Schema.SchemaError>;

    try {
      envelope = Schema.decodeUnknownResult(rpcEnvelopeSchema)(JSON.parse(text));
    } catch {
      this.failAll(new Error('Codex app-server sent invalid JSON'));

      return;
    }

    if (Result.isFailure(envelope))
      return this.failAll(new Error('Codex app-server sent invalid JSON-RPC'));
    const pending = this.pending.get(envelope.success.id);

    if (!pending) return;
    this.pending.delete(envelope.success.id);
    clearTimeout(pending.timer);

    try {
      const decoded = decodeReply(pending.request, text);
      pending.resolve(decoded.reply);
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error('App-server response failed'));
    }
  }

  private failAll(error: Error) {
    if (this.closed) return;
    this.closed = true;

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }

    this.pending.clear();
  }

  close() {
    if (this.closed) return;
    this.failAll(new Error('Codex app-server transport closed'));
    this.socket.end(unmaskedFrame(0x8, Buffer.alloc(0)));
  }
}

type ThreadMode = { kind: 'active' } | { kind: 'idle' };

function threadMode(reply: AppServerReply): ThreadMode | undefined {
  if (reply.kind !== 'thread-read') return undefined;

  return reply.status === 'active' ? { kind: 'active' } : { kind: 'idle' };
}

export class AppServerInvocationError extends Schema.TaggedError<AppServerInvocationError>()(
  'AppServerInvocationError',
  { method: Schema.String, cause: Schema.Defect() },
) {}

type DeliveryInput = Parameters<CodexAppServerPort['deliver']>[0];

type MessageInput = Pick<DeliveryInput, 'deliveryId' | 'message'>;

/** Delivery adapter for one registered Desktop thread. The watcher retains delivery durability. */
export class CodexAppServerDeliveryPort implements CodexAppServerPort {
  constructor(
    private readonly binding: CodexThreadBinding,
    private readonly transport: JsonRpcTransport,
  ) {}

  private requestEffect(request: AppServerRequest) {
    return Effect.tryPromise({
      try: () => this.transport.request(request),
      catch: (cause) => new AppServerInvocationError({ method: request.method, cause }),
    });
  }

  inspectEffect = Effect.fn('CodexAppServer.inspect')(function* (
    this: CodexAppServerDeliveryPort,
    options: { limit?: number; maxBytes?: number } = {},
  ): Effect.fn.Return<CodexThreadHistory> {
    if (this.binding.executionHostId !== this.binding.endpointHostId)
      return { kind: 'unconfirmed', reason: 'App-server endpoint is on another execution host' };
    const limit = options.limit ?? 50;
    const maxBytes = options.maxBytes ?? 64 * 1024;

    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      return yield* Effect.die(new Error('Codex history limit must be between 1 and 200'));

    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024)
      return yield* Effect.die(new Error('Codex history maxBytes must be between 1 and 262144'));

    const result = yield* Effect.result(
      this.requestEffect({
        method: 'thread/read',
        params: { threadId: this.binding.threadId, includeTurns: true },
      }),
    );

    if (Result.isFailure(result)) return this.unconfirmedHistory(result.failure, 'thread/read failed');
    const reply = result.success;

    if (reply.kind !== 'thread-read')
      return { kind: 'unconfirmed', reason: 'thread/read returned an unexpected reply' };

    if (reply.threadId !== this.binding.threadId)
      return { kind: 'unconfirmed', reason: 'thread/read returned another thread identity' };

    if (reply.status === 'notLoaded')
      return { kind: 'session-missing', reason: 'The registered Codex thread is not loaded' };
    const selected: unknown[] = [];
    let bytes = 0;

    for (let index = reply.turns.length - 1; index >= 0 && selected.length < limit; index -= 1) {
      const turn = reply.turns[index];
      const size = Buffer.byteLength(JSON.stringify(turn));

      if (bytes + size > maxBytes) break;
      selected.unshift(turn);
      bytes += size;
    }

    return {
      kind: 'available',
      threadId: reply.threadId,
      reference: codexAppServerThreadPointer(reply.threadId),
      status: reply.status,
      turns: selected,
      truncated: selected.length < reply.turns.length,
      bytes,
    };
  });

  inspect(options: { limit?: number; maxBytes?: number } = {}): Promise<CodexThreadHistory> {
    return Effect.runPromise(this.inspectEffect(options));
  }

  deliverEffect = Effect.fn('CodexAppServer.deliver')(function* (
    this: CodexAppServerDeliveryPort,
    input: DeliveryInput,
  ): Effect.fn.Return<CodexDelivery> {
    if (input.project !== this.binding.projectId || input.recipient.id !== this.binding.threadId)
      return {
        kind: 'unsupported',
        reason: 'Delivery does not target the registered project thread',
      };

    if (this.binding.executionHostId !== this.binding.endpointHostId)
      return {
        kind: 'unsupported',
        reason: 'App-server endpoint is not on the project execution host',
      };

    const read = yield* Effect.result(
      this.requestEffect({
        method: 'thread/read',
        params: { threadId: this.binding.threadId, includeTurns: false },
      }),
    );

    if (Result.isFailure(read)) return this.unconfirmed(read.failure, 'thread/read failed');
    const mode = threadMode(read.success);

    if (!mode) return { kind: 'unsupported', reason: 'thread/read returned an unexpected reply' };

    return yield* mode.kind === 'active' ? this.steerOrStartEffect(input) : this.startEffect(input);
  });

  deliver(input: DeliveryInput): Promise<CodexDelivery> {
    return Effect.runPromise(this.deliverEffect(input));
  }

  private unconfirmed(error: AppServerInvocationError, fallback: string): CodexDelivery {
    return {
      kind: 'unconfirmed',
      reason: error.cause instanceof Error ? errorText(error.cause) : fallback,
    };
  }

  private unconfirmedHistory(error: AppServerInvocationError, fallback: string): CodexThreadHistory {
    return {
      kind: 'unconfirmed',
      reason: error.cause instanceof Error ? errorText(error.cause) : fallback,
    };
  }

  private steerOrStartEffect = Effect.fn('CodexAppServer.steerOrStart')(function* (
    this: CodexAppServerDeliveryPort,
    input: MessageInput,
  ): Effect.fn.Return<CodexDelivery> {
    if (!this.binding.activeTurnId)
      return {
        kind: 'unconfirmed',
        reason: 'Active thread has no registered expected turn identity',
      };

    const result = yield* Effect.result(
      this.requestEffect({
        method: 'turn/steer',
        params: {
          threadId: this.binding.threadId,
          expectedTurnId: this.binding.activeTurnId,
          clientUserMessageId: input.deliveryId,
          input: [{ type: 'text', text: input.message }],
        },
      }),
    );

    if (Result.isSuccess(result))
      return result.success.kind === 'turn-steered'
        ? { kind: 'submitted', turnId: result.success.turnId }
        : { kind: 'unconfirmed', reason: 'turn/steer returned an unexpected reply' };
    const error = result.failure.cause;

    if (!(error instanceof AppServerRpcError))
      return this.unconfirmed(result.failure, 'turn/steer failed');

    const read = yield* Effect.result(
      this.requestEffect({
        method: 'thread/read',
        params: { threadId: this.binding.threadId, includeTurns: false },
      }),
    );

    if (Result.isFailure(read)) return this.unconfirmed(read.failure, 'thread/read failed');

    return threadMode(read.success)?.kind === 'idle'
      ? yield* this.startEffect(input)
      : { kind: 'unconfirmed', reason: `turn/steer rejected: ${error.message}` };
  });

  private startEffect = Effect.fn('CodexAppServer.start')(function* (
    this: CodexAppServerDeliveryPort,
    input: MessageInput,
  ): Effect.fn.Return<CodexDelivery> {
    const result = yield* Effect.result(
      this.requestEffect({
        method: 'turn/start',
        params: {
          threadId: this.binding.threadId,
          clientUserMessageId: input.deliveryId,
          input: [{ type: 'text', text: input.message }],
        },
      }),
    );

    if (Result.isFailure(result)) return this.unconfirmed(result.failure, 'turn/start failed');

    return result.success.kind === 'turn-started'
      ? { kind: 'submitted', turnId: result.success.turnId }
      : { kind: 'unconfirmed', reason: 'turn/start returned an unexpected reply' };
  });
}
