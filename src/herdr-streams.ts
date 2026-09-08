import { isAbsolute } from 'node:path';
import {
  HerdrError,
  JsonConnection,
  validateTimeout,
  type StreamOptions,
} from './herdr-transport.js';
import type { HerdrEvent, HerdrResult, RequestTypes } from './herdr-protocol.js';

export class HerdrEventStream implements AsyncIterableIterator<HerdrEvent> {
  private constructor(private connection: JsonConnection) {}
  static async open(
    socketPath: string,
    subscriptions: RequestTypes.Subscription[],
    options: StreamOptions = {},
  ) {
    const timeout = options.timeoutMs === undefined ? 10000 : options.timeoutMs;
    validateTimeout(timeout);
    JSON.stringify(subscriptions);
    const connection = new JsonConnection(socketPath, options);
    try {
      const result = await connection.start('events.subscribe', { subscriptions }, timeout);
      if (result?.type !== 'subscription_started')
        throw new HerdrError('herdr_invalid_response', 'Missing subscription acknowledgement');
      return new HerdrEventStream(connection);
    } catch (error) {
      connection.close();
      throw error;
    }
  }
  get closed() {
    return this.connection.closed;
  }
  [Symbol.asyncIterator]() {
    return this;
  }
  async next(): Promise<IteratorResult<HerdrEvent>> {
    const value = await this.connection.read();
    if (value === undefined) return { done: true, value: undefined };
    if (!value || typeof value.event !== 'string' || !Object.hasOwn(value, 'data')) {
      const error = new HerdrError('herdr_invalid_response', 'Expected a Herdr event envelope');
      this.connection.fail(error, true);
      throw error;
    }
    return { done: false, value: value as HerdrEvent };
  }
  close() {
    this.connection.close();
  }
  async return(): Promise<IteratorResult<HerdrEvent>> {
    this.close();
    return { done: true, value: undefined };
  }
}

/** This wire method is documented but omitted from Herdr 0.9.0's exported JSON schema. */
export interface GraphicsStreamParams {
  pane_id: string;
  layer_id?: string | null;
  z_index?: number;
}
export interface GraphicsFrame {
  format: RequestTypes.PaneGraphicsFormat;
  image_width: number;
  image_height: number;
  placement?: RequestTypes.PaneGraphicsPlacementParams;
}
export interface GraphicsFileFrame extends Omit<GraphicsFrame, 'format'> {
  format: 'rgba' | 'bgra';
  file: { path: string };
  sequence: number;
  revision: number;
}
export type GraphicsFrameAck = Extract<HerdrResult, { type: 'pane_graphics_frame_ack' }>;
const maxInlineBytes = 16 * 1024 * 1024;
function integer(value: number, name: string, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new TypeError(`Invalid ${name}`);
}
function frameHeader(frame: GraphicsFrame) {
  integer(frame.image_width, 'image_width', 1, 0xffffffff);
  integer(frame.image_height, 'image_height', 1, 0xffffffff);
  if (!['png', 'rgb', 'rgba', 'bgra'].includes(frame.format))
    throw new TypeError('Invalid frame format');
  return {
    format: frame.format,
    image_width: frame.image_width,
    image_height: frame.image_height,
    ...(frame.placement ? { placement: frame.placement } : {}),
  };
}
function encodeHeader(header: unknown) {
  const line = JSON.stringify(header) + '\n';
  if (Buffer.byteLength(line) > 64 * 1024) throw new TypeError('Graphics header exceeds 64 KiB');
  return line;
}

export class HerdrGraphicsStream {
  private busy = false;
  private constructor(private connection: JsonConnection) {}
  static async open(socketPath: string, params: GraphicsStreamParams, options: StreamOptions = {}) {
    const timeout = options.timeoutMs === undefined ? 10000 : options.timeoutMs;
    validateTimeout(timeout);
    JSON.stringify(params);
    const connection = new JsonConnection(socketPath, options);
    try {
      const result = await connection.start('pane.graphics.stream', params, timeout);
      if (result?.type !== 'ok')
        throw new HerdrError('herdr_invalid_response', 'Missing graphics stream acknowledgement');
      return new HerdrGraphicsStream(connection);
    } catch (error) {
      connection.close();
      throw error;
    }
  }
  /** Resolves after local close; rejects on remote failure, cancellation, or disconnect. */
  get closed() {
    return this.connection.closed;
  }
  private async exclusive<T>(action: () => Promise<T>) {
    if (this.busy)
      throw new HerdrError('herdr_stream_busy', 'Await the previous frame before sending another');
    this.busy = true;
    try {
      return await action();
    } finally {
      this.busy = false;
    }
  }
  /** Resolves after local socket write, not a render ACK: inline success has no wire reply. */
  async frame(frame: GraphicsFrame, data: Uint8Array, timeoutMs = 30000): Promise<void> {
    validateTimeout(timeoutMs);
    if (!data.byteLength || data.byteLength > maxInlineBytes)
      throw new TypeError('Inline graphics data must be 1 byte to 16 MiB');
    const header = encodeHeader({ ...frameHeader(frame), data_length: data.byteLength });
    return this.exclusive(async () => {
      // Snapshot bytes before awaiting writes so caller mutation cannot corrupt framing.
      const bytes = Buffer.from(data);
      await this.connection.within(timeoutMs, async () => {
        await this.connection.write(header);
        await this.connection.write(bytes);
      });
    });
  }
  /** Keep the immutable source file until this method acknowledges its sequence and revision. */
  async fileFrame(frame: GraphicsFileFrame, timeoutMs = 30000): Promise<GraphicsFrameAck> {
    validateTimeout(timeoutMs);
    if (!['rgba', 'bgra'].includes(frame.format) || !isAbsolute(frame.file.path))
      throw new TypeError('File frames require rgba/bgra and an absolute source path');
    integer(frame.sequence, 'sequence');
    integer(frame.revision, 'revision');
    const { sequence, revision } = frame;
    const header = encodeHeader({
      ...frameHeader(frame),
      file: { path: frame.file.path },
      sequence,
      revision,
    });
    return this.exclusive(() =>
      this.connection.within(timeoutMs, async () => {
        await this.connection.write(header);
        const message = await this.connection.read();
        const result = message?.result;
        if (
          message?.id !== `${this.connection.id}:file:${sequence}` ||
          result?.type !== 'pane_graphics_frame_ack' ||
          result.sequence !== sequence ||
          result.revision !== revision
        ) {
          const error = new HerdrError(
            'herdr_invalid_response',
            'Graphics acknowledgement did not match the file frame',
          );
          this.connection.fail(error, true);
          throw error;
        }
        return result as GraphicsFrameAck;
      }),
    );
  }
  close() {
    this.connection.close();
  }
}
