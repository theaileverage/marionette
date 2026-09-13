import { isAbsolute } from 'node:path';
import { z } from 'zod';

/**
 * Adapted from Herdr v0.9.0 `src/agent_resume.rs` at
 * b99002ac99b09e00b4ca692436cb15a6b0d676f1 (Apache-2.0).
 *
 * Marionette retains Herdr's official source/agent allow-list and id/path
 * validation, but models Codex app-server threads separately and never builds
 * resume commands from these references.
 */

const MAX_SESSION_ID_LENGTH = 512;
const MAX_SESSION_PATH_LENGTH = 4096;

export const NativeSessionReferenceKindSchema = z.enum(['id', 'path', 'thread']);
export type NativeSessionReferenceKind = z.infer<typeof NativeSessionReferenceKindSchema>;

export const NativeSessionPointerSchema = z
  .object({
    harness: z.string().min(1),
    kind: NativeSessionReferenceKindSchema,
    value: z.string().min(1),
    source: z.string().min(1),
  })
  .strict();
export type NativeSessionPointer = z.infer<typeof NativeSessionPointerSchema>;

export const NativeSessionReferenceStatusSchema = z.enum([
  'confirmed',
  'unconfirmed',
  'legacy-untyped',
]);

export const NativeSessionBindingEvidenceSchema = z
  .object({
    workspaceId: z.string().min(1),
    tabId: z.string().min(1),
    paneId: z.string().min(1),
    terminalId: z.string().min(1),
    identityRevision: z.number().int().nonnegative(),
    foregroundProcess: z
      .object({ pid: z.number().int().positive(), startToken: z.string().min(1) })
      .strict()
      .optional(),
    endpointProtocolGeneration: z.number().int().nonnegative().optional(),
  })
  .strict();

export const NativeSessionReferenceSchema = z
  .object({
    id: z.string().min(1),
    attemptId: z.string().min(1),
    sessionId: z.string().min(1),
    sessionGeneration: z.number().int().positive(),
    hostId: z.string().min(1),
    nativeKind: z.string().min(1),
    nativeServerGeneration: z.string().min(1),
    harness: z.string().min(1),
    kind: z.enum(['id', 'path', 'thread', 'legacy']),
    value: z.string().min(1),
    source: z.string().min(1),
    status: NativeSessionReferenceStatusSchema,
    observedAt: z.string().datetime(),
    binding: NativeSessionBindingEvidenceSchema,
    rejectionReason: z.string().min(1).nullable(),
  })
  .strict();
export type NativeSessionReference = z.infer<typeof NativeSessionReferenceSchema>;

const OFFICIAL_HERDR_SOURCES = new Map<string, string>([
  ['herdr:claude', 'claude'],
  ['herdr:codex', 'codex'],
  ['herdr:copilot', 'copilot'],
  ['herdr:devin', 'devin'],
  ['herdr:droid', 'droid'],
  ['herdr:kimi', 'kimi'],
  ['herdr:omp', 'omp'],
  ['herdr:mastracode', 'mastracode'],
  ['herdr:pi', 'pi'],
  ['herdr:hermes', 'hermes'],
  ['herdr:opencode', 'opencode'],
  ['herdr:qodercli', 'qodercli'],
  ['herdr:qwen', 'qwen'],
  ['herdr:kilo', 'kilo'],
  ['herdr:cursor', 'cursor'],
  ['herdr:antigravity_cli', 'agy'],
  ['herdr:grok', 'grok'],
]);

function validId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_SESSION_ID_LENGTH &&
    !Array.from(value).some((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && (code <= 0x1f || code === 0x7f);
    })
  );
}

function validPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_SESSION_PATH_LENGTH &&
    !Array.from(value).some((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && (code <= 0x1f || code === 0x7f);
    }) &&
    isAbsolute(value)
  );
}

function harnessForHerdrAgent(agent: string): string {
  return agent === 'codex' ? 'codex-cli' : agent;
}

export function herdrSessionPointer(input: {
  source: string;
  agent: string;
  kind: string;
  value: string;
}): NativeSessionPointer | undefined {
  if (OFFICIAL_HERDR_SOURCES.get(input.source) !== input.agent) return undefined;
  if (input.kind === 'path') {
    if ((input.agent !== 'pi' && input.agent !== 'omp') || !validPath(input.value))
      return undefined;
  } else if (input.kind === 'id') {
    if (!validId(input.value)) return undefined;
  } else return undefined;
  return NativeSessionPointerSchema.parse({
    harness: harnessForHerdrAgent(input.agent),
    kind: input.kind,
    value: input.value,
    source: input.source,
  });
}

export function codexAppServerThreadPointer(threadId: string): NativeSessionPointer {
  if (!validId(threadId)) throw new Error('Codex app-server thread id is invalid');
  return NativeSessionPointerSchema.parse({
    harness: 'codex-app-server',
    kind: 'thread',
    value: threadId,
    source: 'codex-app-server:thread/read',
  });
}
