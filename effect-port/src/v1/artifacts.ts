import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { Schema } from 'effect';
import { ArtifactIdSchema, type ArtifactId } from './model.js';
import type { Store } from './store.js';

export const artifactSchema = Schema.Struct({
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  byteLength: Schema.Number.check(Schema.makeFilter(Number.isInteger), Schema.isGreaterThanOrEqualTo(0)),
  mediaType: Schema.NonEmptyString,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type Artifact = typeof artifactSchema.Type;

export class ArtifactFiles {
  readonly directory: string;

  constructor(stateDirectory: string) {
    this.directory = join(stateDirectory, 'artifacts', 'sha256');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  put(bytes: Uint8Array, mediaType = 'application/octet-stream'): Artifact {
    const digest = createHash('sha256').update(bytes).digest('hex');
    const artifact: Artifact = { digest, byteLength: bytes.byteLength, mediaType };
    const destination = this.path(artifact);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, 'wx', 0o400);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temporary, destination);
      const directory = openSync(dirname(destination), 'r');
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    } finally {
      unlinkSync(temporary);
    }
    this.verify(artifact);
    return artifact;
  }

  snapshot(path: string, options: { maxBytes?: number; mediaType?: string } = {}): Artifact {
    const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    const metadata = statSync(path);
    if (!metadata.isFile()) throw new Error('Artifact input must be a regular file');
    if (metadata.size > maxBytes) throw new Error(`Artifact exceeds ${maxBytes} bytes`);
    const bytes = readFileSync(path);
    if (bytes.byteLength > maxBytes) throw new Error(`Artifact exceeds ${maxBytes} bytes`);
    return this.put(bytes, options.mediaType);
  }

  path(artifact: Artifact): string {
    const parsed = Schema.decodeUnknownSync(artifactSchema)(artifact);
    return join(this.directory, parsed.digest.slice(0, 2), parsed.digest.slice(2));
  }

  read(artifact: Artifact): Buffer {
    const bytes = readFileSync(this.path(artifact));
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== artifact.digest || bytes.byteLength !== artifact.byteLength) {
      throw new Error(`Artifact integrity check failed for ${artifact.digest}`);
    }
    return bytes;
  }

  verify(artifact: Artifact): void {
    this.read(artifact);
  }
}

export function registerArtifact(
  store: Store,
  files: ArtifactFiles,
  artifact: Artifact,
): ArtifactId {
  files.verify(artifact);
  return store.transaction((db) => {
    const previous = db
      .prepare(
        'SELECT id, path, byte_length, media_type FROM artifacts WHERE project_id = ? AND digest = ?',
      )
      .get(store.project.id, artifact.digest);
    if (previous) {
      const row = Schema.decodeUnknownSync(Schema.Struct({
        id: ArtifactIdSchema,
        path: Schema.String,
        byte_length: Schema.Number,
        media_type: Schema.String,
      }))(previous);
      if (row.path !== files.path(artifact) || row.byte_length !== artifact.byteLength)
        throw new Error('Artifact catalog does not match durable bytes');
      if (row.media_type === 'application/octet-stream' && artifact.mediaType !== row.media_type)
        db.prepare('UPDATE artifacts SET media_type=? WHERE id=? AND project_id=?').run(
          artifact.mediaType,
          row.id,
          store.project.id,
        );
      return row.id;
    }
    const id = Schema.decodeUnknownSync(ArtifactIdSchema)(randomUUID());
    db.prepare(
      'INSERT INTO artifacts(id, project_id, host_id, digest, path, byte_length, media_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      store.project.id,
      store.project.hostId,
      artifact.digest,
      files.path(artifact),
      artifact.byteLength,
      artifact.mediaType,
      new Date().toISOString(),
    );
    return id;
  });
}
