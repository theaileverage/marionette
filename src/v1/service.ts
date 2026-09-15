import { Context, Effect, Layer } from 'effect';
import { ClientOperationError, Marionette, type ConnectOptions } from './client.js';
import { executeEffect } from './operations.js';

/** The scoped application boundary. Raw SQLite and session credentials stay private. */
export class MarionetteService extends Context.Service<
  MarionetteService,
  {
    readonly execute: <Input>(input: Input) => ReturnType<typeof executeEffect>;
    readonly watch: Marionette['watchEffect'];
  }
>()('marionette/MarionetteService') {}

export const acquireMarionette = Effect.fn('Marionette.acquire')((options: ConnectOptions = {}) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => Marionette.connect(options),
      catch: (cause) =>
        new ClientOperationError({
          operation: 'connect',
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    }),
    (client) => Effect.sync(() => client.close()),
  ),
);

export const marionetteLayer = (options: ConnectOptions = {}) =>
  Layer.effect(
    MarionetteService,
    Effect.gen(function* () {
      const client = yield* acquireMarionette(options);

      return MarionetteService.of({
        execute: Effect.fn('MarionetteService.execute')(<Input>(input: Input) =>
          executeEffect(client, input),
        ),
        watch: client.watchEffect.bind(client),
      });
    }),
  );
