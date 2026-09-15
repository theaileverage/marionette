import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createBinding, localSessionContext, resolveContext, writeSessionContext } from '../../src/v1/context.js';

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

test('init migrates a legacy binding without changing project identity or managed context', () => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-v1-binding-migration-'));

  try {
    const repositoryRoot = join(root, 'repo');
    const stateRoot = join(root, 'state');
    mkdirSync(repositoryRoot);
    const original = createBinding({ repositoryRoot, stateRoot });
    const legacyPath = join(dirname(dirname(original.bindingPath)), '.marionette-v1', 'project.json');
    mkdirSync(dirname(legacyPath));
    renameSync(original.bindingPath, legacyPath);

    const context = writeSessionContext({
      stateDirectory: original.binding.stateDirectory,
      context: {
        version: 1, bindingPath: legacyPath, projectId: original.binding.projectId,
        hostId: original.binding.hostId, sessionId: 'worker', generation: 1,
        token: randomBytes(32).toString('hex'),
      },
    });

    const env = { MARIONETTE_STATE_HOME: stateRoot };
    assert.equal(resolveContext({ cwd: repositoryRoot, env }).bindingPath, legacyPath);
    const migrated = createBinding({ repositoryRoot, stateRoot });
    assert.equal(migrated.bindingPath, original.bindingPath);
    assert.deepEqual(migrated.binding, original.binding);
    assert.deepEqual(readFileSync(migrated.bindingPath), readFileSync(legacyPath));
    assert.equal(resolveContext({ cwd: repositoryRoot, env }).bindingPath, migrated.bindingPath);
    assert.equal(resolveContext({ cwd: repositoryRoot, env: { ...env, MARIONETTE_CONTEXT: context } }).bindingPath, legacyPath);
    assert.ok(existsSync(legacyPath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('local binding migration rejects a different binding and an unrecognized credential path', () => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-v1-local-binding-'));

  try {
    const repositoryRoot = join(root, 'repo');
    const stateRoot = join(root, 'state');
    mkdirSync(repositoryRoot);
    const current = createBinding({ repositoryRoot, stateRoot });
    const legacyPath = join(dirname(dirname(current.bindingPath)), '.marionette-v1', 'project.json');
    mkdirSync(dirname(legacyPath));
    writeFileSync(legacyPath, readFileSync(current.bindingPath));
    const localPath = join(current.binding.stateDirectory, 'local-user.json');

    const credential = {
      version: 1, bindingPath: legacyPath, projectId: current.binding.projectId,
      hostId: current.binding.hostId, sessionId: 'user-local', generation: 1,
      token: randomBytes(32).toString('hex'),
    };

    writeFileSync(localPath, JSON.stringify(credential));
    assert.equal(localSessionContext(current).bindingPath, current.bindingPath);
    assert.equal(localSessionContext(current).token, credential.token);

    writeFileSync(legacyPath, JSON.stringify({ ...current.binding, databasePath: join(root, 'other.sqlite') }));
    assert.throws(() => localSessionContext(current), /bindings disagree/);

    rmSync(legacyPath);
    assert.throws(() => localSessionContext(current), /ENOENT/);
    assert.equal(JSON.parse(readFileSync(localPath, 'utf8')).token, credential.token);

    const unexpectedPath = join(root, 'unexpected.json');
    writeFileSync(unexpectedPath, readFileSync(current.bindingPath));
    writeFileSync(localPath, JSON.stringify({ ...credential, bindingPath: unexpectedPath }));
    assert.equal(localSessionContext(current).bindingPath, unexpectedPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
