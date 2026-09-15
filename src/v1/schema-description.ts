import { Predicate, Schema, SchemaAST } from 'effect';

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

type SchemaDescriptionNode =
  | {
      readonly type: 'string';
      readonly enum?: readonly JsonPrimitive[];
      readonly minLength?: number;
      readonly maxLength?: number;
      readonly pattern?: { readonly source: string; readonly flags: string };
    }
  | {
      readonly type: 'number';
      readonly integer?: true;
      readonly finite?: true;
      readonly minimum?: { readonly value: number; readonly inclusive: boolean };
      readonly maximum?: { readonly value: number; readonly inclusive: boolean };
    }
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

type Modifiers = { required: boolean; defaultValue?: JsonValue; defaultStatus?: 'not-evaluated' };

type Representation = { readonly id?: unknown; readonly payload?: unknown };

type CheckApplication = { node: SchemaDescriptionNode; custom: boolean };

type UnionDescriptionDraft = {
  type: 'union';
  options: readonly SchemaDescription[];
  discriminator?: string;
};

type TupleDescriptionDraft = {
  type: 'tuple';
  items: readonly SchemaDescription[];
  rest?: SchemaDescription;
};

function jsonValue(value: unknown): value is JsonValue {
  if (value === null || Predicate.isString(value) || Predicate.isNumber(value) || Predicate.isBoolean(value)) return true;

  if (Array.isArray(value)) return value.every(jsonValue);

  return (Predicate.isObjectOrArray(value) || value === null) && value !== null && Object.values(value).every(jsonValue);
}

function modifiers(ast: SchemaAST.AST, required: boolean): Modifiers {
  const defaultValue = ast.annotations?.default;

  if (jsonValue(defaultValue)) return { required: false, defaultValue };
  const encodedOptional = ast.encoding?.some((link) => link.to.context?.isOptional) ?? false;

  if (encodedOptional) return { required: false, defaultStatus: 'not-evaluated' };

  return { required: required && !ast.context?.isOptional };
}

function apply(
  node: SchemaDescriptionNode,
  ast: SchemaAST.AST,
  required: boolean,
  refinements = false,
): SchemaDescription {
  const metadata = modifiers(ast, required);

  const base =
    metadata.defaultValue !== undefined
      ? { ...node, required: metadata.required, default: metadata.defaultValue }
      : metadata.defaultStatus
        ? { ...node, required: metadata.required, defaultStatus: metadata.defaultStatus }
        : { ...node, required: metadata.required };

  return refinements ? { ...base, effects: [{ kind: 'refinement', executable: false }] } : base;
}

function representation(check: SchemaAST.Check<unknown>): Representation | undefined {
  const value = check.annotations?.representation;

  return (Predicate.isObjectOrArray(value) || value === null) && value !== null ? value : undefined;
}

