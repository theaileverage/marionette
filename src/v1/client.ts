import { createHash } from 'node:crypto';
import { realpathSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { z } from 'zod';
import { ArtifactFiles, registerArtifact } from './artifacts.js';
import { Board, type BoardAuthor, type BoardRecipient } from './board.js';
import {
  createBinding,
  localSessionContext,
  resolveContext,
  stateRoot,
  type ResolvedContext,
} from './context.js';
import {
  AgentSessionIdSchema,
  ProjectBindingSchema,
  WorkspaceIdSchema,
  type JobId,
  type WorkflowId,
  type ResultId,
  type AttemptId,
} from './model.js';
import { loadPackage, route } from './packages.js';
import { Settings, profileSchema } from './settings.js';
import { SqlQueryService, type SqlRead } from './sql.js';
import { Runtime } from './runtime.js';
import { Handoffs } from './handoff.js';
import { previewRuntimeWorkspaceRetirement, retireRuntimeWorkspace } from './runtime-retirement.js';
import { Watcher } from './watcher.js';
import { NativeBoardDelivery } from './delivery.js';
import {
  currentProcessIdentity,
  ensureBackgroundWatcher,
  localOwnerLiveness,
} from './background.js';
import {
  DEFAULT_BUSY_RETRY_MS,
  DEFAULT_FALLBACK_INTERVAL_MS,
  DEFAULT_MIN_DELIVERY_INTERVAL_MS,
  DEFAULT_RECONCILE_INTERVAL_MS,
  DEFAULT_START_PROGRESS_INTERVAL_MS,
  MAX_BUSY_RETRY_MS,
  WakeListener,
  pokeWatcher,
  pokeWatcherInBackground,
  type PendingWorkPort,
} from './wake.js';
import {
  Store,
  type SessionIdentity,
  type AgentSession,
  type CreateJobInput,
  type CreateWorkflowInput,
  type RegisterWorkspaceInput,
  type RecordResultInput,
  type ResultDecisionInput,
  type AcknowledgeBriefInput,
} from './store.js';

export type ConnectOptions = Omit<NonNullable<Parameters<typeof resolveContext>[0]>, 'readOnly'>;

/** Sleeps, but gives the time back the moment the watcher is asked to stop. */
function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });
}

export class Marionette {
  readonly #store: Store;
  readonly #resolved: ResolvedContext;
  readonly #identity: SessionIdentity;
  readonly #token: string;
  readonly #board: Board;
  readonly #files: ArtifactFiles;
  readonly #settings: Settings;
  readonly #sql: SqlQueryService;
  readonly #runtime: Runtime;

