import { Effect, Latch, Schema } from 'effect';
import { spawn, type SpawnOptions } from 'node:child_process';
import { boundaryError, sync, type BoundaryError } from './effect-runtime.js';
import { AppError } from './types.js';

interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number | null;
  maxBuffer?: number;
  inherit?: boolean;
}
const missingProcess = Schema.Struct({ code: Schema.Literal('ESRCH') });

/** The scope owns the entire process group and waits for stdio closure after termination. */
export const processEffect = Effect.fn('Process.execute')(function* (
  binary: string,
  args: string[],
  options: ProcessOptions = {},
) {
  const resource = yield* Effect.acquireRelease(
    sync('Process.spawn', () => {
      const closed = Latch.makeUnsafe();
      const spawnOptions: SpawnOptions = {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      };
      const child = spawn(binary, args, spawnOptions);
      child.once('close', () => closed.openUnsafe());
      // Keep spawn failures observable even if another acquisition step fails first.
      let failure: Error | undefined;
      child.on('error', (error) => {
        failure = error;
      });
      return { child, closed, failure: () => failure };
    }),
    ({ child, closed }) =>
      Effect.gen(function* () {
        const pid = child.pid;
        if (pid !== undefined && !Latch.isOpen(closed)) {
          yield* Effect.sync(() => {
            try {
              process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL');
            } catch (error) {
              if (!Schema.is(missingProcess)(error)) throw error;
            }
          });
        }
        yield* closed.await;
      }),
  );
  const { child } = resource;
  let output = '',
    stdout = '',
    stderr = '',
    bytes = 0;
  const completion = Effect.callback<
    { code: number | null; output: string; stdout: string; stderr: string; timedOut: boolean },
    AppError | BoundaryError
  >((resume) => {
    const append = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      bytes += chunk.length;
      if (options.maxBuffer && bytes > options.maxBuffer) {
        resume(
          Effect.fail(
            new AppError({
              code: 'process_output_limit',
              message: `${binary} output exceeded ${options.maxBuffer} bytes`,
              status: 400,
            }),
          ),
        );
        return;
      }
      const text = chunk.toString();
      output = (output + text).slice(-50000);
      if (stream === 'stdout') stdout += text;
      else stderr += text;
      // Verification callers need only bounded diagnostics; exec callers set maxBuffer.
      if (!options.maxBuffer) {
        stdout = stdout.slice(-50000);
        stderr = stderr.slice(-50000);
      }
    };
    const out = (chunk: Buffer) => append(chunk, 'stdout');
    const err = (chunk: Buffer) => append(chunk, 'stderr');
    const failed = (error: Error) => resume(Effect.fail(boundaryError('Process.execute')(error)));
    const close = (code: number | null) =>
      resume(Effect.succeed({ code, output, stdout, stderr, timedOut: false }));
    child.stdout?.on('data', out);
    child.stderr?.on('data', err);
    child.once('error', failed);
    child.once('close', close);
    const failure = resource.failure();
    if (failure) failed(failure);
    return Effect.sync(() => {
      child.stdout?.off('data', out);
      child.stderr?.off('data', err);
      child.off('error', failed);
      child.off('close', close);
    });
  });
  const result = yield* options.timeout === null
    ? completion
    : completion.pipe(
        Effect.timeoutOrElse({
          duration: options.timeout ?? 30000,
          orElse: () => Effect.succeed({ code: null, output, stdout, stderr, timedOut: true }),
        }),
      );
  return result;
}, Effect.scoped);

export const execEffect = Effect.fn('Process.exec')(function* (
  binary: string,
  args: string[],
  options: ProcessOptions = {},
) {
  const result = yield* processEffect(binary, args, { maxBuffer: 4 * 1024 * 1024, ...options });
  if (result.code !== 0 || result.timedOut)
    return yield* new AppError({
      code: 'process_failed',
      message: `${binary}: ${result.timedOut ? 'timed out' : `exit ${result.code}`}\n${result.stderr || result.stdout}`,
      status: 400,
    });
  return { stdout: result.stdout, stderr: result.stderr };
});
