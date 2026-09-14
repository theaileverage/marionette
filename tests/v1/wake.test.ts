import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  MAX_WAKE_PAYLOAD_BYTES,
  MAX_WAKE_SOCKET_PATH_BYTES,
  WakeListener,
  pokeWatcher,
  wakeSocketPath,
  wakeSocketPathFits,
} from '../../src/v1/wake.js';

function stateDirectory(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'mw-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Marionette creates project state directories 0700; mirror that, because the
  // endpoint refuses a directory other users can reach.
  const directory = join(root, 'projects', 'project-a');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

async function listener(t: TestContext, directory: string, projectId = 'project-a') {
  const bound = await WakeListener.listen({ stateDirectory: directory, projectId });
  t.after(() => bound.close());
  return bound;
}

/** Sends a raw payload the public sender would refuse, to exercise receiver limits. */
function sendRaw(path: string, payload: string | Buffer): Promise<void> {
  return new Promise<void>((resolve) => {
    const socket = connect(path);
    socket.once('connect', () => socket.end(payload));
    socket.once('close', () => resolve());
    socket.once('error', () => resolve());
  });
}

/** Binds the endpoint from another process so SIGKILL can strand the socket file. */
async function strandedOwner(t: TestContext, directory: string) {
  const path = wakeSocketPath(directory, 'project-a');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const child = spawn(
    process.execPath,
    [
      '-e',
      `require('node:net').createServer().listen(${JSON.stringify(path)},()=>console.log('bound'))`,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  t.after(() => child.kill('SIGKILL'));
  await new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => resolve());
    child.once('error', reject);
    child.once('exit', () => reject(new Error('the stranded owner exited before it bound')));
  });
  return { path, child };
}

test('a poke sent after a committed change wakes a listener that is already waiting', async (t) => {
  const directory = stateDirectory(t);
  const bound = await listener(t, directory);
  assert.equal(bound.unavailable, null);
  const waiting = bound.wait({ timeoutMs: 5_000 });
  const started = Date.now();
  assert.equal(await pokeWatcher({ stateDirectory: directory, projectId: 'project-a' }), true);
  assert.equal(await waiting, 'poked');
  assert.ok(
    Date.now() - started < 5_000,
    'the poke must resolve the wait well before the fallback interval',
  );
  assert.equal(bound.take(), true);
  assert.equal(bound.take(), false);
  assert.equal(bound.accepted, 1);
});

test('a poke that lands before the wait is not lost', async (t) => {
  const directory = stateDirectory(t);
  const bound = await listener(t, directory);
  assert.equal(await pokeWatcher({ stateDirectory: directory, projectId: 'project-a' }), true);
  assert.equal(await bound.wait({ timeoutMs: 5_000 }), 'poked');
  assert.equal(bound.take(), true);
});

test('a burst of pokes coalesces into one signal', async (t) => {
  const directory = stateDirectory(t);
  const bound = await listener(t, directory);
  const burst = 25;
  const delivered = await Promise.all(
    Array.from({ length: burst }, () =>
      // A generous timeout: under load a poke may legitimately give up, and the
      // point of this test is what the accepted ones cost, not how many land.
      pokeWatcher({ stateDirectory: directory, projectId: 'project-a', timeoutMs: 5_000 }),
    ),
  );
  const landed = delivered.filter(Boolean).length;
  assert.ok(landed > 1, `the burst needs several pokes to coalesce (landed=${landed})`);
  assert.equal(bound.accepted, landed, 'every poke the sender confirmed was received');
  assert.equal(bound.take(), true, 'the burst leaves exactly one signal');
  assert.equal(bound.take(), false, 'and the signal is consumed once');
});

test('the receiver refuses foreign, malformed and oversized payloads', async (t) => {
  const directory = stateDirectory(t);
  const bound = await listener(t, directory);
  await sendRaw(bound.path, JSON.stringify({ v: 1, projectId: 'project-b' }));
  await sendRaw(bound.path, 'not json\n');
  await sendRaw(bound.path, JSON.stringify({ v: 2, projectId: 'project-a' }));
  await sendRaw(bound.path, Buffer.alloc(MAX_WAKE_PAYLOAD_BYTES + 1, 0x61));
  assert.equal(bound.take(), false, 'none of those may wake this project');
  assert.equal(bound.accepted, 0);
  assert.equal(bound.refused, 4);
  assert.equal(await pokeWatcher({ stateDirectory: directory, projectId: 'project-a' }), true);
  assert.equal(bound.take(), true, 'a well formed poke still works afterwards');
});

test('a missed poke costs latency only: the wait falls back on its own timer', async (t) => {
  const directory = stateDirectory(t);
  const bound = await listener(t, directory);
  const started = Date.now();
  assert.equal(await bound.wait({ timeoutMs: 120 }), 'timeout');
  assert.ok(Date.now() - started >= 100, 'the fallback interval actually elapsed');
  assert.equal(bound.take(), false);
});

test('an abort resolves the wait and scoped cleanup removes the endpoint', async (t) => {
  const directory = stateDirectory(t);
  const bound = await WakeListener.listen({ stateDirectory: directory, projectId: 'project-a' });
  const abort = new AbortController();
  const waiting = bound.wait({ timeoutMs: 60_000, signal: abort.signal });
  abort.abort();
  assert.equal(await waiting, 'aborted');
  assert.ok(existsSync(bound.path), 'the endpoint exists while the listener is open');
  bound.close();
  assert.equal(
    existsSync(bound.path),
    false,
    'closing the listener removes the socket from the state directory',
  );
  assert.equal(await bound.wait({ timeoutMs: 60_000 }), 'closed');
});

