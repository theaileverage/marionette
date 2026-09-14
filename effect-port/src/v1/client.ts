import { createHash } from 'node:crypto';
import { realpathSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { Clock, Effect, Schedule, Schema } from 'effect';
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
import type { NativeObservation } from './native.js';
import { Settings, profileSchema } from './settings.js';
import { SqlQueryService, type SqlRead } from './sql.js';
import { Runtime } from './runtime.js';
import { Handoffs } from './handoff.js';
import {
  previewRuntimeWorkspaceRetirement,
  retireRuntimeWorkspaceEffect,
} from './runtime-retirement.js';
import { Watcher } from './watcher.js';
import { NativeBoardDelivery } from './delivery.js';
import {
  currentProcessIdentityEffect,
  ensureBackgroundWatcherEffect,
  localOwnerLiveness,
} from './background.js';
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
  type RecoverAttemptInput,
} from './store.js';

export class ClientOperationError extends Schema.TaggedError<ClientOperationError>()(
  'ClientOperationError',
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

function clientError(operation: string, cause: unknown) {
  return new ClientOperationError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

const clientCall = <A>(operation: string, action: () => A) =>
  Effect.try({
    try: action,
    catch: (cause) => clientError(operation, cause),
  });

export type ConnectOptions = Omit<NonNullable<Parameters<typeof resolveContext>[0]>, 'readOnly'>;

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
      id: Schema.decodeUnknownSync(AgentSessionIdSchema)(session.sessionId),
      generation: session.generation,
    };
    this.#store = Store.open({
      databasePath: resolved.binding.databasePath,
      project: Schema.decodeUnknownSync(ProjectBindingSchema)({
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
    input: { workspaceId: typeof WorkspaceIdSchema.Type; idempotencyKey: string },
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
      project: Schema.decodeUnknownSync(ProjectBindingSchema)({
        id: resolved.binding.projectId,
        hostId: resolved.binding.hostId,
        repositoryRoot: resolved.binding.repositoryRoot,
        stateDirectory: resolved.binding.stateDirectory,
      }),
    });
    try {
      const actor = {
        id: Schema.decodeUnknownSync(AgentSessionIdSchema)(session.sessionId),
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

  previewRetirement(input: { workspaceId: typeof WorkspaceIdSchema.Type; idempotencyKey: string }) {
    this.#authenticate();
    return previewRuntimeWorkspaceRetirement({
      ...input,
      store: this.#store,
      actor: this.#identity,
    });
  }

  retireWorkspaceEffect = Effect.fn('Marionette.retireWorkspace')(function* (
    this: Marionette,
    input: { workspaceId: typeof WorkspaceIdSchema.Type; idempotencyKey: string },
  ) {
    yield* clientCall('authenticate', () => this.#authenticate());
    return yield* retireRuntimeWorkspaceEffect({
      ...input,
      store: this.#store,
      actor: this.#identity,
    });
  });
  retireWorkspace(input: { workspaceId: typeof WorkspaceIdSchema.Type; idempotencyKey: string }) {
    return Effect.runPromise(this.retireWorkspaceEffect(input));
  }

  workspace(id: string) {
    this.#authenticate();
    return this.#store.getWorkspace(Schema.decodeUnknownSync(WorkspaceIdSchema)(id));
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
  discoverResult(attemptId: AttemptId) {
    this.#authenticate();
    return this.#store.discoverResult(attemptId);
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
    return this.#board.post({ ...input, author: this.#author() });
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
    return this.#board.subscribe({ ...input, subscriber: this.#recipient() });
  }
  unsubscribe(input: { threadId?: string } = {}) {
    return this.#board.unsubscribe({ ...input, subscriber: this.#recipient() });
  }
  markRead(input: Omit<Parameters<Board['markRead']>[0], 'reader'>) {
    return this.#board.markRead({ ...input, reader: this.#recipient() });
  }
  queryEffect = Effect.fn('Marionette.query')(function* (this: Marionette, input: SqlRead) {
    yield* clientCall('authenticate', () => this.#authenticate());
    return yield* this.#sql.readEffect(input);
  });
  query(input: SqlRead) {
    return Effect.runPromise(this.queryEffect(input));
  }

  contributeEffect = Effect.fn('Marionette.contribute')(function* (
    this: Marionette,
    input: Omit<Parameters<SqlQueryService['contribute']>[0], 'author'>,
  ) {
    const author = yield* clientCall('author', () => this.#author());
    return yield* this.#sql.contributeEffect({ ...input, author });
  });
  contribute(input: Omit<Parameters<SqlQueryService['contribute']>[0], 'author'>) {
    return Effect.runPromise(this.contributeEffect(input));
  }

  registerNativeEffect = Effect.fn('Marionette.registerNative')(function* (
    this: Marionette,
    input: Parameters<Runtime['register']>[0],
  ) {
    yield* clientCall('authenticate', () => this.#authenticate());
    return yield* this.#runtime.registerEffect(input);
  });
  registerNative(input: Parameters<Runtime['register']>[0]) {
    return Effect.runPromise(this.registerNativeEffect(input));
  }
  admit(input: Parameters<Runtime['admit']>[0]) {
    this.#authenticate();
    return this.#runtime.admit(input);
  }
  startAttemptEffect = Effect.fn('Marionette.startAttempt')(function* (
    this: Marionette,
    id: AttemptId,
  ) {
    const session = yield* clientCall('authenticate', () => this.#authenticate());
    if (session.role === 'worker')
      return yield* Effect.fail(
        clientError('startAttempt', new Error('An active controller or user is required')),
      );
    yield* clientCall('getAttempt', () => this.#store.getAttempt(id));
    yield* this.ensureWatcherEffect();
    return yield* this.#runtime.inspectEffect(id);
  });
  startAttempt(id: AttemptId) {
    return Effect.runPromise(this.startAttemptEffect(id));
  }

  inspectAttemptEffect = Effect.fn('Marionette.inspectAttempt')(function* (
    this: Marionette,
    id: AttemptId,
  ) {
    yield* clientCall('authenticate', () => this.#authenticate());
    return yield* this.#runtime.inspectEffect(id);
  });
  inspectAttempt(id: AttemptId) {
    return Effect.runPromise(this.inspectAttemptEffect(id));
  }

  reconcileAttemptEffect = Effect.fn('Marionette.reconcileAttempt')(function* (
    this: Marionette,
    id: AttemptId,
  ) {
    const session = yield* clientCall('authenticate', () => this.#authenticate());
    if (session.role === 'worker')
      return yield* Effect.fail(
        clientError('reconcileAttempt', new Error('An active controller or user is required')),
      );
    const attempt = yield* clientCall('getAttempt', () => this.#store.getAttempt(id));
    if (
      attempt.phase === 'pending' ||
      attempt.phase === 'launching' ||
      attempt.phase === 'running'
    ) {
      yield* this.ensureWatcherEffect();
      return yield* this.#runtime.inspectEffect(id);
    }
    return yield* this.#runtime.reconcileEffect(id);
  });
  reconcileAttempt(id: AttemptId) {
    return Effect.runPromise(this.reconcileAttemptEffect(id));
  }

  recoverAttemptEffect = Effect.fn('Marionette.recoverAttempt')(function* (
    this: Marionette,
    input: Omit<RecoverAttemptInput, 'actor'>,
  ) {
    const session = yield* clientCall('recoverAttempt.authenticate', () => this.#authenticate());
    if (session.role === 'worker')
      return yield* clientError(
        'recoverAttempt',
        new Error('An active controller or user is required'),
      );
    const attempt = yield* clientCall('recoverAttempt.getAttempt', () =>
      this.#store.getAttempt(input.attemptId),
    );
    let native: NativeObservation = {
      kind: 'unconfirmed',
      reason: 'Attempt recovery did not perform native inspection',
    };
    if (!['pending', 'settled', 'closed'].includes(attempt.phase)) {
      const observed = yield* this.#runtime.inspectEffect(input.attemptId);
      if (observed.native.kind === 'working')
        return yield* clientError(
          'recoverAttempt',
          new Error('A working native attempt cannot be recovered'),
        );
      if (observed.native.kind === 'unconfirmed')
        return yield* clientError(
          'recoverAttempt',
          new Error('Native state must be confirmed non-running before recovery'),
        );
      native = observed.native;
    }
    const recovered = yield* clientCall('recoverAttempt.settle', () =>
      this.#store.recoverAttempt({ ...input, actor: this.#identity }),
    );
    return { ...recovered, native };
  });
  recoverAttempt(input: Omit<RecoverAttemptInput, 'actor'>) {
    return Effect.runPromise(this.recoverAttemptEffect(input));
  }

  ensureWatcherEffect = Effect.fn('Marionette.ensureWatcher')(function* (this: Marionette) {
    const session = yield* clientCall('authenticate', () => this.#authenticate());
    if (session.role === 'worker') return;
    yield* ensureBackgroundWatcherEffect(this.#store, this.#resolved.bindingPath);
  });
  ensureWatcher() {
    return Effect.runPromise(this.ensureWatcherEffect());
  }

  watchEffect = Effect.fn('Marionette.watch')(function* (
    this: Marionette,
    options: { signal: AbortSignal; idleTimeoutMs?: number },
  ) {
    const session = yield* clientCall('watch.authenticate', () => this.#authenticate());
    if (session.role === 'worker')
      return yield* Effect.fail(
        new ClientOperationError({
          operation: 'watch',
          message: 'Workers cannot own the project watcher',
          cause: undefined,
        }),
      );
    const processIdentity = yield* currentProcessIdentityEffect();
    return yield* Effect.scoped(
      Effect.gen({ self: this }, function* () {
        const watcher = yield* Effect.acquireRelease(
          Watcher.startEffect({
            store: this.#store,
            deliveryPort: new NativeBoardDelivery(this.#store),
            livenessPort: localOwnerLiveness,
            processIdentity,
          }),
          (watcher) => Effect.sync(() => watcher.stop()),
        );
        const generation = watcher.generation;
        let idleSince = yield* Clock.currentTimeMillis;
        const idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
        const pass = Effect.fn('Marionette.watch.pass')(function* (this: Marionette) {
          const attempts = yield* clientCall('watch.activeAttempts', () =>
            this.#runtime.activeAttempts(),
          );
          for (const id of attempts) {
            if (options.signal.aborted) break;
            yield* this.#runtime.startEffect(id);
            yield* this.#runtime.reconcileEffect(id);
          }
          if (!options.signal.aborted) yield* watcher.pollOnceEffect();
          const pending = yield* clientCall('watch.pendingDeliveries', () =>
            this.#store.read((db) =>
              db
                .prepare(
                  "SELECT 1 FROM notification_deliveries WHERE project_id=? AND state IN ('pending','claimed') LIMIT 1",
                )
                .get(this.#store.project.id),
            ),
          );
          const now = yield* Clock.currentTimeMillis;
          if (attempts.length || pending) idleSince = now;
          return !options.signal.aborted && now - idleSince < idleTimeoutMs;
        }).bind(this);
        const stop = Effect.callback<void>((resume) => {
          const stopped = () => resume(Effect.void);
          options.signal.addEventListener('abort', stopped, { once: true });
          if (options.signal.aborted) stopped();
          return Effect.sync(() => options.signal.removeEventListener('abort', stopped));
        });
        const loop = pass().pipe(
          Effect.uninterruptible,
          Effect.repeat({ while: (running) => running, schedule: Schedule.spaced('1 second') }),
          Effect.delay('1 second'),
        );
        yield* Effect.raceFirst(loop, stop);
        return { stopped: true, generation };
      }),
    );
  });

  watch(options: { signal: AbortSignal; idleTimeoutMs?: number }) {
    return Effect.runPromise(this.watchEffect(options));
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

  checkHandoffEffect = Effect.fn('Marionette.checkHandoff')(function* (
    this: Marionette,
    input: Parameters<Handoffs['check']>[0],
  ) {
    const handoffs = yield* clientCall('handoffs', () => this.#handoffs(input.attemptId));
    return yield* handoffs.checkEffect(input);
  });
  checkHandoff(input: Parameters<Handoffs['check']>[0]) {
    return Effect.runPromise(this.checkHandoffEffect(input));
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
    profile: typeof profileSchema.Type;
    expectedRevision: number;
    idempotencyKey: string;
  }) {
    this.#authenticate();
    const profile = Schema.decodeUnknownSync(profileSchema)(input.profile);
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
