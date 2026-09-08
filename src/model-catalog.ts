import { spawn } from 'node:child_process';
import { command } from './files.js';
import { AppError, now, type Kind } from './types.js';
import { profileSchema, type Profile } from './orchestration-types.js';

export interface CatalogModel {
  model: string;
  name: string;
  description: string;
  reasoning: string[];
  defaultReasoning?: string;
  capabilities: string[];
}
export interface ModelCatalog {
  kind: Kind;
  models: CatalogModel[];
  source: string;
  fetchedAt: string;
}

/** Metadata-only native protocols: never submit a user turn or request a tool. */
async function metadata(
  binary: string,
  args: string[],
  cwd: string,
  kind: 'codex' | 'claude',
): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '',
      bytes = 0,
      finished = false,
      nextId = 2;
    const rows: any[] = [];
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill('SIGTERM');
      error ? reject(error) : resolve(rows);
    };
    const timer = setTimeout(
      () => finish(new AppError('catalog_timeout', `${binary} model metadata timed out`)),
      30000,
    );
    const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + '\n');
    child.on('error', (error) => finish(error));
    child.stdin.on('error', (error) => {
      if (!finished) finish(error);
    });
    child.stderr.on('data', () => {}); // Native initialization diagnostics can contain account details.
    child.on('exit', () => {
      if (!finished)
        finish(
          new AppError('catalog_unavailable', `${binary} exited before returning model metadata`),
        );
    });
    child.stdout.on('data', (data: Buffer) => {
      bytes += data.length;
      if (bytes > 4 * 1024 * 1024)
        return finish(new AppError('catalog_size', 'Native metadata exceeds 4 MiB'));
      buffer += data.toString();
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let item: any;
        try {
          item = JSON.parse(line);
        } catch {
          continue;
        }
        if (kind === 'claude') {
          if (
            item.type !== 'control_response' ||
            item.response?.request_id !== 'marionette-catalog'
          )
            continue;
          const models = item.response.response?.models;
          if (!Array.isArray(models))
            return finish(
              new AppError(
                'catalog_unavailable',
                'Claude SDK initialization did not return supported models',
              ),
            );
          rows.push(...models);
          finish();
          return;
        }
        if (item.id === 1) {
          if (item.error)
            return finish(new AppError('catalog_unavailable', String(item.error.message)));
          send({ method: 'initialized' });
          send({ id: nextId, method: 'model/list', params: { limit: 100, includeHidden: false } });
        } else if (item.id === nextId) {
          if (item.error || !Array.isArray(item.result?.data))
            return finish(new AppError('catalog_unavailable', 'Codex model/list failed'));
          rows.push(...item.result.data);
          if (item.result.nextCursor) {
            if (nextId >= 20)
              return finish(new AppError('catalog_pages', 'Too many model catalog pages'));
            nextId++;
            send({
              id: nextId,
              method: 'model/list',
              params: { limit: 100, includeHidden: false, cursor: item.result.nextCursor },
            });
          } else {
            finish();
            return;
          }
        }
      }
    });
    if (kind === 'claude')
      send({
        type: 'control_request',
        request_id: 'marionette-catalog',
        request: { subtype: 'initialize', hooks: null },
      });
    else
      send({
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'marionette-model-catalog', version: '0.2.0' } },
      });
  });
}
export function parseCatalog(kind: Kind, raw: unknown): CatalogModel[] {
  const result: CatalogModel[] = [];
  if (kind === 'agy') {
    if (typeof raw !== 'string')
      throw new AppError('catalog_format', 'AGY catalog must be tab-separated text');
    for (const line of raw.split('\n')) {
      const [model, name] = line.trim().split('\t');
      if (!model || !name || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]+$/.test(model)) continue;
      const effort = /-(high|medium|low)$/.exec(model)?.[1];
      result.push({
        model,
        name,
        description: `Listed by AGY as ${name}. Evaluate suitability for the assigned work.`,
        reasoning: effort ? [effort] : [],
        defaultReasoning: effort,
        capabilities: [
          'tools',
          ...(effort ? ['reasoning-in-model-id'] : []),
          ...(/thinking/i.test(name) ? ['thinking'] : []),
        ],
      });
    }
  } else {
    if (!Array.isArray(raw))
      throw new AppError('catalog_format', 'Native catalog must be an array');
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      if (kind === 'codex' && item.hidden) continue;
      const model =
        kind === 'claude'
          ? typeof item.value === 'string' && item.value.startsWith('claude-')
            ? item.value
            : item.resolvedModel
          : item.model;
      if (
        typeof model !== 'string' ||
        !model.trim() ||
        /^(default|auto|latest|opus|sonnet|haiku|fable)(\[.*\])?$/.test(model)
      )
        continue;
      const reasoning =
        (kind === 'claude'
          ? item.supportedEffortLevels
          : item.supportedReasoningEfforts?.map((e: any) => e.reasoningEffort)) ?? [];
      if (!Array.isArray(reasoning) || reasoning.some((e) => typeof e !== 'string')) continue;
      const capabilities = [
        'tools',
        ...(kind === 'codex'
          ? (item.inputModalities ?? []).filter((x: unknown) => typeof x === 'string')
          : []),
        ...(item.supportsAdaptiveThinking ? ['adaptive-thinking'] : []),
        ...(item.supportsFastMode ? ['fast-mode'] : []),
        ...(item.supportsAutoMode ? ['native-approval-review'] : []),
      ];
      result.push({
        model,
        name: typeof item.displayName === 'string' ? item.displayName : model,
        description:
          typeof item.description === 'string' ? item.description : 'Native runtime model',
        reasoning,
        defaultReasoning:
          kind === 'codex'
            ? item.defaultReasoningEffort
            : reasoning.includes('high')
              ? 'high'
              : reasoning[0],
        capabilities,
      });
    }
  }
  return [...new Map(result.map((model) => [model.model, model])).values()];
}
export function catalogProfiles(catalog: ModelCatalog): Profile[] {
  return catalog.models.map((m) =>
    profileSchema.parse({
      id: `${catalog.kind}-${m.model}`
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/-$/, ''),
      name: `${catalog.kind === 'codex' ? 'Codex' : catalog.kind === 'claude' ? 'Claude' : 'AGY'} · ${m.name}`,
      kind: catalog.kind,
      model: m.model,
      reasoning: m.defaultReasoning,
      supportedReasoning: m.reasoning,
      categories: ['orchestration', 'research', 'implementation', 'review', 'analysis', 'decision'],
      capabilities: m.capabilities,
      strengths: `Native catalog description: ${m.description} Category labels are selectable uses, not benchmark results.`,
      canDelegate: true,
      maxConcurrency: 2,
      availability: 'unverified',
      availabilityEvidence: `Listed by ${catalog.source} at ${catalog.fetchedAt}; not launch-tested on this account. Use profile.validate before dispatch.`,
    }),
  );
}
export async function discoverModels(kind: Kind, cwd: string): Promise<ModelCatalog> {
  let raw: unknown, source: string;
  if (kind === 'agy') {
    const result = await command('agy', ['models'], cwd, 30000);
    if (result.code !== 0 || result.timedOut)
      throw new AppError('catalog_unavailable', 'agy models failed');
    raw = result.output;
    source = 'agy models';
  } else if (kind === 'claude') {
    raw = await metadata(
      'claude',
      [
        '--print',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--tools',
        '',
        '--strict-mcp-config',
        '--disable-slash-commands',
        '--no-session-persistence',
      ],
      cwd,
      kind,
    );
    source = 'Claude SDK initialization supported models';
  } else {
    raw = await metadata('codex', ['app-server', '--stdio'], cwd, kind);
    source = 'Codex app-server model/list';
  }
  const models = parseCatalog(kind, raw);
  if (!models.length)
    throw new AppError('catalog_empty', `${kind} returned no exact selectable model IDs`);
  return { kind, models, source, fetchedAt: now() };
}
