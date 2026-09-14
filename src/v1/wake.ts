import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { z } from 'zod';

/**
 * Local wake transport.
 *
 * A poke is attention, never authority. It carries no credentials, no context
 * path and no post content, so the receiving watcher must re-read durable state
 * to learn what changed. That is why any role may send one, and why losing one
 * costs latency only: the caller's fallback interval still finds the same rows.
 */

/** Endpoint filename inside the project state directory, which is already 0700. */
export const WAKE_SOCKET_FILENAME = 'wake.sock';
/** Fallback endpoint directory beside `projects`, created 0700 in the state root. */
export const WAKE_DIRECTORY = 'wake';
/** A poke carries attention, not content; both sides refuse anything larger. */
export const MAX_WAKE_PAYLOAD_BYTES = 512;
/** Darwin caps sun_path at 104 bytes including its terminator; Linux allows 108. */
export const MAX_WAKE_SOCKET_PATH_BYTES = 104;

/** Quiet watchers wake at least this often even when every poke is lost. */
export const DEFAULT_FALLBACK_INTERVAL_MS = 15_000;
/** Periodic native reconciliation of attempts that are already running. */
export const DEFAULT_RECONCILE_INTERVAL_MS = 5_000;
/** Attempts still owed launch or prompt progress keep the original cadence. */
export const DEFAULT_START_PROGRESS_INTERVAL_MS = 1_000;
/** First retry after a pass that found work but could not settle any of it. */
export const DEFAULT_BUSY_RETRY_MS = 250;
/** Ceiling for that retry, so an indefinitely busy recipient stays cheap. */
export const MAX_BUSY_RETRY_MS = 5_000;
/**
 * Floor between delivery passes. Pokes are cheap but not free: each pass costs a
 * claim attempt and a read, so an unbounded signal rate would turn into an
 * unbounded transaction rate. Small enough that a wake still feels immediate.
 */
export const DEFAULT_MIN_DELIVERY_INTERVAL_MS = 25;

const POKE_TIMEOUT_MS = 250;
const RECEIVE_TIMEOUT_MS = 1_000;
const PROBE_TIMEOUT_MS = 250;
const DEFAULT_MAX_PENDING_POKES = 32;

const wakeMessageSchema = z.object({ v: z.literal(1), projectId: z.string().min(1) }).strict();

export type WakeOutcome = 'poked' | 'timeout' | 'aborted' | 'closed';

/**
 * The watcher's durable-work predicate, in the shape the watcher declares it:
 * a cheap read that performs no native observation and settles nothing.
 */
export interface PendingWorkPort {
  hasPendingWork(): Promise<boolean>;
}

/**
 * Locates a project's endpoint, as a pure function of the project so that a
 * sender and a receiver always agree without consulting each other.
 *
 * The endpoint belongs in the project state directory, and lives there whenever
 * the kernel can express that path as a socket address. It often cannot: the
 * address limit is far below PATH_MAX, and `projects/<projectId>/wake.sock`
 * alone costs 46 bytes of it. The fallback keeps the endpoint in the same
 * private state root under a digest of the project, which costs 27, so a longer
 * home directory loses headroom rather than losing the transport outright.
 */
export function wakeSocketPath(stateDirectory: string, projectId: string): string {
  const preferred = join(stateDirectory, WAKE_SOCKET_FILENAME);
  if (wakeSocketPathFits(preferred)) return preferred;
  const name = createHash('sha256').update(projectId).digest('hex').slice(0, 16);
  return join(dirname(dirname(stateDirectory)), WAKE_DIRECTORY, `${name}.sock`);
}

/** A path the platform cannot express as a socket address degrades to the timer. */
export function wakeSocketPathFits(path: string): boolean {
  return Buffer.byteLength(path) <= MAX_WAKE_SOCKET_PATH_BYTES;
}

function hasCode(error: Error, code: string): boolean {
  return 'code' in error && error.code === code;
}

/**
 * Checks that the directory holding the endpoint is one this process controls.
 *
 * `lstat`, never `stat`: a symlinked endpoint directory would place the socket
 * somewhere else entirely, and following it silently is how a private endpoint
 * stops being private.
 */
