import { Context, Effect, Fiber, FiberMap, Latch, Layer, ManagedRuntime, Schema } from 'effect';
import express from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { Application, applicationLayer, RuntimeConfiguration } from './application.js';
import { BoundaryError, sdk, sync } from './effect-runtime.js';
import { Service } from './service.js';
import { Supervisor } from './supervisor.js';
import { AppError } from './types.js';
import { packageRoot } from './runtime.js';
import { SETUP_VERSION, VERSION } from './version.js';

interface ServerHandle {
  app: express.Express;
  server: import('node:http').Server;
  service: Service;
  supervisor: Supervisor;
}
export class HttpServer extends Context.Service<HttpServer, ServerHandle>()(
  'Marionette.HttpServer',
) {}

const serverLayer = (shutdown: () => Promise<void>) =>
  Layer.effect(
    HttpServer,
    Effect.gen(function* () {
      const config = yield* RuntimeConfiguration;
      const application = yield* Application;
      const requests = yield* FiberMap.make<string, unknown, AppError | BoundaryError>();
      const runRequest = yield* FiberMap.runtimePromise(requests)();
      const service = application.core;
      const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
      const cliPath = resolve(projectRoot, 'dist/cli.js');
      const url = `http://127.0.0.1:${config.port}`;
      const supervisor = new Supervisor(service, url, cliPath);
      let stopping = false;
      const app = express();
      app.disable('x-powered-by');
      app.use(express.json({ limit: '128kb' }));
      const validToken = (header?: string) => {
        const supplied = Buffer.from((header ?? '').replace(/^Bearer /, '')),
          expected = Buffer.from(config.token);
        return supplied.length === expected.length && timingSafeEqual(supplied, expected);
      };
      app.use((req, res, next) => {
        // Loopback binding plus strict Host/Origin prevents DNS rebinding and cross-site control.
        if (
          ![`127.0.0.1:${config.port}`, `localhost:${config.port}`].includes(req.headers.host ?? '')
        )
          return res.status(403).json({ error: { code: 'host', message: 'Unrecognized Host' } });
        if (
          req.headers.origin &&
          ![url, `http://localhost:${config.port}`].includes(req.headers.origin)
        )
          return res
            .status(403)
            .json({ error: { code: 'origin', message: 'Cross-origin requests are not allowed' } });
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
        );
        next();
      });
      app.get('/health', (_req, res) =>
        res.json({
          ok: true,
          id: config.id,
          pid: process.pid,
          version: VERSION,
          runtime: packageRoot,
          setupVersion: SETUP_VERSION,
          notificationMode: 'durable-inbox-and-dashboard',
        }),
      );
      app.post('/api/worker/:taskId', (req, res, next) => {
        try {
          const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
          res.json({ result: service.report(req.params.taskId, token, req.body) });
        } catch (e) {
          next(e);
        }
      });
      app.post('/api/worker/:taskId/call', async (req, res, next) => {
        try {
          if (stopping)
            throw new AppError({
              code: 'stopping',
              message: 'Supervisor is stopping',
              status: 503,
            });
          const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
          res.json({
            result: await runRequest(
              randomUUID(),
              application.workerAction(req.params.taskId, token, req.body),
            ),
          });
        } catch (e) {
          next(e);
        }
      });
      app.use('/api', (req, res, next) => {
        if (!validToken(req.headers.authorization))
          return res.status(401).json({
            error: {
              code: 'unauthorized',
              message: 'Open the dashboard with its local access link or supply the instance token',
            },
          });
        next();
      });
      app.post('/api/call', async (req, res, next) => {
        try {
          if (stopping)
            throw new AppError({
              code: 'stopping',
              message: 'Supervisor is stopping',
              status: 503,
            });
          res.json({
            result: await runRequest(
              randomUUID(),
              application.invoke(req.body.action, req.body.input),
            ),
          });
        } catch (e) {
          next(e);
        }
      });
      app.post('/api/shutdown', (_req, res) => {
        res.json({ stopping: true });
        void shutdown().catch((error) => console.error('Shutdown failed:', error));
      });
      app.use(express.static(resolve(projectRoot, 'public'), { index: 'index.html', maxAge: 0 }));
      app.use(
        (
          error: Error,
          req: express.Request,
          res: express.Response,
          _next: express.NextFunction,
        ) => {
          const status =
            error instanceof AppError
              ? error.status
              : error instanceof ZodError || Schema.isSchemaError(error)
                ? 400
                : 500;
          res.status(status).json({
            error: {
              code:
                error instanceof AppError
                  ? error.code
                  : error instanceof ZodError || Schema.isSchemaError(error)
                    ? 'invalid_input'
                    : 'internal',
              message: error.message,
            },
          });
        },
      );
      const server = yield* Effect.acquireRelease(
        Effect.callback<import('node:http').Server, BoundaryError>((resume) => {
          const server = app.listen(config.port, '127.0.0.1', (error?: Error) =>
            error ? failed(error) : resume(Effect.succeed(server)),
          );
          const failed = (cause: Error) =>
            resume(
              Effect.fail(
                new BoundaryError({
                  operation: 'HttpServer.listen',
                  message: cause.message,
                  cause,
                }),
              ),
            );
          server.once('error', failed);
          return Effect.sync(() => {
            server.off('error', failed);
          });
        }),
        (server) =>
          Effect.gen(function* () {
            stopping = true;
            yield* supervisor.stopEffect();
            yield* Effect.forEach(requests, ([, fiber]) => Fiber.await(fiber), { discard: true });
            yield* Effect.callback<void>((resume) => {
              server.close(() => resume(Effect.void));
              server.closeIdleConnections();
            });
          }),
      );
      yield* sync('Supervisor.start', () => supervisor.start());
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const onSignal = () => {
            void shutdown().catch((error) => console.error('Shutdown failed:', error));
          };
          process.once('SIGTERM', onSignal);
          process.once('SIGINT', onSignal);
          return onSignal;
        }),
        (onSignal) =>
          Effect.sync(() => {
            process.off('SIGTERM', onSignal);
            process.off('SIGINT', onSignal);
          }),
      );
      yield* Effect.logInfo(
        `Marionette listening at ${url}. Worker processes stay in Herdr when this supervisor stops.`,
      );
      return HttpServer.of({ app, server, service, supervisor });
    }),
  );

/** Promise-facing process ingress; all acquired resources belong to one managed layer. */
export function serve(home: string, port?: number) {
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => (shutdownPromise ??= runtime.dispose());
  const runtime = ManagedRuntime.make(
    serverLayer(shutdown).pipe(Layer.provide(applicationLayer(home, port))),
  );
  return runtime.runPromise(HttpServer).then(
    (server) => ({ ...server, shutdown }),
    async (error) => {
      await runtime.dispose();
      throw error;
    },
  );
}

/** CLI owns the public managed runtime until its listener closes or its fiber is interrupted. */
export const serveEffect = Effect.fn('Server.serve')(function* (home: string, port?: number) {
  const instance = yield* Effect.acquireRelease(
    sdk('Server.acquire', () => serve(home, port)),
    (instance) => Effect.promise(() => instance.shutdown()),
  );
  const closed = Latch.makeUnsafe();
  const onClose = () => closed.openUnsafe();
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      instance.server.once('close', onClose);
      if (!instance.server.listening) closed.openUnsafe();
    }),
    () =>
      Effect.sync(() => {
        instance.server.off('close', onClose);
      }),
  );
  yield* closed.await;
}, Effect.scoped);
