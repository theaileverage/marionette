import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Build/release helpers intentionally execute as dependency-free JavaScript.
import { versionParts, compareVersions, notesFor } from '../scripts/release.mjs';

test('release versions reject ambiguous tags and order prereleases before stable versions', () => {
  for (const invalid of ['v1.0.0', '01.2.3', '1.0.0+build', '1.0.0-01', '../main'])
    assert.throws(() => versionParts(invalid));
  assert.equal(compareVersions('0.2.1', '0.2.0'), 1);
  assert.equal(compareVersions('1.0.0-beta.10', '1.0.0-beta.2'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-1'), 1);
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0);
  assert.equal(compareVersions('0.1.0', '0.2.0'), -1);
});
test('release notes require a completed exact-version changelog section', () => {
  assert.equal(
    notesFor('# Changelog\n\n## 0.2.1 — today\n\nFix recovery.\n\n## 0.2.0\n\nOld.\n', '0.2.1'),
    'Fix recovery.\n',
  );
  assert.throws(() => notesFor('## 0.2.10\n\nWrong version.', '0.2.1'));
  assert.throws(() => notesFor('## 0.2.1\n\nDescribe the release here.', '0.2.1'));
});
