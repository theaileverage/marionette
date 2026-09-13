import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Schema } from 'effect';
import {
  importModelConfig,
  loadPackage,
  packageManifestSchema,
  route,
  type PackageManifest,
} from '../../src/v1/packages.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');

const fixtureManifest = (text = 'source text', name = 'feature'): PackageManifest =>
  Schema.decodeUnknownSync(packageManifestSchema)({
    name,
    version: '1.0.0',
    source: {
      kind: 'local-snapshot',
      root: '/fixture/skills',
      entry: 'poteto-mode/playbooks/feature.md',
      upstream: {
        name: 'pstack',
        license: { status: 'verified', spdx: 'MIT', resource: 'pstack/LICENSE' },
      },
    },
    entryStep: 'ground',
    resources: {
      'feature.md': {
        sourcePath: '/fixture/skills/poteto-mode/playbooks/feature.md',
        sourceDigest: digest(text),
        text,
      },
    },
    steps: [
      {
        name: 'ground',
        resources: ['feature.md'],
        outputContract: 'A grounded model.',
        permittedMethods: ['how'],
        requiredEvidence: ['subsystem-trace'],
      },
      {
        name: 'handoff',
        resources: ['feature.md'],
        outputContract: 'A settled delivery.',
        permittedMethods: [],
        requiredEvidence: ['handoff'],
      },
    ],
    transitions: [
      { from: 'ground', kind: 'advance', to: 'handoff' },
      { from: 'ground', kind: 'repeat', to: 'ground' },
      { from: 'ground', kind: 'route', routes: ['how'] },
      { from: 'ground', kind: 'await-decision' },
      { from: 'ground', kind: 'block' },
      { from: 'ground', kind: 'finish' },
      { from: 'handoff', kind: 'repeat', to: 'handoff' },
      { from: 'handoff', kind: 'await-decision' },
      { from: 'handoff', kind: 'block' },
      { from: 'handoff', kind: 'finish' },
    ],
    limits: {
      maxAttempts: 2,
      maxRepeats: 1,
      deadlineMs: 1_000,
      parallelism: 1,
      innerLoopDeadlineMs: 500,
    },
    stopBoundaries: ['design'],
    constraints: { successRequires: 'handoff' },
    unresolvedReferences: [],
    dependencyStatus: { status: 'complete', parameterizedReferences: [] },
  });

const writeFixture = (manifest: PackageManifest) => {
  const directory = mkdtempSync(join(tmpdir(), 'marionette-package-'));
  const path = join(directory, 'manifest.json');
  writeFileSync(path, `${JSON.stringify(manifest)}\n`);
  return path;
};

test('a package digest changes when a pinned resource changes', () => {
  const firstPath = writeFixture(fixtureManifest('first source'));
  const secondPath = writeFixture(fixtureManifest('second source'));
  const first = loadPackage(firstPath);
  const second = loadPackage(secondPath);
  assert.notEqual(first.digest, second.digest);
  assert.notEqual(first.sourceDigests[0], second.sourceDigests[0]);
  assert.equal(new TextDecoder().decode(first.resources[0].bytes), 'first source');
});

test('resource bytes are copied when read from an immutable snapshot', () => {
  const snapshot = loadPackage(writeFixture(fixtureManifest('protected source')));
  const bytes = snapshot.resources[0].bytes;
  Reflect.set(bytes, 0, 0);
  assert.equal(new TextDecoder().decode(snapshot.resources[0].bytes), 'protected source');
});

test('package loading rejects a resource whose bytes no longer match its pinned digest', () => {
  const manifest = fixtureManifest('original source');
  manifest.resources['feature.md'].text = 'mutated source';
  const path = writeFixture(manifest);
  assert.throws(() => loadPackage(path), /digest does not match manifest/);
});

test('package loading rejects malformed external manifests before routing', () => {
  const directory = mkdtempSync(join(tmpdir(), 'marionette-package-'));
  const path = join(directory, 'manifest.json');
  writeFileSync(path, '{"name":"feature"}');
  assert.throws(() => loadPackage(path), /version/);
});

test('routing uses pstack precedence and keeps routine work direct', () => {
  assert.deepEqual(route({ request: 'format the generated JSON' }), {
    kind: 'direct',
    method: 'direct',
    precedence: 'pstack',
    packageName: 'pstack/direct',
    reason: 'routine engineering work',
  });
  assert.deepEqual(route({ request: 'fix the regression in workflow admission' }), {
    kind: 'workflow',
    method: 'pstack',
    precedence: 'pstack',
    packageName: 'pstack/bug-fix',
    reason: 'deterministic request classification',
  });
  assert.deepEqual(route({ request: 'fix the regression', package: 'refactoring' }), {
    kind: 'workflow',
    method: 'pstack',
    precedence: 'pstack',
    packageName: 'pstack/refactoring',
    reason: 'explicit package',
  });
  assert.deepEqual(route({ request: 'format the generated JSON', package: 'pstack/direct' }), {
    kind: 'direct',
    method: 'direct',
    precedence: 'pstack',
    packageName: 'pstack/direct',
    reason: 'routine engineering work',
  });
});

