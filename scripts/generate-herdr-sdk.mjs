import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { format } from 'prettier';

const namespaces = {
  request: 'RequestTypes',
  success_response: 'ResponseTypes',
  error_response: 'ErrorTypes',
  event: 'EventTypes',
  subscription_event: 'SubscriptionTypes',
};
function type(schema) {
  if (schema === true) return 'unknown';
  if (schema === false) return 'never';
  if (schema.$ref) {
    const [, , doc, , name] = schema.$ref.split('/');
    if (!namespaces[doc] || !name) throw new Error('Unsupported reference: ' + schema.$ref);
    return `${namespaces[doc]}.${name}`;
  }
  if (Object.hasOwn(schema, 'const')) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(' | ');
  if (schema.oneOf || schema.anyOf)
    return '(' + (schema.oneOf ?? schema.anyOf).map(type).join(' | ') + ')';
  if (schema.allOf) return '(' + schema.allOf.map(type).join(' & ') + ')';
  if (Array.isArray(schema.type))
    return '(' + schema.type.map((t) => type({ ...schema, type: t })).join(' | ') + ')';
  switch (schema.type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array':
      return `Array<${type(schema.items ?? true)}>`;
    case 'object': {
      const properties = Object.entries(schema.properties ?? {}).map(([name, value]) => {
        const comment = value.description
          ? `/** ${value.description.replaceAll('*/', '* /')} */\n`
          : '';
        return `${comment}${JSON.stringify(name)}${schema.required?.includes(name) ? '' : '?'}: ${type(value)};`;
      });
      if (schema.additionalProperties)
        properties.push(`[key: string]: ${type(schema.additionalProperties)};`);
      return properties.length ? `{${properties.join('\n')}}` : 'Record<string, never>';
    }
    case undefined:
      if (!Object.keys(schema).length) return 'unknown';
      break;
  }
  throw new Error('Unsupported structural schema: ' + JSON.stringify(schema));
}
export async function generateProtocol(source) {
  const schema = JSON.parse(source);
  if (schema.protocol !== 22) throw new Error('Review protocol changes before regenerating');
  let output = `// Generated from Herdr 0.9.0 (Apache-2.0); see vendor/herdr-0.9.0/LICENSE.\n// Do not edit. Run npm run sdk:generate.\n`;
  output += `export const HERDR_PROTOCOL = ${schema.protocol} as const;\n`;
  output += `export const HERDR_SCHEMA_SHA256 = '${createHash('sha256').update(source).digest('hex')}' as const;\n`;
  for (const [doc, namespace] of Object.entries(namespaces)) {
    output += `export namespace ${namespace} {\n`;
    for (const [name, definition] of Object.entries(schema.schemas[doc].$defs ?? {}))
      output += `export type ${name} = ${type(definition)};\n`;
    output += `}\n`;
  }
  output += `export interface HerdrParams {\n`;
  for (const request of schema.schemas.request.oneOf) {
    const method = request.properties.method.const;
    output += `${JSON.stringify(method)}: ${type(request.properties.params ?? { type: 'object' })};\n`;
  }
  output += `}\n`;
  output += `export const HERDR_METHODS = ${JSON.stringify(schema.schemas.request.oneOf.map((r) => r.properties.method.const))} as const;\n`;
  output += `export type HerdrMethod = keyof HerdrParams;\n`;
  output += `export type HerdrResult = ResponseTypes.ResponseResult;\n`;
  output += `export type HerdrEvent = ${type(schema.schemas.event)} | ${type(schema.schemas.subscription_event)};\n`;
  return format(output, { parser: 'typescript', singleQuote: true, printWidth: 100 });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const source = readFileSync(resolve(root, 'vendor/herdr-0.9.0/api.schema.json'), 'utf8');
  writeFileSync(resolve(root, 'src/herdr-protocol.ts'), await generateProtocol(source));
}
