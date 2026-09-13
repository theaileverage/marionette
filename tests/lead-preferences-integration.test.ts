import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { test } from 'bun:test';
import { Schema } from 'effect';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { serve } from '../src/server.js';
import { credentialsSchema } from '../src/types.js';

type ToolResult = Awaited<ReturnType<Client['callTool']>>;
function toolValue(result: ToolResult) {
  const text = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ text: Schema.String })))(
    result.content,
  );
  assert.ok(text[0]);
  return JSON.parse(text[0].text);
}

test('scoped HTTP and STDIO persist lead preferences and audit conversational grants without admin access', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'marionette-lead-prefs-http-')));
  const probe = net.createServer();
  await new Promise<void>((ok) => probe.listen(0, '127.0.0.1', ok));
  const { port } = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Finite }))(
    probe.address(),
  );
  await new Promise<void>((ok) => probe.close(() => ok()));
  let runtime = await serve(home, port);
  const client = new Client({ name: 'lead-preferences-acceptance', version: '1' });
  try {
    await runtime.supervisor.stop();
    runtime.service.store.put('project', 'preferences', {
      id: 'preferences',
      name: 'Preferences',
      root: home,
      session: 'default',
      socketPath: join(home, 'absent.sock'),
      workspaceId: 'w1',
      maxConcurrency: 1,
      agentArgs: {},
      createdAt: new Date().toISOString(),
      authorityMode: 'conversation',
    });
    const { lease } = await runtime.service.invoke('lead.acquire', {
      projectId: 'preferences',
      owner: 'Ada',
      agent: 'codex',
      expectedEpoch: 0,
      reason: 'Acceptance test',
    });
    const outcome = await runtime.service.invoke('outcome.create', {
      lease,
      outcome: {
        projectId: 'preferences',
        key: 'prefs',
        objective: 'Persist preferences safely',
        scope: ['.'],
        criteria: [
          { id: 'proof', description: 'Durable result', requiredEvidence: 'Saved record' },
        ],
      },
    });
    const leaseFile = join(home, 'lease.json');
    writeFileSync(leaseFile, JSON.stringify(lease), { mode: 0o600 });
    const url = `http://127.0.0.1:${port}`;
    const post = (
      action: string,
      input: Schema.Json,
      identity: Schema.Schema.Type<typeof credentialsSchema> = lease,
    ) =>
      fetch(url + '/api/lead/call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${identity.token}` },
        body: JSON.stringify({ lease: identity, action, input }),
      });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          resolve(process.env.MARIONETTE_TEST_MCP ?? 'src/mcp.ts'),
          '--lead-lease',
          leaseFile,
          '--url',
          url,
        ],
        stderr: 'pipe',
      }),
    );
    const tools = await client.listTools();
    for (const name of [
      'authority_record_user_request',
      'lead_preferences_get',
      'lead_preferences_set',
    ])
      assert.ok(tools.tools.some((tool) => tool.name === name));
    assert.ok(!tools.tools.some((tool) => tool.name === 'project_configure'));
    assert.ok(
      tools.tools.every((tool) => !Object.hasOwn(tool.inputSchema.properties ?? {}, 'lease')),
    );
    const response = await post('lead.preferences.set', {
      expectedRevision: 0,
      preferences: { instructions: 'Report concise evidence.', skills: [] },
    });
    assert.equal(response.status, 200);
    const read = await client.callTool({
      name: 'lead_preferences_get',
      arguments: { projectId: 'preferences' },
    });
    assert.equal(read.isError, undefined);
    assert.equal(toolValue(read).instructions, 'Report concise evidence.');
    const updated = await client.callTool({
      name: 'lead_preferences_set',
      arguments: {
        projectId: 'preferences',
        expectedRevision: 1,
        preferences: { instructions: 'Include the checked revision.', skills: [] },
      },
    });
    assert.equal(updated.isError, undefined);
    assert.equal(toolValue(updated).revision, 2);
    const grant = await client.callTool({
      name: 'authority_record_user_request',
      arguments: {
        projectId: 'preferences',
        outcomeId: outcome.id,
        expectedRevision: outcome.revision,
        activities: ['implementation', 'execute'],
        scope: ['.'],
        source: 'Implement this request and run its checks.',
      },
    });
    assert.equal(grant.isError, undefined);
    const recorded = toolValue(grant);
    assert.equal(recorded.origin, 'lead-conversation');
    assert.equal(recorded.recordedBy, 'Ada');
    assert.ok(runtime.service.store.get('authority-history', recorded.id));
    assert.equal((await post('project.configure', { coordinatorOnly: false })).status, 403);
    assert.notEqual((await post('lead.preferences.get', { projectId: 'other' })).status, 200);
    const stale = await client.callTool({
      name: 'lead_preferences_set',
      arguments: {
        projectId: 'preferences',
        expectedRevision: 0,
        preferences: { instructions: 'Overwrite', skills: [] },
      },
    });
    assert.equal(stale.isError, true);
    await runtime.shutdown();
    runtime = await serve(home, port);
    await runtime.supervisor.stop();
    const persisted = await client.callTool({
      name: 'lead_preferences_get',
      arguments: { projectId: 'preferences' },
    });
    assert.equal(persisted.isError, undefined);
    assert.equal(toolValue(persisted).revision, 2);
    assert.equal(toolValue(persisted).instructions, 'Include the checked revision.');
    assert.ok(runtime.service.store.get('authority-history', recorded.id));
    assert.notEqual(
      (await post('lead.preferences.get', {}, { ...lease, token: 'wrong-token' })).status,
      200,
    );
    await runtime.service.invoke('lead.acquire', {
      projectId: 'preferences',
      owner: 'Grace',
      agent: 'codex',
      expectedEpoch: lease.epoch,
      takeover: true,
      reason: 'Verify old lease fencing',
    });
    assert.notEqual((await post('lead.preferences.get', {})).status, 200);
    const fenced = await client.callTool({
      name: 'lead_preferences_get',
      arguments: { projectId: 'preferences' },
    });
    assert.equal(fenced.isError, true);
  } finally {
    await client.close();
    await runtime.shutdown();
    rmSync(home, { recursive: true, force: true });
  }
});
