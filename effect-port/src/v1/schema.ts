import { SchemaAST } from 'effect';
import { operationSchemas } from './operations.js';
import { describeSchema, describeSchemaAst, type SchemaDescription } from './schema-description.js';

export {
  describeSchema,
  type JsonPrimitive,
  type JsonValue,
  type SchemaDescription,
} from './schema-description.js';

export type OperationDescription = {
  readonly operation: string;
  readonly fields: Readonly<Record<string, SchemaDescription>>;
};

function operationName(ast: SchemaAST.AST): string {
  if (ast._tag !== 'Objects') throw new Error('Operation schema must be an object');
  const field = ast.propertySignatures.find((property) => property.name === 'operation');
  if (!field || field.type._tag !== 'Literal' || typeof field.type.literal !== 'string') {
    throw new Error('Operation schema requires a string literal operation field');
  }
  return field.type.literal;
}

export function operationDescriptions(): readonly OperationDescription[] {
  return operationSchemas.map((schema) => {
    if (schema.ast._tag !== 'Objects') throw new Error('Operation schema must be an object');
    const fields: Record<string, SchemaDescription> = {};
    for (const property of schema.ast.propertySignatures) {
      fields[String(property.name)] = describeSchemaAst(property.type);
    }
    return { operation: operationName(schema.ast), fields };
  });
}
