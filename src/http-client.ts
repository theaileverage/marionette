import { Effect, Schema } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/unstable/http';
import { boundaryError } from './effect-runtime.js';
import { AppError } from './types.js';

const ResponseEnvelope = Schema.Struct({
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ code: Schema.String, message: Schema.String })),
});

/** Loopback JSON transport: mutations are never retried automatically. */
export const callUrlEffect = Effect.fn('Http.call')(
  function* (url: string, token: string, body: Schema.MutableJson, _timeoutMs = 45000) {
    const request = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.bodyJson(body),
    );
    const response = yield* HttpClient.execute(request);
    const envelope = yield* Schema.decodeUnknownEffect(ResponseEnvelope)(yield* response.json);
    if (response.status < 200 || response.status >= 300) {
      return yield* new AppError({
        code: envelope.error?.code ?? String(response.status),
        message: envelope.error?.message ?? `HTTP ${response.status}`,
        status: response.status,
      });
    }
    return envelope.result;
  },
  (effect, _url, _token, _body, timeoutMs = 45000) =>
    effect.pipe(
      Effect.timeout(timeoutMs),
      Effect.mapError(boundaryError('Http.call')),
      Effect.provide(FetchHttpClient.layer),
    ),
);

export const healthEffect = Effect.fn('Http.health')(
  function* (url: string) {
    const response = yield* HttpClient.get(url);
    return yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        pid: Schema.optional(Schema.Finite),
        ok: Schema.optional(Schema.Boolean),
        id: Schema.optional(Schema.String),
        setupVersion: Schema.optional(Schema.Finite),
        version: Schema.optional(Schema.String),
        runtime: Schema.optional(Schema.String),
      }),
    )(yield* response.json);
  },
  (effect) =>
    effect.pipe(
      Effect.timeout(3000),
      Effect.mapError(boundaryError('Http.health')),
      Effect.provide(FetchHttpClient.layer),
    ),
);
