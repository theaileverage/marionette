import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context, Effect, Layer, Result, Schema } from 'effect';
import { createHerdrAdapter, type HerdrAdapterFactory } from './adapters/herdr.js';
import { AdapterError } from './adapters.js';
import { writeSessionContext, type ResolvedContext, type SessionContext } from './context.js';

type SessionContextDraft = {
  -readonly [Key in keyof SessionContext]: SessionContext[Key];
};

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
  type NativeIdentity,
  type NativeJournal,
  type NativeObservation,
  type PreparedEffect,
} from './native.js';
import { readNativeHistory, type NativeHistoryOptions } from './native-history.js';
import { type NativeSessionBindingDraft } from './native-session.js';
import { nativeLocatorForRetirement } from './retirement.js';
import { Settings, profileSchema } from './settings.js';
import { Store, type SessionIdentity } from './store.js';

const nonEmpty = Schema.String.check(Schema.isMinLength(1));

const positiveInteger = Schema.Finite.check(
  Schema.makeFilter((value) => Number.isInteger(value) && value > 0, {
    expected: 'a positive integer',
  }),
);

const runtimeRow = Schema.Struct({
  attempt_id: AttemptIdSchema,
  binding_json: Schema.String,
  profile_json: Schema.String,
  context_path: Schema.String,
  expected_control_revision: Schema.NullOr(positiveInteger),
  phase: Schema.Literals([
    'admitted',
    'launch-claimed',
    'launched',
    'prompt-claimed',
    'active',
    'settled',
    'unconfirmed',
  ]),
  identity_json: Schema.NullOr(Schema.String),
  launch_result_json: Schema.NullOr(Schema.String),
  observed_working: Schema.Finite.check(
    Schema.makeFilter((value) => value === 0 || value === 1, { expected: 'zero or one' }),
  ),
  last_observation_json: Schema.NullOr(Schema.String),
});

type RuntimeRow = typeof runtimeRow.Type;

export class RuntimeError extends Schema.TaggedError<RuntimeError>()('RuntimeError', {
  operation: nonEmpty,
  message: nonEmpty,
  cause: Schema.Defect(),
}) {}

const runtimeError = (operation: string, cause: unknown) =>
  new RuntimeError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

const sync = <A>(operation: string, evaluate: () => A) =>
  Effect.try({ try: evaluate, catch: (cause) => runtimeError(operation, cause) });

const decode = <S extends Schema.ConstraintDecoder<unknown, never>, Value>(
  schema: S,
  value: Value,
): S['Type'] => Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })(value);

const runCompatibility = <A>(effect: Effect.Effect<A, RuntimeError, never>): Promise<A> =>
  Effect.runPromise(effect).catch((error) => {
    if (error instanceof RuntimeError && error.cause instanceof AdapterError) throw error.cause;
    throw error;
  });

export class Runtime {
  constructor(
    private readonly store: Store,
    private readonly actor: SessionIdentity,
    private readonly context: ResolvedContext,
    private readonly adapterFor: HerdrAdapterFactory = createHerdrAdapter,
  ) {}

  private row(id: AttemptId): RuntimeRow {
    return this.store.read((db) =>
      decode(
        runtimeRow,
        db
          .prepare(
            'SELECT attempt_id,binding_json,profile_json,context_path,expected_control_revision,phase,identity_json,launch_result_json,observed_working,last_observation_json FROM native_attempts WHERE project_id=? AND attempt_id=?',
          )
          .get(this.store.project.id, id),
      ),
    );
  }

  private assertController(): void {
    const row = this.store.read((db) =>
      db
        .prepare(
          'SELECT role,state FROM agent_sessions WHERE project_id=? AND id=? AND generation=?',
        )
        .get(this.store.project.id, this.actor.id, this.actor.generation),
    );

    const session = decode(
      Schema.Struct({
        role: Schema.Literals(['user', 'controller', 'worker']),
        state: Schema.String,
      }),
      row,
    );

    if (session.state !== 'active' || session.role === 'worker')
      throw new Error('An active controller or user is required');
  }

