import { Schema, SchemaAST } from 'effect';

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

function jsonValue(value: unknown): value is JsonValue {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(jsonValue);
  return typeof value === 'object' && value !== null && Object.values(value).every(jsonValue);
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
  return typeof value === 'object' && value !== null ? value : undefined;
}

function checked(
  ast: SchemaAST.AST,
  node: SchemaDescriptionNode,
): { node: SchemaDescriptionNode; custom: boolean } {
  let result = node;
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
      result = { ...result, integer: true };
    } else if (
      meta?.id === 'effect/schema/isMinLength' &&
      typeof payload === 'object' &&
      payload !== null &&
      'minLength' in payload &&
      typeof payload.minLength === 'number'
    ) {
      result =
        result.type === 'array'
          ? { ...result, minItems: payload.minLength }
          : result.type === 'string'
            ? { ...result, minLength: payload.minLength }
            : result;
    } else if (
      meta?.id === 'effect/schema/isMaxLength' &&
      typeof payload === 'object' &&
      payload !== null &&
      'maxLength' in payload &&
      typeof payload.maxLength === 'number'
    ) {
      result =
        result.type === 'array'
          ? { ...result, maxItems: payload.maxLength }
          : result.type === 'string'
            ? { ...result, maxLength: payload.maxLength }
            : result;
    } else if (
      meta?.id === 'effect/schema/isLengthBetween' &&
      typeof payload === 'object' &&
      payload !== null &&
      'minimum' in payload &&
      'maximum' in payload &&
      typeof payload.minimum === 'number' &&
      typeof payload.maximum === 'number'
    ) {
      if (result.type === 'array')
        result =
          payload.minimum === payload.maximum
            ? { ...result, exactItems: payload.minimum }
            : { ...result, minItems: payload.minimum, maxItems: payload.maximum };
    } else if (
      meta?.id === 'effect/schema/isPattern' &&
      result.type === 'string' &&
      typeof payload === 'object' &&
      payload !== null &&
      'source' in payload &&
      'flags' in payload &&
      typeof payload.source === 'string' &&
      typeof payload.flags === 'string'
    ) {
      result = { ...result, pattern: { source: payload.source, flags: payload.flags } };
    } else if (meta?.id === 'effect/schema/isInt' && result.type === 'number')
      result = { ...result, integer: true };
    else if (meta?.id === 'effect/schema/isFinite' && result.type === 'number')
      result = { ...result, finite: true };
    else if (
      (meta?.id === 'effect/schema/isGreaterThan' ||
        meta?.id === 'effect/schema/isGreaterThanOrEqualTo') &&
      result.type === 'number' &&
      typeof payload === 'object' &&
      payload !== null
    ) {
      const value =
        'exclusiveMinimum' in payload
          ? payload.exclusiveMinimum
          : 'minimum' in payload
            ? payload.minimum
            : undefined;
      if (typeof value === 'number')
        result = { ...result, minimum: { value, inclusive: meta.id.endsWith('OrEqualTo') } };
    } else if (
      (meta?.id === 'effect/schema/isLessThan' ||
        meta?.id === 'effect/schema/isLessThanOrEqualTo') &&
      result.type === 'number' &&
      typeof payload === 'object' &&
      payload !== null
    ) {
      const value =
        'exclusiveMaximum' in payload
          ? payload.exclusiveMaximum
          : 'maximum' in payload
            ? payload.maximum
            : undefined;
      if (typeof value === 'number')
        result = { ...result, maximum: { value, inclusive: meta.id.endsWith('OrEqualTo') } };
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
  if (typeof value === 'object' && value !== null && 'onExcessProperty' in value) {
    if (value.onExcessProperty === 'error') return 'strict';
    if (value.onExcessProperty === 'preserve') return 'passthrough';
  }
  return 'strip';
}

function literalProperty(ast: SchemaAST.AST, name: string): JsonPrimitive | undefined {
  if (ast._tag !== 'Objects') return undefined;
  const property = ast.propertySignatures.find((entry) => entry.name === name);
  if (!property || property.type._tag !== 'Literal' || typeof property.type.literal === 'bigint')
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
  switch (ast._tag) {
    case 'String':
      node = { type: 'string' };
      break;
    case 'Number':
      node = { type: 'number' };
      break;
    case 'Boolean':
      node = { type: 'boolean' };
      break;
    case 'Null':
      node = { type: 'null', enum: [null] };
      break;
    case 'Literal': {
      if (typeof ast.literal === 'bigint') throw new Error('BigInt literals are not JSON values');
      node = { type: typeof ast.literal === 'string' ? 'literal' : 'literal', enum: [ast.literal] };
      break;
    }
    case 'Union': {
      const types = ast.types.filter((type) => type._tag !== 'Undefined');
      if (types.length === 1) {
        const inner = describeSchemaAst(types[0], true);
        return { ...inner, required: modifiers(ast, required).required };
      }
      const literals = types.every(
        (type) => type._tag === 'Literal' && typeof type.literal === 'string',
      );
      node = literals
        ? {
            type: 'string',
            enum: types.map((type) => (type._tag === 'Literal' ? String(type.literal) : '')),
          }
        : {
            type: 'union',
            options: types.map((type) => describeSchemaAst(type, true)),
            ...(discriminator(types) ? { discriminator: discriminator(types) } : {}),
          };
      break;
    }
    case 'Arrays': {
      if (ast.elements.length === 0 && ast.rest.length === 1)
        node = { type: 'array', items: describeSchemaAst(ast.rest[0], true) };
      else
        node = {
          type: 'tuple',
          items: ast.elements.map((item) => describeSchemaAst(item, true)),
          ...(ast.rest[0] ? { rest: describeSchemaAst(ast.rest[0], true) } : {}),
        };
      break;
    }
    case 'Objects': {
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
    case 'Unknown':
      node = { type: 'unknown' };
      break;
    case 'Suspend':
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
