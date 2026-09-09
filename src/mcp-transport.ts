import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Effect, Latch } from 'effect';
import { sdk } from './effect-runtime.js';

export const serveMcpEffect = Effect.fn('Mcp.serve')(function* (server: McpServer) {
  const closed = yield* Latch.make();
  server.server.onclose = () => closed.openUnsafe();
  yield* Effect.acquireRelease(
    sdk('Mcp.connect', () => server.connect(new StdioServerTransport())),
    () => sdk('Mcp.close', () => server.close()).pipe(Effect.orDie),
  );
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const stop = () => closed.openUnsafe();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      return stop;
    }),
    (stop) =>
      Effect.sync(() => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
      }),
  );
  yield* closed.await;
}, Effect.scoped);
