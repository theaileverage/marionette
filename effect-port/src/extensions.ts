import { createHash } from 'node:crypto';
import { Context, Effect, Layer, Schema } from 'effect';
import { payloadDigest } from './v1/database.js';

const extensionId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9.-]{0,127}$/));
const version = Schema.Int.check(Schema.isGreaterThan(0));
const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const resourcePath = Schema.String.check(
  Schema.makeFilter((value) => {
    const parts = value.split('/');
    return (
      value.length > 0 &&
      value.length <= 4096 &&
      !/[\\\x00-\x1f:]/.test(value) &&
      parts.every((part) => part.length > 0 && part !== '.' && part !== '..')
    );
  }),
);

export const ExtensionReference = Schema.Struct({ id: extensionId, version, digest });
export interface ExtensionReference extends Schema.Schema.Type<typeof ExtensionReference> {}

export const ExtensionDescriptor = Schema.Struct({
  apiVersion: Schema.Literal(1),
  id: extensionId,
  version,
  summary: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  parents: Schema.Array(ExtensionReference).check(Schema.isMaxLength(64)),
  resources: Schema.Array(
    Schema.Struct({
      path: resourcePath,
      text: Schema.String.check(Schema.isMaxLength(1_048_576)),
      digest,
    }),
  ).check(Schema.isMaxLength(256)),
});
export interface ExtensionDescriptor extends Schema.Schema.Type<typeof ExtensionDescriptor> {}

export interface ExtensionSnapshot {
  readonly reference: ExtensionReference;
  readonly descriptor: ExtensionDescriptor;
}

export class ExtensionError extends Schema.TaggedError<ExtensionError>()('ExtensionError', {
  code: Schema.Literals([
    'invalid-descriptor',
    'duplicate-version',
    'missing-parent',
    'digest-mismatch',
    'cycle',
    'not-found',
  ]),
  message: Schema.String,
}) {}

export class ExtensionCatalog extends Context.Service<
  ExtensionCatalog,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<ExtensionSnapshot>>;
    readonly resolve: (reference: unknown) => Effect.Effect<ExtensionSnapshot, ExtensionError>;
  }
>()('@marionette/ExtensionCatalog') {}

const key = (reference: { readonly id: string; readonly version: number }) =>
  `${reference.id}@${reference.version}`;

const invalid = (message: string) => new ExtensionError({ code: 'invalid-descriptor', message });

const decodeDescriptor = Schema.decodeUnknownEffect(ExtensionDescriptor, {
  onExcessProperty: 'error',
});
const decodeReference = Schema.decodeUnknownEffect(ExtensionReference, {
  onExcessProperty: 'error',
});

function freezeDescriptor(descriptor: ExtensionDescriptor): ExtensionDescriptor {
  return Object.freeze({
    ...descriptor,
    parents: Object.freeze(descriptor.parents.map((parent) => Object.freeze({ ...parent }))),
    resources: Object.freeze(descriptor.resources.map((resource) => Object.freeze({ ...resource }))),
  });
}

export const makeExtensionCatalog = Effect.fn('ExtensionCatalog.make')(function* (
  descriptors: ReadonlyArray<unknown>,
) {
  if (descriptors.length > 1024) return yield* Effect.fail(invalid('Catalog exceeds 1024 entries'));
  const catalog = new Map<string, ExtensionSnapshot>();
  for (const input of descriptors) {
    const descriptor = yield* decodeDescriptor(input).pipe(
      Effect.mapError((error) => invalid(error.message)),
    );
    const identity = key(descriptor);
    if (catalog.has(identity))
      return yield* Effect.fail(
        new ExtensionError({ code: 'duplicate-version', message: `Duplicate ${identity}` }),
      );
    const paths = new Set<string>();
    for (const resource of descriptor.resources) {
      if (paths.has(resource.path))
        return yield* Effect.fail(invalid(`Duplicate resource ${resource.path}`));
      paths.add(resource.path);
      if (createHash('sha256').update(resource.text).digest('hex') !== resource.digest)
        return yield* Effect.fail(
          new ExtensionError({
            code: 'digest-mismatch',
            message: `Resource digest mismatch: ${identity}/${resource.path}`,
          }),
        );
    }
    const parentKeys = descriptor.parents.map(key);
    if (new Set(parentKeys).size !== parentKeys.length)
      return yield* Effect.fail(invalid(`Duplicate parent in ${identity}`));
    const reference = Object.freeze({
      id: descriptor.id,
      version: descriptor.version,
      digest: payloadDigest(descriptor),
    });
    catalog.set(identity, Object.freeze({ reference, descriptor: freezeDescriptor(descriptor) }));
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (entry: ExtensionSnapshot): ExtensionError | undefined => {
    const identity = key(entry.reference);
    if (visiting.has(identity))
      return new ExtensionError({ code: 'cycle', message: `Parent cycle at ${identity}` });
    if (visited.has(identity)) return undefined;
    visiting.add(identity);
    for (const reference of entry.descriptor.parents) {
      const parent = catalog.get(key(reference));
      if (!parent)
        return new ExtensionError({ code: 'missing-parent', message: `Missing ${key(reference)}` });
      if (visiting.has(key(reference)))
        return new ExtensionError({ code: 'cycle', message: `Parent cycle at ${key(reference)}` });
      if (parent.reference.digest !== reference.digest)
        return new ExtensionError({
          code: 'digest-mismatch',
          message: `Parent digest mismatch: ${key(reference)}`,
        });
      const error = visit(parent);
      if (error) return error;
    }
    visiting.delete(identity);
    visited.add(identity);
    return undefined;
  };
  for (const entry of catalog.values()) {
    const error = visit(entry);
    if (error) return yield* Effect.fail(error);
  }
  const snapshots = Object.freeze([...catalog.values()].sort((a, b) => key(a.reference).localeCompare(key(b.reference))));
  return ExtensionCatalog.of({
    list: Effect.fn('ExtensionCatalog.list')(() => Effect.succeed(snapshots)),
    resolve: Effect.fn('ExtensionCatalog.resolve')(function* (input) {
      const reference = yield* decodeReference(input).pipe(
        Effect.mapError((error) => invalid(error.message)),
      );
      const snapshot = catalog.get(key(reference));
      if (!snapshot)
        return yield* Effect.fail(
          new ExtensionError({ code: 'not-found', message: `Missing ${key(reference)}` }),
        );
      if (snapshot.reference.digest !== reference.digest)
        return yield* Effect.fail(
          new ExtensionError({ code: 'digest-mismatch', message: `Digest mismatch: ${key(reference)}` }),
        );
      return snapshot;
    }),
  });
});

export const extensionCatalogLayer = (descriptors: ReadonlyArray<unknown>) =>
  Layer.effect(ExtensionCatalog, makeExtensionCatalog(descriptors));
