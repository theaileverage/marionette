import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ControllerInbox } from '../inbox/controller-inbox.js';
import { ControllerRuntime } from '../controllers/controller-runtime.js';
import { ControllerStore } from '../controllers/controller-store.js';
import { EventStore } from '../events/event-store.js';
import { ResultIdSchema, AttemptIdSchema, type AttemptId, type WorkflowId } from '../model.js';
import type { Runtime } from '../runtime.js';
import { Settings } from '../settings.js';
import type { AgentSession, SessionIdentity, Store } from '../store.js';
import { Watcher } from '../watcher.js';
import { NativeBoardDelivery } from '../delivery.js';
import { currentProcessIdentity, localOwnerLiveness } from '../background.js';
import { dueSchedules, requestExpiredDeadlines } from '../workflows/scheduler.js';
import { ServiceControls } from './controls.js';
import { runProjectService } from './project-service.js';
import { RecoveryRegistry } from './recovery.js';

const scheduleBindingSchema = z
  .object({
    profile: z.string(),
    nativeWorkspaceId: z.string(),
    routeDecisionId: z.string(),
  })
  .strict();

export type ServiceRuntimeOptions = {
  store: Store;
  runtime: Runtime;
  actor: SessionIdentity;
  bindingPath: string;
  authenticate: () => AgentSession;
  pumpHierarchy: () => void;
  withWorkflowControlAuthority: <T>(
    workflowId: WorkflowId | null,
    input: { attemptId: AttemptId; controlIntentId: string },
    effect: () => T,
  ) => T;
  signal: AbortSignal;
  watchdogMs?: number;
};

export async function runServiceRuntime(options: ServiceRuntimeOptions) {
  const { store, runtime, actor } = options;
  const session = options.authenticate();
  if (session.role !== 'user') throw new Error('Project service requires the local user context');

  let watcher: Watcher | undefined;
  let attemptOffset = 0;
  let controls: ServiceControls | undefined;
  const recovery = new RecoveryRegistry().register('native_attempts', async (record) => {
    await runtime.reconcile(AttemptIdSchema.parse(record.id));
  });
  const reportBlocked = (kind: string, id: string, error: Error) =>
    new EventStore(store).append({
      kind: 'service.blocked',
      aggregate: { kind, id, revision: 1 },
      payload: { reason: error.message },
      dedupeKey: `service-blocked/${kind}/${id}/${createHash('sha256').update(error.message).digest('hex')}`,
    });

  try {
    await runProjectService({
      store,
      processIdentity: await currentProcessIdentity(),
      livenessPort: localOwnerLiveness,
      signal: options.signal,
      watchdogMs: options.watchdogMs,
      recover: async (owner) => {
        controls = new ServiceControls(
          owner,
          actor,
          undefined,
          options.withWorkflowControlAuthority,
        );
        new ControllerInbox(store).recoverClaims(owner.generation);
        await recovery.recover(owner);
        watcher = await Watcher.start({
          store,
          deliveryPort: new NativeBoardDelivery(store),
          livenessPort: localOwnerLiveness,
          processIdentity: owner.processIdentity,
        });
      },
      scan: async (owner) => {
        options.authenticate();
        store.transaction((db) => {
          owner.assertCurrent(db);
          requestExpiredDeadlines(store, new Date().toISOString());
        });

        for (const schedule of dueSchedules(store).slice(0, 20)) {
          if (options.signal.aborted) break;
          try {
            const workflow = store.getWorkflow(schedule.workflow_id);
            const step = store.getStepRun(schedule.step_run_id);
            if (!step.jobId) throw new Error('Scheduled step has no runnable job');
            if (!workflow.package.steps.some((value) => value.name === step.stepName))
              throw new Error('Scheduled step is absent from the pinned workflow package');
            const configured = new Settings(store, actor).get(
              `schedule/${workflow.id}/${step.stepName}`,
              scheduleBindingSchema,
            );
            if (!configured)
              throw new Error(
                `No execution route is bound for workflow ${workflow.id} step ${step.stepName}`,
              );
            const job = store.getJob(step.jobId);
            const inputResultIds = store.read((db) =>
              db
                .prepare(
                  'SELECT result_id FROM step_run_inputs WHERE step_run_id=? AND result_id IS NOT NULL ORDER BY ordinal',
                )
                .all(schedule.step_run_id)
                .map((row) => ResultIdSchema.parse(row.result_id)),
            );
            store.transaction((db) => {
              owner.assertCurrent(db);
              runtime.admit({
                ...configured.value,
                jobId: job.id,
                inputResultIds,
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

        try {
          if (!controls) throw new Error('Service controls were not initialized during recovery');
          await controls.scan();
        } catch (error) {
          reportBlocked(
            'controls',
            owner.generation,
            error instanceof Error ? error : new Error(String(error)),
          );
        }

        const active = runtime.activeAttempts();
        const batch = active.length
          ? Array.from(
              { length: Math.min(20, active.length) },
              (_, index) => active[(attemptOffset + index) % active.length]!,
            )
          : [];
        attemptOffset = active.length ? (attemptOffset + batch.length) % active.length : 0;
        for (const id of batch) {
          if (options.signal.aborted) break;
          try {
            store.read((db) => owner.assertCurrent(db));
            await runtime.start(id);
            await runtime.reconcile(id);
          } catch (error) {
            reportBlocked('attempt', id, error instanceof Error ? error : new Error(String(error)));
          }
        }

        if (!options.signal.aborted && watcher) {
          try {
            await watcher.pollOnce();
          } catch (error) {
            reportBlocked(
              'watcher',
              owner.generation,
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        }
        try {
          new EventStore(store).project();
        } catch (error) {
          reportBlocked(
            'event-projector',
            store.project.id,
            error instanceof Error ? error : new Error(String(error)),
          );
        }
        try {
          options.pumpHierarchy();
        } catch (error) {
          reportBlocked(
            'project-relay',
            store.project.id,
            error instanceof Error ? error : new Error(String(error)),
          );
        }

        const controller = new ControllerStore(store).status();
        if (controller?.state === 'idle' && controller.current_generation) {
          try {
            const inbox = new ControllerInbox(store);
            const outstanding = store.read((db) =>
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
              if (claims.length) {
                const runtime = new ControllerRuntime(store, options.bindingPath);
                try {
                  const submitted = await runtime.submit({
                    actor,
                    claims,
                    expectedRevision: Number(controller.state_revision),
                  });
                  if (submitted.kind === 'unsupported')
                    for (const claim of claims)
                      inbox.release({
                        claim,
                        reason: submitted.reason,
                        retryAt: new Date(Date.now() + 5_000).toISOString(),
                        confirmedNotSubmitted: true,
                      });
                } catch (error) {
                  // A row still in `claimed` proves the native journal never accepted the effect.
                  for (const claim of claims) {
                    try {
                      inbox.release({
                        claim,
                        reason: error instanceof Error ? error.message : String(error),
                        retryAt: new Date(Date.now() + 5_000).toISOString(),
                      });
                    } catch {
                      // Submitted rows retain their explicit reconciliation requirement.
                    }
                  }
                  throw error;
                }
              }
            }
          } catch (error) {
            reportBlocked(
              'controller',
              String(controller.id),
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        }
      },
    });
    return { stopped: true };
  } finally {
    watcher?.stop();
  }
}
