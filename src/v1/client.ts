import { inboxDecisionSchema } from './control-operations.js';
import { HumanDecisions } from './decisions/human-decisions.js';
import { NativeApprovals } from './decisions/native-approvals.js';
import { NativeBindingSchema } from './native.js';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ServiceLifecycle, type ServiceActionInput } from './service/lifecycle.js';
import { serviceDefinition } from './service/installers/index.js';
import { ServiceControls } from './service/controls.js';
import { runProjectService } from './service/project-service.js';
import { RecoveryRegistry } from './service/recovery.js';
import { EventStore } from './events/event-store.js';
import { ControllerStore } from './controllers/controller-store.js';
import { ControllerRuntime } from './controllers/controller-runtime.js';
import { ControllerInbox } from './inbox/controller-inbox.js';
import { dueSchedules, requestExpiredDeadlines } from './workflows/scheduler.js';
import { HarnessCatalog } from './harnesses/index.js';
import { createHerdrProvider } from './harnesses/herdr.js';
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
  ResultIdSchema,
  AttemptIdSchema,
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

  activateWorkflow(input: Omit<Parameters<Store['activateWorkflow']>[0], 'actor'>) {
    this.#authenticate();
    return this.#store.activateWorkflow({ ...input, actor: this.#identity });
  }

  transitionWorkflow(input: Omit<Parameters<Store['requestTransition']>[0], 'actor'>) {
    this.#authenticate();
    return this.#store.requestTransition({ ...input, actor: this.#identity });
  }

  reviseWorkflow(input: Omit<Parameters<Store['reviseBrief']>[0], 'actor'>) {
    this.#authenticate();
    return this.#store.reviseBrief({ ...input, actor: this.#identity });
  }

  controlWorkflow(input: Omit<Parameters<Store['controlWorkflow']>[0], 'actor'>) {
    this.#authenticate();
    return this.#store.controlWorkflow({ ...input, actor: this.#identity });
  }

  resumeWorkflow(input: Omit<Parameters<Store['resumeWorkflow']>[0], 'actor'>) {
    this.#authenticate();
    return this.#store.resumeWorkflow({ ...input, actor: this.#identity });
  }

  extendWorkflowLimits(input: Omit<Parameters<Store['extendLimits']>[0], 'actor'>) {
    this.#authenticate();
    return this.#store.extendLimits({ ...input, actor: this.#identity });
  }

  workflowStatus(id: WorkflowId) {
    this.#authenticate();
    return this.#store.workflowStatus(id);
  }

  events(after?: number, limit?: number) {
    this.#authenticate();
    return new EventStore(this.#store).list(after, limit);
  }
  controllerStatus() {
    this.#authenticate();
    return new ControllerStore(this.#store).status();
  }
  configureController(input: {
    profilePolicyId: string;
    expectedRevision: number;
    idempotencyKey: string;
  }) {
    this.#authenticate();
    return this.#store.idempotent(
      'controller.configure',
      input.idempotencyKey,
      input,
      z.record(z.unknown()).nullable(),
      () => new ControllerStore(this.#store).configure({ ...input, actor: this.#identity }),
    ).value;
  }
  ensureController(input: { routeId: string; expectedRevision: number; idempotencyKey: string }) {
    this.#authenticate();
    const route = this.harnessCatalog().validateRoute(input.routeId);
    return new ControllerRuntime(this.#store, this.#resolved.bindingPath).ensure({
      actor: this.#identity,
      routeId: input.routeId,
      expectedRevision: input.expectedRevision,
      idempotencyKey: input.idempotencyKey,
      binding: NativeBindingSchema.parse(JSON.parse(route.observation.locator.binding)),
      request: {
        cwd: this.#store.project.repositoryRoot,
        agentKind: route.profile.native.kind,
        agentName: `chief-${String(this.controllerStatus()?.id).replaceAll('-', '').slice(0, 20)}`,
        args: route.profile.native.args,
        env: {},
      },
    });
  }
  reconcileController(input: {
    controllerId: string;
    generation: number;
    expectedRevision: number;
    idempotencyKey: string;
  }) {
    this.#authenticate();
    return new ControllerRuntime(this.#store, this.#resolved.bindingPath).observe({
      ...input,
      actor: this.#identity,
    });
  }
  readInbox(controllerId: string) {
    this.#authenticate();
    return new ControllerInbox(this.#store).read(controllerId);
  }
  acknowledgeInbox(input: {
    claims: Parameters<ControllerInbox['commitDecision']>[0]['claims'];
    decision: z.infer<typeof inboxDecisionSchema>;
    decisionKey: string;
  }) {
    this.#authenticate();
    const decision = inboxDecisionSchema.parse(input.decision);
    return new ControllerInbox(this.#store).commitDecision(
      {
        ...input,
        decision,
        actor: this.#identity,
        disposition: decision.kind === 'acknowledge-only' ? 'dismissed' : 'processed',
      },
      () => {
        switch (decision.kind) {
          case 'workflow-transition':
            return this.#store.requestTransition({
              actor: this.#identity,
              request: decision.request,
            });
          case 'request-human-decision':
            return this.humanDecisions().request(decision.request);
          case 'acknowledge-only':
            return { kind: 'dismissed', reason: decision.reason };
        }
      },
    );
  }
  humanDecisions() {
    this.#authenticate();
    return new HumanDecisions(this.#store, this.#identity);
  }
  nativeApprovals() {
    this.#authenticate();
    return new NativeApprovals(this.#store, this.#identity);
  }
  bindWorkflow(input: {
    workflowId: WorkflowId;
    stepName: string;
    profile: string;
    nativeWorkspaceId: string;
    routeDecisionId: string;
    expectedRevision: number;
    idempotencyKey: string;
  }) {
    this.#authenticate();
    const workflow = this.#store.getWorkflow(input.workflowId);
    if (!workflow.package.steps.some((step) => step.name === input.stepName))
      throw new Error('Unknown pinned step');
    return this.#settings.set({
      key: `schedule/${input.workflowId}/${input.stepName}`,
      expectedRevision: input.expectedRevision,
      value: {
        profile: input.profile,
        nativeWorkspaceId: input.nativeWorkspaceId,
        routeDecisionId: input.routeDecisionId,
      },
      schema: z.object({
        profile: z.string(),
        nativeWorkspaceId: z.string(),
        routeDecisionId: z.string(),
      }),
      idempotencyKey: input.idempotencyKey,
    });
  }
  harnessCatalog() {
    this.#authenticate();
    return new HarnessCatalog(this.#store, this.#identity);
  }
  discoverHarness(input: {
    socketPath: string;
    workspaceId: string;
    endpointId: string;
    verifiedModels: string[];
    idempotencyKey: string;
  }) {
    this.#authenticate();
    const provider = createHerdrProvider({ ...input, hostId: this.#store.project.hostId });
    return new HarnessCatalog(this.#store, this.#identity, [provider]).discover(
      { id: input.endpointId, provider: provider.reference, source: { kind: 'builtin' } },
      input.idempotencyKey,
    );
  }
  probeHarness(input: {
    installationId: string;
    socketPath: string;
    workspaceId: string;
    endpointId: string;
    verifiedModels: string[];
  }) {
    this.#authenticate();
    const provider = createHerdrProvider({ ...input, hostId: this.#store.project.hostId });
    return new HarnessCatalog(this.#store, this.#identity, [provider]).probe(input.installationId);
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

  #serviceLifecycle() {
    const session = this.#authenticate();
    if (session.role !== 'user') throw new Error('Service lifecycle requires the local user');
    const platform = z.enum(['darwin', 'linux']).parse(process.platform);
    const definition = serviceDefinition({
      projectId: this.#store.project.id,
      hostId: this.#store.project.hostId,
      executable: process.execPath,
      arguments: [
        fileURLToPath(new URL('./cli.js', import.meta.url)),
        'service',
        'run',
        '--project',
        this.#resolved.bindingPath,
      ],
      workingDirectory: this.#store.project.repositoryRoot,
      stateDirectory: this.#store.project.stateDirectory,
      homeDirectory: homedir(),
      platform,
      uid: process.getuid!(),
    });
    return new ServiceLifecycle(this.#store, definition, undefined, this.#identity);
  }
  reconcileService(input: { claimId: string; expectedRevision: number }) {
    return this.#serviceLifecycle().reconcile(input);
  }
  serviceStatus() {
    return this.#serviceLifecycle().status();
  }
  serviceAction(input: ServiceActionInput & { dryRun?: boolean }) {
    const lifecycle = this.#serviceLifecycle();
    return input.dryRun ? lifecycle.preview(input.action) : lifecycle.apply(input);
  }
  async runService(options: { signal: AbortSignal; watchdogMs?: number }) {
    const session = this.#authenticate();
    if (session.role !== 'user') throw new Error('Project service requires the local user context');
    let watcher: Watcher | undefined;
    const recovery = new RecoveryRegistry().register('native_attempts', async (record) => {
      await this.#runtime.reconcile(AttemptIdSchema.parse(record.id));
    });
    try {
      await runProjectService({
        store: this.#store,
        processIdentity: await currentProcessIdentity(),
        livenessPort: localOwnerLiveness,
        signal: options.signal,
        watchdogMs: options.watchdogMs,
        recover: async (owner) => {
          new ControllerInbox(this.#store).recoverClaims(owner.generation);
          await recovery.recover(owner);
          watcher = await Watcher.start({
            store: this.#store,
            deliveryPort: new NativeBoardDelivery(this.#store),
            livenessPort: localOwnerLiveness,
            processIdentity: owner.processIdentity,
          });
        },
        scan: async (owner) => {
          this.#authenticate();
          this.#store.transaction((db) => {
            owner.assertCurrent(db);
            requestExpiredDeadlines(this.#store, new Date().toISOString());
          });
          const reportBlocked = (kind: string, id: string, error: Error) =>
            new EventStore(this.#store).append({
              kind: 'service.blocked',
              aggregate: { kind, id, revision: 1 },
              payload: { reason: error.message },
              dedupeKey: `service-blocked/${kind}/${id}/${createHash('sha256').update(error.message).digest('hex')}`,
            });
          for (const schedule of dueSchedules(this.#store).slice(0, 20)) {
            if (options.signal.aborted) break;
            try {
              const workflow = this.#store.getWorkflow(schedule.workflow_id);
              const step = this.#store.getStepRun(schedule.step_run_id);
              if (!step.jobId) continue;
              const policy = workflow.package.steps.find((value) => value.name === step.stepName);
              if (!policy) continue;
              // Explicit role routing is configured per workflow step; missing bindings remain pending.
              const configured = this.#settings.get(
                `schedule/${workflow.id}/${step.stepName}`,
                z.object({
                  profile: z.string(),
                  nativeWorkspaceId: z.string(),
                  routeDecisionId: z.string(),
                }),
              );
              if (!configured) continue;
              const job = this.#store.getJob(step.jobId);
              this.#store.transaction((db) => {
                owner.assertCurrent(db);
                this.#runtime.admit({
                  ...configured.value,
                  jobId: job.id,
                  inputResultIds: this.#store.read((db) =>
                    db
                      .prepare(
                        'SELECT result_id FROM step_run_inputs WHERE step_run_id=? AND result_id IS NOT NULL ORDER BY ordinal',
                      )
                      .all(schedule.step_run_id)
                      .map((row) => ResultIdSchema.parse(row.result_id)),
                  ),
                  expectedBriefRevision: job.currentBriefRevision,
                  idempotencyKey: `schedule/${schedule.id}`,
                });
              });
            } catch (error) {
              reportBlocked(
                'schedule',
                schedule.id,
                error instanceof Error ? error : new Error(String(error)),
              );
            }
          }
          await new ServiceControls(owner, this.#identity).scan();
          for (const id of this.#runtime.activeAttempts().slice(0, 20)) {
            if (options.signal.aborted) break;
            this.#store.read((db) => owner.assertCurrent(db));
            try {
              await this.#runtime.start(id);
              await this.#runtime.reconcile(id);
            } catch (error) {
              reportBlocked(
                'attempt',
                id,
                error instanceof Error ? error : new Error(String(error)),
              );
            }
          }
          if (!options.signal.aborted) await watcher?.pollOnce();
          new EventStore(this.#store).project();
          const controller = new ControllerStore(this.#store).status();
          if (controller?.state === 'idle' && controller.current_generation) {
            const inbox = new ControllerInbox(this.#store);
            const outstanding = this.#store.read((db) =>
              db
                .prepare(
                  "SELECT 1 FROM controller_inbox_items WHERE controller_id=? AND state IN ('claimed','submitted') LIMIT 1",
                )
                .get(String(controller.id)),
            );
            if (!outstanding) {
              const claims = inbox.claim({
                controllerId: String(controller.id),
                controllerGeneration: Number(controller.current_generation),
                serviceGeneration: owner.generation,
                limit: 10,
              });
              if (claims.length)
                await new ControllerRuntime(this.#store, this.#resolved.bindingPath).submit({
                  actor: this.#identity,
                  claims,
                  expectedRevision: Number(controller.state_revision),
                });
            }
          }
        },
      });
      return { stopped: true };
    } finally {
      watcher?.stop();
    }
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
