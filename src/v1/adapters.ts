import { z } from 'zod';
import { describeSchema, type SchemaDescription, type JsonValue } from './schema-description.js';

export const adapterApiVersion = 1 as const;
export const adapterReferenceSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9.-]{0,127}$/),
    version: z.number().int().positive(),
  })
  .strict();
export type AdapterReference = z.infer<typeof adapterReferenceSchema>;
export type AdapterValue = JsonValue;
const objectInputSchema = z.object({}).passthrough();
const plainObjectSchema = z.custom<object>((value) => {
  if (!objectInputSchema.safeParse(value).success) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
});
const plainArraySchema = z.custom<object>(
  (value) => Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype,
);
export const adapterValueSchema: z.ZodType<AdapterValue, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    plainArraySchema.pipe(z.array(adapterValueSchema)),
    plainObjectSchema
      .pipe(z.record(adapterValueSchema.optional()))
      .transform((value) =>
        Object.fromEntries(
          Object.entries(value).flatMap(([key, entry]): [string, AdapterValue][] =>
            entry === undefined ? [] : [[key, entry]],
          ),
        ),
      ),
  ]),
);

export type AdapterCallOptions = { readonly signal?: AbortSignal };
export type AdapterEffect = 'read' | 'mutation';
export type AdapterFailureCode =
  | 'invalid-reference'
  | 'duplicate-capability'
  | 'duplicate-adapter'
  | 'adapter-not-found'
  | 'unsupported-capability'
  | 'invalid-input'
  | 'invalid-output'
  | 'aborted'
  | 'execution-failed';

