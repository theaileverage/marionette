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
    const row = this.store.read((db) =>
      db
        .prepare(
          'SELECT role,state FROM agent_sessions WHERE project_id=? AND id=? AND generation=?',
        )
        .get(this.store.project.id, this.actor.id, this.actor.generation),
    );
    const session = z
      .object({ role: z.enum(['user', 'controller', 'worker']), state: z.string() })
      .parse(row);
    if (session.state !== 'active' || session.role === 'worker')
      throw new Error('An active controller or user is required');
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
        const profile = settings.profile(input.profile);
        const configured = settings.get(`native/${input.nativeWorkspaceId}`, NativeBindingSchema);
        if (!configured) throw new Error('Register this native workspace before launching work');
        if (configured.value.hostId !== this.store.project.hostId)
          throw new Error('Native binding belongs to another host');
        const job = this.store.getJob(input.jobId);
        const workspace = this.store.getWorkspace(job.workspaceId);
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
        return admitted.attempt.id;
      },
    ).value;
  }

  private journal(id: AttemptId): NativeJournal {
    return {
      prepare: async (effect: NativeEffect) =>
        this.store.transaction((db) => {
          this.assertController();
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
        agentName: `marionette-${id}`,
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
    const claimed = this.store.transaction(
      (db) =>
        db
          .prepare(
            "UPDATE native_attempts SET phase='prompt-claimed',updated_at=? WHERE project_id=? AND attempt_id=? AND phase='launched'",
          )
          .run(new Date().toISOString(), this.store.project.id, id).changes,
    );
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
