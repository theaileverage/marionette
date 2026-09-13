import { z } from 'zod';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

type EffectDescription = {
  readonly kind: 'refinement' | 'transform' | 'preprocess';
  readonly executable: false;
};

type DescriptionBase = {
  readonly required: boolean;
  readonly default?: JsonValue;
  readonly defaultStatus?: 'not-evaluated';
  readonly effects?: readonly EffectDescription[];
};

type StringDescription = {
  readonly type: 'string';
  readonly enum?: readonly JsonPrimitive[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: { readonly source: string; readonly flags: string };
};

type NumberDescription = {
  readonly type: 'number';
  readonly integer?: true;
  readonly finite?: true;
  readonly minimum?: { readonly value: number; readonly inclusive: boolean };
  readonly maximum?: { readonly value: number; readonly inclusive: boolean };
};

type StringMetadata = {
  type: 'string';
  minLength?: number;
  maxLength?: number;
  pattern?: { source: string; flags: string };
};
type NumberMetadata = {
  type: 'number';
  integer?: true;
  finite?: true;
  minimum?: { value: number; inclusive: boolean };
  maximum?: { value: number; inclusive: boolean };
};
type ArrayMetadata = {
  type: 'array';
  items: SchemaDescription;
  minItems?: number;
  maxItems?: number;
  exactItems?: number;
};

type SchemaDescriptionNode =
  | StringDescription
  | NumberDescription
  | {
      readonly type: 'boolean' | 'null' | 'unknown' | 'literal';
      readonly enum?: readonly JsonPrimitive[];
    }
  | {
      readonly type: 'object';
      readonly unknownKeys: 'strip' | 'strict' | 'passthrough';
      readonly fields: Readonly<Record<string, SchemaDescription>>;
    }
  | {
      readonly type: 'array';
      readonly items: SchemaDescription;
      readonly minItems?: number;
      readonly maxItems?: number;
      readonly exactItems?: number;
    }
  | {
      readonly type: 'tuple';
      readonly items: readonly SchemaDescription[];
      readonly rest?: SchemaDescription;
    }
  | {
      readonly type: 'record';
      readonly keys: SchemaDescription;
      readonly values: SchemaDescription;
    }
  | {
      readonly type: 'union';
      readonly options: readonly SchemaDescription[];
      readonly discriminator?: string;
    };

export type SchemaDescription = DescriptionBase & SchemaDescriptionNode;

type Modifiers = {
  readonly required: boolean;
  readonly defaultValue?: JsonValue;
  readonly defaultStatus?: 'not-evaluated';
};

const knownStaticDefaults = new WeakMap<z.ZodTypeAny, JsonValue>();

export function registerStaticDefault(schema: z.ZodTypeAny, value: JsonValue): void {
  knownStaticDefaults.set(schema, value);
}

function applyModifiers(
  description: SchemaDescriptionNode,
  modifiers: Modifiers,
): SchemaDescription {
  if (modifiers.defaultValue !== undefined)
    return { ...description, required: modifiers.required, default: modifiers.defaultValue };
  if (modifiers.defaultStatus !== undefined)
    return { ...description, required: modifiers.required, defaultStatus: modifiers.defaultStatus };
  return { ...description, required: modifiers.required };
}

function stringDescription(schema: z.ZodString): StringDescription {
  const description: StringMetadata = { type: 'string' };
  for (const check of schema._def.checks) {
    if (check.kind === 'min') description.minLength = check.value;
    if (check.kind === 'max') description.maxLength = check.value;
    if (check.kind === 'regex')
      description.pattern = { source: check.regex.source, flags: check.regex.flags };
  }
  return description;
}

function numberDescription(schema: z.ZodNumber): NumberDescription {
  const description: NumberMetadata = { type: 'number' };
  for (const check of schema._def.checks) {
    if (check.kind === 'int') description.integer = true;
    if (check.kind === 'finite') description.finite = true;
    if (check.kind === 'min')
      description.minimum = { value: check.value, inclusive: check.inclusive };
    if (check.kind === 'max')
      description.maximum = { value: check.value, inclusive: check.inclusive };
  }
  return description;
}

function withEffect(description: SchemaDescription, effect: EffectDescription): SchemaDescription {
  return { ...description, effects: [...(description.effects ?? []), effect] };
}

function describeEffects(
  schema: z.ZodEffects<z.ZodTypeAny>,
  modifiers: Modifiers,
): SchemaDescription {
  const description = describeSchemaInner(schema.innerType(), modifiers);
  switch (schema._def.effect.type) {
    case 'refinement':
      return withEffect(description, { kind: 'refinement', executable: false });
    case 'transform':
      return withEffect(description, { kind: 'transform', executable: false });
    case 'preprocess':
      return withEffect(description, { kind: 'preprocess', executable: false });
  }
}

function describeSchemaInner(schema: z.ZodTypeAny, modifiers: Modifiers): SchemaDescription {
  if (schema instanceof z.ZodOptional)
    return describeSchemaInner(schema.unwrap(), { ...modifiers, required: false });
  if (schema instanceof z.ZodDefault) {
    const defaultValue = knownStaticDefaults.get(schema);
    return describeSchemaInner(schema.removeDefault(), {
      ...modifiers,
      required: false,
      ...(defaultValue === undefined ? { defaultStatus: 'not-evaluated' } : { defaultValue }),
    });
  }
  if (schema instanceof z.ZodNullable)
    return applyModifiers(
      {
        type: 'union',
        options: [describeSchemaInner(schema.unwrap(), { required: true }), nullDescription()],
      },
      modifiers,
    );
  if (schema instanceof z.ZodBranded) return describeSchemaInner(schema.unwrap(), modifiers);
  if (schema instanceof z.ZodEffects) return describeEffects(schema, modifiers);

  if (schema instanceof z.ZodString) return applyModifiers(stringDescription(schema), modifiers);
  if (schema instanceof z.ZodNumber) return applyModifiers(numberDescription(schema), modifiers);
  if (schema instanceof z.ZodBoolean) return applyModifiers({ type: 'boolean' }, modifiers);
  if (schema instanceof z.ZodNull) return applyModifiers(nullDescription(), modifiers);
  if (schema instanceof z.ZodUnknown) return applyModifiers({ type: 'unknown' }, modifiers);
  if (schema instanceof z.ZodLiteral) {
    const value: JsonPrimitive = schema.value;
    return applyModifiers({ type: 'literal', enum: [value] }, modifiers);
  }
  if (schema instanceof z.ZodEnum)
    return applyModifiers({ type: 'string', enum: schema.options }, modifiers);
  if (schema instanceof z.ZodArray) {
    const description: ArrayMetadata = {
      type: 'array',
      items: describeSchemaInner(schema.element, { required: true }),
    };
    if (schema._def.minLength) description.minItems = schema._def.minLength.value;
    if (schema._def.maxLength) description.maxItems = schema._def.maxLength.value;
    if (schema._def.exactLength) description.exactItems = schema._def.exactLength.value;
    return applyModifiers(description, modifiers);
  }
  if (schema instanceof z.ZodObject) {
    const fields: Record<string, SchemaDescription> = {};
    for (const name of Object.keys(schema.shape))
      fields[name] = describeSchemaInner(schema.shape[name], { required: true });
    return applyModifiers(
      { type: 'object', unknownKeys: schema._def.unknownKeys, fields },
      modifiers,
    );
  }
  if (schema instanceof z.ZodDiscriminatedUnion)
    return applyModifiers(
      {
        type: 'union',
        discriminator: schema.discriminator,
        options: schema.options.map((option: z.ZodTypeAny) =>
          describeSchemaInner(option, { required: true }),
        ),
      },
      modifiers,
    );
  if (schema instanceof z.ZodUnion)
    return applyModifiers(
      {
        type: 'union',
        options: schema.options.map((option: z.ZodTypeAny) =>
          describeSchemaInner(option, { required: true }),
        ),
      },
      modifiers,
    );
  if (schema instanceof z.ZodTuple) {
    const items = schema.items.map((item: z.ZodTypeAny) =>
      describeSchemaInner(item, { required: true }),
    );
    if (schema._def.rest)
      return applyModifiers(
        { type: 'tuple', items, rest: describeSchemaInner(schema._def.rest, { required: true }) },
        modifiers,
      );
    return applyModifiers({ type: 'tuple', items }, modifiers);
  }
  if (schema instanceof z.ZodRecord)
    return applyModifiers(
      {
        type: 'record',
        keys: describeSchemaInner(schema.keySchema, { required: true }),
        values: describeSchemaInner(schema.valueSchema, { required: true }),
      },
      modifiers,
    );

  throw new Error(`Unsupported Zod schema type: ${schema._def.typeName}`);
}

function nullDescription(): SchemaDescription {
  return applyModifiers({ type: 'null', enum: [null] }, { required: true });
}

export function describeSchema(schema: z.ZodTypeAny): SchemaDescription {
  return describeSchemaInner(schema, { required: true });
}
