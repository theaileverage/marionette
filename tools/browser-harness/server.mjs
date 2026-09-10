import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { authorized, parseInput } from './security.mjs';

const directory = import.meta.dir;
let runtimeCli = process.env.MARIONETTE_CLI;
if (!runtimeCli) {
  const prepared = Bun.spawnSync([process.execPath, join(directory, 'prepare-runtime.mjs')], {
    stdout: 'pipe',
    stderr: 'inherit',
  });
  if (prepared.exitCode !== 0) throw new Error('Unable to prepare an isolated Marionette build');
  runtimeCli = new TextDecoder().decode(prepared.stdout).trim();
}
const build = await Bun.build({
  entrypoints: [join(directory, 'client.js')],
  outdir: join(directory, 'dist'),
  target: 'browser',
  minify: false,
});
if (!build.success) throw new Error(build.logs.join('\n'));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'marionette-browser-')));
const session = `wterm-${randomBytes(6).toString('hex')}`;
for (const fixture of ['fresh', 'existing']) {
  const cwd = join(root, fixture);
  mkdirSync(cwd);
  for (const cmd of [
    ['git', 'init', '-q'],
    ['git', 'config', 'user.email', 'harness@example.invalid'],
    ['git', 'config', 'user.name', 'Browser Harness'],
  ]) {
    if (Bun.spawnSync(cmd, { cwd }).exitCode !== 0)
      throw new Error('Fixture Git initialization failed');
  }
  if (fixture === 'existing') {
    writeFileSync(join(cwd, 'README.md'), '# Existing fixture\n');
    Bun.spawnSync(['git', 'add', 'README.md'], { cwd });
    if (Bun.spawnSync(['git', 'commit', '-qm', 'Fixture baseline'], { cwd }).exitCode !== 0)
      throw new Error('Fixture commit failed');
    writeFileSync(
      join(cwd, 'README.md'),
      '# Existing fixture\n\nUncommitted user work — preserve me.\n',
    );
    writeFileSync(join(cwd, 'untracked.txt'), 'Preserve this untracked file.\n');
  }
}
const prefix = `/${randomBytes(24).toString('hex')}/`;
const clients = new Set();
const history = [];
let historyBytes = 0;
let child;
let exitCode;
const env = {
  ...process.env,
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  PS1: 'harness$ ',
  HARNESS_ROOT: root,
  HARNESS_SESSION: session,
  MARIONETTE_CLI: runtimeCli,
  HARNESS_SMOKE: join(directory, 'smoke.sh'),
  BASH_SILENCE_DEPRECATION_WARNING: '1',
};
// Never inherit an active pane identity into the outer PTY. Herdr injects the real one.
for (const key of Object.keys(env)) if (key.startsWith('HERDR_')) delete env[key];
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: Number(process.env.HARNESS_PORT ?? 0),
  fetch(request, server) {
    const origin = `http://127.0.0.1:${server.port}`;
    if (!authorized(request, origin, prefix)) return new Response('Forbidden', { status: 403 });
    const path = new URL(request.url).pathname.slice(prefix.length);
    if (path === 'pty') {
      if (request.headers.get('origin') !== origin)
        return new Response('Forbidden', { status: 403 });
      if (clients.size) return new Response('Terminal already has a controller', { status: 409 });
      if (server.upgrade(request)) return;
      return new Response('WebSocket required', { status: 400 });
    }
    const files = {
      '': 'index.html',
      'client.js': 'dist/client.js',
      'client.css': 'dist/client.css',
      'ghostty-vt.wasm': 'node_modules/@wterm/ghostty/wasm/ghostty-vt.wasm',
    };
    if (request.method !== 'GET' || !Object.hasOwn(files, path))
      return new Response('Not found', { status: 404 });
    return new Response(Bun.file(join(directory, files[path])), {
      headers: {
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  },
  websocket: {
    maxPayloadLength: 65536,
    open(ws) {
      if (clients.size) {
        ws.close(1008, 'Terminal already has a controller');
        return;
      }
      clients.add(ws);
      if (child) {
        ws.send(JSON.stringify({ type: 'replay', active: true }));
        for (const chunk of history) ws.send(chunk);
        ws.send(JSON.stringify({ type: 'replay', active: false }));
        if (exitCode !== undefined) ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
        return;
      }
      child = Bun.spawn(['/bin/bash', '--noprofile', '--norc', '-i'], {
        cwd: join(root, 'fresh'),
        env,
        terminal: {
          cols: 100,
          rows: 30,
          data(_terminal, data) {
            const copy = new Uint8Array(data);
            history.push(copy);
            historyBytes += copy.length;
            while (historyBytes > 4 * 1024 * 1024) historyBytes -= history.shift().length;
            for (const client of clients) client.send(copy);
          },
        },
        onExit(_process, code) {
          exitCode = code;
          for (const client of clients) client.send(JSON.stringify({ type: 'exit', code }));
        },
      });
      child.terminal.write(
        `printf '\\nStart the isolated session: herdr --session "$HARNESS_SESSION"\\nInside Herdr, run: bash "$HARNESS_SMOKE"\\nFixtures: %s\\n' "$HARNESS_ROOT"\n`,
      );
    },
    message(ws, message) {
      const value = parseInput(message);
      if (!value) {
        ws.close(1008, 'Invalid terminal message');
        return;
      }
      if (exitCode !== undefined) return;
      if (value.type === 'input') child?.terminal.write(value.data);
      else child?.terminal.resize(value.cols, value.rows);
    },
    close(ws) {
      clients.delete(ws);
    },
  },
});
console.log(JSON.stringify({ url: `http://127.0.0.1:${server.port}${prefix}`, root, session }));
// Stopping the harness closes only its outer PTY, never Herdr's server or workers.
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    child?.kill();
    child?.terminal.close();
    server.stop(true);
    process.exit(0);
  });
