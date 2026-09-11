import { operationSchema } from './operations.js';
import {
  describeSchema,
  registerStaticDefault,
  type SchemaDescription,
  type JsonValue,
} from './schema-description.js';
export {
  describeSchema,
  type SchemaDescription,
  type JsonValue,
  type JsonPrimitive,
} from './schema-description.js';

export type OperationDescription = {
  readonly operation: string;
  readonly fields: Readonly<Record<string, SchemaDescription>>;
};

function operationDefault(operation: string, field: string, value: JsonValue): void {
  const option = operationSchema.options.find(
    (candidate) => candidate.shape.operation.value === operation,
  );
  const entry = option && Object.entries(option.shape).find(([name]) => name === field);
  if (!entry) throw new Error(`Missing default schema for ${operation}.${field}`);
  registerStaticDefault(entry[1], value);
}
operationDefault('job.create', 'dependencies', Object.freeze([]));
operationDefault('workflow.create', 'boundary', 'all');
operationDefault('attempt.admit', 'inputResultIds', Object.freeze([]));

export function operationDescriptions(): readonly OperationDescription[] {
  return operationSchema.options.map((option) => {
    const fields: Record<string, SchemaDescription> = {};
    for (const [name, field] of Object.entries(option.shape)) fields[name] = describeSchema(field);
    const operation: string = option.shape.operation.value;
    return { operation, fields };
  });
}
