import { Effect, Schema } from 'effect';
import { ZodError } from 'zod';
import { AppError } from './types.js';

/** Infrastructure failures retain their original cause and operation at the adapter. */
export class BoundaryError extends Schema.TaggedError<BoundaryError>()('BoundaryError', {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export const boundaryError = (operation: string) => (cause: unknown) =>
  cause instanceof AppError || cause instanceof BoundaryError
    ? cause
    : cause instanceof ZodError || Schema.isSchemaError(cause)
      ? new AppError({ code: 'invalid_input', message: cause.message, status: 400 })
      : new BoundaryError({ operation, message: String(cause), cause });

/** Synchronous SQLite operations must finish before the fiber may yield. */
export const sync = <A>(operation: string, evaluate: () => A) =>
  Effect.try({ try: evaluate, catch: boundaryError(operation) });

/** Published Herdr SDK methods remain Promise based for package compatibility. */
export const sdk = <A>(operation: string, evaluate: (signal: AbortSignal) => PromiseLike<A>) =>
  Effect.tryPromise({ try: evaluate, catch: boundaryError(operation) });

export const herdrCall = Effect.fn('Herdr.call')(
  (
    port: import('./types.js').HerdrPort,
    method: string,
    params?: Parameters<import('./types.js').HerdrPort['call']>[1],
    timeoutMs?: number,
  ) => sdk(`Herdr.${method}`, (signal) => port.call(method, params, timeoutMs, signal)),
);
