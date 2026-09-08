import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Schema } from 'effect';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'bun:test';
import { promisify } from 'node:util';
import { loadConfig } from '../src/config.js';
import { serve } from '../src/server.js';

test('real HTTP and STDIO MCP enforce instance auth and expose the same durable state', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'marionette-http-'))),
    probe = net.createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const port = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Finite }))(
    probe.address(),
  ).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const runtime = await serve(home, port),
    config = loadConfig(home),
    url = `http://127.0.0.1:${port}`;
  const client = new Client({ name: 'marionette-integration', version: '1' });
  try {
    assert.equal((await fetch(url + '/health')).status, 200);
    assert.equal(
      (
        await fetch(url + '/api/call', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{"action":"project.list"}',
        })
      ).status,
      401,
    );
    const request = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
      body: '{"action":"project.list"}',
    };
    assert.equal(
      (
        await fetch(url + '/api/call', {
          ...request,
          headers: { ...request.headers, Origin: 'https://untrusted.example' },
        })
      ).status,
      403,
    );
    const badHostStatus = await new Promise<number | undefined>((ok, fail) => {
      const req = http.request(
        url + '/health',
        { headers: { Host: 'untrusted.example' } },
        (res) => {
          res.resume();
          ok(res.statusCode);
        },
      );
      req.on('error', fail);
      req.end();
    });
    assert.equal(badHostStatus, 403);
    assert.deepEqual(await (await fetch(url + '/api/call', request)).json(), { result: [] });
    await assert.rejects(serve(home, port), /already running/);
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve('src/mcp.ts'), '--home', home],
        stderr: 'pipe',
      }),
    );
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 47);
    for (const name of [
      'outcome_create',
      'outcome_complete',
      'plan_revise',
      'lead_wait',
      'strategy_finish',
      'cleanup_preview',
      'cleanup_release',
      'cleanup_reconcile',
      'cleanup_deliver',
      'cleanup_archive',
      'cleanup_collect',
      'cleanup_configure',
      'profile_validate',
    ])
      assert.ok(tools.tools.some((t) => t.name === name));
    const projects = await client.callTool({ name: 'project_list', arguments: {} });
    assert.equal(projects.isError, undefined);
    assert.equal(
      Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ text: Schema.String })))(
        projects.content,
      )[0].text,
      '[]',
    );
    const missing = await client.callTool({
      name: 'project_briefing',
      arguments: { projectId: 'missing' },
    });
    assert.equal(missing.isError, true);
    assert.match(
      Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ text: Schema.String })))(
        missing.content,
      )[0].text,
      /Project not found/,
    );
    await runtime.supervisor.stop();
    runtime.service.store.put('project', 'parity', {
      id: 'parity',
      name: 'Parity',
      root: home,
      session: 'test',
      socketPath: join(home, 'unused.sock'),
      workspaceId: 'w1',
      maxConcurrency: 1,
      agentArgs: {},
      createdAt: new Date().toISOString(),
    });
    const post = async (action: string, input: any) => {
      const response = await fetch(url + '/api/call', {
        ...request,
        body: JSON.stringify({ action, input }),
      });
      return { status: response.status, ...(await response.json()) };
    };
    const {
      result: { lease },
    } = await post('lead.acquire', {
      projectId: 'parity',
      owner: 'integration',
      expectedEpoch: 0,
      reason: 'Verify all transports',
    });
    const created = await client.callTool({
      name: 'outcome_create',
      arguments: {
        lease,
        outcome: {
          projectId: 'parity',
          key: 'parity',
          objective: 'Same durable records across transports',
          scope: ['.'],
          criteria: [
            { id: 'proof', description: 'Verified artifact', requiredEvidence: 'Result file' },
          ],
        },
      },
    });
    assert.equal(created.isError, undefined);
    const outcome = JSON.parse(
      Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ text: Schema.String })))(
        created.content,
      )[0].text,
    );
    writeFileSync(join(home, 'lease.json'), JSON.stringify(lease), { mode: 0o600 });
    writeFileSync(
      join(home, 'assignment.json'),
      JSON.stringify({
        assignment: {
          projectId: 'parity',
          outcomeId: outcome.id,
          expectedTreeRevision: outcome.revision,
          key: 'cli-task',
          title: 'CLI task',
          kind: 'codex',
          prompt: 'Produce evidence',
          ownership: ['result.txt'],
          checks: [{ type: 'file', path: 'result.txt' }],
          deferStart: true,
        },
      }),
    );
    const cli = await promisify(execFile)(process.execPath, [
      resolve('src/cli.ts'),
      'call',
      'task.submit',
      '--home',
      home,
      '--lease',
      join(home, 'lease.json'),
      '--file',
      join(home, 'assignment.json'),
    ]);
    const task = JSON.parse(cli.stdout);
    const board = await post('board.get', { projectId: 'parity' });
    assert.equal(board.result.tasks[0].id, task.id);
    assert.equal(board.result.tasks[0].status, 'paused');
    const blocked = await client.callTool({
      name: 'outcome_complete',
      arguments: {
        lease,
        outcomeId: outcome.id,
        expectedRevision: board.result.outcomes[0].revision,
      },
    });
    assert.equal(blocked.isError, true);
    assert.match(
      Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ text: Schema.String })))(
        blocked.content,
      )[0].text,
      /required|criterion|integrated/i,
    );
    const unauthorized = await fetch(url + '/api/worker/' + task.id + '/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' },
      body: JSON.stringify({ action: 'inspect' }),
    });
    assert.equal(unauthorized.status, 401);
  } finally {
    await client.close();
    await runtime.shutdown();
    assert.equal(existsSync(join(home, 'supervisor.lock')), false);
    rmSync(home, { recursive: true, force: true });
  }
});

test('shutdown drains an in-flight HTTP operation even after its client disconnects', async () => {
  const { Effect, Latch } = await import('effect');
  const { Store } = await import('../src/store.js');
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'marionette-http-drain-')));
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Finite }))(
    probe.address(),
  ).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const runtime = await serve(home, port);
  const entered = Latch.makeUnsafe();
  const release = Latch.makeUnsafe();
  const config = loadConfig(home);
  runtime.service.store.put('project', 'held', { id: 'held', workspaceId: 'w1' });
  runtime.service.port = () => ({
    async call(method) {
      if (method === 'workspace.get') {
        entered.openUnsafe();
        await Effect.runPromise(release.await);
        runtime.service.store.event(
          'held',
          'test.late-write',
          'Request drained before SQLite close',
        );
      }
      return { agents: [], panes: [] };
    },
  });
  const controller = new AbortController();
  const request = fetch(`http://127.0.0.1:${port}/api/call`, {
    method: 'POST',
    signal: controller.signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
    body: JSON.stringify({ action: 'project.inspect', input: { projectId: 'held' } }),
  }).catch(() => undefined);
  try {
    await Effect.runPromise(entered.await.pipe(Effect.timeout(3000)));
    controller.abort();
    await request;
    let stopped = false;
    const stopping = runtime.shutdown().then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
    release.openUnsafe();
    await stopping;
    const store = new Store(join(home, 'state.sqlite'));
    try {
      assert.ok(store.events('held').some((event) => event.type === 'test.late-write'));
    } finally {
      store.close();
    }
  } finally {
    release.openUnsafe();
    controller.abort();
    await runtime.shutdown();
    rmSync(home, { recursive: true, force: true });
  }
});
