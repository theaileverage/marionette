import { requireControlActor } from './controllers/controller-store.js';
import { createHerdrAdapter, type HerdrAdapterFactory } from './adapters/herdr.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { writeSessionContext, type ResolvedContext, type SessionContext } from './context.js';
import {
  AgentSessionIdSchema,
  AttemptIdSchema,
  type AttemptId,
  type JobId,
  type ResultId,
} from './model.js';
import {
  NativeBindingSchema,
  NativeIdentitySchema,
  type NativeEffect,
  type NativeJournal,
  type NativeObservation,
} from './native.js';
import { nativeLocatorForRetirement } from './retirement.js';
import { Settings, profileSchema } from './settings.js';
import { HarnessCatalog } from './harnesses/index.js';
import { canonicalJson, payloadDigest } from './database.js';
import { Store, type SessionIdentity } from './store.js';

const runtimeRow = z.object({
  attempt_id: AttemptIdSchema,
  binding_json: z.string(),
  profile_json: z.string(),
  context_path: z.string(),
  expected_control_revision: z.number().int().positive().nullable(),
  phase: z.enum([
    'admitted',
    'launch-claimed',
    'launched',
    'prompt-claimed',
    'active',
    'settled',
    'unconfirmed',
  ]),
  identity_json: z.string().nullable(),
  launch_result_json: z.string().nullable(),
  observed_working: z.number().int().min(0).max(1),
  last_observation_json: z.string().nullable(),
});

export class Runtime {
  constructor(
    private readonly store: Store,
    private readonly actor: SessionIdentity,
    private readonly context: ResolvedContext,
    private readonly adapterFor: HerdrAdapterFactory = createHerdrAdapter,
  ) {}

  private row(id: AttemptId) {
    return this.store.read((db) =>
      runtimeRow.parse(
        db
          .prepare('SELECT * FROM native_attempts WHERE project_id=? AND attempt_id=?')
          .get(this.store.project.id, id),
      ),
    );
  }

  private assertController() {
    this.store.read((db) => requireControlActor(this.store, db, this.actor));
  }

  async register(input: {
    socketPath: string;
    workspaceId: string;
    expectedRevision: number;
    idempotencyKey: string;
  }) {
    this.assertController();
    const adapter = this.adapterFor({
      prepare: async () => ({
        kind: 'rejected',
        reason: 'Registration cannot mutate native execution',
      }),
    });
    const binding = await adapter.invoke('register', {
      hostId: this.store.project.hostId,
      socketPath: input.socketPath,
      workspaceId: input.workspaceId,
    });
    if ('kind' in binding) throw new Error(binding.reason);
    return new Settings(this.store, this.actor).set({
      key: `native/${input.workspaceId}`,
      expectedRevision: input.expectedRevision,
      value: binding,
      schema: NativeBindingSchema,
      idempotencyKey: input.idempotencyKey,
    });
  }