function checked(ast: SchemaAST.AST, node: SchemaDescriptionNode): CheckApplication {
  let result: SchemaDescriptionNode = { ...node };
  let custom = false;
  const checks = ast.checks ?? [];
  const ids = checks.map((check) => representation(check)?.id);
  const finiteIndex = ids.indexOf('effect/schema/isFinite');
  const integerIndex = ids.indexOf('effect/schema/isInt');
  const finiteIsIntegerBase = finiteIndex >= 0 && integerIndex >= 0 && finiteIndex < integerIndex;

  for (const check of checks) {
    const meta = representation(check);
    const payload = meta?.payload;

    if (
      meta === undefined &&
      check.annotations?.expected === 'an integer' &&
      result.type === 'number'
    ) {
      Object.assign(result, { integer: true });
    } else if (
      meta?.id === 'effect/schema/isMinLength' &&
      (Predicate.isObjectOrArray(payload) || payload === null) &&
      payload !== null &&
      'minLength' in payload &&
      Predicate.isNumber(payload.minLength)
    ) {
      if (result.type === 'array') Object.assign(result, { minItems: payload.minLength });
      else if (result.type === 'string') Object.assign(result, { minLength: payload.minLength });
    } else if (
      meta?.id === 'effect/schema/isMaxLength' &&
      (Predicate.isObjectOrArray(payload) || payload === null) &&
      payload !== null &&
      'maxLength' in payload &&
      Predicate.isNumber(payload.maxLength)
    ) {
      if (result.type === 'array') Object.assign(result, { maxItems: payload.maxLength });
      else if (result.type === 'string') Object.assign(result, { maxLength: payload.maxLength });
    } else if (
      meta?.id === 'effect/schema/isLengthBetween' &&
      (Predicate.isObjectOrArray(payload) || payload === null) &&
      payload !== null &&
      'minimum' in payload &&
      'maximum' in payload &&
      Predicate.isNumber(payload.minimum) &&
      Predicate.isNumber(payload.maximum)
    ) {
      if (result.type === 'array') {
        if (payload.minimum === payload.maximum)
          Object.assign(result, { exactItems: payload.minimum });
        else Object.assign(result, { minItems: payload.minimum, maxItems: payload.maximum });
      }
    } else if (
      meta?.id === 'effect/schema/isPattern' &&
      result.type === 'string' &&
      (Predicate.isObjectOrArray(payload) || payload === null) &&
      payload !== null &&
      'source' in payload &&
      'flags' in payload &&
      Predicate.isString(payload.source) &&
      Predicate.isString(payload.flags)
    ) {
      Object.assign(result, { pattern: { source: payload.source, flags: payload.flags } });
    } else if (meta?.id === 'effect/schema/isInt' && result.type === 'number')
      Object.assign(result, { integer: true });
    else if (meta?.id === 'effect/schema/isFinite' && result.type === 'number')
      Object.assign(result, { finite: true });
    else if (
      (meta?.id === 'effect/schema/isGreaterThan' ||
        meta?.id === 'effect/schema/isGreaterThanOrEqualTo') &&
      result.type === 'number' &&
      (Predicate.isObjectOrArray(payload) || payload === null) &&
      payload !== null
    ) {
      const value =
        'exclusiveMinimum' in payload
          ? payload.exclusiveMinimum
          : 'minimum' in payload
            ? payload.minimum
            : undefined;

      if (Predicate.isNumber(value))
        Object.assign(result, { minimum: { value, inclusive: meta.id.endsWith('OrEqualTo') } });
    } else if (
      (meta?.id === 'effect/schema/isLessThan' ||
        meta?.id === 'effect/schema/isLessThanOrEqualTo') &&
      result.type === 'number' &&
      (Predicate.isObjectOrArray(payload) || payload === null) &&
      payload !== null
    ) {
      const value =
        'exclusiveMaximum' in payload
          ? payload.exclusiveMaximum
          : 'maximum' in payload
            ? payload.maximum
            : undefined;

      if (Predicate.isNumber(value))
        Object.assign(result, { maximum: { value, inclusive: meta.id.endsWith('OrEqualTo') } });
    } else custom = true;
  }

  if (result.type === 'number' && result.integer && result.finite && finiteIsIntegerBase) {
    const { finite: _finite, ...integerResult } = result;
    result = integerResult;
  }

  return { node: result, custom };
}

function unknownKeys(ast: SchemaAST.AST): 'strip' | 'strict' | 'passthrough' {
  const value = ast.annotations?.parseOptions;

  if ((Predicate.isObjectOrArray(value) || value === null) && value !== null && 'onExcessProperty' in value) {
    if (value.onExcessProperty === 'error') return 'strict';

    if (value.onExcessProperty === 'preserve') return 'passthrough';
  }

  return 'strip';
}

