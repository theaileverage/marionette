import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Effect, Latch } from 'effect';
import { sdk } from './effect-runtime.js';

export const serveMcpEffect = Effect.fn('Mcp.serve')(function* (server: McpServer) {
  const closed = yield* Latch.make();
  server.server.onclose = () => closed.openUnsafe();
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const stop = () => closed.openUnsafe();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      // The SDK transport does not close itself when its client's pipe ends.
      // Register before connecting so an immediate EOF cannot leave us waiting.
      process.stdin.once('end', stop);
      process.stdin.once('close', stop);
      process.stdin.once('error', stop);
      if (process.stdin.readableEnded || process.stdin.destroyed) stop();
      return stop;
    }),
    (stop) =>
      Effect.sync(() => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        process.stdin.off('end', stop);
        process.stdin.off('close', stop);
        process.stdin.off('error', stop);
      }),
  );
  yield* Effect.acquireRelease(
    sdk('Mcp.connect', () => server.connect(new StdioServerTransport())),
    () => sdk('Mcp.close', () => server.close()).pipe(Effect.orDie),
  );
  yield* closed.await;
}, Effect.scoped);