  admit(input: {
    jobId: JobId;
    profile: string;
    nativeWorkspaceId: string;
    routeDecisionId?: string;
    inputResultIds: ResultId[];
    expectedBriefRevision: number;
    idempotencyKey: string;
  }) {
    this.assertController();
    return this.store.idempotent(
      'runtime.admit',
      input.idempotencyKey,
      input,
      AttemptIdSchema,
      (db) => {
        const settings = new Settings(this.store, this.actor);
        const catalog = new HarnessCatalog(this.store, this.actor);
        const route = input.routeDecisionId
          ? catalog.admissionSnapshot(input.routeDecisionId)
          : null;
        if (route && (route.adapter.id !== 'herdr' || route.adapter.version !== 1))
          throw new Error('This runtime requires the exact herdr adapter contract version 1');
        if (route && route.profile.id !== input.profile)
          throw new Error('Requested profile does not match route');
        const profile = route ? route.profile.native : settings.profile(input.profile);
        const configured = route
          ? {
              value: NativeBindingSchema.parse(
                JSON.parse(route.observation.locator.binding ?? 'null'),
              ),
            }
          : settings.get(`native/${input.nativeWorkspaceId}`, NativeBindingSchema);
        if (
          route &&
          configured &&
          (configured.value.workspaceId !== input.nativeWorkspaceId ||
            payloadDigest(configured.value.endpoint) !== route.endpointGeneration)
        )
          throw new Error('Requested workspace or endpoint generation does not match route');
        if (!configured) throw new Error('Register this native workspace before launching work');
        if (configured.value.hostId !== this.store.project.hostId)
          throw new Error('Native binding belongs to another host');
        const job = this.store.getJob(input.jobId);
        const workspace = this.store.getWorkspace(job.workspaceId);
        if (route && workspace.access === 'write' && route.profile.workspaceAccess !== 'write')
          throw new Error('Routed profile does not authorize this writable workspace');
        const workflow =
          job.origin.kind === 'workflow' ? this.store.getWorkflow(job.origin.workflowId) : null;
        const step =
          job.origin.kind === 'workflow' ? this.store.getStepRun(job.origin.stepRunId) : null;
        const token = randomBytes(32).toString('hex');
        const session = this.store.registerSession({
          id: AgentSessionIdSchema.parse(`worker-${randomUUID()}`),
          generation: 1,
          workspaceId: job.workspaceId,
          role: 'worker',
          executionRole: step?.stepName ?? 'direct',
          tokenHash: createHash('sha256').update(token).digest('hex'),
          parentWorkflowId: workflow?.id ?? null,
          attemptId: null,
          nativeKind: null,
          nativeServerGeneration: null,
          nativeLocator: null,
        });
        const admitted = this.store.admitAttempt({
          actor: this.actor,
          jobId: job.id,
          session,
          resourceKey:
            workspace.access === 'write' ? `workspace/${job.workspaceId}` : `session/${session.id}`,
          inputResultIds: input.inputResultIds,
          expectedBriefRevision: input.expectedBriefRevision,
          workflow:
            workflow && step
              ? {
                  kind: 'managed',
                  workflowId: workflow.id,
                  stepRunId: step.id,
                  expectedWorkflowRevision: workflow.revision,
                  expectedControlRevision: workflow.controlRevision,
                }
              : { kind: 'direct' },
          idempotencyKey: `runtime/${input.idempotencyKey}`,
        });
        const sessionContext: SessionContext = {
          version: 1,
          bindingPath: this.context.bindingPath,
          projectId: this.store.project.id,
          hostId: this.store.project.hostId,
          sessionId: session.id,
          generation: session.generation,
          token,
          attemptId: admitted.attempt.id,
        };
        if (workflow) sessionContext.parentWorkflowId = workflow.id;
        const contextPath = writeSessionContext({
          stateDirectory: this.store.project.stateDirectory,
          context: sessionContext,
        });
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO native_attempts(attempt_id,project_id,binding_json,profile_json,context_path,expected_control_revision,phase,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'admitted',?,?)`,
        ).run(
          admitted.attempt.id,
          this.store.project.id,
          JSON.stringify(configured.value),
          JSON.stringify(profile),
          contextPath,
          workflow?.controlRevision ?? null,
          now,
          now,
        );
        if (route)
          db.prepare('INSERT INTO harness_attempt_routes VALUES (?,?,?)').run(
            admitted.attempt.id,
            route.routeDecisionId,
            canonicalJson(route),
          );
        return admitted.attempt.id;
      },
    ).value;
  }

  private validateAttemptRoute(id: AttemptId) {
    const raw = this.store.read((db) =>
      db
        .prepare('SELECT route_id,snapshot_json FROM harness_attempt_routes WHERE attempt_id=?')
        .get(id),
    );
    if (!raw) return;
    const linked = z.object({ route_id: z.string(), snapshot_json: z.string() }).parse(raw);
    const current = new HarnessCatalog(this.store, this.actor).validateRoute(linked.route_id);
    if (canonicalJson(current) !== linked.snapshot_json)
      throw new Error('Attempt route changed; reconcile before any native effect');
  }

  private journal(id: AttemptId): NativeJournal {
    return {
      prepare: async (effect: NativeEffect) =>
        this.store.transaction((db) => {
          this.assertController();
          if (effect.kind !== 'interrupt' && effect.kind !== 'cleanup')
            this.validateAttemptRoute(id);
          const attempt = this.store.getAttempt(id);
          const runtime = this.row(id);
          const job = this.store.getJob(attempt.jobId);
          if (job.currentBriefRevision !== attempt.briefRevision)
            return { kind: 'rejected', reason: 'Brief changed before native effect' };
          if (attempt.workflowId) {
            const workflow = this.store.getWorkflow(attempt.workflowId);
            if (
              workflow.phase !== 'running' ||
              workflow.controlRevision !== runtime.expected_control_revision
            )
              return { kind: 'rejected', reason: 'Workflow control changed before native effect' };
          }
          if (attempt.workflowId) {
            const ancestors = db
              .prepare(
                `WITH RECURSIVE a AS (SELECT * FROM workflow_runs WHERE id=? UNION ALL SELECT w.* FROM workflow_runs w JOIN a ON a.parent_workflow_id=w.id) SELECT id,phase,deadline_at,limits_revision FROM a`,
              )
              .all(attempt.workflowId);
            for (const ancestor of ancestors) {
              if (
                ancestor.phase !== 'running' ||
                Date.parse(String(ancestor.deadline_at)) <= Date.now()
              )
                return {
                  kind: 'rejected',
                  reason: 'Ancestor stopped or deadline expired before native effect',
                };
              const debit = db
                .prepare(
                  'SELECT limits_revision FROM workflow_budget_ledger WHERE attempt_id=? AND workflow_id=?',
                )
                .get(id, ancestor.id);
              if (!debit || debit.limits_revision !== ancestor.limits_revision)
                return { kind: 'rejected', reason: 'Budget revision changed before native effect' };
            }
            const deadline = db
              .prepare(
                'SELECT deadline_at,state FROM workflow_attempt_deadlines WHERE attempt_id=?',
              )
              .get(id);
            if (
              deadline &&
              (deadline.state !== 'pending' ||
                Date.parse(String(deadline.deadline_at)) <= Date.now())
            )
              return { kind: 'rejected', reason: 'Attempt deadline expired before native effect' };
          }
          if (!['launching', 'running'].includes(attempt.phase))
            return { kind: 'rejected', reason: `Attempt is ${attempt.phase}` };
          const prior = db
            .prepare('SELECT id FROM native_effects WHERE attempt_id=? AND effect_kind=?')
            .get(id, effect.kind);
          if (prior)
            return {
              kind: 'rejected',
              reason: 'Native effect was already claimed; inspect its outcome before retrying',
            };
          const operationId = randomUUID();
          db.prepare(
            'INSERT INTO native_effects(id,project_id,attempt_id,effect_kind,effect_json,created_at) VALUES(?,?,?,?,?,?)',
          ).run(
            operationId,
            this.store.project.id,
            id,
            effect.kind,
            JSON.stringify(effect),
            new Date().toISOString(),
          );
          return { kind: 'prepared', operationId };
        }),
    };
  }

  private update(
    id: AttemptId,
    phase: z.infer<typeof runtimeRow>['phase'],
    details: { identity?: z.infer<typeof NativeIdentitySchema>; launch?: unknown } = {},
  ) {
    this.store.transaction((db) =>
      db
        .prepare(
          `UPDATE native_attempts SET phase=?,identity_json=COALESCE(?,identity_json),launch_result_json=COALESCE(?,launch_result_json),updated_at=? WHERE project_id=? AND attempt_id=?`,
        )
        .run(
          phase,
          details.identity ? JSON.stringify(details.identity) : null,
          details.launch ? JSON.stringify(details.launch) : null,
          new Date().toISOString(),
          this.store.project.id,
          id,
        ),
    );
  }

  async start(id: AttemptId) {
    this.assertController();
    const row = this.row(id);
    if (row.phase === 'launched') return this.submit(id);
    if (row.phase !== 'admitted') return this.inspect(id);
    const attempt = this.store.getAttempt(id);
    const workspace = this.store.getWorkspace(attempt.workspaceId);
    this.store.transaction(() => {
      this.validateAttemptRoute(id);
      this.store.claimAttemptLaunch({
        actor: this.actor,
        attemptId: id,
        expectedBriefRevision: attempt.briefRevision,
        expectedControlRevision: row.expected_control_revision,
        idempotencyKey: `launch/${id}`,
      });
      this.update(id, 'launch-claimed');
    });
    const profile = profileSchema.parse(JSON.parse(row.profile_json));
    const binding = NativeBindingSchema.parse(JSON.parse(row.binding_json));
    const adapter = this.adapterFor(this.journal(id));
    const launched = await adapter.invoke('launch', {
      binding,
      request: {
        cwd: workspace.path,
        agentKind: profile.kind,
        agentName: `mnett-${createHash('sha256').update(id).digest('hex').slice(0, 24)}`,
        args: profile.args,
        env: {
          MARIONETTE_CONTEXT: row.context_path,
          MARIONETTE_STATE_HOME: dirname(dirname(this.store.project.stateDirectory)),
        },
      },
    });
    if (launched.kind !== 'launched') {
      this.update(id, 'unconfirmed', { launch: launched });
      this.store.settleAttempt({
        actor: this.actor,
        attemptId: id,
        observation: { kind: 'unconfirmed', reason: launched.reason },
        idempotencyKey: `launch-unconfirmed/${id}`,
      });
      return { attempt: this.store.getAttempt(id), native: launched };
    }
    this.store.transaction(() => {
      this.store.observeAttemptRunning({
        actor: this.actor,
        attemptId: id,
        nativeKind: profile.kind,
        nativeServerGeneration: binding.endpoint.serverStartToken,
        nativeLocator: nativeLocatorForRetirement(launched.identity),
        idempotencyKey: `running/${id}`,
      });
      this.update(id, 'launched', { identity: launched.identity, launch: launched });
    });
    return this.submit(id);
  }

  private prompt(id: AttemptId): string {
    const attempt = this.store.getAttempt(id);
    const brief = this.store.getBrief(attempt.jobId, attempt.briefRevision);
    const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
    let workflowInstructions = '';
    if (attempt.workflowId && attempt.stepRunId) {
      const workflow = this.store.getWorkflow(attempt.workflowId);
      const stepRun = this.store.getStepRun(attempt.stepRunId);
      const step = workflow.package.steps.find((candidate) => candidate.name === stepRun.stepName);
      if (!step) throw new Error('Pinned workflow step is missing');
      const resources = this.store.read((db) =>
        step.resources.map((name) => {
          const row = db
            .prepare(
              'SELECT r.path,a.digest FROM workflow_package_resources r JOIN artifacts a ON a.id=r.artifact_id AND a.project_id=r.project_id WHERE r.project_id=? AND r.package_digest=? AND r.resource_name=?',
            )
            .get(this.store.project.id, workflow.package.digest, name);
          const resource = z.object({ path: z.string(), digest: z.string() }).parse(row);
          if (
            createHash('sha256').update(readFileSync(resource.path)).digest('hex') !==
            resource.digest
          )
            throw new Error('Pinned workflow resource bytes changed before prompt submission');
          return resource.path;
        }),
      );
      workflowInstructions = `\n\nWorkflow step: ${step.name}. Read these pinned resources before working:\n${resources.join('\n')}\nOutput contract: ${step.outputContract}\nRequired evidence claims: ${step.requiredEvidence.join(', ')}. Permitted methods: ${step.permittedMethods.join(', ')}.`;
    }
    return `You are working on Marionette job ${attempt.jobId}, attempt ${id}. Adopt brief revision ${attempt.briefRevision} before working. Your MARIONETTE_CONTEXT already identifies this project and session. Use the CLI through ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)}.\n\nCurrent brief:\n${JSON.stringify(brief.content, null, 2)}${workflowInstructions}\n\nAcknowledge with the brief.acknowledge operation, attemptId ${id}, briefRevision ${attempt.briefRevision}, and a stable idempotencyKey. Use board posts for findings and questions. Record a durable result through result.record when your work is ready. A native idle state alone does not mean the result was accepted. Do not change unrelated files.`;
  }

  private async submit(id: AttemptId) {
    const row = this.row(id);
    if (row.phase !== 'launched' || !row.identity_json) return this.inspect(id);
    const prompt = this.prompt(id);
    const claimed = this.store.transaction((db) => {
      this.validateAttemptRoute(id);
      return db
        .prepare(
          "UPDATE native_attempts SET phase='prompt-claimed',updated_at=? WHERE project_id=? AND attempt_id=? AND phase='launched'",
        )
        .run(new Date().toISOString(), this.store.project.id, id).changes;
    });
    if (!claimed) return this.inspect(id);
    const identity = NativeIdentitySchema.parse(JSON.parse(row.identity_json));
    const submitted = await this.adapterFor(this.journal(id)).invoke('prompt', {
      identity,
      text: prompt,
    });
    this.update(id, submitted.kind === 'submitted' ? 'active' : 'unconfirmed');
    if (submitted.kind !== 'submitted')
      this.store.settleAttempt({
        actor: this.actor,
        attemptId: id,
        observation: { kind: 'unconfirmed', reason: submitted.reason },
        idempotencyKey: `prompt-unconfirmed/${id}`,
      });
    return { attempt: this.store.getAttempt(id), native: submitted };
  }

  async inspect(id: AttemptId) {
    this.assertController();
    const row = this.row(id);
    if (!row.identity_json)
      return {
        attempt: this.store.getAttempt(id),
        native: {
          kind: 'unconfirmed',
          reason: 'No confirmed native identity is recorded',
          phase: row.phase,
        } satisfies Extract<NativeObservation, { kind: 'unconfirmed' }> & {
          phase: z.infer<typeof runtimeRow>['phase'];
        },
      };
    const identity = NativeIdentitySchema.parse(JSON.parse(row.identity_json));
    const observation = await this.adapterFor(this.journal(id)).invoke('observe', { identity });
    this.store.transaction((db) =>
      db
        .prepare(
          'UPDATE native_attempts SET last_observation_json=?,observed_working=MAX(observed_working,?),updated_at=? WHERE project_id=? AND attempt_id=?',
        )
        .run(
          JSON.stringify(observation),
          observation.kind === 'working' ? 1 : 0,
          new Date().toISOString(),
          this.store.project.id,
          id,
        ),
    );
    return { attempt: this.store.getAttempt(id), native: observation };
  }

  private markUnconfirmed(id: AttemptId, reason: string) {
    return this.store.transaction((db) => {
      const current = this.store.getAttempt(id);
      if (['unconfirmed', 'settled', 'closed'].includes(current.phase)) return current;
      db.prepare(
        'UPDATE native_attempts SET phase=?,updated_at=? WHERE project_id=? AND attempt_id=?',
      ).run('unconfirmed', new Date().toISOString(), this.store.project.id, id);
      return this.store.settleAttempt({
        actor: this.actor,
        attemptId: id,
        observation: { kind: 'unconfirmed', reason },
        idempotencyKey: `native-unconfirmed/${id}`,
      });
    });
  }

  async reconcile(id: AttemptId) {
    const observed = await this.inspect(id);
    if (['settled', 'closed'].includes(observed.attempt.phase)) return observed;
    if (observed.native.kind === 'working') {
      if (this.row(id).phase === 'prompt-claimed') this.update(id, 'active');
      return observed;
    }
    if (observed.native.kind !== 'settled') {
      if (observed.attempt.phase === 'unconfirmed') return observed;
      return { ...observed, attempt: this.markUnconfirmed(id, observed.native.reason) };
    }
    const result = this.store
      .listResults(observed.attempt.jobId)
      .find((candidate) => candidate.attemptId === id);
    if (!result) return observed;
    const attempt = this.store.settleAttempt({
      actor: this.actor,
      attemptId: id,
      observation: {
        kind: 'settled',
        outcome: result.verification.kind === 'failed' ? 'failed' : 'succeeded',
        reason:
          'Native adapter confirmed the session is idle with its slot ready after a result was recorded',
      },
      idempotencyKey: `native-settlement/${id}`,
    });
    this.update(id, 'settled');
    return { ...observed, attempt };
  }

  activeAttempts() {
    this.assertController();
    return this.store.read((db) =>
      db
        .prepare(
          "SELECT attempt_id FROM native_attempts WHERE project_id=? AND phase IN ('admitted','launch-claimed','launched','prompt-claimed','active')",
        )
        .all(this.store.project.id)
        .map((row) => z.object({ attempt_id: AttemptIdSchema }).parse(row).attempt_id),
    );
  }
}
