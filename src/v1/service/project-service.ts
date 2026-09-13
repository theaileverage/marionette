import { ControllerInbox } from '../inbox/controller-inbox.js';
import type { Server } from 'node:net';
import { ServiceOwnership, type OwnershipOptions } from './ownership.js';
import { openWakePort, wakeSocketPath } from './wake-port.js';

export interface ProjectServiceOptions extends OwnershipOptions {
  signal: AbortSignal;
  watchdogMs?: number;
  recover: (owner: ServiceOwnership) => Promise<void>;
  scan: (owner: ServiceOwnership) => Promise<void>;
}
/** Serial scans are bounded by their ports. There is deliberately no idle timeout. */
export async function runProjectService(options: ProjectServiceOptions): Promise<void> {
  const interval = options.watchdogMs ?? 5_000;
  if (!Number.isInteger(interval) || interval < 10 || interval > 60_000)
    throw new Error('watchdogMs must be between 10 and 60000');
  const owner = await ServiceOwnership.acquire(options);
  let server: Server | undefined;
  let wakePending = true;
  let notify: (() => void) | undefined;
  const wake = () => {
    wakePending = true;
    notify?.();
  };
  options.signal.addEventListener('abort', wake);
  try {
    server = await openWakePort(wakeSocketPath(options.store.project.stateDirectory), wake);
    owner.heartbeat('recovering');
    new ControllerInbox(options.store).recoverClaims(owner.generation);
    await options.recover(owner);
    while (!options.signal.aborted) {
      wakePending = false;
      owner.heartbeat();
      await options.scan(owner);
      owner.heartbeat();
      if (options.signal.aborted || wakePending) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, interval);
        function done() {
          clearTimeout(timer);
          notify = undefined;
          resolve();
        }
        notify = done;
        if (wakePending || options.signal.aborted) done();
      });
    }
    owner.heartbeat('draining');
  } finally {
    options.signal.removeEventListener('abort', wake);
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    owner.stop();
  }
}
