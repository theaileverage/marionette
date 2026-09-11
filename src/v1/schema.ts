import { z } from 'zod';
import { operationSchema } from './operations.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

type DescriptionBase = {
  readonly required: boolean;
  readonly default?: JsonValue;
};

type SchemaDescriptionNode =
  | {
      readonly type: 'string' | 'number' | 'boolean' | 'null' | 'unknown' | 'literal';
      readonly enum?: readonly JsonPrimitive[];
    }
  | { readonly type: 'object'; readonly fields: Readonly<Record<string, SchemaDescription>> }
  | { readonly type: 'array'; readonly items: SchemaDescription }
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

export type OperationDescription = {
  readonly operation: string;
  readonly fields: Readonly<Record<string, SchemaDescription>>;
};

type Modifiers = {
  readonly required: boolean;
  readonly defaultValue?: JsonValue;
};

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

function applyModifiers(
  description: SchemaDescriptionNode,
  modifiers: Modifiers,
): SchemaDescription {
  if (modifiers.defaultValue === undefined) return { ...description, required: modifiers.required };
  return { ...description, required: modifiers.required, default: modifiers.defaultValue };
}

function describeSchema(schema: z.ZodTypeAny, modifiers: Modifiers): SchemaDescription {
  if (schema instanceof z.ZodOptional)
    return describeSchema(schema.unwrap(), { ...modifiers, required: false });
  if (schema instanceof z.ZodDefault)
    return describeSchema(schema.removeDefault(), {
      ...modifiers,
      required: false,
      defaultValue: jsonValueSchema.parse(schema._def.defaultValue()),
    });
  if (schema instanceof z.ZodNullable)
    return applyModifiers(
      {
        type: 'union',
        options: [describeSchema(schema.unwrap(), { required: true }), nullDescription()],
      },
      modifiers,
    );
  if (schema instanceof z.ZodBranded) return describeSchema(schema.unwrap(), modifiers);
  if (schema instanceof z.ZodEffects) return describeSchema(schema.innerType(), modifiers);

  if (schema instanceof z.ZodString) return applyModifiers({ type: 'string' }, modifiers);
  if (schema instanceof z.ZodNumber) return applyModifiers({ type: 'number' }, modifiers);
  if (schema instanceof z.ZodBoolean) return applyModifiers({ type: 'boolean' }, modifiers);
  if (schema instanceof z.ZodNull) return applyModifiers(nullDescription(), modifiers);
  if (schema instanceof z.ZodUnknown) return applyModifiers({ type: 'unknown' }, modifiers);
  if (schema instanceof z.ZodLiteral) {
    const value: JsonPrimitive = schema.value;
    return applyModifiers({ type: 'literal', enum: [value] }, modifiers);
  }
  if (schema instanceof z.ZodEnum)
    return applyModifiers({ type: 'string', enum: schema.options }, modifiers);
  if (schema instanceof z.ZodArray)
    return applyModifiers(
      { type: 'array', items: describeSchema(schema.element, { required: true }) },
      modifiers,
    );
  if (schema instanceof z.ZodObject) {
    const fields: Record<string, SchemaDescription> = {};
    for (const name of Object.keys(schema.shape))
      fields[name] = describeSchema(schema.shape[name], { required: true });
    return applyModifiers({ type: 'object', fields }, modifiers);
  }
  if (schema instanceof z.ZodDiscriminatedUnion)
    return applyModifiers(
      {
        type: 'union',
        discriminator: schema.discriminator,
        options: schema.options.map((option: z.ZodTypeAny) =>
          describeSchema(option, { required: true }),
        ),
      },
      modifiers,
    );
  if (schema instanceof z.ZodUnion)
    return applyModifiers(
      {
        type: 'union',
        options: schema.options.map((option: z.ZodTypeAny) =>
          describeSchema(option, { required: true }),
        ),
      },
      modifiers,
    );
  if (schema instanceof z.ZodTuple) {
    const items = schema.items.map((item: z.ZodTypeAny) =>
      describeSchema(item, { required: true }),
    );
    if (schema._def.rest)
      return applyModifiers(
        { type: 'tuple', items, rest: describeSchema(schema._def.rest, { required: true }) },
        modifiers,
      );
    return applyModifiers({ type: 'tuple', items }, modifiers);
  }
  if (schema instanceof z.ZodRecord)
    return applyModifiers(
      {
        type: 'record',
        keys: describeSchema(schema.keySchema, { required: true }),
        values: describeSchema(schema.valueSchema, { required: true }),
      },
      modifiers,
    );

  throw new Error(`Unsupported Zod schema type: ${schema._def.typeName}`);
}

function nullDescription(): SchemaDescription {
  return applyModifiers({ type: 'null', enum: [null] }, { required: true });
}

export function operationDescriptions(): readonly OperationDescription[] {
  return operationSchema.options.map((option) => {
    const fields: Record<string, SchemaDescription> = {};
    for (const [name, field] of Object.entries(option.shape))
      fields[name] = describeSchema(field, { required: true });
    const operation: string = option.shape.operation.value;
    return { operation, fields };
  });
}
