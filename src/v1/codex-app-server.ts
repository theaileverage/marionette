import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';

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

export interface CodexAppServerPort {
  deliver(input: {
    deliveryId: string;
    project: string;
    recipient: { kind: 'codex-desktop'; id: string; generation: string };
    message: string;
  }): Promise<CodexDelivery>;
}

export interface JsonRpcTransport {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  notify(method: string, params: Record<string, unknown>): void;
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
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
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
    await transport.request('initialize', {
      clientInfo: { name: 'marionette-v1', title: 'Marionette', version: '1.0.0' },
    });
    transport.notify('initialized', {});
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

  request(method: string, params: Record<string, unknown>) {
    if (this.closed) return Promise.reject(new Error('Codex app-server transport is closed'));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} acknowledgement is unknown after timeout`));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown>) {
    if (!this.closed) this.send({ method, params });
  }

  private send(message: Record<string, unknown>) {
    this.socket.write(maskedFrame(JSON.stringify(message)), (error) => {
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
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      this.failAll(new Error('Codex app-server sent invalid JSON'));
      return;
    }
    if (!record(message) || typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (
      record(message.error) &&
      typeof message.error.code === 'number' &&
      typeof message.error.message === 'string'
    ) {
      pending.reject(new AppServerRpcError(message.error.code, message.error.message));
      return;
    }
    if (!Object.hasOwn(message, 'result')) {
      pending.reject(new Error('Codex app-server response lacked result'));
      return;
    }
    pending.resolve(message.result);
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

type ThreadMode = { kind: 'active' } | { kind: 'idle' } | { kind: 'unavailable'; reason: string };

function threadMode(value: unknown): ThreadMode {
  if (!record(value) || !record(value.thread) || !record(value.thread.status))
    return { kind: 'unavailable', reason: 'thread/read returned no thread status' };
  const status = value.thread.status;
  if (status.type === 'active') return { kind: 'active' };
  if (status.type === 'idle' || status.type === 'notLoaded') return { kind: 'idle' };
  return {
    kind: 'unavailable',
    reason: `Thread is ${typeof status.type === 'string' ? status.type : 'unknown'}`,
  };
}

function turnId(value: unknown, field: 'turnId' | 'turn') {
  if (!record(value)) return undefined;
  if (field === 'turnId') return typeof value.turnId === 'string' ? value.turnId : undefined;
  return record(value.turn) && typeof value.turn.id === 'string' ? value.turn.id : undefined;
}

/** Delivery adapter for one registered Desktop thread. The watcher retains delivery durability. */
export class CodexAppServerDeliveryPort implements CodexAppServerPort {
  constructor(
    private readonly binding: CodexThreadBinding,
    private readonly transport: JsonRpcTransport,
  ) {}

  async deliver(input: {
    deliveryId: string;
    project: string;
    recipient: { kind: 'codex-desktop'; id: string; generation: string };
    message: string;
  }): Promise<CodexDelivery> {
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
    let mode: ThreadMode;
    try {
      mode = threadMode(
        await this.transport.request('thread/read', {
          threadId: this.binding.threadId,
          includeTurns: false,
        }),
      );
    } catch (error) {
      return { kind: 'unconfirmed', reason: errorText(error) };
    }
    if (mode.kind === 'unavailable') return { kind: 'unsupported', reason: mode.reason };
    if (mode.kind === 'active') return this.steerOrStart(input);
    return this.start(input);
  }

  private async steerOrStart(input: {
    deliveryId: string;
    message: string;
  }): Promise<CodexDelivery> {
    if (!this.binding.activeTurnId)
      return {
        kind: 'unconfirmed',
        reason: 'Active thread has no registered expected turn identity',
      };
    try {
      const result = await this.transport.request('turn/steer', {
        threadId: this.binding.threadId,
        expectedTurnId: this.binding.activeTurnId,
        clientUserMessageId: input.deliveryId,
        input: [{ type: 'text', text: input.message }],
      });
      const id = turnId(result, 'turnId');
      return id
        ? { kind: 'submitted', turnId: id }
        : { kind: 'unconfirmed', reason: 'turn/steer lacked turnId' };
    } catch (error) {
      if (!(error instanceof AppServerRpcError))
        return { kind: 'unconfirmed', reason: errorText(error) };
      try {
        const mode = threadMode(
          await this.transport.request('thread/read', {
            threadId: this.binding.threadId,
            includeTurns: false,
          }),
        );
        return mode.kind === 'idle'
          ? this.start(input)
          : { kind: 'unconfirmed', reason: `turn/steer rejected: ${error.message}` };
      } catch (readError) {
        return { kind: 'unconfirmed', reason: errorText(readError) };
      }
    }
  }

  private async start(input: { deliveryId: string; message: string }): Promise<CodexDelivery> {
    try {
      const result = await this.transport.request('turn/start', {
        threadId: this.binding.threadId,
        clientUserMessageId: input.deliveryId,
        input: [{ type: 'text', text: input.message }],
      });
      const id = turnId(result, 'turn');
      return id
        ? { kind: 'submitted', turnId: id }
        : { kind: 'unconfirmed', reason: 'turn/start lacked turn.id' };
    } catch (error) {
      return { kind: 'unconfirmed', reason: errorText(error) };
    }
  }
}
