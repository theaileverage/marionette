import * as prompts from '@clack/prompts';
import { Effect } from 'effect';
import { sdk } from './effect-runtime.js';
import { AppError } from './types.js';

export { prompts };
export const promptEffect = Effect.fn('CLI.prompt')(function* <T extends string | boolean>(
  ask: (signal: AbortSignal) => Promise<T | symbol>,
) {
  const value = yield* sdk('CLI.prompt', ask);
  if (prompts.isCancel(value)) {
    prompts.cancel('Operation cancelled.', { output: process.stderr });
    return yield* new AppError({
      code: 'operation_cancelled',
      message: 'Operation cancelled.',
      status: 400,
    });
  }
  // SAFETY: Clack resolves only the requested value or its cancellation symbol, handled above.
  return value as T;
});