  readonly registerEffect = Effect.fn('Runtime.register')(
    function* (
      this: Runtime,
      input: {
        socketPath: string;
        workspaceId: string;
        expectedRevision: number;
        idempotencyKey: string;
      },
    ) {
      yield* sync('Runtime.register.authority', () => this.assertController());

      const adapter = this.adapterFor({
        prepare: async () => ({
          kind: 'rejected',
          reason: 'Registration cannot mutate native execution',
        }),
        prepareEffect: () =>
          Effect.succeed({
            kind: 'rejected',
            reason: 'Registration cannot mutate native execution',
          }),
      });

      const binding = yield* adapter
        .invokeEffect('register', {
          hostId: this.store.project.hostId,
          socketPath: input.socketPath,
          workspaceId: input.workspaceId,
        })
        .pipe(Effect.mapError((cause) => runtimeError('Runtime.register.native', cause)));

      if ('kind' in binding)
        return yield* runtimeError('Runtime.register.native', new Error(binding.reason));

      return yield* sync('Runtime.register.persist', () =>
        new Settings(this.store, this.actor).set({
          key: `native/${input.workspaceId}`,
          expectedRevision: input.expectedRevision,
          value: binding,
          schema: NativeBindingSchema,
          idempotencyKey: input.idempotencyKey,
        }),
      );
    }.bind(this),
  );

  register(input: Parameters<Runtime['registerEffect']>[0]) {
    return runCompatibility(this.registerEffect(input));
  }