  private constructor(resolved: ResolvedContext) {
    const session = localSessionContext(resolved);
    if (
      session.projectId !== resolved.binding.projectId ||
      session.hostId !== resolved.binding.hostId ||
      realpathSync(session.bindingPath) !== realpathSync(resolved.bindingPath)
    ) {
      throw new Error('Local session does not match the project binding');
    }
    this.#resolved = resolved;
    this.#token = session.token;
    this.#identity = {
      id: AgentSessionIdSchema.parse(session.sessionId),
      generation: session.generation,
    };
    this.#store = Store.open({
      databasePath: resolved.binding.databasePath,
      project: ProjectBindingSchema.parse({
        id: resolved.binding.projectId,
        hostId: resolved.binding.hostId,
        repositoryRoot: resolved.binding.repositoryRoot,
        stateDirectory: resolved.binding.stateDirectory,
      }),
    });
    try {
      if (!resolved.session) {
        this.#store.registerSession({
          ...this.#identity,
          workspaceId: null,
          role: 'user',
          executionRole: 'user',
          tokenHash: createHash('sha256').update(session.token).digest('hex'),
          parentWorkflowId: null,
          attemptId: null,
          nativeKind: null,
          nativeServerGeneration: null,
          nativeLocator: null,
        });
      }
      this.#authenticate();
      this.#board = Board.create({ store: this.#store });
      this.#files = new ArtifactFiles(resolved.binding.stateDirectory);
      this.#settings = new Settings(this.#store, this.#identity);
      this.#sql = new SqlQueryService({ board: this.#board });
      this.#runtime = new Runtime(this.#store, this.#identity, resolved);
    } catch (error) {
      this.#store.close();
      throw error;
    }
  }

  static connect(options: ConnectOptions = {}): Marionette {
    return new Marionette(resolveContext(options));
  }

  static previewRetirement(
    options: ConnectOptions,
    input: { workspaceId: z.infer<typeof WorkspaceIdSchema>; idempotencyKey: string },
  ) {
    const resolved = resolveContext({ ...options, readOnly: true });
    const session = localSessionContext(resolved, true);
    if (
      session.projectId !== resolved.binding.projectId ||
      session.hostId !== resolved.binding.hostId ||
      realpathSync(session.bindingPath) !== realpathSync(resolved.bindingPath)
    )
      throw new Error('Local session does not match the project binding');
    const store = Store.open({
      readOnly: true,
      databasePath: resolved.binding.databasePath,
      project: ProjectBindingSchema.parse({
        id: resolved.binding.projectId,
        hostId: resolved.binding.hostId,
        repositoryRoot: resolved.binding.repositoryRoot,
        stateDirectory: resolved.binding.stateDirectory,
      }),
    });
    try {
      const actor = {
        id: AgentSessionIdSchema.parse(session.sessionId),
        generation: session.generation,
      };
      store.authenticateSession({ ...actor, token: session.token });
      return previewRuntimeWorkspaceRetirement({ ...input, store, actor });
    } finally {
      store.close();
    }
  }

  static init(options: { repositoryRoot: string; stateHome?: string }): Marionette {
    if (process.env.MARIONETTE_CONTEXT)
      throw new Error('Managed sessions cannot initialize another project');
    return new Marionette(
      createBinding({
        repositoryRoot: options.repositoryRoot,
        stateRoot: options.stateHome ?? stateRoot(),
      }),
    );
  }

  close(): void {
    this.#store.close();
  }

  #authenticate(): AgentSession {
    return this.#store.authenticateSession({ ...this.#identity, token: this.#token });
  }

  #author(): BoardAuthor {
    const session = this.#authenticate();
    return {
      kind: session.role === 'user' ? 'user' : 'session',
      id: session.id,
      generation: session.generation,
    };
  }

  #recipient(): BoardRecipient {
    const session = this.#authenticate();
    return {
      kind: session.role === 'user' ? 'user' : 'session',
      id: session.id,
      generation: session.generation,
    };
  }

  context() {
    const session = this.#authenticate();
    return {
      project: this.#store.project,
      bindingPath: this.#resolved.bindingPath,
      session,
      authentication: {
        source: this.#resolved.session ? 'managed-context-file' : 'local-session-file',
        projectId: session.projectId,
        role: session.role,
        workspaceId: session.workspaceId,
      },
    };
  }

  registerWorkspace(input: Omit<RegisterWorkspaceInput, 'actor'>) {
    this.#authenticate();
    return this.#store.registerWorkspace({ ...input, actor: this.#identity });
  }

  previewRetirement(input: {
    workspaceId: z.infer<typeof WorkspaceIdSchema>;
    idempotencyKey: string;
  }) {
    this.#authenticate();
    return previewRuntimeWorkspaceRetirement({
      ...input,
      store: this.#store,
      actor: this.#identity,
    });
  }

  retireWorkspace(input: {
    workspaceId: z.infer<typeof WorkspaceIdSchema>;
    idempotencyKey: string;
  }) {
    this.#authenticate();
    return retireRuntimeWorkspace({ ...input, store: this.#store, actor: this.#identity });
  }

  workspace(id: string) {
    this.#authenticate();
    return this.#store.getWorkspace(WorkspaceIdSchema.parse(id));
  }

  snapshot(input: { path: string; name: string; mediaType?: string }) {
    this.#authenticate();
    const artifact = this.#files.snapshot(input.path, { mediaType: input.mediaType });
    const id = registerArtifact(this.#store, this.#files, artifact);
    return { id, name: input.name, ...artifact };
  }

  createJob(input: Omit<CreateJobInput, 'actor'>) {
    this.#authenticate();
    return this.#store.createJob({ ...input, actor: this.#identity });
  }

  createWorkflow(input: Omit<CreateWorkflowInput, 'actor' | 'package'> & { package: string }) {
    this.#authenticate();
    const snapshot = loadPackage(input.package);
    const resources = snapshot.resources.map((resource) => {
      if (
        isAbsolute(resource.path) ||
        resource.path.split(/[\\/]/).some((part) => part === '..' || part === '.' || part === '')
      )
        throw new Error('Workflow resources require normalized relative paths');
      const bytes = Uint8Array.from(resource.bytes);
      const artifact = this.#files.put(bytes, 'text/plain');
      const id = registerArtifact(this.#store, this.#files, artifact);
      const path = join(
        this.#store.project.stateDirectory,
        'packages',
        snapshot.digest,
        resource.path,
      );
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      try {
        writeFileSync(path, bytes, { flag: 'wx', mode: 0o400 });
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      }
      if (createHash('sha256').update(readFileSync(path)).digest('hex') !== artifact.digest)
        throw new Error('Pinned workflow resource bytes changed');
      return { id, path, name: resource.path };
    });
    return this.#store.transaction((db) => {
      const workflow = this.#store.createWorkflow({
        ...input,
        package: snapshot,
        actor: this.#identity,
      });
      for (const resource of resources)
        db.prepare(
          'INSERT OR IGNORE INTO workflow_package_resources(project_id,package_digest,resource_name,artifact_id,path) VALUES(?,?,?,?,?)',
        ).run(this.#store.project.id, snapshot.digest, resource.name, resource.id, resource.path);
      return workflow;
    });
  }

  route(input: Parameters<typeof route>[0]) {
    return route(input);
  }
  jobs() {
    this.#authenticate();
    return this.#store.listJobs();
  }
  job(id: JobId) {
    this.#authenticate();
    return this.#store.getJob(id);
  }
  brief(id: JobId, revision?: number) {
    this.#authenticate();
    return this.#store.getBrief(id, revision);
  }
  workflows() {
    this.#authenticate();
    return this.#store.listWorkflows();
  }
  workflow(id: WorkflowId) {
    this.#authenticate();
    return this.#store.getWorkflow(id);
  }
  attempt(id: AttemptId) {
    this.#authenticate();
    return this.#store.getAttempt(id);
  }
  result(id: ResultId) {
    this.#authenticate();
    return this.#store.getResult(id);
  }

  acknowledgeBrief(input: Omit<AcknowledgeBriefInput, 'actor'>) {
    this.#authenticate();
    return this.#store.acknowledgeBrief({ ...input, actor: this.#identity });
  }

  recordResult(input: Omit<RecordResultInput, 'actor'>) {
    this.#authenticate();
    return this.#store.recordResult({ ...input, actor: this.#identity });
  }

  decideResult(input: Omit<ResultDecisionInput, 'actor'>) {
    this.#authenticate();
    return this.#store.decideResult({ ...input, actor: this.#identity });
  }

  createThread(input: Omit<Parameters<Board['createThread']>[0], 'author'>) {
    return this.#board.createThread({ ...input, author: this.#author() });
  }
  post(input: Omit<Parameters<Board['post']>[0], 'author'>) {
    const post = this.#board.post({ ...input, author: this.#author() });
    pokeWatcherInBackground({
      stateDirectory: this.#store.project.stateDirectory,
      projectId: this.#store.project.id,
    });
    return post;
  }
  threads(input: Parameters<Board['listThreads']>[0] = {}) {
    this.#authenticate();
    return this.#board.listThreads(input);
  }
  readThread(input: Parameters<Board['readThread']>[0]) {
    this.#authenticate();
    return this.#board.readThread(input);
  }
  searchBoard(input: Parameters<Board['search']>[0]) {
    this.#authenticate();
    return this.#board.search(input);
  }
  inbox(input: Omit<Parameters<Board['inbox']>[0], 'recipient'> = {}) {
    return this.#board.inbox({ ...input, recipient: this.#recipient() });
  }
  subscribe(input: Omit<Parameters<Board['subscribe']>[0], 'subscriber'> = {}) {
    const subscription = this.#board.subscribe({ ...input, subscriber: this.#recipient() });
    pokeWatcherInBackground({
      stateDirectory: this.#store.project.stateDirectory,
      projectId: this.#store.project.id,
    });
    return subscription;
  }
  unsubscribe(input: { threadId?: string } = {}) {
    return this.#board.unsubscribe({ ...input, subscriber: this.#recipient() });
  }
  markRead(input: Omit<Parameters<Board['markRead']>[0], 'reader'>) {
    const result = this.#board.markRead({ ...input, reader: this.#recipient() });
    pokeWatcherInBackground({
      stateDirectory: this.#store.project.stateDirectory,
      projectId: this.#store.project.id,
    });
    return result;
  }
  query(input: SqlRead) {
    this.#authenticate();
    return this.#sql.read(input);
  }
  contribute(input: Omit<Parameters<SqlQueryService['contribute']>[0], 'author'>) {
    return this.#sql.contribute({ ...input, author: this.#author() });
  }
  registerNative(input: Parameters<Runtime['register']>[0]) {
    this.#authenticate();
    return this.#runtime.register(input);
  }
  admit(input: Parameters<Runtime['admit']>[0]) {
    this.#authenticate();
    return this.#runtime.admit(input);
  }
  async startAttempt(id: AttemptId) {
    const session = this.#authenticate();
    if (session.role === 'worker') throw new Error('An active controller or user is required');
    this.#store.getAttempt(id);
    await this.ensureWatcher();
    return this.#runtime.inspect(id);
  }
  inspectAttempt(id: AttemptId) {
    this.#authenticate();
    return this.#runtime.inspect(id);
  }

  async reconcileAttempt(id: AttemptId) {
    const session = this.#authenticate();
    if (session.role === 'worker') throw new Error('An active controller or user is required');
    const attempt = this.#store.getAttempt(id);
    if (
      attempt.phase === 'pending' ||
      attempt.phase === 'launching' ||
      attempt.phase === 'running'
    ) {
      await this.ensureWatcher();
      return this.#runtime.inspect(id);
    }
    return this.#runtime.reconcile(id);
  }

  async ensureWatcher() {
    const session = this.#authenticate();
    // Callers reach here after their write has committed, so a poke can only
    // point at durable state. It carries attention, never authority: it names
    // this project and nothing else, and the watcher re-reads the database to
    // decide what to do. That is why a worker may wake an existing watcher even
    // though it may never own or spawn one.
    await pokeWatcher({
      stateDirectory: this.#store.project.stateDirectory,
      projectId: this.#store.project.id,
    });
    if (session.role === 'worker') return;
    await ensureBackgroundWatcher(this.#store, this.#resolved.bindingPath);
  }

  /**
   * Runs the project watcher until it is aborted or idles out.
   *
   * Delivery and native reconciliation are two independent schedules sharing one
   * process, so a blocked recipient cannot hold up an observation and a slow
   * observation cannot hold up a wake. They share only a stop: the first failure
   * or a lost ownership claim ends both, and the call reports that failure.
   */
  async watch(options: {
    signal: AbortSignal;
    idleTimeoutMs?: number;
    fallbackIntervalMs?: number;
    reconcileIntervalMs?: number;
    minDeliveryIntervalMs?: number;
    pendingWork?: PendingWorkPort;
  }) {
    const session = this.#authenticate();
    if (session.role === 'worker') throw new Error('Workers cannot own the project watcher');
    const watcher = await Watcher.start({
      store: this.#store,
      deliveryPort: new NativeBoardDelivery(this.#store),
      livenessPort: localOwnerLiveness,
      processIdentity: await currentProcessIdentity(),
    });
    const generation = watcher.generation;
    const pendingWork = options.pendingWork ?? watcher;
    const idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
    const fallbackIntervalMs = options.fallbackIntervalMs ?? DEFAULT_FALLBACK_INTERVAL_MS;
    const reconcileIntervalMs = options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
    const minDeliveryIntervalMs = options.minDeliveryIntervalMs ?? DEFAULT_MIN_DELIVERY_INTERVAL_MS;
    // Arm the endpoint before either schedule reads durable state. Only the
    // process holding this project's owner generation reaches here, so only it
    // binds; anything committed after a read still pokes an armed listener,
    // which is why no wake can fall into the gap between reading and sleeping.
    const listener = await WakeListener.listen({
      stateDirectory: this.#store.project.stateDirectory,
      projectId: this.#store.project.id,
    });
    const stopping = new AbortController();
    let failure: Error | undefined;
    const stop = () => {
      if (!stopping.signal.aborted) stopping.abort();
    };
    const fail = (error: Error) => {
      failure ??= error;
      stop();
    };
    options.signal.addEventListener('abort', stop, { once: true });
    if (options.signal.aborted) stop();
    let idleSince = Date.now();
    let deliveryPasses = 0;
    let reconcilePasses = 0;
    let reconciliations = 0;
    let deliveries = 0;
    let wakes = 0;

    const deliverySchedule = async () => {
      let retryMs = DEFAULT_BUSY_RETRY_MS;
      let passedAt = Date.now() - minDeliveryIntervalMs;
      while (!stopping.signal.aborted) {
        // A floor between passes, so an unbounded signal rate cannot become an
        // unbounded transaction rate. Short enough that a wake stays prompt.
        const since = Date.now() - passedAt;
        if (since < minDeliveryIntervalMs)
          await delay(minDeliveryIntervalMs - since, stopping.signal);
        if (stopping.signal.aborted) break;
        passedAt = Date.now();
        // Consume the signal before reading durable state, never after: a poke
        // that lands during this pass must survive into the next wait.
        if (listener.take()) wakes += 1;
        deliveryPasses += 1;
        const settled = await watcher.pollOnce();
        deliveries += settled;
        const pending = await pendingWork.hasPendingWork();
        if (pending || this.#runtime.activeAttempts().length > 0) idleSince = Date.now();
        else if (Date.now() - idleSince >= idleTimeoutMs) {
          stop();
          break;
        }
        if (settled > 0) {
          retryMs = DEFAULT_BUSY_RETRY_MS;
          continue;
        }
        // Work that stayed put means a recipient was not ready, not that the
        // queue is empty: another recipient may be. Retrying far sooner than
        // the fallback bounds that starvation, and backing off keeps an
        // indefinitely busy recipient cheap.
        const waitMs = pending ? retryMs : fallbackIntervalMs;
        if (pending) retryMs = Math.min(retryMs * 2, MAX_BUSY_RETRY_MS);
        const outcome = await listener.wait({ timeoutMs: waitMs, signal: stopping.signal });
        if (outcome === 'poked') retryMs = DEFAULT_BUSY_RETRY_MS;
      }
    };

    const reconcileSchedule = async () => {
      while (!stopping.signal.aborted) {
        reconcilePasses += 1;
        const attempts = this.#runtime.activeAttempts();
        let owedStart = false;
        for (const id of attempts) {
          if (stopping.signal.aborted) break;
          // Past launch, start() only inspects, and reconcile() inspects again;
          // running it then costs a second native observation for nothing.
          // Attempts still owed launch or prompt progress keep it.
          if (this.#runtime.needsStartProgress(id)) {
            owedStart = true;
            await this.#runtime.start(id);
          }
          await this.#runtime.reconcile(id);
          reconciliations += 1;
        }
        if (attempts.length > 0) idleSince = Date.now();
        await delay(
          attempts.length === 0
            ? fallbackIntervalMs
            : owedStart
              ? DEFAULT_START_PROGRESS_INTERVAL_MS
              : reconcileIntervalMs,
          stopping.signal,
        );
      }
    };

    // Either schedule failing stops both: ownership loss reaches here from
    // assertOwner, and the watcher must fail closed rather than keep delivering.
    const supervise = (schedule: () => Promise<void>) =>
      schedule().catch((cause) => fail(cause instanceof Error ? cause : new Error(String(cause))));
    await Promise.all([supervise(deliverySchedule), supervise(reconcileSchedule)]);
    options.signal.removeEventListener('abort', stop);
    listener.close();
    try {
      watcher.stop();
    } catch (error) {
      failure ??= error instanceof Error ? error : new Error(String(error));
    }
    if (failure !== undefined) throw failure;
    return {
      stopped: true,
      generation,
      deliveryPasses,
      reconcilePasses,
      reconciliations,
      deliveries,
      wakes,
      wakeEndpoint: listener.unavailable === null ? listener.path : null,
    };
  }

  #handoffs(attemptId?: string) {
    const session = this.#authenticate();
    if (session.role === 'worker' && (!attemptId || session.attemptId !== attemptId))
      throw new Error('Workers may only act on their own integrator attempt');
    return new Handoffs(this.#store, this.#files);
  }

  handoff(id: string) {
    this.#authenticate();
    return new Handoffs(this.#store, this.#files).get(id);
  }

  createHandoff(input: Parameters<Handoffs['create']>[0]) {
    return this.#handoffs().create(input);
  }

  claimHandoff(input: Parameters<Handoffs['claim']>[0]) {
    return this.#handoffs().claim(input);
  }

  checkHandoff(input: Parameters<Handoffs['check']>[0]) {
    return this.#handoffs(input.attemptId).check(input);
  }

  completeHandoff(input: Parameters<Handoffs['complete']>[0]) {
    return this.#handoffs(input.attemptId).complete(input);
  }

  resolveHandoff(input: Parameters<Handoffs['resolve']>[0]) {
    return this.#handoffs().resolve(input);
  }

  replanHandoff(input: Parameters<Handoffs['replan']>[0]) {
    return this.#handoffs().replan(input);
  }

  profiles() {
    this.#authenticate();
    return this.#settings.profiles();
  }
  configureProfile(input: {
    profile: z.infer<typeof profileSchema>;
    expectedRevision: number;
    idempotencyKey: string;
  }) {
    this.#authenticate();
    const profile = profileSchema.parse(input.profile);
    return this.#settings.set({
      key: `profile/${profile.name}`,
      value: profile,
      expectedRevision: input.expectedRevision,
      idempotencyKey: input.idempotencyKey,
      schema: profileSchema,
    });
  }
}

export const connect = Marionette.connect;
