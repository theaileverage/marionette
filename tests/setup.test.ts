import test from 'node:test';
import assert from 'node:assert/strict';
import {
  realpathSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { trustAgyWorkspace } from '../src/agy-trust.js';
import { setupPlan, mcpCommand, privateJson } from '../src/setup.js';
import { installRuntime } from '../src/runtime.js';
import { Store } from '../src/store.js';
import { Service } from '../src/service.js';

function fixture(t: any) {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'marionette-setup-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
test('AGY trust preserves settings, permissions and existing roots and is idempotent', (t) => {
  const root = fixture(t),
    settings = resolve(root, 'settings.json');
  const original = {
    trustedWorkspaces: ['/existing/project'],
    model: 'chosen-model',
    permissions: { mode: 'ask' },
  };
  writeFileSync(settings, JSON.stringify(original), { mode: 0o640 });
  assert.equal(trustAgyWorkspace(root, settings).changed, true);
  const after = readFileSync(settings, 'utf8');
  assert.deepEqual(JSON.parse(after), {
    ...original,
    trustedWorkspaces: ['/existing/project', root],
  });
  assert.equal(statSync(settings).mode & 0o777, 0o640);
  assert.equal(trustAgyWorkspace(root, settings).changed, false);
  assert.equal(readFileSync(settings, 'utf8'), after);
});
test('AGY trust fails closed on malformed data and concurrent lock', (t) => {
  const root = fixture(t),
    settings = resolve(root, 'settings.json');
  for (const input of ['invalid', '[]', '{"trustedWorkspaces":true}']) {
    writeFileSync(settings, input);
    assert.throws(() => trustAgyWorkspace(root, settings));
    assert.equal(readFileSync(settings, 'utf8'), input);
    assert.equal(existsSync(settings + '.marionette.lock'), false);
  }
  writeFileSync(settings, '{}');
  writeFileSync(settings + '.marionette.lock', 'existing');
  assert.throws(() => trustAgyWorkspace(root, settings), /being edited/);
  assert.equal(readFileSync(settings, 'utf8'), '{}');
});
test('setup dry plan is read-only, validates input and retains saved lead preferences', (t) => {
  const root = fixture(t),
    home = resolve(root, 'state');
  assert.throws(() => setupPlan({ project: root, lead: 'typo' }));
  assert.throws(() => setupPlan({ project: root, trutsAgy: true }));
  const plan = setupPlan({ project: root, home, lead: 'claude', leadName: 'Ada', mcp: 'skip' });
  assert.equal(plan.leadName, 'Ada');
  assert.equal(existsSync(home), false);
  privateJson(resolve(root, '.marionette/project.json'), {
    home,
    lead: 'claude',
    leadName: 'Ada',
    trustAgy: false,
    mcp: 'skip',
    session: plan.session,
    socket: plan.socket,
    workspace: 'w9',
  });
  const repeat = setupPlan({ project: root });
  assert.equal(repeat.leadName, 'Ada');
  assert.equal(repeat.lead, 'claude');
  assert.equal(repeat.trustAgy, false);
  assert.equal(repeat.workspace, 'w9');
  assert.equal(statSync(resolve(root, '.marionette/project.json')).mode & 0o777, 0o600);
});
test('durable runtime survives deletion of the npx package and reuses identical content', (t) => {
  const root = fixture(t),
    source = resolve(root, 'npm-cache/package'),
    home = resolve(root, 'state');
  mkdirSync(resolve(source, 'dist'), { recursive: true });
  mkdirSync(resolve(source, 'public'), { recursive: true });
  writeFileSync(resolve(source, 'package.json'), '{"version":"1.2.3"}');
  writeFileSync(resolve(source, 'dist/cli.js'), 'cli');
  writeFileSync(resolve(source, 'dist/mcp.js'), 'mcp');
  writeFileSync(resolve(source, 'public/index.html'), 'dashboard');
  const runtime = installRuntime(home, source);
  assert.equal(installRuntime(home, source), runtime);
  rmSync(source, { recursive: true });
  assert.equal(readFileSync(resolve(runtime, 'dist/mcp.js'), 'utf8'), 'mcp');
  assert.equal(readFileSync(resolve(runtime, 'public/index.html'), 'utf8'), 'dashboard');
  assert.equal(installRuntime(home, runtime), runtime);
});
test('all MCP client commands use separate arguments and stable executable paths', () => {
  for (const agent of ['codex-desktop', 'codex', 'claude', 'agy'] as const) {
    const c = mcpCommand(
      agent,
      'marionette-test',
      '/path with spaces/runtime',
      '/state with spaces',
    );
    assert.equal(c.binary, agent === 'codex-desktop' ? 'codex' : agent);
    assert.deepEqual(c.args.slice(-5), [
      process.execPath,
      '--no-warnings',
      '/path with spaces/runtime/dist/mcp.js',
      '--home',
      '/state with spaces',
    ]);
    if (agent === 'claude') assert.ok(c.args.includes('user'));
  }
});
test('named lead agent metadata follows handover while old leases are fenced', async (t) => {
  const root = fixture(t),
    store = new Store(resolve(root, 'state.sqlite'));
  t.after(() => store.close());
  const service = new Service(store, () => ({ call: async () => ({}) }));
  const p = await service.invoke('project.register', {
    name: 'Test',
    root,
    session: 'test',
    socketPath: '/tmp/test.sock',
    workspaceId: 'w1',
  });
  const first = await service.invoke('lead.acquire', {
    projectId: p.id,
    owner: 'Ada',
    agent: 'claude',
    expectedEpoch: 0,
    reason: 'setup',
  });
  assert.equal(first.briefing.lead.agent, 'claude');
  const next = await service.invoke('lead.handover', {
    lease: first.lease,
    toOwner: 'Grace',
    agent: 'agy',
    reason: 'handover',
  });
  assert.equal(next.briefing.lead.owner, 'Grace');
  assert.equal(next.briefing.lead.agent, 'agy');
  await assert.rejects(
    service.invoke('project.configure', { lease: first.lease, trustAgyWorkspaces: true }),
    /another lead/,
  );
  assert.equal(
    (await service.invoke('project.configure', { lease: next.lease, trustAgyWorkspaces: true }))
      .trustAgyWorkspaces,
    true,
  );
});