  admit(input: {
    jobId: JobId;
    profile: string;
    nativeWorkspaceId: string;
    inputResultIds: ResultId[];
    expectedBriefRevision: number;
    idempotencyKey: string;
  }): AttemptId {
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
          id: decode(AgentSessionIdSchema, `worker-${randomUUID()}`),
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

        const sessionContext: SessionContextDraft = {
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
          `INSERT INTO native_attempts(attempt_id,project_id,binding_json,profile_json,context_path,expected_control_revision,phase,created_at,updated_at) VALUES(?,?,?,?,?,?,'admitted',?,?)`,
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

  private prepareEffect(
    id: AttemptId,
    effect: NativeEffect,
  ): Effect.Effect<PreparedEffect, RuntimeError> {
    return sync('Runtime.nativeEffect.prepare', () =>
      this.store.transaction((db) => {
        this.assertController();
        const attempt = this.store.getAttempt(id);
        const runtime = this.row(id);
        const job = this.store.getJob(attempt.jobId);

        if (job.currentBriefRevision !== attempt.briefRevision)
          return { kind: 'rejected', reason: 'Brief changed before native effect' } as const;

        if (attempt.workflowId) {
          const workflow = this.store.getWorkflow(attempt.workflowId);

          if (
            workflow.phase !== 'running' ||
            workflow.controlRevision !== runtime.expected_control_revision
          )
            return {
              kind: 'rejected',
              reason: 'Workflow control changed before native effect',
            } as const;
        }

        if (!['launching', 'running'].includes(attempt.phase))
          return { kind: 'rejected', reason: `Attempt is ${attempt.phase}` } as const;

        const prior = db
          .prepare('SELECT id FROM native_effects WHERE attempt_id=? AND effect_kind=?')
          .get(id, effect.kind);

        if (prior)
          return {
            kind: 'rejected',
            reason: 'Native effect was already claimed; inspect its outcome before retrying',
          } as const;
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

        return { kind: 'prepared', operationId } as const;
      }),
    );
  }

  private journal(id: AttemptId): NativeJournal {
    return {
      prepareEffect: (effect) => this.prepareEffect(id, effect),
      prepare: (effect) => Effect.runPromise(this.prepareEffect(id, effect)),
    };
  }

  private update(
    id: AttemptId,
    phase: RuntimeRow['phase'],
    details: { identity?: typeof NativeIdentitySchema.Type; launch?: unknown } = {},
  ): void {
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

  private persistReference(
    id: AttemptId,
    identity: NativeIdentity,
    candidate?: Extract<NativeObservation, { kind: 'unconfirmed' }>['candidate'],
    rejectionReason?: string,
  ): void {
    const attempt = this.store.getAttempt(id);

    if (!attempt.nativeKind || !attempt.nativeServerGeneration) return;
    const reference = candidate?.reference ?? identity.sessionReference;

    const binding: NativeSessionBindingDraft = {
      workspaceId: identity.binding.workspaceId,
      tabId: identity.tabId,
      paneId: identity.paneId,
      terminalId: identity.terminalId,
      identityRevision: candidate?.identityRevision ?? identity.identityRevision,
    };

    if (identity.foregroundProcess) binding.foregroundProcess = identity.foregroundProcess;

    if (identity.binding.endpoint.endpointProtocolGeneration !== undefined)
      binding.endpointProtocolGeneration = identity.binding.endpoint.endpointProtocolGeneration;

    if (reference) {
      const record: Parameters<typeof this.store.recordNativeSessionReference>[0] = {
        actor: this.actor,
        attemptId: id,
        nativeKind: attempt.nativeKind,
        nativeServerGeneration: attempt.nativeServerGeneration,
        reference,
        status: candidate ? 'unconfirmed' : 'confirmed',
        binding,
      };

      if (candidate && rejectionReason) record.rejectionReason = rejectionReason;

      this.store.recordNativeSessionReference(record);
    } else if (identity.nativeSession) {
      this.store.recordNativeSessionReference({
        actor: this.actor,
        attemptId: id,
        nativeKind: attempt.nativeKind,
        nativeServerGeneration: attempt.nativeServerGeneration,
        reference: {
          harness: 'unknown',
          kind: 'legacy',
          value: identity.nativeSession,
          source: 'legacy-nativeSession',
        },
        status: 'legacy-untyped',
        binding,
      });
    }
  }

  readonly startEffect = Effect.fn('Runtime.start')(
    function* (this: Runtime, id: AttemptId) {
      yield* sync('Runtime.start.authority', () => this.assertController());
      const row = yield* sync('Runtime.start.row', () => this.row(id));

      if (row.phase === 'launched') return yield* this.submitEffect(id);

      if (row.phase !== 'admitted') return yield* this.inspectEffect(id);

      const attempt = yield* sync('Runtime.start.claim', () => {
        const current = this.store.getAttempt(id);
        this.store.transaction(() => {
          this.store.claimAttemptLaunch({
            actor: this.actor,
            attemptId: id,
            expectedBriefRevision: current.briefRevision,
            expectedControlRevision: row.expected_control_revision,
            idempotencyKey: `launch/${id}`,
          });
          this.update(id, 'launch-claimed');
        });

        return current;
      });

      const workspace = yield* sync('Runtime.start.workspace', () =>
        this.store.getWorkspace(attempt.workspaceId),
      );

      const profile = decode(profileSchema, JSON.parse(row.profile_json));
      const binding = decode(NativeBindingSchema, JSON.parse(row.binding_json));

      const launched = yield* this.adapterFor(this.journal(id))
        .invokeEffect('launch', {
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
        })
        .pipe(Effect.mapError((cause) => runtimeError('Runtime.start.launch', cause)));

      if (launched.kind !== 'launched') {
        return yield* sync('Runtime.start.unconfirmed', () => {
          this.update(id, 'unconfirmed', { launch: launched });

          const settled = this.store.settleAttempt({
            actor: this.actor,
            attemptId: id,
            observation: { kind: 'unconfirmed', reason: launched.reason },
            idempotencyKey: `launch-unconfirmed/${id}`,
          });

          return { attempt: settled, native: launched };
        });
      }

      yield* sync('Runtime.start.running', () =>
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
        }),
      );
      yield* sync('Runtime.start.reference', () => this.persistReference(id, launched.identity));

      return yield* this.submitEffect(id);
    }.bind(this),
  );

  start(id: AttemptId) {
    return runCompatibility(this.startEffect(id));
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
          const resource = decode(
            Schema.Struct({ path: Schema.String, digest: Schema.String }),
            db
              .prepare(
                'SELECT r.path,a.digest FROM workflow_package_resources r JOIN artifacts a ON a.id=r.artifact_id AND a.project_id=r.project_id WHERE r.project_id=? AND r.package_digest=? AND r.resource_name=?',
              )
              .get(this.store.project.id, workflow.package.digest, name),
          );

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

    return `You are working on Marionette job ${attempt.jobId}, attempt ${id}. Adopt brief revision ${attempt.briefRevision} before working. Your MARIONETTE_CONTEXT already identifies this project and session. Use the CLI through ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)}.\n\nCurrent brief:\n${JSON.stringify(brief.content, null, 2)}${workflowInstructions}\n\nAcknowledge with the brief.acknowledge operation, attemptId ${id}, briefRevision ${attempt.briefRevision}, and a stable idempotencyKey. Use board posts for findings and questions. Subscribe explicitly to the brief-named discussion thread, then read board.inbox at safe task boundaries for catch-up. Mark a thread read only after consuming its posts; never implicitly subscribe to unrelated project traffic. Record a durable result through result.record when your work is ready. A native idle state alone does not mean the result was accepted. Do not change unrelated files.`;
  }

  private readonly submitEffect = Effect.fn('Runtime.submit')(
    function* (this: Runtime, id: AttemptId) {
      const row = yield* sync('Runtime.submit.row', () => this.row(id));

      if (row.phase !== 'launched' || !row.identity_json) return yield* this.inspectEffect(id);
      const prompt = yield* sync('Runtime.submit.prompt', () => this.prompt(id));

      const claimed = yield* sync('Runtime.submit.claim', () =>
        this.store.transaction(
          (db) =>
            db
              .prepare(
                "UPDATE native_attempts SET phase='prompt-claimed',updated_at=? WHERE project_id=? AND attempt_id=? AND phase='launched'",
              )
              .run(new Date().toISOString(), this.store.project.id, id).changes,
        ),
      );

      if (!claimed) return yield* this.inspectEffect(id);
      const identity = decode(NativeIdentitySchema, JSON.parse(row.identity_json));

      const submitted = yield* this.adapterFor(this.journal(id))
        .invokeEffect('prompt', { identity, text: prompt })
        .pipe(Effect.mapError((cause) => runtimeError('Runtime.submit.native', cause)));

      const persisted = yield* sync('Runtime.submit.persist', () => {
        this.update(id, submitted.kind === 'submitted' ? 'active' : 'unconfirmed');

        if (submitted.kind !== 'submitted')
          this.store.settleAttempt({
            actor: this.actor,
            attemptId: id,
            observation: { kind: 'unconfirmed', reason: submitted.reason },
            idempotencyKey: `prompt-unconfirmed/${id}`,
          });

        return { attempt: this.store.getAttempt(id), native: submitted };
      });

      if (submitted.kind === 'submitted') {
        const refreshed = yield* Effect.result(this.inspectEffect(id));

      if (Result.isFailure(refreshed)) {
          yield* sync('Runtime.submit.refresh-failed', () => {
            const observation = {
              kind: 'unconfirmed',
              reason: `Post-prompt reference refresh failed: ${refreshed.failure.message}`,
            };

            this.store.transaction((db) =>
              db
                .prepare(
                  'UPDATE native_attempts SET last_observation_json=?,updated_at=? WHERE project_id=? AND attempt_id=?',
                )
                .run(JSON.stringify(observation), new Date().toISOString(), this.store.project.id, id),
            );
          });
        }
      }

      return persisted;
    }.bind(this),
  );

  readonly inspectEffect = Effect.fn('Runtime.inspect')(
    function* (this: Runtime, id: AttemptId) {
      yield* sync('Runtime.inspect.authority', () => this.assertController());
      const row = yield* sync('Runtime.inspect.row', () => this.row(id));

      if (!row.identity_json)
        return {
          attempt: this.store.getAttempt(id),
          native: {
            kind: 'unconfirmed',
            reason: 'No confirmed native identity is recorded',
            phase: row.phase,
          } satisfies Extract<NativeObservation, { kind: 'unconfirmed' }> & { phase: RuntimeRow['phase'] },
        };
      const identity = decode(NativeIdentitySchema, JSON.parse(row.identity_json));

      const observation = yield* this.adapterFor(this.journal(id))
        .invokeEffect('observe', { identity })
        .pipe(Effect.mapError((cause) => runtimeError('Runtime.inspect.native', cause)));

      return yield* sync('Runtime.inspect.persist', () => {
        if ('identity' in observation) {
          this.update(id, row.phase, { identity: observation.identity });
          this.persistReference(id, observation.identity);
        } else if (observation.candidate) {
          this.persistReference(id, identity, observation.candidate, observation.reason);
        }

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
      });
    }.bind(this),
  );
  inspect(id: AttemptId) {
    return runCompatibility(this.inspectEffect(id));
  }

  readonly inspectRetainedWorkEffect = Effect.fn('Runtime.inspectRetainedWork')(
    function* (
      this: Runtime,
      id: AttemptId,
      options: NativeHistoryOptions & { refresh?: boolean } = {},
    ) {
      yield* sync('Runtime.retained-work.authority', () => this.assertController());

      if (options.refresh !== false) yield* this.inspectEffect(id);

      return yield* sync('Runtime.retained-work.read', () => {
        const references = this.store.listNativeSessionReferences(id);
        const reference = references.at(-1);

        return {
          attempt: this.store.getAttempt(id),
          references,
          history: reference
            ? readNativeHistory(reference, this.store.project.hostId, options)
            : {
                kind: 'missing-reference' as const,
                reason: 'This attempt has no native conversation reference',
              },
          retained: this.store.retainedWork(id),
        };
      });
    }.bind(this),
  );
  inspectRetainedWork(id: AttemptId, options: NativeHistoryOptions & { refresh?: boolean } = {}) {
    return runCompatibility(this.inspectRetainedWorkEffect(id, options));
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

  readonly reconcileEffect = Effect.fn('Runtime.reconcile')(
    function* (this: Runtime, id: AttemptId) {
      const observed = yield* this.inspectEffect(id);

      if (['settled', 'closed'].includes(observed.attempt.phase)) return observed;

      if (observed.native.kind === 'working') {
        yield* sync('Runtime.reconcile.working', () => {
          if (this.row(id).phase === 'prompt-claimed') this.update(id, 'active');
        });

        return observed;
      }

      if (observed.native.kind !== 'settled') {
        if (observed.attempt.phase === 'unconfirmed') return observed;

        return yield* sync('Runtime.reconcile.unconfirmed', () => ({
          ...observed,
          attempt: this.markUnconfirmed(
            id,
            'reason' in observed.native
              ? observed.native.reason
              : `Agent is ${observed.native.kind}`,
          ),
        }));
      }

      const result = yield* sync('Runtime.reconcile.result', () =>
        this.store
          .listResults(observed.attempt.jobId)
          .find((candidate) => candidate.attemptId === id),
      );

      if (!result) return observed;

      return yield* sync('Runtime.reconcile.settle', () => {
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
      });
    }.bind(this),
  );
  reconcile(id: AttemptId) {
    return runCompatibility(this.reconcileEffect(id));
  }

  /**
   * Whether `start` still owes this attempt launch or prompt progress. In every
   * other phase `start` falls through to a bare `inspect`, which the following
   * `reconcile` immediately repeats; skipping it halves the native observations
   * a watcher pass costs for an attempt that is already running.
   */
  needsStartProgress(id: AttemptId): boolean {
    this.assertController();
    const phase = this.row(id).phase;

    return phase === 'admitted' || phase === 'launched';
  }

  activeAttempts(): AttemptId[] {
    this.assertController();

    return this.store.read((db) =>
      db
        .prepare(
          "SELECT attempt_id FROM native_attempts WHERE project_id=? AND phase IN ('admitted','launch-claimed','launched','prompt-claimed','active')",
        )
        .all(this.store.project.id)
        .map((row) => decode(Schema.Struct({ attempt_id: AttemptIdSchema }), row).attempt_id),
    );
  }
}

export interface RuntimeServiceContract {
  readonly runtime: Runtime;
  readonly start: Runtime['startEffect'];
  readonly inspect: Runtime['inspectEffect'];
  readonly inspectRetainedWork: Runtime['inspectRetainedWorkEffect'];
  readonly reconcile: Runtime['reconcileEffect'];
}

export class RuntimeService extends Context.Service<RuntimeService, RuntimeServiceContract>()(
  '@marionette/v1/Runtime',
) {}

export const runtimeLayer = (runtime: Runtime) =>
  Layer.succeed(
    RuntimeService,
    RuntimeService.of({
      runtime,
      start: runtime.startEffect,
      inspect: runtime.inspectEffect,
      inspectRetainedWork: runtime.inspectRetainedWorkEffect,
      reconcile: runtime.reconcileEffect,
    }),
  );