test('bundled package names resolve after the caller changes directory', () => {
  const original = process.cwd();
  const otherDirectory = mkdtempSync(join(tmpdir(), 'marionette-cwd-'));
  try {
    process.chdir(otherDirectory);
    assert.equal(loadPackage('feature').name, 'feature');
    assert.equal(loadPackage('pstack/feature').name, 'feature');
    assert.equal(loadPackage('pstack/direct').name, 'direct');
  } finally {
    process.chdir(original);
  }
});

test('reviewed custom manifests use their own name without joining the bundled registry', () => {
  const manifest = fixtureManifest('custom source', 'team/custom');
  assert.equal(loadPackage(writeFixture(manifest)).name, 'team/custom');
});

test('model imports retain source-line diagnostics without substituting a model', () => {
  const sourcePath = '/fixture/.cursor/rules/pstack-models.mdc';
  const result = importModelConfig(
    [
      '---',
      'description: pstack model configuration',
      'alwaysApply: true',
      '---',
      'architect runners: gpt-5.6-sol:xhigh',
      'architect runners: gpt-5.6-terraform:high',
      'feature: gpt-5.6-terra:high',
    ].join('\n'),
    {
      sourcePath,
      availableModels: new Set(['gpt-5.6-sol:xhigh', 'gpt-5.6-terra:high']),
    },
  );
  assert.deepEqual(result.roles['architect runners'], ['gpt-5.6-sol:xhigh']);
  assert.deepEqual(result.diagnostics, [
    {
      code: 'duplicate_role',
      sourcePath,
      line: 6,
      message: 'Role architect runners was already declared',
    },
    {
      code: 'model_unavailable',
      sourcePath,
      line: 6,
      message: 'Model gpt-5.6-terraform:high is not available',
    },
  ]);
  const unavailable = importModelConfig('---\nname: pstack\n---\nfeature: gpt-5.6-terraform:high', {
    sourcePath,
    availableModels: new Set(),
  });
  assert.deepEqual(unavailable.diagnostics, [
    {
      code: 'model_unavailable',
      sourcePath,
      line: 4,
      message: 'Model gpt-5.6-terraform:high is not available',
    },
  ]);
});

test('the captured workflow resources still match their declared source digests', () => {
  const feature = loadPackage('feature');
  const bugFix = loadPackage('bug-fix');
  const direct = loadPackage('direct');
  const source = feature.manifest.resources['poteto-mode/SKILL.md'];
  assert.equal(digest(source.text), source.sourceDigest);
  assert.equal(feature.manifest.unresolvedReferences.length > 0, true);
  assert.equal(feature.manifest.constraints.successRequires, 'handoff');
  assert.equal(
    feature.transitions.some((transition) => transition.kind === 'route'),
    true,
  );
  assert.deepEqual(feature.steps.find((step) => step.name === 'review')?.requiredEvidence, [
    'independent-review',
  ]);
  assert.equal(feature.steps.find((step) => step.name === 'review')?.requiresDistinctRole, true);
  assert.deepEqual(bugFix.steps.find((step) => step.name === 'reproduce')?.requiredEvidence, [
    'failing-reproduction',
  ]);
  assert.equal(feature.manifest.source.upstream.license.resource, 'pstack/LICENSE');
  assert.equal(feature.manifest.resources['pstack/LICENSE'].sourcePath, 'pstack/LICENSE');
  assert.match(feature.manifest.resources['pstack/LICENSE'].text, /MIT License/);
  assert.equal(
    feature.manifest.resources['poteto-mode/SKILL.md'].sourcePath.startsWith('/'),
    false,
  );
  assert.equal(feature.manifest.dependencyStatus.status, 'classified-incomplete');
  assert.deepEqual(feature.manifest.dependencyStatus.parameterizedReferences, [
    { pattern: 'why/references/sources/*.md', directory: 'why/references/sources' },
    { pattern: 'why/references/sources/<source>.md', directory: 'why/references/sources' },
  ]);
  assert.ok(
    feature.manifest.resources[
      'create-verification-skill/references/feature-map-example/README.md'
    ],
  );
  assert.ok(feature.manifest.resources['why/references/sources/incident-postmortem.md']);
  assert.equal(direct.limits.maxAttempts > 0, true);
  assert.equal(direct.steps[0].name, 'direct');
});
