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
import { z } from 'zod';

export const artifactSchema = z
  .object({
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    byteLength: z.number().int().nonnegative(),
    mediaType: z.string().min(1),
  })
  .strict();
export type Artifact = z.infer<typeof artifactSchema>;

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
    const parsed = artifactSchema.parse(artifact);
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