export function endpointDirectoryFault(directory: string): string | null {
  const stats = lstatSync(directory, { throwIfNoEntry: false });
  if (stats === undefined) return 'the wake endpoint directory is missing';
  if (stats.isSymbolicLink()) return 'the wake endpoint directory is a symbolic link';
  if (!stats.isDirectory()) return 'the wake endpoint directory is not a directory';
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid)
    return 'the wake endpoint directory belongs to another user';
  if ((stats.mode & 0o077) !== 0)
    return 'the wake endpoint directory is readable or writable by other users';
  return null;
}

function listenOnce(server: Server, path: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const settle = (error?: Error) => {
      server.off('error', onError);
      server.off('listening', onListening);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error) => settle(error);
    const onListening = () => settle();
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(path);
  });
}

/**
 * Classifies an occupied endpoint.
 *
 * Only `ECONNREFUSED` proves that nobody is listening on a socket. A timeout, a
 * permission error or a saturated backlog all come from endpoints that may well
 * be alive, so they are inconclusive and must never be read as absence.
 */
type EndpointProbe = 'answered' | 'stale' | 'inconclusive';

function probeEndpoint(path: string): Promise<EndpointProbe> {
  return new Promise<EndpointProbe>((resolve) => {
    let settled = false;
    const finish = (outcome: EndpointProbe) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(outcome);
    };
    const socket = connect(path);
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once('connect', () => finish('answered'));
    socket.once('timeout', () => finish('inconclusive'));
    socket.once('error', (error: Error) =>
      finish(hasCode(error, 'ECONNREFUSED') ? 'stale' : 'inconclusive'),
    );
  });
}

async function bindExclusive(server: Server, path: string): Promise<void> {
  try {
    await listenOnce(server, path);
    return;
  } catch (error) {
    if (!(error instanceof Error) || !hasCode(error, 'EADDRINUSE')) throw error;
  }
  // The path is occupied by a live peer, by a socket a killed owner stranded, or
  // by some other file entirely. Removing anything here is destructive, so it
  // happens only on proof: the path is a socket and it refuses connections.
  const occupant = statSync(path, { throwIfNoEntry: false });
  if (occupant === undefined) {
    await listenOnce(server, path);
    return;
  }
  if (!occupant.isSocket())
    throw new Error('the wake endpoint path is occupied by something that is not a socket');
  const probe = await probeEndpoint(path);
  if (probe === 'answered')
    throw new Error('another process is already listening on the wake socket');
  if (probe === 'inconclusive')
    throw new Error('the wake endpoint did not answer conclusively and was left in place');
  unlinkSync(path);
  await listenOnce(server, path);
}

/**
 * Sends one poke. Never throws and never blocks a command: an absent watcher,
 * a full backlog or a refused connection all resolve `false`, which only means
 * the receiver will find the same durable rows on its fallback interval.
 */
export function pokeWatcher(input: {
  readonly stateDirectory: string;
  readonly projectId: string;
  readonly timeoutMs?: number;
}): Promise<boolean> {
  const path = wakeSocketPath(input.stateDirectory, input.projectId);
  const payload = `${JSON.stringify({ v: 1, projectId: input.projectId })}\n`;
  if (!wakeSocketPathFits(path) || Buffer.byteLength(payload) > MAX_WAKE_PAYLOAD_BYTES)
    return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let flushed = false;
    const finish = (delivered: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(delivered);
    };
    const socket = connect(path);
    socket.setTimeout(input.timeoutMs ?? POKE_TIMEOUT_MS);
    // Half-close, then let the receiver close its side once it has read the
    // payload. Destroying straight after the flush can reset the connection
    // before the receiver drains it.
    socket.once('connect', () => socket.end(payload, () => (flushed = true)));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.once('close', (hadError: boolean) => finish(flushed && !hadError));
  });
}

/**
 * Pokes without making the caller asynchronous, for the synchronous write paths
 * that must keep returning their durable value directly. There is nothing to
 * wait for: the sender already answers `false` instead of failing.
 */
export function pokeWatcherInBackground(input: {
  readonly stateDirectory: string;
  readonly projectId: string;
}): void {
  void pokeWatcher(input).catch(() => undefined);
}

export interface WakeListenerOptions {
  readonly stateDirectory: string;
  readonly projectId: string;
  readonly maxPendingPokes?: number;
}

/**
 * Receives pokes for one project. Many pokes coalesce into a single boolean, so
 * a burst of posts costs the loop one extra pass rather than one pass each.
 *
 * The listener supports one waiter, which is the single watch loop that owns it.
 */
