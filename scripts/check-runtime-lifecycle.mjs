import assert from 'node:assert/strict';
import net from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Schema } from 'effect';
import { serve } from '../src/server.ts';

const root = mkdtempSync(join(tmpdir(), 'marionette-lifecycle-'));
const signals = ['SIGINT', 'SIGTERM'];
const listeners = signals.map((signal) => process.listenerCount(signal));
const blocker = net.createServer();
let runtime;

try {
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', resolve);
  });
  const address = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(
    blocker.address(),
  );
  const occupiedHome = join(root, 'occupied');
  await assert.rejects(serve(occupiedHome, address.port));
  assert.equal(
    existsSync(join(occupiedHome, 'supervisor.lock')),
    false,
    'Failed HTTP acquisition must release the supervisor lock',
  );

  const invalidDatabaseHome = join(root, 'invalid-database');
  mkdirSync(join(invalidDatabaseHome, 'state.sqlite'), { recursive: true });
  await assert.rejects(serve(invalidDatabaseHome, address.port));
  assert.equal(
    existsSync(join(invalidDatabaseHome, 'supervisor.lock')),
    false,
    'Failed database acquisition must release the supervisor lock',
  );

  await new Promise((resolve, reject) =>
    blocker.close((error) => (error ? reject(error) : resolve())),
  );
  const home = join(root, 'running');
  runtime = await serve(home, address.port);
  const lock = readFileSync(join(home, 'supervisor.lock'), 'utf8');
  await assert.rejects(serve(home, address.port), /already running/);
  assert.equal(readFileSync(join(home, 'supervisor.lock'), 'utf8'), lock);

  const first = runtime.shutdown();
  const second = runtime.shutdown();
  await second;
  assert.equal(runtime.server.listening, false, 'Every shutdown caller must await HTTP closure');
  assert.equal(existsSync(join(home, 'supervisor.lock')), false);
  await first;
  assert.deepEqual(
    signals.map((signal) => process.listenerCount(signal)),
    listeners,
    'Shutdown must remove only its own signal listeners',
  );
  console.log(
    'Runtime lifecycle verified: failed acquisitions unwind; shutdown is shared and scoped.',
  );
} finally {
  if (runtime) await runtime.shutdown();
  if (blocker.listening) await new Promise((resolve) => blocker.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
