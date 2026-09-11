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

export type ConnectOptions = Parameters<typeof resolveContext>[0];

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
  subscribe(input: Omit<Parameters<Board['subscribe']>[0], 'subscriber'> = {}) {
    return this.#board.subscribe({ ...input, subscriber: this.#recipient() });
  }
  unsubscribe(input: { threadId?: string } = {}) {
    return this.#board.unsubscribe({ ...input, subscriber: this.#recipient() });
  }
  markRead(input: Omit<Parameters<Board['markRead']>[0], 'reader'>) {
    return this.#board.markRead({ ...input, reader: this.#recipient() });
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
  startAttempt(id: AttemptId) {
    this.#authenticate();
    return this.#runtime.start(id);
  }
  inspectAttempt(id: AttemptId) {
    this.#authenticate();
    return this.#runtime.inspect(id);
  }

  reconcileAttempt(id: AttemptId) {
    this.#authenticate();
    return this.#runtime.reconcile(id);
  }

  async ensureWatcher() {
    const session = this.#authenticate();
    if (session.role === 'worker') return;
    await ensureBackgroundWatcher(this.#store, this.#resolved.bindingPath);
  }

  async watch(options: { signal: AbortSignal; idleTimeoutMs?: number }) {
    const session = this.#authenticate();
    if (session.role === 'worker') throw new Error('Workers cannot own the project watcher');
    const watcher = await Watcher.start({
      store: this.#store,
      deliveryPort: new NativeBoardDelivery(this.#store),
      livenessPort: localOwnerLiveness,
      processIdentity: await currentProcessIdentity(),
    });
    const generation = watcher.generation;
    let polling = false;
    let idleSince = Date.now();
    const idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
    await new Promise<void>((resolve, reject) => {
      let stopRequested = false;
      let stopped = false;
      let failure: Error | null = null;
      const finish = () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        options.signal.removeEventListener('abort', requestStop);
        try {
          watcher.stop();
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
        }
        if (failure) reject(failure);
        else resolve();
      };
      const requestStop = () => {
        stopRequested = true;
        if (!polling) finish();
      };
      const tick = async () => {
        if (polling || stopRequested) return;
        polling = true;
        try {
          const attempts = this.#runtime.activeAttempts();
          for (const id of attempts) {
            if (stopRequested) break;
            await this.#runtime.start(id);
            await this.#runtime.reconcile(id);
          }
          if (!stopRequested) await watcher.pollOnce();
          const pending = this.#store.read((db) =>
            db
              .prepare(
                "SELECT 1 FROM notification_deliveries WHERE project_id=? AND state IN ('pending','claimed') LIMIT 1",
              )
              .get(this.#store.project.id),
          );
          if (attempts.length || pending) idleSince = Date.now();
          else if (Date.now() - idleSince >= idleTimeoutMs) requestStop();
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
          stopRequested = true;
        } finally {
          polling = false;
          if (stopRequested) finish();
        }
      };
      const timer = setInterval(() => void tick(), 1_000);
      options.signal.addEventListener('abort', requestStop, { once: true });
      if (options.signal.aborted) requestStop();
    });
    return { stopped: true, generation };
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
