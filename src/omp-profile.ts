import { Effect, Schema } from 'effect';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { sync } from './effect-runtime.js';
import { discoverModelsEffect } from './model-catalog.js';
import type { Profile } from './orchestration-types.js';
import { processEffect } from './process.js';
import { AppError } from './types.js';

export function ompProbeSucceeded(output: string, model: string) {
  const record = Schema.Struct({
    type: Schema.Literal('message_end'),
    message: Schema.Struct({
      role: Schema.Literal('assistant'),
      provider: Schema.String,
      model: Schema.String,
      stopReason: Schema.String,
      content: Schema.Array(
        Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
      ),
    }),
  });
  return output.split('\n').some((line) => {
    try {
      const parsed = Schema.decodeUnknownOption(record)(JSON.parse(line));
      return (
        parsed._tag === 'Some' &&
        `${parsed.value.message.provider}/${parsed.value.message.model}` === model &&
        ['stop', 'length'].includes(parsed.value.message.stopReason) &&
        parsed.value.message.content.some(
          (part) => part.type === 'text' && part.text?.trim() === 'MARIONETTE_PROFILE_OK',
        )
      );
    } catch {
      return false;
    }
  });
}

export const probeOmpProfileEffect = Effect.fn('Profile.probeOmp')(function* (
  profile: Profile,
  cwd: string,
) {
  const catalog = yield* discoverModelsEffect('omp', cwd);
  const model = catalog.models.find((m) => m.model === profile.model);
  if (!model || (profile.reasoning && !model.reasoning.includes(profile.reasoning)))
    return yield* new AppError({
      code: 'model_unavailable',
      message:
        'The exact OMP provider/model and reasoning selection is absent from the native catalog',
      status: 400,
    });
  const directory = yield* Effect.acquireRelease(
    sync('Profile.probeDirectory', () => mkdtempSync(resolve(tmpdir(), 'marionette-omp-probe-'))),
    (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
  );
  const extension = resolve(directory, 'probe.js'),
    overlay = resolve(directory, 'config.json');
  yield* sync('Profile.probePolicy', () => {
    writeFileSync(
      extension,
      `export default function(pi) { pi.on('tool_call', () => ({ block: true, reason: 'Profile validation cannot use tools' })); }`,
      { mode: 0o600 },
    );
    writeFileSync(
      overlay,
      JSON.stringify({
        retry: { enabled: false, modelFallback: false },
        advisor: { enabled: false },
      }),
      { mode: 0o600 },
    );
  });
  const result = yield* processEffect(
    'omp',
    [
      '--print',
      '--mode',
      'json',
      '--no-tools',
      '--no-extensions',
      '--no-skills',
      '--no-rules',
      '--no-session',
      '--no-lsp',
      '--no-title',
      '--no-prewalk',
      '--config',
      overlay,
      '--extension',
      extension,
      '--model',
      profile.model,
      ...(profile.reasoning ? ['--thinking', profile.reasoning] : []),
      'Reply exactly MARIONETTE_PROFILE_OK. Do not use tools or inspect files.',
    ],
    { cwd, timeout: 120000, maxBuffer: 1024 * 1024 },
  );
  if (result.code !== 0 || result.timedOut || !ompProbeSucceeded(result.stdout, profile.model))
    return yield* new AppError({
      code: 'model_probe',
      message:
        'OMP did not return a successful response from the exact selected provider/model. No fallback accepted.',
      status: 400,
    });
  return {
    output: result.stdout,
    evidence: `oh-my-pi responded with exact provider/model ${profile.model}${profile.reasoning ? ` and effort ${profile.reasoning}` : ''}`,
  };
}, Effect.scoped);
