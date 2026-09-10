import { Schema } from 'effect';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import { safePath } from './files.js';
import { AppError } from './types.js';

/** Inspection without handing a read-only worker an arbitrary shell. */
export function inspectWorkerFiles<Input>(root: string, raw: Input) {
  const input = Schema.decodeUnknownSync(
    Schema.Struct({
      action: Schema.Literals(['read', 'list']),
      path: Schema.String,
      startLine: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
      maxLines: Schema.optional(
        Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(1000)),
      ),
    }),
  )(raw);
  const path = safePath(root, input.path, true);
  if (
    relative(root, path)
      .split(/[\\/]/)
      .some((part) => ['.marionette', '.git'].includes(part))
  )
    throw new AppError({
      code: 'worker_scope',
      message: 'Private runtime and Git metadata are outside file inspection',
      status: 403,
    });
  if (input.action === 'list') {
    const all = readdirSync(path, { withFileTypes: true });
    return {
      path: input.path,
      truncated: all.length > 1000,
      entries: all.slice(0, 1000).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file',
      })),
    };
  }
  if (!statSync(path).isFile() || statSync(path).size > 2 * 1024 * 1024)
    throw new AppError({
      code: 'worker_file_size',
      message: 'Inspection requires a file at most 2 MiB',
      status: 400,
    });
  const lines = readFileSync(path, 'utf8').split('\n'),
    start = (input.startLine ?? 1) - 1;
  return {
    path: input.path,
    totalLines: lines.length,
    startLine: start + 1,
    text: lines
      .slice(start, start + (input.maxLines ?? 200))
      .join('\n')
      .slice(0, 50000),
  };
}
