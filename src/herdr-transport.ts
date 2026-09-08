import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

export class HerdrError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HerdrError';
  }
}
export interface RequestOptions {
  /** Transport deadline, including connection time; null disables it. */
  timeoutMs?: number | null;
  signal?: AbortSignal;
  maxResponseBytes?: number;
}
export interface StreamOptions extends RequestOptions {
  maxQueuedEvents?: number;
  maxQueuedBytes?: number;
}
export function validateSocketPath(path: string) {
  if (!isAbsolute(path) && !/^\\\\[.?]\\pipe\\[^\\]/.test(path))
    throw new TypeError('An absolute Herdr socket path or Windows named pipe is required');
}
export function validateTimeout(value: number | null) {
  if (value !== null && (!Number.isFinite(value) || value <= 0 || value > 2147483647))
    throw new TypeError('timeoutMs must be a positive bounded duration or null');
}
function limit(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TypeError(`${name} must be a positive integer`);
  return value;
}

/** Internal, single-reader NDJSON connection. JSON reads and binary writes stay separate. */
export class JsonConnection {
  readonly id = randomUUID();
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  private rejectClosed!: (error: Error) => void;
  private socket: net.Socket;
  private buffer = '';
  private queue: { value: any; bytes: number }[] = [];
  private queuedBytes = 0;
  private reader?: { resolve: (value: any) => void; reject: (error: Error) => void };
  private writes = new Set<(error: Error) => void>();
  private ended = false;
  private failure?: Error;
  private explicitClose = false;
  private readonly maxMessageBytes: number;
  private readonly maxQueuedEvents: number;
  private readonly maxQueuedBytes: number;
  private readonly abort: () => void;
  constructor(
    socketPath: string,
    private options: StreamOptions = {},
  ) {
    validateSocketPath(socketPath);
    this.maxMessageBytes = limit(options.maxResponseBytes ?? 32 * 1024 * 1024, 'maxResponseBytes');
    this.maxQueuedEvents = limit(options.maxQueuedEvents ?? 1024, 'maxQueuedEvents');
    this.maxQueuedBytes = limit(options.maxQueuedBytes ?? this.maxMessageBytes, 'maxQueuedBytes');
    if (options.signal?.aborted)
      throw new HerdrError('herdr_aborted', 'Herdr operation was aborted');
    this.closed = new Promise<void>((resolve, reject) => {
      this.resolveClosed = resolve;
      this.rejectClosed = reject;
    });
    // Consumers may observe this promise; an unobserved stream error must not crash Node.
    void this.closed.catch(() => {});
    this.socket = net.createConnection(socketPath);
    this.socket.setEncoding('utf8');
    this.abort = () =>
      this.fail(new HerdrError('herdr_aborted', 'Herdr operation was aborted'), true);
    options.signal?.addEventListener('abort', this.abort, { once: true });
    this.socket.on('error', (error) =>
      this.fail(new HerdrError('herdr_unavailable', error.message)),
    );
    this.socket.on('close', () => {
      this.ended = true;
      this.detachAbort();
      this.rejectWrites(this.error());
      if (this.failure || !this.explicitClose) this.rejectClosed(this.error());
      else this.resolveClosed();
      this.deliver();
    });
    this.socket.on('data', (data: string) => this.receive(data));
  }
  private error() {
    return (
      this.failure ??
      new HerdrError(
        'herdr_disconnected',
        'Herdr disconnected before acknowledgement or stream completion',
      )
    );
  }
  private detachAbort() {
    this.options.signal?.removeEventListener('abort', this.abort);
  }
  private rejectWrites(error: Error) {
    for (const reject of this.writes) reject(error);
    this.writes.clear();
  }
  fail(error: Error, discard = false) {
    if (this.explicitClose) return;
    this.failure ??= error;
    this.ended = true;
    this.buffer = '';
    if (discard) {
      this.queue = [];
      this.queuedBytes = 0;
    }
    this.detachAbort();
    this.socket.destroy();
    this.rejectWrites(this.failure);
    this.deliver();
  }
  close() {
    this.explicitClose = true;
    this.ended = true;
    this.buffer = '';
    this.queue = [];
    this.queuedBytes = 0;
    this.detachAbort();
    this.socket.destroy();
    this.rejectWrites(this.error());
    this.deliver();
  }
  private deliver() {
    if (!this.reader) return;
    const reader = this.reader;
    if (this.failure) {
      this.reader = undefined;
      reader.reject(this.failure);
      return;
    }
    const next = this.queue.shift();
    if (next) {
      this.reader = undefined;
      this.queuedBytes -= next.bytes;
      reader.resolve(next.value);
    } else if (this.ended) {
      this.reader = undefined;
      if (this.explicitClose) reader.resolve(undefined);
      else reader.reject(this.error());
    }
  }
  private receive(data: string) {
    if (this.ended) return;
    this.buffer += data;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      const bytes = Buffer.byteLength(line);
      if (bytes > this.maxMessageBytes)
        return this.fail(
          new HerdrError('herdr_response_too_large', 'Herdr message exceeded maxResponseBytes'),
          true,
        );
      let value: any;
      try {
        value = JSON.parse(line);
      } catch (error) {
        return this.fail(new HerdrError('herdr_invalid_response', String(error)), true);
      }
      // Each connection owns one request; graphics replies append a frame identifier.
      if (
        value?.id !== undefined &&
        value.id !== this.id &&
        !String(value.id).startsWith(this.id + ':')
      )
        continue;
      if (value?.error)
        return this.fail(new HerdrError(value.error.code, value.error.message), true);
      if (
        this.queue.length >= this.maxQueuedEvents ||
        this.queuedBytes + bytes > this.maxQueuedBytes
      )
        return this.fail(
          new HerdrError(
            'herdr_stream_overflow',
            'Herdr consumer fell behind; stream closed without silently dropping events',
          ),
          true,
        );
      this.queue.push({ value, bytes });
      this.queuedBytes += bytes;
      this.deliver();
    }
    if (Buffer.byteLength(this.buffer) > this.maxMessageBytes)
      this.fail(
        new HerdrError('herdr_response_too_large', 'Herdr message exceeded maxResponseBytes'),
        true,
      );
  }
  read(): Promise<any> {
    if (this.reader)
      return Promise.reject(new Error('Only one reader may consume a Herdr connection'));
    return new Promise((resolve, reject) => {
      this.reader = { resolve, reject };
      this.deliver();
    });
  }
  write(data: string | Uint8Array): Promise<void> {
    if (this.ended) return Promise.reject(this.error());
    return new Promise((resolve, reject) => {
      this.writes.add(reject);
      this.socket.write(data, (error) => {
        this.writes.delete(reject);
        if (error) {
          this.fail(new HerdrError('herdr_unavailable', error.message));
          reject(this.error());
        } else if (this.failure) reject(this.failure);
        else resolve();
      });
    });
  }
  async within<T>(timeoutMs: number | null, action: () => Promise<T>): Promise<T> {
    validateTimeout(timeoutMs);
    const timer =
      timeoutMs === null
        ? undefined
        : setTimeout(
            () =>
              this.fail(
                new HerdrError(
                  'herdr_timeout',
                  'Herdr response timed out; delivery may be ambiguous',
                ),
                true,
              ),
            timeoutMs,
          );
    try {
      return await action();
    } finally {
      clearTimeout(timer);
    }
  }
  async start(method: string, params: unknown, timeoutMs: number | null) {
    return this.within(timeoutMs, async () => {
      await this.write(JSON.stringify({ id: this.id, method, params }) + '\n');
      const message = await this.read();
      if (!message || message.id !== this.id || !Object.hasOwn(message, 'result'))
        throw new HerdrError('herdr_invalid_response', `${method}: missing correlated result`);
      return message.result;
    });
  }
}

export async function socketRequest<T>(
  socketPath: string,
  method: string,
  params: unknown,
  options: RequestOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs === undefined ? 10000 : options.timeoutMs;
  validateTimeout(timeoutMs);
  // Validate serialization before opening a connection.
  JSON.stringify(params);
  const connection = new JsonConnection(socketPath, options);
  try {
    return (await connection.start(method, params, timeoutMs)) as T;
  } finally {
    connection.close();
  }
}
