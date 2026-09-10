import { Effect, Schema } from 'effect';
import { readFileSync } from 'node:fs';
import { sync } from './effect-runtime.js';
import { callUrlEffect } from './http-client.js';
import { credentialsSchema } from './types.js';

export const leadCallEffect = Effect.fn('Lead.call')(function* (
  leasePath: string,
  url: string,
  action: string,
  input: Schema.MutableJson,
) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url))
    throw new Error('Lead transport requires a loopback Marionette URL');
  const lease = yield* sync('Lead.readIdentity', () =>
    Schema.decodeUnknownSync(credentialsSchema)(JSON.parse(readFileSync(leasePath, 'utf8'))),
  );
  const { token, ...identity } = lease;
  return yield* callUrlEffect(`${url}/api/lead/call`, token, { action, input, lease: identity });
});
