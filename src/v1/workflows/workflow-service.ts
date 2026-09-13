import { EventStore } from '../events/event-store.js';
import { requireControlActor } from '../controllers/controller-store.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { canonicalJson, payloadDigest } from '../database.js';
import {
  BriefContentSchema,
  BriefIdSchema,
  ControlIntentIdSchema,
  ControlOperationSchema,
  JobIdSchema,
  StepRunIdSchema,
  TimestampSchema,
  TransitionRequestIdSchema,
  TransitionRequestSchema,
  WorkflowIdSchema,
  WorkflowLimitsSchema,
  WorkflowPackageSnapshotSchema,
  OriginalRequestSchema,
  type WorkflowId,
  type TransitionDecision,
  type ControlIntent,
} from '../model.js';
import {
  StoreError,
  type Store,
  type SessionIdentity,
  type ReviseBriefInput,
  type RequestTransitionInput,
  type ControlWorkflowInput,
  type ResumeWorkflowInput,
  type ExtendLimitsInput,
} from '../store.js';
import { validateTransition } from './reducer.js';

export type ActivateWorkflowInput = Omit<ResumeWorkflowInput, 'decision'>;
const fresh = (kind: string) => `${kind}_${randomUUID()}`;
const active = "('pending','launching','running','stopping','unconfirmed')";

