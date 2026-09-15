import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBinding, resolveContext, writeSessionContext } from '../../src/v1/context.js';

test('inherited context stays bound when cwd changes and rejects an explicit project switch', () => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-v1-context-'));

  try {
    const stateRoot = join(root, 'state');
    const first = join(root, 'first');
    const second = join(root, 'second');
    mkdirSync(first);
    mkdirSync(second);
    const a = createBinding({ repositoryRoot: first, stateRoot });
    const b = createBinding({ repositoryRoot: second, stateRoot });

    const context = writeSessionContext({
      stateDirectory: a.binding.stateDirectory,
      context: {
        version: 1,
        bindingPath: a.bindingPath,
        projectId: a.binding.projectId,
        hostId: a.binding.hostId,
        sessionId: 'worker',
        generation: 1,
        token: randomBytes(32).toString('hex'),
        parentWorkflowId: 'workflow-1',
      },
    });

    const env = { MARIONETTE_STATE_HOME: stateRoot, MARIONETTE_CONTEXT: context };
    const resolved = resolveContext({ cwd: second, env });
    assert.equal(resolved.binding.projectId, a.binding.projectId);
    assert.equal(resolved.session?.parentWorkflowId, 'workflow-1');
    assert.throws(() => resolveContext({ bindingPath: b.bindingPath, env }), /cannot switch/);
    assert.equal(statSync(context).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('host mismatch and malformed context fail before project fallback', () => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-v1-context-'));

  try {
    const repositoryRoot = join(root, 'repo');
    mkdirSync(repositoryRoot);
    createBinding({ repositoryRoot, stateRoot: join(root, 'state-a') });
    assert.throws(
      () =>
        resolveContext({
          cwd: repositoryRoot,
          env: { MARIONETTE_STATE_HOME: join(root, 'state-b') },
        }),
      /another execution host/,
    );
    const context = join(root, 'bad.json');
    writeFileSync(context, '{');
    assert.throws(
      () => resolveContext({ cwd: repositoryRoot, env: { MARIONETTE_CONTEXT: context } }),
      SyntaxError,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
