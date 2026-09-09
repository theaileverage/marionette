import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { Schema } from 'effect';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentAccessArgs, agentAccessSchema } from '../src/agent-access.js';
import { agentAccessSchema as transportSchema } from '../src/mcp-schemas.js';
import { setupPlan } from '../src/setup.js';
import { terminalLeadArgs } from '../src/lead-terminal.js';
import { fixture } from './swarm-fixture.js';

const full = { codex: 'full-access', claude: 'full-access', agy: 'full-access' } as const;

test('access is inherited unless explicitly selected, with native full-access flags for each harness', () => {
  for (const kind of ['codex', 'claude', 'agy'] as const) {
    assert.deepEqual(agentAccessArgs(kind, undefined, ['--model', 'exact']), ['--model', 'exact']);
    assert.deepEqual(agentAccessArgs(kind, { [kind]: 'inherit' }, ['--model', 'exact']), [
      '--model',
      'exact',
    ]);
    const args = agentAccessArgs(kind, full);
    assert.ok(
      args.includes(
        kind === 'codex'
          ? '--dangerously-bypass-approvals-and-sandbox'
          : '--dangerously-skip-permissions',
      ),
    );
    const lead = terminalLeadArgs(kind, args, 'Lead prompt');
    assert.deepEqual(lead.slice(0, args.length), args);
  }
  assert.ok(agentAccessArgs('agy', full).includes('--sandbox=false'));
  assert.deepEqual(JSON.parse(agentAccessArgs('claude', full).at(-1)!), {
    sandbox: { enabled: false },
  });
  assert.deepEqual(Schema.decodeUnknownSync(agentAccessSchema)(transportSchema.parse(full)), full);
  assert.throws(() => Schema.decodeUnknownSync(agentAccessSchema)({ codex: 'typo' }));
  assert.throws(() => transportSchema.parse({ codex: 'full-access', typo: true }));
});

test('conflicting explicit flags fail instead of silently weakening or rewriting another policy', () => {
  for (const args of [
    ['--approve-for-me'],
    ['--sandbox=workspace-write'],
    ['-a', 'never'],
    ['-c', 'sandbox_mode="read-only"'],
  ])
    assert.throws(() => agentAccessArgs('codex', full, args), /conflict/);
  assert.throws(() => agentAccessArgs('claude', full, ['--settings', 'custom.json']), /conflict/);
  assert.throws(() => agentAccessArgs('agy', full, ['--sandbox']), /conflict/);
});

test('setup retains per-harness choices and supports reverting one harness to inherited access', () => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-access-'));
  try {
    assert.deepEqual(setupPlan({ project: root }).agentAccess, {});
    mkdirSync(join(root, '.marionette'));
    writeFileSync(join(root, '.marionette/project.json'), JSON.stringify({ agentAccess: full }));
    assert.deepEqual(setupPlan({ project: root }).agentAccess, full);
    const plan = setupPlan({ project: root, agentAccess: { claude: 'inherit' } });
    assert.deepEqual(plan.agentAccess, { ...full, claude: 'inherit' });
    assert.ok(
      plan.effects.some((e) => e.includes('new codex') && e.includes('full harness access')),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('project configuration applies full access to new workers, patches one harness and preserves current runs', async () => {
  const f = await fixture();
  try {
    await f.invoke('project.configure', { agentAccess: full });
    const task = await f.submit('a');
    await f.tick();
    const start = f.agents.calls.find((c) => c.method === 'agent.start')!;
    assert.ok(start.params.args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(start.params.args.some((a: string) => a.includes('mcp_servers.marionette_worker')));
    const runId = f.service.task(task.id).runId;
    await f.invoke('project.configure', { agentAccess: { codex: 'inherit' } });
    assert.deepEqual(f.service.project(f.p.id).agentAccess, { ...full, codex: 'inherit' });
    assert.equal(f.service.task(task.id).runId, runId);
    await assert.rejects(
      f.invoke('project.configure', {
        agentAccess: full,
        agentArgs: { codex: ['--sandbox', 'read-only'] },
      }),
      /conflict/,
    );
    assert.equal(f.service.project(f.p.id).agentAccess?.codex, 'inherit');
  } finally {
    await f.close();
  }
});
