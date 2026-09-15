import { isAbsolute } from 'node:path';
import { Schema } from 'effect';
import { TimestampSchema } from './model.js';

/**
 * Adapted from Herdr v0.9.0 `src/agent_resume.rs` at
 * b99002ac99b09e00b4ca692436cb15a6b0d676f1 (Apache-2.0).
 *
 * Marionette retains Herdr's official source/agent allow-list and id/path
 * validation, but models Codex app-server threads separately and never builds
 * resume commands from these references.
 */

const nonEmpty = Schema.String.check(Schema.isMinLength(1));

const positiveInteger = Schema.Finite.check(
  Schema.makeFilter((value) => Number.isInteger(value) && value > 0, {
    expected: 'a positive integer',
  }),
);

const nonNegativeInteger = Schema.Finite.check(
  Schema.makeFilter((value) => Number.isInteger(value) && value >= 0, {
    expected: 'a non-negative integer',
  }),
);

const MAX_SESSION_ID_LENGTH = 512;

const MAX_SESSION_PATH_LENGTH = 4096;

export const NativeSessionReferenceKindSchema = Schema.Literals(['id', 'path', 'thread']);

export type NativeSessionReferenceKind = typeof NativeSessionReferenceKindSchema.Type;

export const NativeSessionPointerSchema = Schema.Struct({
  harness: nonEmpty,
  kind: NativeSessionReferenceKindSchema,
  value: nonEmpty,
  source: nonEmpty,
});

export type NativeSessionPointer = typeof NativeSessionPointerSchema.Type;

export const NativeSessionReferenceStatusSchema = Schema.Literals([
  'confirmed',
  'unconfirmed',
  'legacy-untyped',
]);

export type NativeSessionReferenceStatus = typeof NativeSessionReferenceStatusSchema.Type;

export const NativeSessionBindingEvidenceSchema = Schema.Struct({
  workspaceId: nonEmpty,
  tabId: nonEmpty,
  paneId: nonEmpty,
  terminalId: nonEmpty,
  identityRevision: nonNegativeInteger,
  foregroundProcess: Schema.optional(Schema.Struct({ pid: positiveInteger, startToken: nonEmpty })),
  endpointProtocolGeneration: Schema.optional(nonNegativeInteger),
});

export type NativeSessionBindingEvidence = typeof NativeSessionBindingEvidenceSchema.Type;

/** Mutable construction state before a binding is validated or persisted. */
export type NativeSessionBindingDraft = {
  -readonly [Key in keyof NativeSessionBindingEvidence]: NativeSessionBindingEvidence[Key];
};

export const NativeSessionReferenceSchema = Schema.Struct({
  id: nonEmpty,
  attemptId: nonEmpty,
  sessionId: nonEmpty,
  sessionGeneration: positiveInteger,
  hostId: nonEmpty,
  nativeKind: nonEmpty,
  nativeServerGeneration: nonEmpty,
  harness: nonEmpty,
  kind: Schema.Literals(['id', 'path', 'thread', 'legacy']),
  value: nonEmpty,
  source: nonEmpty,
  status: NativeSessionReferenceStatusSchema,
  observedAt: TimestampSchema,
  binding: NativeSessionBindingEvidenceSchema,
  rejectionReason: Schema.NullOr(nonEmpty),
});

export type NativeSessionReference = typeof NativeSessionReferenceSchema.Type;

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

function noControlCharacters(value: string): boolean {
  return !Array.from(value).some((character) => {
    const code = character.codePointAt(0);

    return code !== undefined && (code <= 0x1f || code === 0x7f);
  });
}

function validId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_SESSION_ID_LENGTH && noControlCharacters(value);
}

function validPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_SESSION_PATH_LENGTH &&
    noControlCharacters(value) &&
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

  return Schema.decodeSync(NativeSessionPointerSchema, { onExcessProperty: 'error' })({
    harness: harnessForHerdrAgent(input.agent),
    kind: input.kind,
    value: input.value,
    source: input.source,
  });
}

export function codexAppServerThreadPointer(threadId: string): NativeSessionPointer {
  if (!validId(threadId)) throw new Error('Codex app-server thread id is invalid');

  return Schema.decodeSync(NativeSessionPointerSchema)({
    harness: 'codex-app-server',
    kind: 'thread',
    value: threadId,
    source: 'codex-app-server:thread/read',
  });
}
