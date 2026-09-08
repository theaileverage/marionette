import express from 'express';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { Store } from './store.js';
import { Service } from './service.js';
import { Supervisor } from './supervisor.js';
import { initConfig } from './config.js';
import { AppError } from './types.js';
import { VERSION, SETUP_VERSION } from './version.js';

export async function serve(home: string, port?: number) {
  const config = initConfig(home, port),
    lock = resolve(home, 'supervisor.lock'),
    lockId = randomUUID();
  if (existsSync(lock)) {
    const old = JSON.parse(readFileSync(lock, 'utf8'));
    try {
      process.kill(old.pid, 0);
      throw new AppError(
        'already_running',
        `Supervisor process ${old.pid} is already running`,
        409,
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
      unlinkSync(lock);
    }
  }
  writeFileSync(lock, JSON.stringify({ pid: process.pid, id: lockId }), {
    flag: 'wx',
    mode: 0o600,
  });
  const store = new Store(resolve(home, 'state.sqlite')),
    service = new Service(store);
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const cliPath = resolve(projectRoot, 'dist/cli.js');
  const url = `http://127.0.0.1:${config.port}`;
  const supervisor = new Supervisor(service, url, cliPath);
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
    if (![`127.0.0.1:${config.port}`, `localhost:${config.port}`].includes(req.headers.host ?? ''))
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
      if (stopping) throw new AppError('stopping', 'Supervisor is stopping', 503);
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      res.json({
        result: await service.orchestration.workerAction(req.params.taskId, token, req.body),
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
      if (stopping) throw new AppError('stopping', 'Supervisor is stopping', 503);
      res.json({ result: await service.invoke(req.body.action, req.body.input) });
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/shutdown', (_req, res) => {
    res.json({ stopping: true });
    setTimeout(() => void shutdown(), 20);
  });
  app.use(express.static(resolve(projectRoot, 'public'), { index: 'index.html', maxAge: 0 }));
  app.use(
    (error: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const status =
        error instanceof AppError ? error.status : error instanceof ZodError ? 400 : 500;
      res.status(status).json({
        error: {
          code:
            error instanceof AppError
              ? error.code
              : error instanceof ZodError
                ? 'invalid_input'
                : 'internal',
          message: error.message,
        },
      });
    },
  );
  let stopping = false;
  const server = await new Promise<ReturnType<typeof app.listen>>((ok, fail) => {
    const v = app.listen(config.port, '127.0.0.1', () => ok(v));
    v.on('error', fail);
  }).catch((e) => {
    store.close();
    unlinkSync(lock);
    throw e;
  });
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    await supervisor.stop();
    await new Promise<void>((r) => {
      server.close(() => r());
      server.closeIdleConnections();
    });
    store.close();
    if (existsSync(lock) && JSON.parse(readFileSync(lock, 'utf8')).id === lockId) unlinkSync(lock);
  }
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
  supervisor.start();
  console.log(
    `Marionette listening at ${url}. Worker processes stay in Herdr when this supervisor stops.`,
  );
  return { app, server, service, supervisor, shutdown };
}
