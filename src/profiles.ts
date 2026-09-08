import { catalogProfiles, parseCatalog } from './model-catalog.js';
import { catalogSnapshot } from './model-catalog-snapshot.js';
import { command } from './files.js';
import { AppError } from './types.js';
import { profileSchema, type Profile } from './orchestration-types.js';

export const builtinProfiles: Profile[] = [
  profileSchema.parse({
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
  }
  return args;
}
/** Small opt-in account probe with no task data, tools or model fallback. */
export async function probeProfile(profile: Profile, cwd: string) {
  if (/^(default|fable|opus|sonnet|haiku|auto|latest)$/i.test(profile.model))
    throw new AppError(
      'model_alias',
      'Use an exact model ID so availability and run history are reproducible',
    );
  if (profile.reasoning && !profile.supportedReasoning.includes(profile.reasoning))
    throw new AppError(
      'reasoning_unsupported',
      'Requested effort is absent from the profile capability list',
    );
  if (profile.kind === 'agy') {
    const result = await command('agy', ['models'], cwd, 30000);
    if (result.code !== 0 || result.timedOut)
      throw new AppError(
        'model_probe',
        'AGY model availability query failed: ' + result.output.slice(-2000),
      );
    // Match complete IDs rather than allowing substrings of another available model.
    if (!result.output.split(/[^a-zA-Z0-9_.:/-]+/).includes(profile.model))
      throw new AppError(
        'model_unavailable',
        'The exact model is absent from the current AGY model list',
      );
    return { output: result.output, evidence: `agy models includes exact ID ${profile.model}` };
  }
  const prompt =
    'Reply exactly MARIONETTE_PROFILE_OK. Do not use tools, inspect files, or perform any other work.';
  const args =
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
        ];
  const result = await command(profile.kind, args, cwd, 120000);
  if (result.code !== 0 || result.timedOut)
    throw new AppError(
      'model_unavailable',
      `Exact model probe failed (${result.timedOut ? 'timeout' : result.code}): ${result.output.slice(-3000)}`,
    );
  let records: any[];
  try {
    const value = JSON.parse(result.output);
    records = Array.isArray(value) ? value : [value];
  } catch {
    records = result.output
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
    throw new AppError(
      'model_probe',
      'Native CLI did not return a successful model response; no fallback accepted',
    );
  return {
    output: result.output,
    evidence: `${profile.kind} responded successfully with explicit model ${profile.model}${profile.reasoning ? ` and effort ${profile.reasoning}` : ''}`,
  };
}
