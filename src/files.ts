import { Effect, Schema } from 'effect';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { processEffect } from './process.js';
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
    throw new AppError({
      code: 'path_escape',
      message: 'Path must stay within the task working directory',
      status: 400,
    });
  try {
    const real = realpathSync(path);
    if (!inside(realRoot, real))
      throw new AppError({
        code: 'path_escape',
        message: 'Symlink escapes task directory',
        status: 400,
      });
    return real;
  } catch (e) {
    if (!Schema.is(Schema.Struct({ code: Schema.Literal('ENOENT') }))(e) || mustExist) throw e;
    // Validate the closest existing parent too, including dangling links.
    let parent = resolve(path, '..');
    while (parent !== root) {
      try {
        const real = realpathSync(parent);
        if (!inside(realRoot, real))
          throw new AppError({
            code: 'path_escape',
            message: 'Parent symlink escapes task directory',
            status: 400,
          });
        break;
      } catch (err) {
        if (!Schema.is(Schema.Struct({ code: Schema.Literal('ENOENT') }))(err)) throw err;
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
    if (Schema.is(Schema.Struct({ code: Schema.Literal('ENOENT') }))(e)) return null;
    throw e;
  }
}
export interface CommandResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

export const commandEffect = Effect.fn('Verification.command')(function* (
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 30000,
) {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith('MARIONETTE_') || key.startsWith('HERDR_')) delete env[key];
  const result = yield* processEffect(command, args, { cwd, env, timeout: timeoutMs });
  return { code: result.code, output: result.output, timedOut: result.timedOut };
});

/** Compatibility entry point for CLI and existing package consumers. */
export const command = (command: string, args: string[], cwd: string, timeoutMs = 30000) =>
  Effect.runPromise(commandEffect(command, args, cwd, timeoutMs));