export class WakeListener {
  readonly #path: string;
  readonly #projectId: string;
  readonly #server: Server | null;
  readonly #unavailable: string | null;
  readonly #open = new Set<Socket>();
  #signalled = false;
  #accepted = 0;
  #refused = 0;
  #closed = false;
  #notify: ((outcome: WakeOutcome) => void) | null = null;

  private constructor(input: {
    path: string;
    projectId: string;
    server: Server | null;
    unavailable: string | null;
  }) {
    this.#path = input.path;
    this.#projectId = input.projectId;
    this.#server = input.server;
    this.#unavailable = input.unavailable;
  }

  /**
   * Binds the endpoint. Never throws: a transport that cannot bind is reported
   * through `unavailable` and the caller keeps running on its fallback interval.
   */
  static async listen(options: WakeListenerOptions): Promise<WakeListener> {
    const path = wakeSocketPath(options.stateDirectory, options.projectId);
    const degraded = (unavailable: string) =>
      new WakeListener({ path, projectId: options.projectId, server: null, unavailable });
    if (!wakeSocketPathFits(path))
      return degraded(
        `wake socket path exceeds ${MAX_WAKE_SOCKET_PATH_BYTES} bytes on this platform`,
      );
    const server = createServer({ allowHalfOpen: false });
    server.maxConnections = options.maxPendingPokes ?? DEFAULT_MAX_PENDING_POKES;
    const listener = new WakeListener({
      path,
      projectId: options.projectId,
      server,
      unavailable: null,
    });
    // A transport fault must never take the watcher down with it.
    server.on('error', () => {});
    server.on('connection', (socket) => listener.#accept(socket));
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const fault = endpointDirectoryFault(dirname(path));
      if (fault !== null) throw new Error(fault);
      await bindExclusive(server, path);
      chmodSync(path, 0o600);
    } catch (error) {
      server.close();
      return degraded(error instanceof Error ? error.message : String(error));
    }
    return listener;
  }

  get path(): string {
    return this.#path;
  }

  /** The reason pokes cannot be received, or null when the endpoint is bound. */
  get unavailable(): string | null {
    return this.#unavailable;
  }

  /** Pokes accepted for this project since the listener bound. */
  get accepted(): number {
    return this.#accepted;
  }

  /** Connections dropped as malformed, oversized, or addressed to another project. */
  get refused(): number {
    return this.#refused;
  }

  /** Reads and clears the coalesced signal. */
  take(): boolean {
    const signalled = this.#signalled;
    this.#signalled = false;
    return signalled;
  }

  /**
   * Resolves on the next poke, the timeout, an abort, or close. A poke that
   * arrives before this call is not lost: the coalesced flag is checked first.
   */
  wait(input: { readonly timeoutMs: number; readonly signal?: AbortSignal }): Promise<WakeOutcome> {
    if (this.#signalled) return Promise.resolve('poked');
    if (this.#closed) return Promise.resolve('closed');
    if (input.signal?.aborted) return Promise.resolve('aborted');
    return new Promise<WakeOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: WakeOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', onAbort);
        if (this.#notify === finish) this.#notify = null;
        resolve(outcome);
      };
      const onAbort = () => finish('aborted');
      const timer = setTimeout(() => finish('timeout'), input.timeoutMs);
      this.#notify = finish;
      input.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const notify = this.#notify;
    this.#notify = null;
    for (const socket of this.#open) socket.destroy();
    this.#open.clear();
    // Node removes the bound socket file itself when the server closes.
    this.#server?.close();
    notify?.('closed');
  }

  #accept(socket: Socket): void {
    this.#open.add(socket);
    socket.setTimeout(RECEIVE_TIMEOUT_MS);
    const chunks: Buffer[] = [];
    let size = 0;
    const done = (accepted: boolean) => {
      if (!this.#open.delete(socket)) return;
      socket.destroy();
      if (accepted) this.#signal();
      else this.#refused += 1;
    };
    socket.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_WAKE_PAYLOAD_BYTES) {
        done(false);
        return;
      }
      chunks.push(chunk);
    });
    socket.once('end', () => done(this.#addressed(Buffer.concat(chunks))));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.once('close', () => done(false));
  }

  #addressed(payload: Buffer): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.toString('utf8'));
    } catch {
      return false;
    }
    const message = wakeMessageSchema.safeParse(parsed);
    return message.success && message.data.projectId === this.#projectId;
  }

  #signal(): void {
    this.#accepted += 1;
    this.#signalled = true;
    const notify = this.#notify;
    this.#notify = null;
    notify?.('poked');
  }
}
