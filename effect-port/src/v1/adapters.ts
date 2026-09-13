import { Context, Effect, Layer, Schema } from 'effect';

export const adapterApiVersion = 1 as const;
const nonEmpty = Schema.String.check(Schema.isMinLength(1));
const positiveInteger = Schema.Finite.check(
  Schema.makeFilter((value) => Number.isInteger(value) && value > 0, { expected: 'a positive integer' }),
);

export const adapterReferenceSchema = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9.-]{0,127}$/)),
  version: positiveInteger,
});
export type AdapterReference = typeof adapterReferenceSchema.Type;

export type AdapterValue = string | number | boolean | null | ReadonlyArray<AdapterValue> | { readonly [key: string]: AdapterValue };
function isAdapterValue(value: unknown, seen = new Set<object>()): value is AdapterValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value))
    return Object.getPrototypeOf(value) === Array.prototype && value.every((entry) => isAdapterValue(entry, seen));
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) &&
    Object.values(value).every((entry) => entry !== undefined && isAdapterValue(entry, seen));
}
function normalizeAdapterValue(value: unknown, seen = new Set<object>()): AdapterValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || seen.has(value)) throw new Error('not a finite JSON value');
  seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error('not a plain array');
    const normalized = value.map((entry) => normalizeAdapterValue(entry, seen));
    seen.delete(value);
    return normalized;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('not a plain object');
  const normalized: Record<string, AdapterValue> = {};
  for (const [key, entry] of Object.entries(value)) if (entry !== undefined) normalized[key] = normalizeAdapterValue(entry, seen);
  seen.delete(value);
  return normalized;
}
export const adapterValueSchema = Schema.Unknown.check(
  Schema.makeFilter((value) => isAdapterValue(value), { expected: 'a finite JSON value' }),
);

