import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { Effect, Result, Schema } from 'effect';

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

const nonEmpty = Schema.String.check(Schema.isMinLength(1));
const WakeMessageSchema = Schema.Struct({ v: Schema.Literals([1]), projectId: nonEmpty });

export class WakeError extends Schema.TaggedError<WakeError>()('WakeError', {
  operation: nonEmpty,
  message: nonEmpty,
  cause: Schema.Defect(),
}) {}

export type WakeOutcome = 'poked' | 'timeout' | 'aborted' | 'closed';

/**
 * The watcher's durable-work predicate, in the shape the watcher declares it:
 * a cheap read that performs no native observation and settles nothing.
 */
export interface PendingWorkEffectPort<E = never> {
  hasPendingWorkEffect(): Effect.Effect<boolean, E, never>;
}

export function wakeSocketPathFits(path: string): boolean {
  return Buffer.byteLength(path) <= MAX_WAKE_SOCKET_PATH_BYTES;
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

const listenOnce = Effect.fn('Wake.listen')((server: Server, path: string) =>
  Effect.callback<void, WakeError>((resume) => {
    const cleanup = () => {
      server.off('error', onError);
      server.off('listening', onListening);
    };
    const onError = (cause: Error) => {
      cleanup();
      resume(
        Effect.fail(new WakeError({ operation: 'Wake.listen', message: cause.message, cause })),
      );
    };
    const onListening = () => {
      cleanup();
      resume(Effect.void);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(path);
    return Effect.sync(cleanup);
  }),
);

/**
 * Classifies an occupied endpoint.
 *
 * Only `ECONNREFUSED` proves that nobody is listening on a socket. A timeout, a
 * permission error or a saturated backlog all come from endpoints that may well
 * be alive, so they are inconclusive and must never be read as absence.
 */
export type EndpointProbe = 'answered' | 'stale' | 'inconclusive';

const probeEndpoint = Effect.fn('Wake.probeEndpoint')((path: string) =>
  Effect.callback<EndpointProbe>((resume) => {
    let settled = false;
    const finish = (outcome: EndpointProbe) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resume(Effect.succeed(outcome));
    };
    const socket = connect(path);
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once('connect', () => finish('answered'));
    socket.once('timeout', () => finish('inconclusive'));
    socket.once('error', (cause: Error) =>
      finish(hasCode(cause, 'ECONNREFUSED') ? 'stale' : 'inconclusive'),
    );
    return Effect.sync(() => {
      settled = true;
      socket.destroy();
    });
  }),
);

const wakeError = (operation: string, message: string) =>
  new WakeError({ operation, message, cause: new Error(message) });

const bindExclusive = Effect.fn('Wake.bindExclusive')(function* (server: Server, path: string) {
  const first = yield* Effect.result(listenOnce(server, path));
  if (Result.isSuccess(first)) return;
  const cause = first.failure.cause;
  if (!(cause instanceof Error) || !hasCode(cause, 'EADDRINUSE')) return yield* first.failure;
  // The path is occupied by a live peer, by a socket a killed owner stranded, or
  // by some other file entirely. Removing anything here is destructive, so it
  // happens only on proof: the path is a socket and it refuses connections.
  const occupant = yield* Effect.try({
    try: () => statSync(path, { throwIfNoEntry: false }),
    catch: (error) => wakeError('Wake.bindExclusive.stat', String(error)),
  });
  if (occupant === undefined) return yield* listenOnce(server, path);
  if (!occupant.isSocket())
    return yield* wakeError(
      'Wake.bindExclusive',
      'the wake endpoint path is occupied by something that is not a socket',
    );
  const probe = yield* probeEndpoint(path);
  if (probe === 'answered')
    return yield* wakeError(
      'Wake.bindExclusive',
      'another process is already listening on the wake socket',
    );
  if (probe === 'inconclusive')
    return yield* wakeError(
      'Wake.bindExclusive',
      'the wake endpoint did not answer conclusively and was left in place',
    );
  yield* Effect.try({
    try: () => unlinkSync(path),
    catch: (error) => wakeError('Wake.bindExclusive.unlink', String(error)),
  });
  yield* listenOnce(server, path);
});

export interface PokeInput {
  readonly stateDirectory: string;
  readonly projectId: string;
  readonly timeoutMs?: number;
}

/**
 * Sends one poke. Never fails and never blocks a command: an absent watcher, a
 * full backlog or a refused connection all yield `false`, which only means the
 * receiver will find the same durable rows on its fallback interval.
 */
export const pokeWatcherEffect = Effect.fn('Wake.poke')((input: PokeInput) => {
  const path = wakeSocketPath(input.stateDirectory, input.projectId);
  const payload = `${JSON.stringify({ v: 1, projectId: input.projectId })}\n`;
  if (!wakeSocketPathFits(path) || Buffer.byteLength(payload) > MAX_WAKE_PAYLOAD_BYTES)
    return Effect.succeed(false);
  return Effect.callback<boolean>((resume) => {
    let settled = false;
    let flushed = false;
    const finish = (delivered: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resume(Effect.succeed(delivered));
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
    return Effect.sync(() => {
      settled = true;
      socket.destroy();
    });
  });
});

export function pokeWatcher(input: PokeInput): Promise<boolean> {
  return Effect.runPromise(pokeWatcherEffect(input));
}

/**
 * Pokes without making the caller asynchronous, for the synchronous write paths
 * that must keep returning their durable value directly. There is nothing to
 * wait for: the sender already answers `false` instead of failing.
 */
export function pokeWatcherInBackground(input: PokeInput): void {
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
   * Binds the endpoint. Never fails: a transport that cannot bind is reported
   * through `unavailable` and the caller keeps running on its fallback interval.
   */
  static readonly listenEffect = Effect.fn('Wake.listener')(function* (
    options: WakeListenerOptions,
  ) {
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
    server.on('connection', (socket) => listener.accept(socket));
    const prepare: Effect.Effect<void, WakeError, never> = Effect.gen(function* () {
      yield* Effect.try({
        try: () => mkdirSync(dirname(path), { recursive: true, mode: 0o700 }),
        catch: (error) => wakeError('Wake.listener.mkdir', String(error)),
      });
      const fault = yield* Effect.try({
        try: () => endpointDirectoryFault(dirname(path)),
        catch: (error) => wakeError('Wake.listener.inspectDirectory', String(error)),
      });
      if (fault !== null) return yield* wakeError('Wake.listener', fault);
      yield* bindExclusive(server, path);
      yield* Effect.try({
        try: () => chmodSync(path, 0o600),
        catch: (error) => wakeError('Wake.listener.chmod', String(error)),
      });
    });
    const bound = yield* Effect.result(prepare);
    if (Result.isFailure(bound)) {
      server.close();
      return degraded(bound.failure.message);
    }
    return listener;
  });

  static listen(options: WakeListenerOptions): Promise<WakeListener> {
    return Effect.runPromise(WakeListener.listenEffect(options));
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
   * Resolves on the next poke, the timeout, or interruption. A poke that arrives
   * before this call is not lost: the coalesced flag is checked first.
   */
  readonly waitEffect = Effect.fn('Wake.wait')((input: { readonly timeoutMs: number }) => {
    if (this.#signalled) return Effect.succeed<WakeOutcome>('poked');
    if (this.#closed) return Effect.succeed<WakeOutcome>('closed');
    return Effect.callback<WakeOutcome>((resume) => {
      let settled = false;
      const finish = (outcome: WakeOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.#notify === finish) this.#notify = null;
        resume(Effect.succeed(outcome));
      };
      const timer = setTimeout(() => finish('timeout'), input.timeoutMs);
      this.#notify = finish;
      return Effect.sync(() => {
        clearTimeout(timer);
        settled = true;
        if (this.#notify === finish) this.#notify = null;
      });
    });
  });

  wait(input: { readonly timeoutMs: number; readonly signal?: AbortSignal }): Promise<WakeOutcome> {
    if (input.signal === undefined) return Effect.runPromise(this.waitEffect(input));
    if (input.signal.aborted) return Promise.resolve<WakeOutcome>('aborted');
    return Effect.runPromise(
      Effect.raceFirst(
        this.waitEffect(input),
        Effect.callback<WakeOutcome>((resume) => {
          const aborted = () => resume(Effect.succeed<WakeOutcome>('aborted'));
          input.signal?.addEventListener('abort', aborted, { once: true });
          return Effect.sync(() => input.signal?.removeEventListener('abort', aborted));
        }),
      ),
    );
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

  private accept(socket: Socket): void {
    this.#open.add(socket);
    socket.setTimeout(RECEIVE_TIMEOUT_MS);
    const chunks: Buffer[] = [];
    let size = 0;
    const done = (accepted: boolean) => {
      if (!this.#open.delete(socket)) return;
      socket.destroy();
      if (accepted) this.signal();
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
    socket.once('end', () => done(this.addressed(Buffer.concat(chunks))));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.once('close', () => done(false));
  }

  private addressed(payload: Buffer): boolean {
    const text = payload.toString('utf8');
    const parsed = Effect.runSync(Effect.result(Effect.try(() => JSON.parse(text))));
    if (Result.isFailure(parsed)) return false;
    const message = Schema.decodeUnknownResult(WakeMessageSchema, { onExcessProperty: 'error' })(
      parsed.success,
    );
    return Result.isSuccess(message) && message.success.projectId === this.#projectId;
  }

  private signal(): void {
    this.#accepted += 1;
    this.#signalled = true;
    const notify = this.#notify;
    this.#notify = null;
    notify?.('poked');
  }
}