function literalProperty(ast: SchemaAST.AST, name: string): JsonPrimitive | undefined {
  if (!Predicate.isTagged('Objects')(ast)) return undefined;
  const property = ast.propertySignatures.find((entry) => entry.name === name);

  if (!property || !Predicate.isTagged('Literal')(property.type) || Predicate.isBigInt(property.type.literal))
    return undefined;

  return property.type.literal;
}

function discriminator(types: ReadonlyArray<SchemaAST.AST>): string | undefined {
  for (const name of ['operation', 'kind']) {
    const values = types.map((type) => literalProperty(type, name));

    if (values.every((value) => value !== undefined) && new Set(values).size === values.length)
      return name;
  }

  return undefined;
}

export function describeSchemaAst(ast: SchemaAST.AST, required = true): SchemaDescription {
  let node: SchemaDescriptionNode;

  switch (true) {
    case Predicate.isTagged('String')(ast):
      node = { type: 'string' };
      break;
    case Predicate.isTagged('Number')(ast):
      node = { type: 'number' };
      break;
    case Predicate.isTagged('Boolean')(ast):
      node = { type: 'boolean' };
      break;
    case Predicate.isTagged('Null')(ast):
      node = { type: 'null', enum: [null] };
      break;
    case Predicate.isTagged('Literal')(ast): {
      if (Predicate.isBigInt(ast.literal)) throw new Error('BigInt literals are not JSON values');
      node = { type: Predicate.isString(ast.literal) ? 'literal' : 'literal', enum: [ast.literal] };
      break;
    }

    case Predicate.isTagged('Union')(ast): {
      const types = ast.types.filter((type) => !Predicate.isTagged('Undefined')(type));

      if (types.length === 1) {
        const inner = describeSchemaAst(types[0], true);

        return { ...inner, required: modifiers(ast, required).required };
      }

      const literals = types.every(
        (type) => Predicate.isTagged('Literal')(type) && Predicate.isString(type.literal),
      );

      if (literals) {
        node = {
          type: 'string',
          enum: types.map((type) => (Predicate.isTagged('Literal')(type) ? String(type.literal) : '')),
        };
      } else {
        const union: UnionDescriptionDraft = {
          type: 'union',
          options: types.map((type) => describeSchemaAst(type, true)),
        };

        const tag = discriminator(types);

        if (tag) union.discriminator = tag;

        node = union;
      }

      break;
    }

    case Predicate.isTagged('Arrays')(ast): {
      if (ast.elements.length === 0 && ast.rest.length === 1)
        node = { type: 'array', items: describeSchemaAst(ast.rest[0], true) };
      else {
        const tuple: TupleDescriptionDraft = {
          type: 'tuple',
          items: ast.elements.map((item) => describeSchemaAst(item, true)),
        };

        if (ast.rest[0]) tuple.rest = describeSchemaAst(ast.rest[0], true);

        node = tuple;
      }

      break;
    }

    case Predicate.isTagged('Objects')(ast): {
      if (ast.propertySignatures.length === 0 && ast.indexSignatures.length === 1) {
        const index = ast.indexSignatures[0];
        node = {
          type: 'record',
          keys: describeSchemaAst(index.parameter, true),
          values: describeSchemaAst(index.type, true),
        };
      } else {
        const fields: Record<string, SchemaDescription> = {};

        for (const property of ast.propertySignatures)
          fields[String(property.name)] = describeSchemaAst(property.type, true);
        node = { type: 'object', unknownKeys: unknownKeys(ast), fields };
      }

      break;
    }

    case Predicate.isTagged('Unknown')(ast):
      node = { type: 'unknown' };
      break;
    case Predicate.isTagged('Suspend')(ast):
      return describeSchemaAst(ast.thunk(), required);
    default:
      throw new Error(`Unsupported Effect Schema AST node: ${ast._tag}`);
  }

  const result = checked(ast, node);

  return apply(result.node, ast, required, result.custom);
}

export function describeSchema(schema: Schema.Constraint): SchemaDescription {
  return describeSchemaAst(schema.ast, true);
}
