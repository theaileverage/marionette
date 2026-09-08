import { Effect, Exit, Fiber, FiberMap, Scope } from 'effect';

/** An imperative ingress for synchronous schedulers; every job belongs to this scope. */
export class ScopedTasks {
  private readonly scope = Scope.makeUnsafe();
  private readonly fibers = Effect.runSync(
    FiberMap.make<string, void>().pipe(Effect.provideService(Scope.Scope, this.scope)),
  );
  private readonly fork = Effect.runSync(FiberMap.runtime(this.fibers)());
  private accepting = true;
  private closed = false;
  has(id: string) {
    return FiberMap.hasUnsafe(this.fibers, id);
  }
  run<E>(id: string, effect: Effect.Effect<void, E>) {
    if (!this.accepting) return;
    return this.fork(id, effect, { onlyIfMissing: true });
  }
  close = Effect.fn('ScopedTasks.close')({ self: this }, function* (this: ScopedTasks) {
    if (this.closed) return;
    this.accepting = false;
    yield* Effect.forEach(this.fibers, ([, fiber]) => Fiber.await(fiber), { discard: true });
    yield* Scope.close(this.scope, Exit.void);
    this.closed = true;
  });
  interrupt(id: string) {
    return FiberMap.remove(this.fibers, id);
  }
  cancel = Effect.fn('ScopedTasks.cancel')({ self: this }, function* (this: ScopedTasks) {
    if (this.closed) return;
    this.accepting = false;
    yield* Scope.close(this.scope, Exit.void);
    this.closed = true;
  });
}