export class AdapterError extends Error {
  constructor(
    readonly code: AdapterFailureCode,
    message: string,
    readonly phase: 'before-invocation' | 'after-invocation',
    readonly fields: readonly string[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AdapterError';
  }
}

function parseReference(reference: AdapterReference): AdapterReference {
  const parsed = adapterReferenceSchema.safeParse(reference);
  if (!parsed.success)
    throw new AdapterError(
      'invalid-reference',
      'An adapter needs a valid id and positive contract version.',
      'before-invocation',
    );
  return parsed.data;
}

function adapterPayload<Value>(value: Value, direction: 'input' | 'output'): AdapterValue {
  try {
    return adapterValueSchema.parse(value);
  } catch {
    throw new AdapterError(
      direction === 'input' ? 'invalid-input' : 'invalid-output',
      `Adapter ${direction} must be JSON serializable.`,
      direction === 'input' ? 'before-invocation' : 'after-invocation',
    );
  }
}

async function validateCapability<Schema extends z.ZodTypeAny, Value>(
  schema: Schema,
  value: Value,
  direction: 'input' | 'output',
): Promise<z.output<Schema>> {
  const phase = direction === 'input' ? 'before-invocation' : 'after-invocation';
  const code = direction === 'input' ? 'invalid-input' : 'invalid-output';
  try {
    const result = await schema.safeParseAsync(value);
    if (result.success) return result.data;
    throw new AdapterError(
      code,
      `Adapter ${direction} does not match its capability contract.`,
      phase,
      result.error.issues.map((issue) => issue.path.join('.')),
    );
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw new AdapterError(code, `Adapter ${direction} validation failed.`, phase);
  }
}

export type AdapterCapability<
  Input extends z.ZodTypeAny = z.ZodTypeAny,
  Output extends z.ZodTypeAny = z.ZodTypeAny,
> = {
  readonly input: Input;
  readonly output: Output;
  readonly effect: AdapterEffect;
  readonly summary: string;
  readonly execute: (input: AdapterValue, options: AdapterCallOptions) => Promise<AdapterValue>;
};
export type AdapterCapabilities = Readonly<Record<string, AdapterCapability>>;

export function defineCapability<
  Input extends z.ZodTypeAny,
  Output extends z.ZodTypeAny,
>(definition: {
  input: Input;
  output: Output;
  effect: AdapterEffect;
  summary: string;
  execute: (
    input: z.output<Input>,
    options: AdapterCallOptions,
  ) => z.input<Output> | Promise<z.input<Output>>;
}): AdapterCapability<Input, Output> {
  return Object.freeze({
    input: definition.input,
    output: definition.output,
    effect: definition.effect,
    summary: definition.summary,
    async execute(input, options) {
      if (options.signal?.aborted)
        throw new AdapterError(
          'aborted',
          'Adapter invocation was cancelled before execution.',
          'before-invocation',
        );
      const parsed = await validateCapability(definition.input, input, 'input');
      if (options.signal?.aborted)
        throw new AdapterError(
          'aborted',
          'Adapter invocation was cancelled before execution.',
          'before-invocation',
        );
      const result = await definition.execute(parsed, options);
      const output = await validateCapability(definition.output, result, 'output');
      return adapterPayload(output, 'output');
    },
  });
}

export type AdapterDescription = {
  readonly apiVersion: 1;
  readonly adapter: AdapterReference;
  readonly capabilities: readonly {
    readonly name: string;
    readonly summary: string;
    readonly effect: AdapterEffect;
    readonly input: SchemaDescription;
    readonly output: SchemaDescription;
  }[];
};

export type AdapterInput<Capability extends AdapterCapability> = z.input<Capability['input']>;
export type AdapterOutput<Capability extends AdapterCapability> = z.output<Capability['output']>;

export interface AdapterHandle {
  readonly reference: AdapterReference;
  describe(): AdapterDescription;
  dispatch(name: string, input: AdapterValue, options?: AdapterCallOptions): Promise<AdapterValue>;
}

export interface Adapter<Capabilities extends AdapterCapabilities> extends AdapterHandle {
  invoke<Name extends keyof Capabilities & string>(
    name: Name,
    input: AdapterInput<Capabilities[Name]>,
    options?: AdapterCallOptions,
  ): Promise<AdapterOutput<Capabilities[Name]>>;
}

type CapabilityNames<Module> = Module extends AdapterCapabilities ? keyof Module : never;
type CapabilityFor<Module, Name extends PropertyKey> =
  Module extends Record<Name, infer Capability> ? Capability : never;
export type ComposedCapabilities<Modules extends readonly AdapterCapabilities[]> = {
  readonly [Name in CapabilityNames<Modules[number]> & string]: Extract<
    CapabilityFor<Modules[number], Name>,
    AdapterCapability
  >;
};

export function composeAdapter<const Modules extends readonly AdapterCapabilities[]>(
  reference: AdapterReference,
  ...modules: Modules
): Adapter<ComposedCapabilities<Modules>> {
  const validated = parseReference(reference);
  const entries = modules.flatMap((module) => Object.entries(module));
  const names = new Set<string>();
  for (const [name] of entries) {
    if (!/^[a-z][a-z0-9.-]{0,127}$/.test(name))
      throw new AdapterError(
        'unsupported-capability',
        'Capability names must use lowercase letters, numbers, dots, or hyphens.',
        'before-invocation',
      );
    if (names.has(name))
      throw new AdapterError(
        'duplicate-capability',
        'Adapter modules cannot override the same capability.',
        'before-invocation',
        [name],
      );
    names.add(name);
  }
  const capabilities = new Map(entries);
  const frozenReference = Object.freeze(validated);
  async function dispatch(name: string, input: AdapterValue, options: AdapterCallOptions = {}) {
    const capability = capabilities.get(name);
    if (!capability)
      throw new AdapterError(
        'unsupported-capability',
        'This adapter does not implement the requested capability.',
        'before-invocation',
      );
    const value = adapterPayload(input, 'input');
    try {
      return await capability.execute(value, options);
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError(
        'execution-failed',
        'Adapter execution failed. Inspect the outcome before retrying a mutation.',
        'after-invocation',
        [],
        { cause: error },
      );
    }
  }
  const adapter: Adapter<ComposedCapabilities<Modules>> = {
    reference: frozenReference,
    describe: () => ({
      apiVersion: adapterApiVersion,
      adapter: frozenReference,
      capabilities: entries.map(([name, capability]) => ({
        name,
        summary: capability.summary,
        effect: capability.effect,
        input: describeSchema(capability.input),
        output: describeSchema(capability.output),
      })),
    }),
    async invoke(name, input, options = {}) {
      return dispatch(name, input, options);
    },
    dispatch,
  };
  return Object.freeze(adapter);
}

export class AdapterRegistry {
  readonly #adapters = new Map<string, AdapterHandle>();
  constructor(adapters: readonly AdapterHandle[]) {
    for (const adapter of adapters) {
      const reference = parseReference(adapter.reference);
      const key = JSON.stringify(reference);
      if (this.#adapters.has(key))
        throw new AdapterError(
          'duplicate-adapter',
          'An adapter id and version can be registered only once.',
          'before-invocation',
        );
      this.#adapters.set(key, adapter);
    }
  }
  get(reference: AdapterReference): AdapterHandle {
    const parsed = parseReference(reference);
    const adapter = this.#adapters.get(JSON.stringify(parsed));
    if (!adapter)
      throw new AdapterError(
        'adapter-not-found',
        'The exact adapter id and version is not registered.',
        'before-invocation',
      );
    return adapter;
  }
  describe(): readonly AdapterDescription[] {
    return [...this.#adapters.values()].map((adapter) => adapter.describe());
  }
}
