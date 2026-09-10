import { Effect, Latch, Option, Schema } from 'effect';
import { spawn } from 'node:child_process';
import { BoundaryError, boundaryError, sync } from './effect-runtime.js';
import { commandEffect } from './files.js';
import { processEffect } from './process.js';
import { profileSchema, type Profile } from './orchestration-types.js';
import { AppError, now, type Kind } from './types.js';
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
const metadataEffect = Effect.fn('ModelCatalog.metadata')(function* (
  binary: string,
  args: string[],
  cwd: string,
  kind: 'codex' | 'claude',
) {
  const { child } = yield* Effect.acquireRelease(
    sync('ModelCatalog.spawn', () => {
      const closed = Latch.makeUnsafe();
      const child = spawn(binary, args, {
        cwd,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.once('close', () => closed.openUnsafe());
      return { child, closed };
    }),
    ({ child, closed }) =>
      Effect.gen(function* () {
        const pid = child.pid;
        if (pid !== undefined && !Latch.isOpen(closed))
          yield* Effect.sync(() => {
            try {
              process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL');
            } catch (error) {
              if (!Schema.is(Schema.Struct({ code: Schema.Literal('ESRCH') }))(error)) throw error;
            }
          });
        yield* closed.await;
      }),
  );
  return yield* Effect.callback<any[], AppError | BoundaryError>((resume) => {
    let buffer = '',
      bytes = 0,
      finished = false,
      nextId = 2;
    const rows: any[] = [];
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      child.stdin.end();
      resume(
        error ? Effect.fail(boundaryError('ModelCatalog.metadata')(error)) : Effect.succeed(rows),
      );
    };
    const send = (value: Schema.MutableJson) => child.stdin.write(JSON.stringify(value) + '\n');
    child.on('error', (error) => finish(error));
    child.stdin.on('error', (error) => {
      if (!finished) finish(error);
    });
    child.stderr.on('data', () => {}); // Native initialization diagnostics can contain account details.
    child.on('exit', () => {
      if (!finished)
        finish(
          new AppError({
            code: 'catalog_unavailable',
            message: `${binary} exited before returning model metadata`,
            status: 400,
          }),
        );
    });
    child.stdout.on('data', (data: Buffer) => {
      bytes += data.length;
      if (bytes > 4 * 1024 * 1024)
        return finish(
          new AppError({
            code: 'catalog_size',
            message: 'Native metadata exceeds 4 MiB',
            status: 400,
          }),
        );
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
              new AppError({
                code: 'catalog_unavailable',
                message: 'Claude SDK initialization did not return supported models',
                status: 400,
              }),
            );
          rows.push(...models);
          finish();
          return;
        }
        if (item.id === 1) {
          if (item.error)
            return finish(
              new AppError({
                code: 'catalog_unavailable',
                message: String(item.error.message),
                status: 400,
              }),
            );
          send({ method: 'initialized' });
          send({ id: nextId, method: 'model/list', params: { limit: 100, includeHidden: false } });
        } else if (item.id === nextId) {
          if (item.error || !Array.isArray(item.result?.data))
            return finish(
              new AppError({
                code: 'catalog_unavailable',
                message: 'Codex model/list failed',
                status: 400,
              }),
            );
          rows.push(...item.result.data);
          if (item.result.nextCursor) {
            if (nextId >= 20)
              return finish(
                new AppError({
                  code: 'catalog_pages',
                  message: 'Too many model catalog pages',
                  status: 400,
                }),
              );
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
  }).pipe(Effect.timeout(30000), Effect.mapError(boundaryError('ModelCatalog.metadata')));
}, Effect.scoped);
const nativeModelSchema = Schema.Struct({
  hidden: Schema.optional(Schema.Boolean),
  value: Schema.optional(Schema.String),
  resolvedModel: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  supportedEffortLevels: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  supportedReasoningEfforts: Schema.optional(
    Schema.Array(Schema.Struct({ reasoningEffort: Schema.String })),
  ),
  inputModalities: Schema.optional(Schema.Array(Schema.String)),
  supportsAdaptiveThinking: Schema.optional(Schema.Boolean),
  supportsFastMode: Schema.optional(Schema.Boolean),
  supportsAutoMode: Schema.optional(Schema.Boolean),
  displayName: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  defaultReasoningEffort: Schema.optional(Schema.String),
});
export function parseCatalog<Input>(kind: Kind, raw: Input): CatalogModel[] {
  const result: CatalogModel[] = [];
  if (kind === 'omp') {
    const catalog = Schema.decodeUnknownSync(
      Schema.Struct({
        models: Schema.Array(
          Schema.Struct({
            provider: Schema.String,
            id: Schema.String,
            selector: Schema.String,
            name: Schema.String,
            thinking: Schema.NullOr(Schema.Array(Schema.String)),
            input: Schema.Array(Schema.String),
          }),
        ),
      }),
    )(raw);
    for (const item of catalog.models) {
      if (
        item.selector !== `${item.provider}/${item.id}` ||
        /^(auto|default|latest)$/.test(item.id)
      )
        continue;
      result.push({
        model: item.selector,
        name: item.name,
        description: `Listed by oh-my-pi provider ${item.provider}; availability requires an account probe.`,
        reasoning: [...(item.thinking ?? [])],
        capabilities: ['tools', ...item.input],
      });
    }
    return [...new Map(result.map((m) => [m.model, m])).values()];
  }
  if (kind === 'agy') {
    if (!Schema.is(Schema.String)(raw))
      throw new AppError({
        code: 'catalog_format',
        message: 'AGY catalog must be tab-separated text',
        status: 400,
      });
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
      throw new AppError({
        code: 'catalog_format',
        message: 'Native catalog must be an array',
        status: 400,
      });
    for (const candidate of raw) {
      const decoded = Schema.decodeUnknownOption(nativeModelSchema)(candidate);
      if (Option.isNone(decoded)) continue;
      const item = decoded.value;
      if (kind === 'codex' && item.hidden) continue;
      const model =
        kind === 'claude'
          ? item.value !== undefined && item.value.startsWith('claude-')
            ? item.value
            : item.resolvedModel
          : item.model;
      if (
        model === undefined ||
        !model.trim() ||
        /^(default|auto|latest|opus|sonnet|haiku|fable)(\[.*\])?$/.test(model)
      )
        continue;
      const reasoning =
        (kind === 'claude'
          ? item.supportedEffortLevels
          : item.supportedReasoningEfforts?.map((e) => e.reasoningEffort)) ?? [];
      const capabilities = [
        'tools',
        ...(kind === 'codex' ? (item.inputModalities ?? []) : []),
        ...(item.supportsAdaptiveThinking ? ['adaptive-thinking'] : []),
        ...(item.supportsFastMode ? ['fast-mode'] : []),
        ...(item.supportsAutoMode ? ['native-approval-review'] : []),
      ];
      result.push({
        model,
        name: item.displayName ?? model,
        description: item.description ?? 'Native runtime model',
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
    Schema.decodeSync(profileSchema)({
      id: `${catalog.kind}-${m.model}`
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/-$/, ''),
      name: `${catalog.kind === 'codex' ? 'Codex' : catalog.kind === 'claude' ? 'Claude' : catalog.kind === 'omp' ? 'oh-my-pi' : 'AGY'} · ${m.name}`,
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
export const discoverModelsEffect = Effect.fn('discoverModels')(function* (
  kind: Kind,
  cwd: string,
) {
  let raw: unknown, source: string;
  if (kind === 'omp') {
    const result = yield* processEffect('omp', ['models', '--json', '--no-extensions'], {
      cwd,
      timeout: 30000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.code !== 0 || result.timedOut)
      return yield* new AppError({
        code: 'catalog_unavailable',
        message: 'omp models failed',
        status: 400,
      });
    raw = yield* sync('ModelCatalog.omp', () => JSON.parse(result.stdout));
    source = 'omp models --json';
  } else if (kind === 'agy') {
    const result = yield* commandEffect('agy', ['models'], cwd, 30000);
    if (result.code !== 0 || result.timedOut)
      return yield* new AppError({
        code: 'catalog_unavailable',
        message: 'agy models failed',
        status: 400,
      });
    raw = result.output;
    source = 'agy models';
  } else if (kind === 'claude') {
    raw = yield* metadataEffect(
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
    raw = yield* metadataEffect('codex', ['app-server', '--stdio'], cwd, kind);
    source = 'Codex app-server model/list';
  }
  const models = yield* sync('discoverModels.discoverModels', () => parseCatalog(kind, raw));
  if (!models.length)
    return yield* new AppError({
      code: 'catalog_empty',
      message: `${kind} returned no exact selectable model IDs`,
      status: 400,
    });
  return yield* sync('discoverModels.discoverModels', () => ({
    kind,
    models,
    source,
    fetchedAt: now(),
  }));
});
export const discoverModels = (kind: Kind, cwd: string) =>
  Effect.runPromise(discoverModelsEffect(kind, cwd));
