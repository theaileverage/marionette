import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

assert.equal(process.env.HERDR_ENV, '1', 'Run inside the actual browser-controlled Herdr pane');
const root = process.env.HARNESS_ROOT;
assert.ok(root && process.env.MARIONETTE_CLI);
const evidence = [];
for (const fixture of ['fresh', 'existing']) {
  const binding = JSON.parse(readFileSync(join(root, fixture, '.marionette/project.json'), 'utf8'));
  const config = JSON.parse(readFileSync(join(binding.home, 'config.json'), 'utf8'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      join(dirname(process.env.MARIONETTE_CLI), 'mcp.js'),
      '--home',
      binding.home,
      '--lead-lease',
      binding.leasePath,
      '--url',
      `http://127.0.0.1:${config.port}`,
    ],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'scoped-wait-harness', version: '1.0.0' });
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError)
      writeFileSync(
        join(root, `evidence/scoped-${fixture}-${name}-error.json`),
        JSON.stringify(result),
      );
    assert.ok(!result.isError, `${name} returned an MCP error`);
    const value = JSON.parse(result.content.find((c) => c.type === 'text').text);
    assert.notEqual(value.ok, false, `${name} returned an application error`);
    return value;
  };
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(!tools.tools.some((t) => t.name === 'authority_grant'));
    const ids = [];
    for (const objective of ['Earlier investigation', 'Added investigation']) {
      const outcome = await call('outcome_create', {
        outcome: {
          projectId: binding.projectId,
          key: `scoped-wait-${objective}`,
          objective,
          scope: ['.'],
          criteria: [
            {
              id: 'evidence',
              description: 'Transport test fixture',
              requiredEvidence: 'Successful scoped wait registration',
            },
          ],
        },
      });
      const wait = await call('lead_wait', {
        key: `scoped-wait-${outcome.id}`,
        outcomeId: outcome.id,
        condition: { tasks: [], intervention: true },
        adapter: { type: 'next-message' },
      });
      assert.equal(wait.projectId, binding.projectId);
      assert.equal(wait.outcomeId, outcome.id);
      ids.push(outcome.id);
    }
    const briefing = await call('project_briefing', { projectId: binding.projectId });
    assert.ok(ids.every((id) => briefing.swarm.activeIntents.some((i) => i.outcomeId === id)));
    evidence.push({ fixture, outcomeIds: ids, scopedWaits: true, bothIntentsVisible: true });
    console.log(`SCOPED_WAITS_OK ${fixture}`);
  } finally {
    await client.close();
  }
}
writeFileSync(join(root, 'evidence/scoped-waits.json'), JSON.stringify(evidence, null, 2));
