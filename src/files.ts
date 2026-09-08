import { realpathSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { AppError } from './types.js';
export const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
// Path prefixes must be compared on directory boundaries, never raw string prefixes.
export function inside(root: string, path: string) {
  const r = relative(root, path);
  return !r.startsWith('../') && r !== '..' && !isAbsolute(r);
}
export function safePath(root: string, input: string, mustExist = false): string {
  const realRoot = realpathSync(root);
  const path = resolve(root, input);
  if (!inside(root, path))
    throw new AppError('path_escape', 'Path must stay within the task working directory');
  try {
    const real = realpathSync(path);
    if (!inside(realRoot, real))
      throw new AppError('path_escape', 'Symlink escapes task directory');
    return real;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || mustExist) throw e;
    // Validate the closest existing parent too, including dangling links.
    let parent = resolve(path, '..');
    while (parent !== root) {
      try {
        const real = realpathSync(parent);
        if (!inside(realRoot, real))
          throw new AppError('path_escape', 'Parent symlink escapes task directory');
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        parent = resolve(parent, '..');
      }
    }
    return path;
  }
}
export function digest(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return null;
    if (statSync(path).size > 10 * 1024 * 1024) throw new Error('Artifact exceeds 10 MiB');
    return hash(readFileSync(path));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}
export function command(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 30000,
): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const k of Object.keys(env))
      if (k.startsWith('MARIONETTE_') || k.startsWith('HERDR_')) delete env[k];
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(process.platform === 'win32' ? child.pid! : -child.pid!, 'SIGKILL');
      } catch {}
    }, timeoutMs);
    const append = (b: Buffer) => {
      output = (output + b.toString()).slice(-50000);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}