test('closing while a wait is pending releases the waiter', async (t) => {
  const directory = stateDirectory(t);
  const bound = await WakeListener.listen({ stateDirectory: directory, projectId: 'project-a' });
  const waiting = bound.wait({ timeoutMs: 60_000 });
  bound.close();
  assert.equal(await waiting, 'closed');
});

test('the endpoint is private to its owner', async (t) => {
  const directory = stateDirectory(t);
  const bound = await listener(t, directory);
  assert.equal(statSync(bound.path).mode & 0o777, 0o600);
});

test('a restart rebinds over the socket a killed owner left behind', async (t) => {
  const directory = stateDirectory(t);
  const owner = await strandedOwner(t, directory);
  owner.child.kill('SIGKILL');
  await new Promise<void>((resolve) => owner.child.once('exit', () => resolve()));
  assert.ok(existsSync(owner.path), 'SIGKILL strands the endpoint file');
  const restarted = await listener(t, directory);
  assert.equal(restarted.unavailable, null, 'the restarted owner rebinds the endpoint');
  assert.equal(await pokeWatcher({ stateDirectory: directory, projectId: 'project-a' }), true);
  assert.equal(restarted.take(), true);
});

test('a regular file occupying the endpoint is preserved, never removed', async (t) => {
  const directory = stateDirectory(t);
  const path = wakeSocketPath(directory, 'project-a');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, 'not a socket');
  const bound = await WakeListener.listen({ stateDirectory: directory, projectId: 'project-a' });
  t.after(() => bound.close());
  assert.match(String(bound.unavailable), /not a socket/);
  assert.equal(readFileSync(path, 'utf8'), 'not a socket', 'the occupant is left untouched');
});

test('an endpoint that cannot be probed conclusively is left in place', async (t) => {
  const directory = stateDirectory(t);
  const owner = await strandedOwner(t, directory);
  owner.child.kill('SIGKILL');
  await new Promise<void>((resolve) => owner.child.once('exit', () => resolve()));
  // The socket is genuinely stale, but an unreadable one cannot prove that:
  // EACCES is not ECONNREFUSED, so absence is not established.
  chmodSync(owner.path, 0o000);
  const bound = await WakeListener.listen({ stateDirectory: directory, projectId: 'project-a' });
  t.after(() => bound.close());
  assert.ok(bound.unavailable, 'the listener degrades rather than guessing');
  assert.ok(existsSync(owner.path), 'and leaves the endpoint it could not classify');
});

test('an endpoint directory reached through a symbolic link is refused', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mw-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const real = join(root, 'projects', 'real-a');
  mkdirSync(real, { recursive: true, mode: 0o700 });
  // The state directory itself is the link, so the endpoint would be bound
  // somewhere this process never verified.
  const directory = join(root, 'projects', 'project-a');
  symlinkSync(real, directory);
  const bound = await WakeListener.listen({ stateDirectory: directory, projectId: 'project-a' });
  t.after(() => bound.close());
  assert.match(String(bound.unavailable), /symbolic link/);
  assert.equal(existsSync(join(real, 'wake.sock')), false, 'nothing was bound through the link');
});

test('an endpoint directory other users can reach is refused', async (t) => {
  const directory = stateDirectory(t);
  const path = wakeSocketPath(directory, 'project-a');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o755);
  const bound = await WakeListener.listen({ stateDirectory: directory, projectId: 'project-a' });
  t.after(() => bound.close());
  assert.match(String(bound.unavailable), /other users/);
  assert.equal(existsSync(path), false);
});

test('a live owner is never displaced by a second listener', async (t) => {
  const directory = stateDirectory(t);
  const first = await listener(t, directory);
  assert.equal(first.unavailable, null);
  const second = await WakeListener.listen({ stateDirectory: directory, projectId: 'project-a' });
  t.after(() => second.close());
  assert.ok(second.unavailable, 'the second listener reports why it cannot receive');
  assert.equal(await pokeWatcher({ stateDirectory: directory, projectId: 'project-a' }), true);
  assert.equal(first.take(), true, 'the live owner still receives its pokes');
  assert.equal(second.take(), false);
});

test('poking an absent watcher is a quiet no-op', async (t) => {
  const directory = stateDirectory(t);
  assert.equal(existsSync(wakeSocketPath(directory, 'project-a')), false);
  assert.equal(await pokeWatcher({ stateDirectory: directory, projectId: 'project-a' }), false);
});

test('a state directory the platform cannot address degrades to the fallback timer', async (t) => {
  const root = stateDirectory(t);
  const deep = join(root, 'd'.repeat(MAX_WAKE_SOCKET_PATH_BYTES), 'projects', 'project-a');
  mkdirSync(deep, { recursive: true, mode: 0o700 });
  assert.equal(wakeSocketPathFits(wakeSocketPath(deep, 'project-a')), false);
  const bound = await WakeListener.listen({ stateDirectory: deep, projectId: 'project-a' });
  t.after(() => bound.close());
  assert.ok(bound.unavailable, 'the listener reports the endpoint it could not bind');
  assert.equal(await pokeWatcher({ stateDirectory: deep, projectId: 'project-a' }), false);
  assert.equal(await bound.wait({ timeoutMs: 60 }), 'timeout', 'the timer still wakes the loop');
});
