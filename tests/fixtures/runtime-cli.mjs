#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
const runtime = resolve(dirname(import.meta.filename), '..');
const pkg = JSON.parse(readFileSync(resolve(runtime, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log(pkg.version);
  process.exit(0);
}
const home = args[args.indexOf('--home') + 1];
const config = JSON.parse(readFileSync(resolve(home, 'config.json'), 'utf8'));
const url = `http://127.0.0.1:${config.port}`;
const lock = resolve(home, 'supervisor.lock');
if (args[0] === 'stop') {
  try {
    await fetch(url + '/api/shutdown', { method: 'POST' });
  } catch {}
  for (let i = 0; i < 100 && existsSync(lock); i++) await Bun.sleep(20);
  process.exit(0);
}
if (args[0] === 'start') {
  if (pkg.testFailStart) {
    const db = new Database(resolve(home, 'state.sqlite'));
    db.query('INSERT OR REPLACE INTO records(kind,id,data) VALUES(?,?,?)').run(
      'test',
      'failed-migration',
      '{}',
    );
    db.close();
    console.error('fixture startup failed');
    process.exit(2);
  }
  const child = spawn(process.execPath, [import.meta.filename, 'serve', '--home', home], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  for (let i = 0; i < 100; i++) {
    try {
      if ((await (await fetch(url + '/health')).json()).id === config.id) process.exit(0);
    } catch {}
    await Bun.sleep(20);
  }
  process.exit(3);
}
writeFileSync(lock, JSON.stringify({ pid: process.pid, id: 'fixture-supervisor' }), { flag: 'wx' });
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: config.port,
  fetch(request) {
    if (new URL(request.url).pathname === '/health')
      return Response.json({
        ok: true,
        version: pkg.version,
        runtime,
        setupVersion: 2,
        id: config.id,
        pid: process.pid,
      });
    if (new URL(request.url).pathname === '/api/shutdown') {
      setTimeout(() => {
        server.stop(true);
        // Match real shutdown: HTTP closes before the scoped database lock releases.
        setTimeout(() => {
          // Node's SQLite checkpoints and removes WAL sidecars on clean close.
          // Bun retains them, so explicitly reproduce the legacy runtime here.
          const database = resolve(home, 'state.sqlite');
          if (existsSync(database)) {
            const db = new Database(database);
            db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
            db.close();
            for (const suffix of ['-wal', '-shm'])
              if (existsSync(database + suffix)) unlinkSync(database + suffix);
          }
          if (existsSync(lock)) unlinkSync(lock);
          process.exit(0);
        }, 200);
      }, 0);
      return Response.json({ result: { stopping: true } });
    }
    return Response.json(
      { error: { code: 'unknown', message: 'fixture only supports health and shutdown' } },
      { status: 404 },
    );
  },
});
