import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { ConfigProvider, Effect } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { assignmentSchema, outcomeSchema } from '../src/mcp-schemas.js';
import { mcpResult } from '../src/mcp-result.js';
import { AppError } from '../src/types.js';
import { workerMcpArgs } from '../src/worker-mcp.js';
import { workerRequestEffect } from '../src/server-control.js';

const assignment = {
  projectId: 'p',
  key: 'remove-iii',
  title: 'Remove iii',
  kind: 'codex',
  prompt: 'Remove iii and verify the maintained Cloudflare path',
  ownership: ['services/iii'],
  checks: [{ type: 'command', command: 'pnpm', args: ['test'] }],
};

test('MCP dispatch validates revision, paths and timeout limits before calling the supervisor', () => {
  const invalid = assignmentSchema.safeParse({
    ...assignment,
    outcomeId: 'existing',
    ownership: ['services/iii/**'],
    checks: [{ type: 'command', command: 'pnpm', timeoutMs: 300000 }],
  });
  assert.equal(invalid.success, false);
  if (invalid.success) throw new Error('Expected invalid assignment');
  const fields = invalid.error.issues.map((issue) => issue.path.join('.'));
  assert.ok(fields.includes('expectedTreeRevision'));
  assert.ok(fields.includes('ownership.0'));
  assert.ok(fields.includes('checks.0.timeoutMs'));
  assert.ok(assignmentSchema.safeParse(assignment).success);
  assert.ok(
    assignmentSchema.safeParse({ ...assignment, parentId: 'p', expectedTreeRevision: 1 }).success,
  );
  assert.equal(
    assignmentSchema.safeParse({ ...assignment, outcomeId: 'existing', expectedTreeRevision: 0 })
      .success,
    false,
  );
});

test('MCP read-only assignments cannot accidentally grant writes or delegation', () => {
  assert.equal(assignmentSchema.safeParse({ ...assignment, ownership: [] }).success, false);
  assert.ok(assignmentSchema.safeParse({ ...assignment, ownership: [], readOnly: true }).success);
  assert.equal(assignmentSchema.safeParse({ ...assignment, readOnly: true }).success, false);
  assert.equal(
    assignmentSchema.safeParse({ ...assignment, ownership: [], readOnly: true, canDelegate: true })
      .success,
    false,
  );
  assert.match(outcomeSchema.shape.scope.description!, /filesystem boundary, never prose/);
});

test('MCP failures remain errors and carry parseable status rather than an apparent success', async () => {
  const result = await mcpResult(
    Effect.fail(
      new AppError({ code: 'lead_identity', message: 'No wait was registered', status: 400 }),
    ),
  );
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    ok: false,
    error: { code: 'lead_identity', message: 'No wait was registered' },
  });
  const text = result.content[0];
  assert.equal(text.type, 'text');
  if (text.type !== 'text') throw new Error('Expected error text');
  assert.deepEqual(JSON.parse(text.text), result.structuredContent);
  const success = await mcpResult(Effect.succeed({ id: 'wait-id', state: 'waiting' }));
  assert.equal(success.isError, undefined);
  assert.deepEqual(success.structuredContent, {
    ok: true,
    result: { id: 'wait-id', state: 'waiting' },
  });
});

test('worker MCP launch overrides are valid TOML even for paths with spaces and quotes', () => {
  const args = workerMcpArgs('/runtime with spaces/bun', '/runtime/"quoted"/cli.js');
  const overrides = args.filter((_, index) => index % 2 === 1).join('\n');
  const config = Bun.TOML.parse(overrides);
  assert.deepEqual(config, {
    mcp_servers: {
      marionette_worker: {
        command: '/runtime with spaces/bun',
        args: ['/runtime/"quoted"/cli.js', 'worker-mcp'],
        env_vars: ['MARIONETTE_URL', 'MARIONETTE_TASK_ID', 'MARIONETTE_WORKER_TOKEN'],
        enabled: true,
        required: true,
        startup_timeout_sec: 20,
        tool_timeout_sec: 20,
      },
    },
  });
});

test('worker transport failures explain permission recovery without replaying mutations or hiding auth errors', async () => {
  const config = ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      MARIONETTE_URL: 'http://127.0.0.1:4382',
      MARIONETTE_TASK_ID: 'task',
      MARIONETTE_WORKER_TOKEN: 'private-test-token',
    }),
  );
  let requests = 0;
  const blocked = Object.assign(
    async () => {
      requests++;
      throw new Error('Operation not permitted');
    },
    { preconnect() {} },
  );
  const result = await mcpResult(
    workerRequestEffect('worker-report', { revision: 1, type: 'complete', summary: 'Done' }).pipe(
      Effect.provide(config),
      Effect.provideService(FetchHttpClient.Fetch, blocked),
    ),
  );
  assert.equal(requests, 1);
  assert.equal(result.isError, true);
  const serialized = JSON.stringify(result);
  assert.match(serialized, /worker_transport/);
  assert.match(serialized, /require_escalated/);
  assert.match(serialized, /inspect the current/);
  assert.equal(serialized.includes('private-test-token'), false);
  const denied = Object.assign(
    async () =>
      new Response(
        JSON.stringify({ error: { code: 'worker_auth', message: 'Invalid worker token' } }),
        { status: 401 },
      ),
    { preconnect() {} },
  );
  const auth = await mcpResult(
    workerRequestEffect('worker-call', { action: 'inspect' }).pipe(
      Effect.provide(config),
      Effect.provideService(FetchHttpClient.Fetch, denied),
    ),
  );
  assert.deepEqual(auth.structuredContent, {
    ok: false,
    error: { code: 'worker_auth', message: 'Invalid worker token' },
  });
});
