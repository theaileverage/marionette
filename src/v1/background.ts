import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { closeSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { LocalProcessInspector } from './native.js';
import type { Store } from './store.js';
import type { OwnerLivenessPort } from './watcher.js';

const processIdentitySchema = z
  .object({ pid: z.number().int().positive(), startToken: z.string().min(1) })
  .strict();

export const localOwnerLiveness: OwnerLivenessPort = {
  async confirmAbsent(input) {
    const identity = processIdentitySchema.parse(JSON.parse(input.processIdentity));
    try {
      process.kill(identity.pid, 0);
    } catch (error) {
      return error instanceof Error && 'code' in error && error.code === 'ESRCH';
    }
    const current = await new LocalProcessInspector().startToken(identity.pid);
    return current !== undefined && current !== identity.startToken;
  },
};

export async function currentProcessIdentity(): Promise<string> {
  const startToken = await new LocalProcessInspector().startToken(process.pid);
  if (!startToken) throw new Error('Cannot establish the watcher process identity');
  return JSON.stringify({ pid: process.pid, startToken });
}

export async function ensureBackgroundWatcher(store: Store, bindingPath: string) {
  const prior = store.read((db) =>
    db
      .prepare('SELECT process_identity,settled_at FROM watcher_owners WHERE project_id=?')
      .get(store.project.id),
  );
  if (prior) {
    const owner = z
      .object({ process_identity: z.string(), settled_at: z.string().nullable() })
      .parse(prior);
    if (
      !owner.settled_at &&
      !(await localOwnerLiveness.confirmAbsent({
        project: store.project,
        processIdentity: owner.process_identity,
      }))
    )
      return;
  }
  const log = openSync(join(store.project.stateDirectory, 'watcher.log'), 'a', 0o600);
  try {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('./cli.js', import.meta.url)),
        'watch',
        '--project',
        bindingPath,
        '--foreground',
      ],
      {
        cwd: store.project.repositoryRoot,
        detached: true,
        stdio: ['ignore', log, log],
        env: {
          ...process.env,
          MARIONETTE_STATE_HOME: dirname(dirname(store.project.stateDirectory)),
        },
      },
    );
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
  } finally {
    closeSync(log);
  }
}
