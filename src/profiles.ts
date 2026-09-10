import { Effect, Schema } from 'effect';
import { sync } from './effect-runtime.js';
import { commandEffect } from './files.js';
import { catalogSnapshot } from './model-catalog-snapshot.js';
import { catalogProfiles, parseCatalog } from './model-catalog.js';
import { profileSchema, type Profile } from './orchestration-types.js';
import { AppError } from './types.js';
import { probeOmpProfileEffect } from './omp-profile.js';
export const builtinProfiles: Profile[] = [
  Schema.decodeSync(profileSchema)({
    id: 'claude-fable-orchestration',
    name: 'Claude Fable',
    kind: 'claude',
    model: 'claude-fable-5',
    reasoning: 'high',
    supportedReasoning: ['low', 'medium', 'high', 'xhigh', 'max'],
    categories: ['orchestration', 'research', 'review'],
    capabilities: ['tools', 'same-session-continuation'],
    strengths:
      'Candidate for orchestration and evidence synthesis; validate on your account and evaluate on representative work.',
    canDelegate: true,
    maxConcurrency: 2,
  }),
  ...(['codex', 'claude', 'agy'] as const).flatMap((kind) =>
    catalogProfiles({
      kind,
      models: parseCatalog(kind, catalogSnapshot[kind]),
      source:
        kind === 'codex'
          ? 'Codex app-server model/list'
          : kind === 'claude'
            ? 'Claude SDK initialization supported models'
            : 'agy models',
      fetchedAt: '2026-09-08',
    }),
  ),
];
export function profileArgs(p: Pick<Profile, 'kind' | 'model' | 'reasoning'>) {
  const args = ['--model', p.model];
  if (p.reasoning) {
    if (p.kind === 'codex')
      args.push('-c', `model_reasoning_effort=${JSON.stringify(p.reasoning)}`);
    else if (p.kind === 'claude') args.push('--effort', p.reasoning);
    else if (p.kind === 'omp') args.push('--thinking', p.reasoning);
  }
  return args;
}
/** Small opt-in account probe with no task data, tools or model fallback. */
export const probeProfileEffect = Effect.fn('probeProfile')(function* (
  profile: Profile,
  cwd: string,
) {
  if (profile.kind === 'omp') return yield* probeOmpProfileEffect(profile, cwd);
  if (/^(default|fable|opus|sonnet|haiku|auto|latest)$/i.test(profile.model))
    return yield* new AppError({
      code: 'model_alias',
      message: 'Use an exact model ID so availability and run history are reproducible',
      status: 400,
    });
  if (profile.reasoning && !profile.supportedReasoning.includes(profile.reasoning))
    return yield* new AppError({
      code: 'reasoning_unsupported',
      message: 'Requested effort is absent from the profile capability list',
      status: 400,
    });
  if (profile.kind === 'agy') {
    const result = yield* commandEffect('agy', ['models'], cwd, 30000);
    if (result.code !== 0 || result.timedOut)
      return yield* new AppError({
        code: 'model_probe',
        message: 'AGY model availability query failed: ' + result.output.slice(-2000),
        status: 400,
      });
    // Match complete IDs rather than allowing substrings of another available model.
    if (!result.output.split(/[^a-zA-Z0-9_.:/-]+/).includes(profile.model))
      return yield* new AppError({
        code: 'model_unavailable',
        message: 'The exact model is absent from the current AGY model list',
        status: 400,
      });
    return { output: result.output, evidence: `agy models includes exact ID ${profile.model}` };
  }
  const prompt =
    'Reply exactly MARIONETTE_PROFILE_OK. Do not use tools, inspect files, or perform any other work.';
  const args = yield* sync('probeProfile.probeProfile', () =>
    profile.kind === 'claude'
      ? [
          '--print',
          '--output-format',
          'json',
          '--tools',
          '',
          '--disable-slash-commands',
          '--strict-mcp-config',
          ...profileArgs(profile),
          prompt,
        ]
      : [
          'exec',
          '--json',
          '--skip-git-repo-check',
          '--sandbox',
          'read-only',
          ...profileArgs(profile),
          prompt,
        ],
  );
  const result = yield* commandEffect(profile.kind, args, cwd, 120000);
  if (result.code !== 0 || result.timedOut)
    return yield* new AppError({
      code: 'model_unavailable',
      message: `Exact model probe failed (${result.timedOut ? 'timeout' : result.code}): ${result.output.slice(-3000)}`,
      status: 400,
    });
  const records = yield* sync('Profile.decodeResponse', () => {
    try {
      const value = JSON.parse(result.output);
      return Array.isArray(value) ? value : [value];
    } catch {
      return result.output
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
    }
  });
  if (
    !records.some(
      (item) =>
        (item.type === 'result' &&
          !item.is_error &&
          item.result?.includes('MARIONETTE_PROFILE_OK')) ||
        (item.type === 'item.completed' &&
          item.item?.type === 'agent_message' &&
          item.item.text?.includes('MARIONETTE_PROFILE_OK')),
    )
  )
    return yield* new AppError({
      code: 'model_probe',
      message: 'Native CLI did not return a successful model response; no fallback accepted',
      status: 400,
    });
  return {
    output: result.output,
    evidence: `${profile.kind} responded successfully with explicit model ${profile.model}${profile.reasoning ? ` and effort ${profile.reasoning}` : ''}`,
  };
});
export const probeProfile = (profile: Profile, cwd: string) =>
  Effect.runPromise(probeProfileEffect(profile, cwd));
