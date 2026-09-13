import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { extname, resolve } from 'node:path';

import { z } from 'zod';

import type { NativeSessionReference } from './native-session.js';
import type { JsonValue } from './schema-description.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_BYTES = 64 * 1024;
const MAX_BYTES = 256 * 1024;

export type NativeHistoryEntry = {
  offset: number;
  value: JsonValue;
};

export type NativeHistory =
  | { kind: 'missing-reference'; reason: string }
  | { kind: 'identity-unconfirmed'; reason: string }
  | { kind: 'unsupported'; harness: string; referenceKind: string; reason: string }
  | { kind: 'session-missing'; reason: string }
  | { kind: 'unsafe-path'; reason: string }
  | { kind: 'malformed-history'; reason: string; offset: number }
  | {
      kind: 'available';
      harness: string;
      referenceId: string;
      cursor: number;
      nextCursor: number | null;
      truncated: boolean;
      bytesRead: number;
      entries: NativeHistoryEntry[];
    };

export type NativeHistoryOptions = {
  cursor?: number;
  limit?: number;
  maxBytes?: number;
};

function bounds(options: NativeHistoryOptions) {
  const cursor = options.cursor ?? 0;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const maxBytes = options.maxBytes ?? DEFAULT_BYTES;
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('History cursor is invalid');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT)
    throw new Error(`History limit must be between 1 and ${MAX_LIMIT}`);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES)
    throw new Error(`History maxBytes must be between 1 and ${MAX_BYTES}`);
  return { cursor, limit, maxBytes };
}

export function readNativeHistory(
  reference: NativeSessionReference,
  expectedHostId: string,
  options: NativeHistoryOptions = {},
): NativeHistory {
  const { cursor, limit, maxBytes } = bounds(options);
  if (reference.status !== 'confirmed')
    return {
      kind: 'identity-unconfirmed',
      reason:
        reference.status === 'legacy-untyped'
          ? 'Legacy native session bytes have no verified harness or reference kind'
          : (reference.rejectionReason ?? 'Native session reference is unconfirmed'),
    };
  if (reference.hostId !== expectedHostId)
    return {
      kind: 'identity-unconfirmed',
      reason: 'Native session reference belongs to another host',
    };
  if (reference.kind !== 'path')
    return {
      kind: 'unsupported',
      harness: reference.harness,
      referenceKind: reference.kind,
      reason: 'This harness exposes an identifier, not a locally readable history path',
    };
  if (reference.harness !== 'pi' && reference.harness !== 'omp')
    return {
      kind: 'unsupported',
      harness: reference.harness,
      referenceKind: reference.kind,
      reason: 'Path history is supported only for verified Pi and OMP references',
    };

  const expectedPath = resolve(reference.value);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(expectedPath);
  } catch {
    return { kind: 'session-missing', reason: 'The recorded native session file is unavailable' };
  }
  if (!stat.isFile() || stat.isSymbolicLink())
    return {
      kind: 'unsafe-path',
      reason: 'The recorded native session path is not a regular file',
    };
  if (extname(expectedPath) !== '.jsonl')
    return { kind: 'unsafe-path', reason: 'The recorded native session path is not JSONL' };
  try {
    if (realpathSync(expectedPath) !== expectedPath)
      return { kind: 'unsafe-path', reason: 'The recorded native session path traverses a link' };
  } catch {
    return { kind: 'session-missing', reason: 'The recorded native session file is unavailable' };
  }
  const currentUserId = process.getuid?.();
  if (currentUserId !== undefined && stat.uid !== currentUserId)
    return { kind: 'unsafe-path', reason: 'The recorded native session file has another owner' };
  if (cursor > stat.size)
    return { kind: 'session-missing', reason: 'The requested history cursor is past end of file' };

  let descriptor: number;
  try {
    descriptor = openSync(expectedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return { kind: 'unsafe-path', reason: 'The recorded native session file changed before read' };
  }
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino)
      return {
        kind: 'unsafe-path',
        reason: 'The recorded native session file changed before read',
      };
    if (cursor > 0) {
      const boundary = Buffer.alloc(1);
      if (readSync(descriptor, boundary, 0, 1, cursor - 1) !== 1 || boundary[0] !== 0x0a)
        return {
          kind: 'unsafe-path',
          reason: 'The requested history cursor is not a line boundary',
        };
    }
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, stat.size - cursor));
    const count = readSync(descriptor, buffer, 0, buffer.length, cursor);
    const hasMoreBytes = cursor + count < stat.size;
    let usable = count;
    if (hasMoreBytes || count > maxBytes) {
      usable = buffer.subarray(0, Math.min(count, maxBytes)).lastIndexOf(0x0a) + 1;
      if (usable === 0)
        return { kind: 'unsafe-path', reason: 'A native history record exceeds the byte bound' };
    }
    const text = buffer.subarray(0, usable).toString('utf8');
    const entries: NativeHistoryEntry[] = [];
    let offset = cursor;
    let consumed = 0;
    for (const line of text.split('\n')) {
      const width = Buffer.byteLength(line) + 1;
      if (line.length > 0) {
        if (entries.length >= limit) break;
        try {
          // SAFETY: JSON.parse returns only JSON values; z.unknown forces parsing at this I/O boundary.
          const value = z.unknown().parse(JSON.parse(line)) as JsonValue;
          entries.push({ offset, value });
        } catch {
          return {
            kind: 'malformed-history',
            reason: 'The native history contains an invalid JSONL record',
            offset,
          };
        }
      }
      offset += width;
      consumed += width;
    }
    const exhaustedEntries = entries.length >= limit && consumed < usable;
    const nextCursor = cursor + Math.min(consumed, usable);
    const truncated = exhaustedEntries || nextCursor < stat.size;
    return {
      kind: 'available',
      harness: reference.harness,
      referenceId: reference.id,
      cursor,
      nextCursor: truncated ? nextCursor : null,
      truncated,
      bytesRead: Math.min(consumed, usable),
      entries,
    };
  } finally {
    closeSync(descriptor);
  }
}
