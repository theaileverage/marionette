import { Config, Effect, Redacted, Schema } from 'effect';
import { boundaryError, BoundaryError } from './effect-runtime.js';
import { callUrlEffect } from './http-client.js';
import { AppError } from './types.js';

export const workerRequestEffect = Effect.fn('Worker.request')(
  function* (mode: 'worker-call' | 'worker-report', input: Schema.MutableJson) {
    const url = yield* Config.string('MARIONETTE_URL');
    const taskId = yield* Config.string('MARIONETTE_TASK_ID');
    const token = yield* Config.redacted('MARIONETTE_WORKER_TOKEN');
    return yield* callUrlEffect(
      `${url}/api/worker/${encodeURIComponent(taskId)}${mode === 'worker-call' ? '/call' : ''}`,
      Redacted.value(token),
      input,
      10000,
    ).pipe(
      Effect.mapError((error) =>
        error instanceof BoundaryError
          ? new AppError({
              code: 'worker_transport',
              status: 503,
              message:
                `Cannot reach the Marionette worker endpoint at ${url}. ` +
                'This does not prove the supervisor is down: a sandbox can block loopback networking. ' +
                'Prefer the marionette_worker MCP tools. If using the CLI, request normal network permission ' +
                '(Codex exec_command: sandbox_permissions="require_escalated") for the exact command. ' +
                'Do not repeat the same sandboxed call, disable the sandbox, or change project settings. ' +
                'Inspection is safe to retry; after an uncertain report or mutation, inspect the current ' +
                'task/receipt before sending it again. If permission is denied, retain the report and tell the lead.',
            })
          : error,
      ),
    );
  },
  (effect) => effect.pipe(Effect.mapError(boundaryError('Worker.report'))),
);