export type AdapterCallOptions = { readonly signal?: AbortSignal };
export type AdapterEffect = 'read' | 'mutation';
export type AdapterFailureCode = 'invalid-reference' | 'duplicate-capability' | 'duplicate-adapter' | 'adapter-not-found' | 'unsupported-capability' | 'invalid-input' | 'invalid-output' | 'aborted' | 'execution-failed';
export class AdapterError extends Schema.TaggedError<AdapterError>()('AdapterError', {
  code: Schema.Literals(['invalid-reference', 'duplicate-capability', 'duplicate-adapter', 'adapter-not-found', 'unsupported-capability', 'invalid-input', 'invalid-output', 'aborted', 'execution-failed']),
  message: nonEmpty,
  phase: Schema.Literals(['before-invocation', 'after-invocation']),
  fields: Schema.Array(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {}
const failure = (code: AdapterFailureCode, message: string, phase: 'before-invocation' | 'after-invocation', fields: ReadonlyArray<string> = [], cause?: unknown) =>
  new AdapterError({ code, message, phase, fields, ...(cause === undefined ? {} : { cause }) });

function issueFields(cause: unknown): ReadonlyArray<string> {
  const fields = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const issue = value as { path?: unknown; issue?: unknown; issues?: unknown };
    if (Array.isArray(issue.path)) {
      for (const part of issue.path) if (typeof part === 'string') fields.add(part);
    }
    visit(issue.issue);
    if (Array.isArray(issue.issues)) for (const child of issue.issues) visit(child);
  };
  visit((cause as { issue?: unknown } | undefined)?.issue);
  return [...fields];
}

function parseReference(reference: unknown): AdapterReference {
  try {
    return Schema.decodeUnknownSync(adapterReferenceSchema, { onExcessProperty: 'error' })(reference);
  } catch (cause) {
    throw failure('invalid-reference', 'An adapter needs a valid id and positive contract version.', 'before-invocation', [], cause);
  }
}
function adapterPayload(value: unknown, direction: 'input' | 'output'): AdapterValue {
  try {
    return normalizeAdapterValue(value);
  } catch (cause) {
    throw failure(direction === 'input' ? 'invalid-input' : 'invalid-output', `Adapter ${direction} must be JSON serializable.`, direction === 'input' ? 'before-invocation' : 'after-invocation', [], cause);
  }
}
async function validateCapability<S extends Schema.ConstraintDecoder<unknown, never>>(schema: S, value: unknown, direction: 'input' | 'output'): Promise<S['Type']> {
  try {
    return await Schema.decodeUnknownPromise(schema, { onExcessProperty: 'error', errors: 'all' })(value);
  } catch (cause) {
    throw failure(direction === 'input' ? 'invalid-input' : 'invalid-output', `Adapter ${direction} does not match its capability contract.`, direction === 'input' ? 'before-invocation' : 'after-invocation', issueFields(cause), cause);
  }
}

export type AdapterCapability<Input extends Schema.ConstraintDecoder<unknown, never> = Schema.ConstraintDecoder<unknown, never>, Output extends Schema.ConstraintDecoder<unknown, never> = Schema.ConstraintDecoder<unknown, never>> = {
  readonly input: Input;
  readonly output: Output;
  readonly effect: AdapterEffect;
  readonly summary: string;
  readonly execute: (input: AdapterValue, options: AdapterCallOptions) => Promise<AdapterValue>;
  readonly executeEffect: (input: AdapterValue, options: AdapterCallOptions) => Effect.Effect<AdapterValue, AdapterError>;
};
export type AdapterCapabilities = Readonly<Record<string, AdapterCapability>>;
export function defineCapability<Input extends Schema.ConstraintDecoder<unknown, never>, Output extends Schema.ConstraintDecoder<unknown, never>>(definition: {
  readonly input: Input;
  readonly output: Output;
  readonly effect: AdapterEffect;
  readonly summary: string;
  readonly execute: (input: Input['Type'], options: AdapterCallOptions) => Output['Type'] | Promise<Output['Type']>;
  readonly executeEffect?: (input: Input['Type'], options: AdapterCallOptions) => Effect.Effect<Output['Type'], unknown, never>;
}): AdapterCapability<Input, Output> {
  const executeEffect = Effect.fn('AdapterCapability.execute')(function* (input: AdapterValue, options: AdapterCallOptions) {
    if (options.signal?.aborted) return yield* failure('aborted', 'Adapter invocation was cancelled before execution.', 'before-invocation');
    const parsed = yield* Effect.tryPromise({
      try: () => validateCapability(definition.input, input, 'input'),
      catch: (cause) => cause instanceof AdapterError ? cause : failure('invalid-input', 'Adapter input does not match its capability contract.', 'before-invocation', [], cause),
    });
    if (options.signal?.aborted) return yield* failure('aborted', 'Adapter invocation was cancelled before execution.', 'before-invocation');
    const result = definition.executeEffect
      ? yield* definition.executeEffect(parsed, options).pipe(Effect.mapError((cause) => cause instanceof AdapterError ? cause : failure('execution-failed', 'Adapter execution failed. Inspect the outcome before retrying a mutation.', 'after-invocation', [], cause)))
      : yield* Effect.tryPromise({
        try: () => Promise.resolve(definition.execute(parsed, options)),
        catch: (cause) => cause instanceof AdapterError ? cause : failure('execution-failed', 'Adapter execution failed. Inspect the outcome before retrying a mutation.', 'after-invocation', [], cause),
      });
    const validated = yield* Effect.tryPromise({
      try: () => validateCapability(definition.output, result, 'output'),
      catch: (cause) => cause instanceof AdapterError ? cause : failure('invalid-output', 'Adapter output does not match its capability contract.', 'after-invocation', [], cause),
    });
    return yield* Effect.try({
      try: () => adapterPayload(validated, 'output'),
      catch: (cause) => cause instanceof AdapterError ? cause : failure('invalid-output', 'Adapter output must be JSON serializable.', 'after-invocation', [], cause),
    });
  });
  const executePromise = (input: AdapterValue, options: AdapterCallOptions) => Effect.runPromise(executeEffect(input, options));
  return Object.freeze({ ...definition, execute: executePromise, executeEffect });
}

export type AdapterDescription = { readonly apiVersion: 1; readonly adapter: AdapterReference; readonly capabilities: ReadonlyArray<{ readonly name: string; readonly summary: string; readonly effect: AdapterEffect; readonly input: unknown; readonly output: unknown }> };
export type AdapterInput<C extends AdapterCapability> = C['input']['Type'];
export type AdapterOutput<C extends AdapterCapability> = C['output']['Type'];
export interface AdapterHandle { readonly reference: AdapterReference; describe(): AdapterDescription; dispatch(name: string, input: AdapterValue, options?: AdapterCallOptions): Promise<AdapterValue>; dispatchEffect(name: string, input: AdapterValue, options?: AdapterCallOptions): Effect.Effect<AdapterValue, AdapterError> }
export interface Adapter<C extends AdapterCapabilities> extends AdapterHandle { invoke<Name extends keyof C & string>(name: Name, input: AdapterInput<C[Name]>, options?: AdapterCallOptions): Promise<AdapterOutput<C[Name]>>; invokeEffect<Name extends keyof C & string>(name: Name, input: AdapterInput<C[Name]>, options?: AdapterCallOptions): Effect.Effect<AdapterOutput<C[Name]>, AdapterError> }
type CapabilityNames<M> = M extends AdapterCapabilities ? keyof M : never;
type CapabilityFor<M, N extends PropertyKey> = M extends Record<N, infer C> ? C : never;
export type ComposedCapabilities<M extends ReadonlyArray<AdapterCapabilities>> = { readonly [N in CapabilityNames<M[number]> & string]: Extract<CapabilityFor<M[number], N>, AdapterCapability> };

export function composeAdapter<const M extends ReadonlyArray<AdapterCapabilities>>(reference: AdapterReference, ...modules: M): Adapter<ComposedCapabilities<M>> {
  const validated = parseReference(reference);
  const entries = modules.flatMap((module) => Object.entries(module));
  const names = new Set<string>();
  for (const [name] of entries) {
    if (!/^[a-z][a-z0-9.-]{0,127}$/.test(name)) throw failure('unsupported-capability', 'Capability names must use lowercase letters, numbers, dots, or hyphens.', 'before-invocation');
    if (names.has(name)) throw failure('duplicate-capability', 'Adapter modules cannot override the same capability.', 'before-invocation', [name]);
    names.add(name);
  }
  const capabilities = new Map(entries);
  const frozenReference = Object.freeze(validated);
  function dispatch(name: string, input: AdapterValue, options: AdapterCallOptions = {}) {
    return Effect.runPromise(dispatchEffect(name, input, options));
  }
  const dispatchEffect = Effect.fn('Adapter.dispatch')(function* (name: string, input: AdapterValue, options: AdapterCallOptions = {}) {
    const capability = capabilities.get(name);
    if (!capability) return yield* failure('unsupported-capability', 'This adapter does not implement the requested capability.', 'before-invocation');
    const payload = yield* Effect.try({
      try: () => adapterPayload(input, 'input'),
      catch: (cause) => cause instanceof AdapterError ? cause : failure('invalid-input', 'Adapter input must be JSON serializable.', 'before-invocation', [], cause),
    });
    return yield* capability.executeEffect(payload, options);
  });
  const adapter: Adapter<ComposedCapabilities<M>> = {
    reference: frozenReference,
    describe: () => ({ apiVersion: adapterApiVersion, adapter: frozenReference, capabilities: entries.map(([name, capability]) => ({ name, summary: capability.summary, effect: capability.effect, input: Schema.toJsonSchemaDocument(capability.input).schema, output: Schema.toJsonSchemaDocument(capability.output).schema })) }),
    invoke: async (name, input, options = {}) => dispatch(name, input as AdapterValue, options) as Promise<AdapterOutput<ComposedCapabilities<M>[typeof name]>>,
    invokeEffect: (name, input, options = {}) => dispatchEffect(name, input as AdapterValue, options) as Effect.Effect<AdapterOutput<ComposedCapabilities<M>[typeof name]>, AdapterError>,
    dispatch,
    dispatchEffect,
  };
  return Object.freeze(adapter);
}

export class AdapterRegistry {
  readonly #adapters = new Map<string, AdapterHandle>();
  constructor(adapters: ReadonlyArray<AdapterHandle>) {
    for (const adapter of adapters) {
      const reference = parseReference(adapter.reference);
      const key = JSON.stringify(reference);
      if (this.#adapters.has(key)) throw failure('duplicate-adapter', 'An adapter id and version can be registered only once.', 'before-invocation');
      this.#adapters.set(key, adapter);
    }
  }
  get(reference: AdapterReference): AdapterHandle {
    const parsed = parseReference(reference);
    const adapter = this.#adapters.get(JSON.stringify(parsed));
    if (!adapter) throw failure('adapter-not-found', 'The exact adapter id and version is not registered.', 'before-invocation');
    return adapter;
  }
  describe(): ReadonlyArray<AdapterDescription> { return [...this.#adapters.values()].map((adapter) => adapter.describe()); }
}

export interface AdapterInvocationService { readonly invoke: (adapter: AdapterHandle, capability: string, input: AdapterValue, options?: AdapterCallOptions) => Effect.Effect<AdapterValue, AdapterError> }
export class AdapterInvocation extends Context.Service<AdapterInvocation, AdapterInvocationService>()('@marionette/v1/AdapterInvocation') {}
export const adapterInvocationLayer = Layer.succeed(AdapterInvocation, AdapterInvocation.of({
  invoke: Effect.fn('AdapterInvocation.invoke')((adapter, capability, input, options) => adapter.dispatchEffect(capability, input, options)),
}));
