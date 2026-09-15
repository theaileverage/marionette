import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Effect } from 'effect';
import {
  ExtensionCatalog,
  extensionCatalogLayer,
  makeExtensionCatalog,
} from '../src/extensions.js';
import { payloadDigest } from '../src/v1/database.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');

const base = () => ({
  apiVersion: 1,
  id: 'review-guidance',
  version: 1,
  summary: 'Review requirements',
  parents: [],
  resources: [{ path: 'review.md', text: 'Check evidence.', digest: digest('Check evidence.') }],
});

test('resolves a derived idea by exact version and digest through an Effect layer', async () => {
  const parent = base();
  const reference = { id: parent.id, version: parent.version, digest: payloadDigest(parent) };

  const derived = {
    ...base(),
    id: 'security-review',
    parents: [reference],
    resources: [
      { path: 'security.md', text: 'Check authority.', digest: digest('Check authority.') },
    ],
  };

  await Effect.runPromise(
    Effect.gen(function* () {
      const catalog = yield* ExtensionCatalog;
      const snapshots = yield* catalog.list();
      assert.equal(snapshots.length, 2);

      const selected = yield* catalog.resolve({
        id: derived.id,
        version: derived.version,
        digest: payloadDigest(derived),
      });

      assert.deepEqual(selected.descriptor.parents, [reference]);
      assert.deepEqual(selected.descriptor.resources, derived.resources);
      assert.ok(Object.isFrozen(selected.descriptor.resources));
      assert.ok(Object.isFrozen(selected.descriptor.resources[0]));
    }).pipe(Effect.provide(extensionCatalogLayer([derived, parent]))),
  );
});

test('catalog snapshots do not mutate or retain mutable caller resource objects', async () => {
  const input = base();
  const catalog = await Effect.runPromise(makeExtensionCatalog([input]));
  assert.ok(!Object.isFrozen(input));
  assert.ok(!Object.isFrozen(input.resources[0]));
  input.resources[0].text = 'Modified after acquisition';
  const snapshots = await Effect.runPromise(catalog.list());
  assert.equal(snapshots[0]?.descriptor.resources[0]?.text, 'Check evidence.');
});

test('rejects authority fields, executable payloads, unsupported versions and unsafe paths', async () => {
  for (const input of [
    { ...base(), writes: ['**'] },
    { ...base(), authority: 'controller' },
    {
      ...base(),
      execute: () => {
        throw new Error('must not execute');
      },
    },
    { ...base(), apiVersion: 2 },
    { ...base(), version: 0 },
    { ...base(), parents: undefined },
    { ...base(), resources: undefined },
    ...['/absolute', '../escape', 'a/../b', 'a\\b', 'a//b', 'a\u0000b', 'C:drive'].map((path) => ({
      ...base(),
      resources: [{ path, text: '', digest: digest('') }],
    })),
  ]) {
    const failure = await Effect.runPromise(makeExtensionCatalog([input]).pipe(Effect.flip));
    assert.equal(failure.code, 'invalid-descriptor');
  }
});

test('rejects duplicate identities, missing parents and changed resource or parent bytes', async () => {
  const parent = base();

  const cases = [
    { inputs: [parent, parent], code: 'duplicate-version' },
    {
      inputs: [
        { ...parent, resources: [{ path: 'a', text: 'changed', digest: digest('original') }] },
      ],
      code: 'digest-mismatch',
    },
    {
      inputs: [{ ...parent, parents: [{ id: 'absent', version: 1, digest: digest('') }] }],
      code: 'missing-parent',
    },
    {
      inputs: [
        parent,
        {
          ...parent,
          id: 'derived',
          parents: [{ id: parent.id, version: 1, digest: digest('wrong') }],
        },
      ],
      code: 'digest-mismatch',
    },
    {
      inputs: [{ ...parent, parents: [{ id: parent.id, version: 1, digest: digest('self') }] }],
      code: 'cycle',
    },
  ];

  for (const { inputs, code } of cases) {
    const failure = await Effect.runPromise(makeExtensionCatalog(inputs).pipe(Effect.flip));
    assert.equal(failure.code, code);
  }
});

test('resolution never falls back to another version or accepts an incorrect digest', async () => {
  const parent = base();
  const catalog = await Effect.runPromise(makeExtensionCatalog([parent]));

  const missing = await Effect.runPromise(
    catalog.resolve({ id: parent.id, version: 2, digest: payloadDigest(parent) }).pipe(Effect.flip),
  );

  assert.equal(missing.code, 'not-found');

  const changed = await Effect.runPromise(
    catalog.resolve({ id: parent.id, version: 1, digest: digest('wrong') }).pipe(Effect.flip),
  );

  assert.equal(changed.code, 'digest-mismatch');
});