export function assertWorkflowActor(db: DatabaseSync, store: Store, actor: SessionIdentity): void {
  requireControlActor(store, db, actor);
}
function exact(store: Store, input: ActivateWorkflowInput) {
  const w = store.getWorkflow(input.workflowId);
  if (
    w.revision !== input.expectedWorkflowRevision ||
    w.briefRevision !== input.expectedBriefRevision ||
    w.controlRevision !== input.expectedControlRevision
  )
    throw new StoreError('stale-revision', 'Workflow revisions changed');
  return w;
}
export function refreshSchedule(store: Store, workflowId: WorkflowId, now: string): void {
  store.transaction((db) => {
    db.prepare(
      "UPDATE workflow_schedule_intents SET state='superseded' WHERE workflow_id=? AND state='pending'",
    ).run(workflowId);
    db.prepare(
      `INSERT OR IGNORE INTO workflow_schedule_intents(id,project_id,workflow_id,step_run_id,workflow_revision,brief_revision,control_revision,limits_revision,state,created_at)
 SELECT ?,project_id,id,current_step_run_id,revision,brief_revision,control_revision,limits_revision,'pending',? FROM workflow_runs
 WHERE id=? AND project_id=? AND activated=1 AND phase='running' AND EXISTS(SELECT 1 FROM step_runs s WHERE s.id=current_step_run_id AND s.phase='pending')`,
    ).run(fresh('schedule'), now, workflowId, store.project.id);
    const workflow = store.getWorkflow(workflowId);
    new EventStore(store).append({
      kind: 'workflow.changed',
      aggregate: { kind: 'workflow', id: workflowId, revision: workflow.revision },
      payload: {
        workflowId,
        phase: workflow.phase,
        briefRevision: workflow.briefRevision,
        controlRevision: workflow.controlRevision,
      },
      dedupeKey: `workflow.changed/${workflowId}/${workflow.revision}`,
    });
  });
}
export function activateWorkflow(store: Store, input: ActivateWorkflowInput, now: string) {
  store.idempotent('activate-workflow', input.idempotencyKey, input, WorkflowIdSchema, (db) => {
    assertWorkflowActor(db, store, input.actor);
    const w = exact(store, input);
    if (w.phase !== 'running')
      throw new StoreError('invalid-state', 'Only running workflows can activate');
    db.prepare('UPDATE workflow_runs SET activated=1 WHERE id=?').run(w.id);
    refreshSchedule(store, w.id, now);
    return w.id;
  });
  return store.getWorkflow(input.workflowId);
}
export function requestTransition(
  store: Store,
  input: RequestTransitionInput,
  now: string,
): TransitionDecision {
  const request = TransitionRequestSchema.parse(input.request);
  const receipt = store.idempotent(
    'workflow-transition',
    request.idempotencyKey,
    { actor: input.actor, request },
    z.object({
      requestId: TransitionRequestIdSchema,
      workflowId: WorkflowIdSchema,
      workflowRevision: z.number(),
      stepId: StepRunIdSchema.nullable(),
    }),
    (db) => {
      assertWorkflowActor(db, store, input.actor);
      const w = store.getWorkflow(request.workflowId);
      const step = store.getStepRun(request.sourceStepRunId);
      validateTransition(w, step, request);
      const stoppedAncestor = db
        .prepare(
          `WITH RECURSIVE a(id,parent_workflow_id,phase,deadline_at) AS(SELECT id,parent_workflow_id,phase,deadline_at FROM workflow_runs WHERE id=? UNION ALL SELECT w.id,w.parent_workflow_id,w.phase,w.deadline_at FROM workflow_runs w JOIN a ON w.id=a.parent_workflow_id) SELECT 1 FROM a WHERE phase<>'running' OR deadline_at<=?`,
        )
        .get(w.id, now);
      if (stoppedAncestor)
        throw new StoreError('limit-exhausted', 'Workflow or ancestor stopped or deadline expired');
      if (
        db
          .prepare(`SELECT 1 FROM attempts WHERE workflow_id=? AND phase IN ${active} LIMIT 1`)
          .get(w.id)
      )
        throw new StoreError('invalid-state', 'Unsettled attempts prevent transition');
      const ids = [
        ...new Set([
          ...request.evidenceResultIds,
          ...(request.kind === 'await-decision'
            ? [request.artifact]
            : request.kind === 'finish'
              ? request.result.outcome === 'succeeded'
                ? request.result.resultIds
                : request.result.retainedResultIds
              : []),
        ]),
      ];
      if (
        ['advance', 'repeat', 'finish', 'await-decision'].includes(request.kind) &&
        ids.length === 0
      )
        throw new StoreError('invalid-transition', 'Transition requires durable result evidence');
      if (
        ids.length > 0 &&
        !ids.some((id) =>
          db
            .prepare(
              'SELECT 1 FROM results r JOIN attempts a ON a.id=r.attempt_id WHERE r.id=? AND a.step_run_id=?',
            )
            .get(id, step.id),
        )
      ) {
        throw new StoreError(
          'invalid-transition',
          'Transition requires evidence from its source step',
        );
      }
      for (const id of ids) {
        const evidence = db
          .prepare(
            `SELECT r.id,a.workflow_id,v.state,r.brief_revision,ac.decision FROM results r JOIN attempts a ON a.id=r.attempt_id JOIN result_validity v ON v.result_id=r.id LEFT JOIN result_acceptances ac ON ac.result_id=r.id AND ac.brief_id=r.brief_id WHERE r.project_id=? AND r.id=?`,
          )
          .get(store.project.id, id);
        if (
          !evidence ||
          evidence.workflow_id !== w.id ||
          evidence.state !== 'eligible' ||
          evidence.brief_revision !== w.briefRevision
        )
          throw new StoreError(
            'result-stale',
            'Evidence is missing, stale, or belongs to another workflow',
          );
        if (
          (request.kind === 'advance' ||
            (request.kind === 'finish' && request.result.outcome === 'succeeded')) &&
          evidence.decision !== 'accepted'
        )
          throw new StoreError('invalid-transition', 'Advancement requires accepted evidence');
      }
      if (request.kind === 'repeat') {
        if (
          !ids.some((id) =>
            db
              .prepare(
                `SELECT 1 FROM result_acceptances ac
                 JOIN results r ON r.id=ac.result_id
                 JOIN attempts a ON a.id=r.attempt_id
                 WHERE ac.result_id=? AND ac.decision='rejected'
                   AND json_array_length(ac.issues_json)>0 AND a.step_run_id=?`,
              )
              .get(id, step.id),
          )
        )
          throw new StoreError(
            'invalid-transition',
            'Repair requires a rejected result with explicit issues',
          );
        const ancestors = db
          .prepare(
            `WITH RECURSIVE a(id,parent_workflow_id,max_repeats,deadline_at) AS (SELECT id,parent_workflow_id,max_repeats,deadline_at FROM workflow_runs WHERE id=? UNION ALL SELECT w.id,w.parent_workflow_id,w.max_repeats,w.deadline_at FROM workflow_runs w JOIN a ON w.id=a.parent_workflow_id) SELECT * FROM a`,
          )
          .all(w.id);
        for (const ancestor of ancestors) {
          const count = db
            .prepare(
              `WITH RECURSIVE d(id) AS (SELECT id FROM workflow_runs WHERE id=? UNION ALL SELECT w.id FROM workflow_runs w JOIN d ON w.parent_workflow_id=d.id) SELECT count(*) AS n FROM workflow_repair_cycles r JOIN d ON d.id=r.workflow_id`,
            )
            .get(ancestor.id);
          if (
            Number(count?.n) >= Number(ancestor.max_repeats) ||
            String(ancestor.deadline_at) <= now
          )
            throw new StoreError('limit-exhausted', 'Ancestor repair limit or deadline exhausted');
        }
      }
      let routedStep: string | null = null;
      if (request.kind === 'route' && request.target.kind === 'method') {
        const method = request.target.method;
        const candidates = w.package.steps.filter(
          (s) => s.permittedMethods.includes(method) && s.name !== step.stepName,
        );
        if (candidates.length !== 1)
          throw new StoreError(
            'invalid-transition',
            'Method route must identify exactly one other package step',
          );
        const candidate = candidates[0];
        if (!candidate) throw new StoreError('invalid-transition', 'Route target missing');
        if (w.boundary === 'design-only' && candidate.phase === 'implementation')
          throw new StoreError('invalid-transition', 'Route violates design-only boundary');
        routedStep = candidate.name;
      }
      if (request.kind === 'route' && request.target.kind === 'child-workflow') {
        const candidates = db
          .prepare('SELECT snapshot_json FROM workflow_packages WHERE project_id=? AND name=?')
          .all(store.project.id, request.target.packageName);
        if (candidates.length !== 1)
          throw new StoreError(
            'invalid-transition',
            'Child route requires exactly one stored package version',
          );
        const candidate = candidates[0];
        if (!candidate) throw new StoreError('invalid-transition', 'Child package missing');
        const pkg = WorkflowPackageSnapshotSchema.parse(
          JSON.parse(z.string().parse(candidate.snapshot_json)),
        );
        const root = store.getJob(step.jobId);
        const requestRow = db
          .prepare('SELECT request_json FROM job_requests WHERE id=?')
          .get(root.requestId);
        const original = OriginalRequestSchema.parse(
          JSON.parse(z.string().parse(requestRow?.request_json)),
        );
        const child = store.createWorkflow({
          actor: input.actor,
          stableKey: `child:${w.id}:${request.idempotencyKey}`,
          package: pkg,
          request: original,
          brief: store.getBrief(root.id, root.currentBriefRevision).content,
          workspaceId: root.workspaceId,
          delivery: root.delivery,
          boundary: w.boundary,
          idempotencyKey: `route:${request.idempotencyKey}`,
        });
        db.prepare('UPDATE workflow_runs SET parent_workflow_id=? WHERE id=?').run(w.id, child.id);
        db.prepare("UPDATE step_runs SET phase='blocked',updated_at=? WHERE id=?").run(
          now,
          step.id,
        );
      }

      const requestId = TransitionRequestIdSchema.parse(fresh('transition'));
      let stepId: ReturnType<typeof StepRunIdSchema.parse> | null = null;
      if (request.kind === 'advance' || request.kind === 'repeat' || routedStep !== null) {
        const targetName =
          request.kind === 'advance' || request.kind === 'repeat' ? request.targetStep : routedStep;
        const target = w.package.steps.find((s) => s.name === targetName);
        if (!target) throw new StoreError('invalid-transition', 'Unknown target');
        stepId = StepRunIdSchema.parse(fresh('step'));
        const jobId = JobIdSchema.parse(fresh('job'));
        const briefId = BriefIdSchema.parse(fresh('brief'));
        const prior = store.getJob(step.jobId);
        const brief = store.getBrief(prior.id, prior.currentBriefRevision);
        db.prepare(
          `INSERT INTO jobs(id,project_id,stable_key,request_id,current_brief_id,current_brief_revision,workspace_id,delivery_kind,origin_kind,origin_workflow_id,origin_step_run_id,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?, 'workflow',?,?,'open',?,?)`,
        ).run(
          jobId,
          store.project.id,
          `${w.id}:${step.ordinal + 1}`,
          prior.requestId,
          briefId,
          w.briefRevision,
          prior.workspaceId,
          prior.delivery,
          w.id,
          stepId,
          now,
          now,
        );
        db.prepare(
          'INSERT INTO brief_revisions(id,project_id,job_id,revision,prior_brief_id,content_json,change_reason,created_at) VALUES(?,?,?,?,NULL,?,?,?)',
        ).run(
          briefId,
          store.project.id,
          jobId,
          w.briefRevision,
          canonicalJson(brief.content),
          request.reason,
          now,
        );
        db.prepare(
          `INSERT INTO step_runs(id,project_id,workflow_id,job_id,step_name,step_phase,ordinal,phase,input_workflow_revision,input_brief_revision,source_transition_request_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'pending',?,?,?,?,?)`,
        ).run(
          stepId,
          store.project.id,
          w.id,
          jobId,
          target.name,
          target.phase,
          step.ordinal + 1,
          w.revision + 1,
          w.briefRevision,
          requestId,
          now,
          now,
        );
        db.prepare(
          'INSERT INTO job_dependencies(job_id,depends_on_job_id,created_at) VALUES(?,?,?)',
        ).run(jobId, prior.id, now);
        ids.forEach((id, i) =>
          db
            .prepare(
              'INSERT INTO step_run_inputs(step_run_id,brief_id,result_id,ordinal) VALUES(?,?,?,?)',
            )
            .run(stepId, briefId, id, i),
        );
        db.prepare("UPDATE step_runs SET phase='closed',updated_at=? WHERE id=?").run(now, step.id);
        db.prepare('UPDATE workflow_runs SET current_step_run_id=? WHERE id=?').run(stepId, w.id);
      }
      db.prepare(
        'INSERT INTO transition_requests(id,project_id,workflow_id,source_step_run_id,kind,expected_workflow_revision,expected_brief_revision,expected_control_revision,payload_json,payload_digest,created_step_run_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
        requestId,
        store.project.id,
        w.id,
        step.id,
        request.kind,
        w.revision,
        w.briefRevision,
        w.controlRevision,
        canonicalJson(request),
        payloadDigest(request),
        stepId,
        now,
      );
      if (request.kind === 'repeat')
        db.prepare('INSERT INTO workflow_repair_cycles VALUES(?,?,?,?,?,?,?)').run(
          fresh('repair'),
          store.project.id,
          w.id,
          requestId,
          canonicalJson(ids),
          stepId,
          now,
        );
      if (request.kind === 'block' || request.kind === 'await-decision')
        db.prepare('UPDATE step_runs SET phase=?,updated_at=? WHERE id=?').run(
          request.kind === 'block' ? 'blocked' : 'awaiting-decision',
          now,
          step.id,
        );
      if (request.kind === 'finish') {
        db.prepare("UPDATE workflow_runs SET phase='finished',outcome=? WHERE id=?").run(
          request.result.outcome,
          w.id,
        );
        db.prepare('UPDATE step_runs SET phase=?,updated_at=? WHERE id=?').run(
          request.result.outcome === 'succeeded' ? 'succeeded' : 'failed',
          now,
          step.id,
        );
      }
      db.prepare('UPDATE workflow_runs SET revision=revision+1,updated_at=? WHERE id=?').run(
        now,
        w.id,
      );
      db.prepare('INSERT INTO workflow_transition_decisions VALUES(?,?,?,?,?,?)').run(
        requestId,
        store.project.id,
        w.revision + 1,
        input.actor.id,
        input.actor.generation,
        now,
      );
      refreshSchedule(store, w.id, now);
      return { requestId, workflowId: w.id, workflowRevision: w.revision + 1, stepId };
    },
  );
  return {
    ...receipt.value,
    createdStepRun: receipt.value.stepId === null ? null : store.getStepRun(receipt.value.stepId),
    replayed: receipt.replayed,
  };
}
export function controlWorkflow(
  store: Store,
  input: ControlWorkflowInput,
  now: string,
): ControlIntent {
  const operation = ControlOperationSchema.parse(input.operation);
  const receipt = store.idempotent(
    'workflow-control',
    input.idempotencyKey,
    input,
    z.object({
      id: ControlIntentIdSchema,
      workflowId: WorkflowIdSchema,
      controlRevision: z.number(),
      affectedWorkflowIds: z.array(WorkflowIdSchema),
      affectedAttemptIds: z.array(z.string()),
      createdAt: TimestampSchema,
    }),
    (db) => {
      assertWorkflowActor(db, store, input.actor);
      const w = store.getWorkflow(input.workflowId);
      if (
        w.revision !== input.expectedWorkflowRevision ||
        w.controlRevision !== input.expectedControlRevision
      )
        throw new StoreError('stale-revision', 'Control revisions changed');
      if (w.phase === 'finished' || w.phase === 'cancelled' || w.phase === 'cancelling')
        throw new StoreError(
          'invalid-state',
          'Terminal or cancelling workflow cannot be controlled again',
        );
      const affected = db
        .prepare(
          `WITH RECURSIVE d(id) AS (SELECT id FROM workflow_runs WHERE id=? UNION ALL SELECT w.id FROM workflow_runs w JOIN d ON w.parent_workflow_id=d.id) SELECT id FROM d`,
        )
        .all(w.id)
        .map((row) => WorkflowIdSchema.parse(row.id));
      const id = ControlIntentIdSchema.parse(fresh('control'));
      const attempts: string[] = [];
      db.prepare('INSERT INTO control_intents VALUES(?,?,?,?,?,?,?,?)').run(
        id,
        store.project.id,
        w.id,
        operation.kind,
        operation.kind === 'pause' ? operation.mode : null,
        w.controlRevision + 1,
        payloadDigest(input),
        now,
      );
      for (const workflowId of affected) {
        db.prepare(
          'INSERT INTO control_workflows(control_intent_id,workflow_id,expected_control_revision) SELECT ?,id,control_revision+1 FROM workflow_runs WHERE id=?',
        ).run(id, workflowId);
        db.prepare(
          "UPDATE workflow_runs SET phase=?,control_revision=control_revision+1,revision=revision+1,updated_at=? WHERE id=? AND phase NOT IN ('finished','cancelled')",
        ).run(operation.kind === 'cancel' ? 'cancelling' : 'pausing', now, workflowId);
        db.prepare(
          "UPDATE workflow_schedule_intents SET state='superseded' WHERE workflow_id=? AND state='pending'",
        ).run(workflowId);
        for (const a of db
          .prepare(`SELECT id,phase FROM attempts WHERE workflow_id=? AND phase IN ${active}`)
          .all(workflowId)) {
          const attemptId = z.string().parse(a.id);
          attempts.push(attemptId);
          // Pending admission has no launch claim, so closing it is a confirmed local effect.
          const pending = a.phase === 'pending';
          db.prepare('INSERT INTO attempt_control_intents VALUES(?,?,?,?,?,?,?,?,?)').run(
            fresh('attempt_control'),
            store.project.id,
            attemptId,
            'workflow-control',
            id,
            operation.kind === 'cancel' ? 'cancel' : operation.mode,
            pending ? 'confirmed' : 'requested',
            now,
            pending ? now : null,
          );
          if (pending) {
            db.prepare(
              "UPDATE attempts SET phase='closed',settled_at=?,settlement_reason='Closed before native launch' WHERE id=?",
            ).run(now, attemptId);
            db.prepare(
              "UPDATE execution_reservations SET state='released',released_at=?,release_reason='Closed before native launch' WHERE attempt_id=?",
            ).run(now, attemptId);
          }
        }
      }
      for (const workflowId of [...affected].reverse()) {
        const unsettled = db
          .prepare(
            `WITH RECURSIVE d(id) AS (SELECT id FROM workflow_runs WHERE id=? UNION ALL SELECT w.id FROM workflow_runs w JOIN d ON w.parent_workflow_id=d.id) SELECT 1 FROM attempts a JOIN d ON a.workflow_id=d.id WHERE a.phase IN ${active} LIMIT 1`,
          )
          .get(workflowId);
        if (!unsettled)
          db.prepare(
            "UPDATE workflow_runs SET phase=? WHERE id=? AND phase IN ('pausing','cancelling')",
          ).run(operation.kind === 'cancel' ? 'cancelled' : 'paused', workflowId);
      }
      new EventStore(store).append({
        kind: `workflow.${operation.kind}`,
        aggregate: { kind: 'workflow', id: w.id, revision: w.revision + 1 },
        payload: { workflowId: w.id, controlIntentId: id, affectedWorkflowIds: affected },
        dedupeKey: `workflow.control/${id}`,
      });
      return {
        id,
        workflowId: w.id,
        controlRevision: w.controlRevision + 1,
        affectedWorkflowIds: affected,
        affectedAttemptIds: attempts,
        createdAt: TimestampSchema.parse(now),
      };
    },
  );
  return {
    ...receipt.value,
    affectedAttemptIds: receipt.value.affectedAttemptIds.map((id) =>
      z.string().brand<'AttemptId'>().parse(id),
    ),
    operation,
    replayed: receipt.replayed,
  };
}
export function resumeWorkflow(store: Store, input: ResumeWorkflowInput, now: string) {
  store.idempotent('workflow-resume', input.idempotencyKey, input, WorkflowIdSchema, (db) => {
    assertWorkflowActor(db, store, input.actor);
    const w = exact(store, input);
    if (w.phase !== 'paused')
      throw new StoreError('invalid-state', 'Only confirmed paused workflows can resume');
    const parent = db
      .prepare(
        `WITH RECURSIVE a(id,parent_workflow_id,phase) AS(SELECT id,parent_workflow_id,phase FROM workflow_runs WHERE id=? UNION ALL SELECT w.id,w.parent_workflow_id,w.phase FROM workflow_runs w JOIN a ON a.parent_workflow_id=w.id) SELECT 1 FROM a WHERE id<>? AND phase<>'running'`,
      )
      .get(w.id, w.id);
    if (parent) throw new StoreError('invalid-state', 'Ancestor is not running');
    if (w.deadlineAt <= now)
      throw new StoreError('limit-exhausted', 'Extend deadline before resume');
    const pause = db
      .prepare(
        `SELECT ci.id FROM control_intents ci JOIN control_workflows cw ON cw.control_intent_id=ci.id
         WHERE cw.workflow_id=? AND ci.kind='pause' AND cw.expected_control_revision=?
         ORDER BY ci.created_at DESC,ci.id DESC LIMIT 1`,
      )
      .get(w.id, w.controlRevision);
    if (!pause)
      throw new StoreError('invalid-state', 'Paused workflow has no matching control closure');
    const resumable = db
      .prepare(
        `WITH RECURSIVE d(id) AS (
           SELECT id FROM workflow_runs WHERE id=?
           UNION ALL SELECT child.id FROM workflow_runs child JOIN d ON child.parent_workflow_id=d.id
         )
         SELECT wr.id,wr.revision,wr.brief_revision
         FROM workflow_runs wr JOIN d ON d.id=wr.id
         JOIN control_workflows cw ON cw.workflow_id=wr.id AND cw.control_intent_id=?
         WHERE wr.phase='paused' AND wr.control_revision=cw.expected_control_revision
         ORDER BY wr.created_at,wr.id`,
      )
      .all(w.id, pause.id)
      .map((row) =>
        z
          .object({ id: WorkflowIdSchema, revision: z.number(), brief_revision: z.number() })
          .parse(row),
      );
    for (const workflow of resumable) {
      db.prepare(
        "UPDATE workflow_runs SET phase='running',revision=revision+1,control_revision=control_revision+1,updated_at=? WHERE id=?",
      ).run(now, workflow.id);
      const current = store.getWorkflow(workflow.id);
      db.prepare(
        "UPDATE step_runs SET phase='pending',input_workflow_revision=?,input_brief_revision=?,updated_at=? WHERE id=? AND phase IN ('active','pending','stale')",
      ).run(current.revision, current.briefRevision, now, current.currentStepRunId);
      refreshSchedule(store, workflow.id, now);
    }
    return w.id;
  });
  return store.getWorkflow(input.workflowId);
}
export function extendLimits(store: Store, input: ExtendLimitsInput, now: string) {
  const limits = WorkflowLimitsSchema.parse(input.limits);
  const deadline = TimestampSchema.parse(input.deadlineAt);
  store.idempotent(
    'workflow-extend-limits',
    input.idempotencyKey,
    input,
    WorkflowIdSchema,
    (db) => {
      requireControlActor(store, db, input.actor, true);
      const w = store.getWorkflow(input.workflowId);
      const row = db.prepare('SELECT limits_revision FROM workflow_runs WHERE id=?').get(w.id);
      if (row?.limits_revision !== input.expectedLimitsRevision)
        throw new StoreError('stale-revision', 'Limits revision changed');
      if (
        !input.reason.trim() ||
        deadline <= now ||
        limits.maxAttempts < w.limits.maxAttempts ||
        limits.maxRepeats < w.limits.maxRepeats ||
        limits.parallelism < w.limits.parallelism ||
        limits.innerLoopDeadlineMs < w.limits.innerLoopDeadlineMs ||
        deadline < w.deadlineAt
      )
        throw new StoreError(
          'invalid-state',
          'Limit extension must be monotonic with a future deadline and reason',
        );
      db.prepare('INSERT INTO limit_revisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        fresh('limits'),
        store.project.id,
        w.id,
        input.expectedLimitsRevision + 1,
        limits.maxAttempts,
        limits.maxRepeats,
        limits.parallelism,
        limits.innerLoopDeadlineMs,
        deadline,
        input.reason,
        input.actor.id,
        input.actor.generation,
        now,
      );
      db.prepare(
        'UPDATE workflow_runs SET limits_revision=limits_revision+1,revision=revision+1,max_attempts=?,max_repeats=?,parallelism=?,inner_loop_deadline_ms=?,deadline_at=?,updated_at=? WHERE id=?',
      ).run(
        limits.maxAttempts,
        limits.maxRepeats,
        limits.parallelism,
        limits.innerLoopDeadlineMs,
        deadline,
        now,
        w.id,
      );
      refreshSchedule(store, w.id, now);
      return w.id;
    },
  );
  return store.getWorkflow(input.workflowId);
}
export function reviseBrief(store: Store, input: ReviseBriefInput, now: string) {
  const brief = BriefContentSchema.parse(input.brief);
  const receipt = store.idempotent(
    'revise-brief',
    input.idempotencyKey,
    input,
    z.number().int().positive(),
    (db) => {
      assertWorkflowActor(db, store, input.actor);
      const job = store.getJob(input.jobId);
      if (job.currentBriefRevision !== input.expectedBriefRevision)
        throw new StoreError('stale-revision', 'Brief revision changed');
      if (!input.changeReason.trim())
        throw new StoreError('invalid-state', 'Brief change reason required');
      const briefId = BriefIdSchema.parse(fresh('brief'));
      const revision = job.currentBriefRevision + 1;
      db.prepare('INSERT INTO brief_revisions VALUES(?,?,?,?,?,?,?,?)').run(
        briefId,
        store.project.id,
        job.id,
        revision,
        job.currentBriefId,
        canonicalJson(brief),
        input.changeReason,
        now,
      );
      db.prepare('INSERT INTO workflow_brief_revision_causes VALUES(?,?,?,?,?)').run(
        briefId,
        input.actor.id,
        input.actor.generation,
        input.changeReason,
        now,
      );
      const affected = db
        .prepare(
          `WITH RECURSIVE d(id) AS(SELECT ? UNION SELECT j.job_id FROM job_dependencies j JOIN d ON j.depends_on_job_id=d.id) SELECT id FROM d`,
        )
        .all(job.id);
      const touched = new Set<WorkflowId>();
      for (const row of affected) {
        const id = JobIdSchema.parse(row.id);
        db.prepare('INSERT INTO brief_impacts VALUES(?,?)').run(briefId, id);
        db.prepare(
          "UPDATE result_validity SET state='stale',stale_by_brief_id=?,reason=?,updated_at=? WHERE result_id IN (SELECT id FROM results WHERE job_id=?)",
        ).run(briefId, input.changeReason, now, id);
        db.prepare(
          `INSERT INTO attempt_control_intents(id,project_id,attempt_id,cause_kind,cause_id,operation,state,created_at,settled_at) SELECT 'brief_control_'||id||'_'||?,project_id,id,'brief-revision',?,'supersede','requested',?,NULL FROM attempts WHERE job_id=? AND phase IN ${active}`,
        ).run(briefId, briefId, now, id);
        const affectedJob = store.getJob(id);
        if (affectedJob.origin.kind === 'workflow') {
          const workflowId = affectedJob.origin.workflowId;
          if (touched.has(workflowId)) continue;
          touched.add(workflowId);
          db.prepare(
            'UPDATE workflow_runs SET brief_revision=brief_revision+1,revision=revision+1,updated_at=? WHERE id=?',
          ).run(now, workflowId);
          db.prepare(
            "UPDATE step_runs SET phase='pending',input_brief_revision=input_brief_revision+1,updated_at=? WHERE workflow_id=? AND phase IN ('pending','active','blocked','awaiting-decision')",
          ).run(now, workflowId);
          db.prepare(
            "UPDATE workflow_schedule_intents SET state='superseded' WHERE workflow_id=? AND state='pending'",
          ).run(workflowId);
        }
      }
      for (const row of affected) {
        const id = JobIdSchema.parse(row.id);
        if (id === job.id) continue;
        const previous = store.getJob(id);
        const previousBrief = store.getBrief(id, previous.currentBriefRevision);
        const derived = BriefIdSchema.parse(fresh('brief'));
        db.prepare('INSERT INTO brief_revisions VALUES(?,?,?,?,?,?,?,?)').run(
          derived,
          store.project.id,
          id,
          previous.currentBriefRevision + 1,
          previous.currentBriefId,
          canonicalJson(previousBrief.content),
          input.changeReason,
          now,
        );
        db.prepare(
          'UPDATE jobs SET current_brief_id=?,current_brief_revision=current_brief_revision+1,updated_at=? WHERE id=?',
        ).run(derived, now, id);
      }
      db.prepare(
        'UPDATE jobs SET current_brief_id=?,current_brief_revision=?,updated_at=? WHERE id=?',
      ).run(briefId, revision, now, job.id);
      for (const workflowId of touched) refreshSchedule(store, workflowId, now);
      return revision;
    },
  );
  return store.getBrief(input.jobId, receipt.value);
}
