import { createServer, createConnection, type Server } from 'node:net';
import { chmodSync, existsSync, lstatSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export function wakeSocketPath(stateDirectory: string) {
  return join(stateDirectory, 'service.sock');
}
/** Must only be opened after fenced ownership has positively displaced the old process. */
export async function openWakePort(path: string, wake: () => void): Promise<Server> {
  if (existsSync(path)) {
    if (!lstatSync(path).isSocket()) throw new Error('wake path is not a socket');
    unlinkSync(path);
  }
  const server = createServer((socket) => {
    socket.setTimeout(1_000, () => socket.destroy());
    socket.once('data', () => {
      wake();
      socket.end();
    });
    socket.on('error', () => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  chmodSync(path, 0o600);
  return server;
}
/** Best effort only: the durable event and periodic scan are the delivery mechanism. */
export async function nudgeService(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    let settled = false;
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(success);
    };
    socket.setTimeout(250, () => finish(false));
    socket.once('error', () => finish(false));
    socket.once('connect', () => socket.end('wake\n', () => finish(true)));
  });
}
