import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ArtifactFiles } from '../../src/v1/artifacts.js';
import { assertGitState, captureGitState, exportCommit } from '../../src/v1/git.js';

test('target checks detect untracked bytes, staged changes and HEAD drift; commit exports retain bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-v1-git-'));

  const run = (args: string[]) => {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);

    return result.stdout.trim();
  };

  try {
    run(['init', '-q']);
    run(['config', 'user.name', 'Fixture']);
    run(['config', 'user.email', 'fixture@example.invalid']);
    writeFileSync(join(root, 'file.txt'), 'before\n');
    run(['add', 'file.txt']);
    run(['commit', '-qm', 'base']);
    const base = captureGitState(root);
    assert.equal(base.clean, true);
    assert.deepEqual(assertGitState(base), base);
    writeFileSync(join(root, 'untracked.txt'), 'first');
    const dirty = captureGitState(root);
    writeFileSync(join(root, 'untracked.txt'), 'second');
    assert.throws(() => assertGitState(dirty), /changed/);
    rmSync(join(root, 'untracked.txt'));
    writeFileSync(join(root, 'file.txt'), 'after\n');
    run(['add', 'file.txt']);
    assert.throws(() => assertGitState(base), /changed/);
    run(['commit', '-qm', 'change']);
    const commit = run(['rev-parse', 'HEAD']);
    const artifacts = new ArtifactFiles(join(root, '.git', 'fixture-artifacts'));
    const exported = exportCommit({ workspacePath: root, base: base.head, commit, artifacts });
    assert.deepEqual(exported.changedPaths, ['file.txt']);
    assert.match(artifacts.read(exported.patch).toString(), /\+after/);
    assert.throws(() => assertGitState(base), /changed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
