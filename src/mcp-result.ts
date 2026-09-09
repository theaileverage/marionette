import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Effect } from 'effect';
import { AppError } from './types.js';

/** Keep the legacy success text, but make both outcomes explicit and errors JSON-readable. */
export const mcpResult = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.match({
        onSuccess: (result): CallToolResult => ({
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: { ok: true, result },
        }),
        onFailure: (error): CallToolResult => {
          const failure = {
            ok: false,
            error: {
              code: error instanceof AppError ? error.code : 'transport_error',
              message: error instanceof AppError ? error.message : String(error),
            },
          };
          return {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify(failure) }],
            structuredContent: failure,
          };
        },
      }),
    ),
  );
