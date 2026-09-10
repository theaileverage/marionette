import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { catalogProfiles, parseCatalog } from '../src/model-catalog.js';
import { ompProbeSucceeded } from '../src/omp-profile.js';
import { profileArgs } from '../src/profiles.js';
import { agentAccessArgs } from '../src/agent-access.js';
import { readMcpRegistration, writeOmpMcp } from '../src/mcp-registration.js';
import { workspaceTrustEnabled } from '../src/workspace-trust.js';
import { toolInstaller } from '../src/setup-dependencies.js';

test('OMP catalog preserves exact provider IDs and effort while rejecting aliases and mismatched selectors', () => {
  const item = {
    provider: 'fixture',
    id: 'model-1',
    selector: 'fixture/model-1',
    name: 'Fixture model',
    thinking: ['low', 'high'],
    input: ['text'],
  };
  const models = parseCatalog('omp', {
    models: [
      item,
      item,
      { ...item, id: 'auto', selector: 'fixture/auto' },
      { ...item, selector: 'other/model-1' },
    ],
  });
  assert.equal(models.length, 1);
  const [profile] = catalogProfiles({
    kind: 'omp',
    models,
    source: 'fixture',
    fetchedAt: '2026-09-09T00:00:00Z',
  });
  assert.equal(profile.availability, 'unverified');
  assert.deepEqual(profile.supportedReasoning, ['low', 'high']);
  assert.deepEqual(profileArgs({ ...profile, reasoning: 'high' }), [
    '--model',
    'fixture/model-1',
    '--thinking',
    'high',
  ]);
  assert.deepEqual(agentAccessArgs('omp', { omp: 'full-access' }), ['--approval-mode', 'yolo']);
  assert.equal(workspaceTrustEnabled({}, 'omp'), false);
  assert.deepEqual(toolInstaller('omp', false, false), {
    binary: process.execPath,
    args: ['install', '-g', '@oh-my-pi/pi-coding-agent'],
  });
});

test('OMP validation requires a successful response from the selected provider and model', () => {
  const event = {
    type: 'message_end',
    message: {
      role: 'assistant',
      provider: 'fixture',
      model: 'model-1',
      stopReason: 'stop',
      content: [{ type: 'text', text: 'MARIONETTE_PROFILE_OK' }],
    },
  };
  assert.equal(ompProbeSucceeded('diagnostic\n' + JSON.stringify(event), 'fixture/model-1'), true);
  assert.equal(ompProbeSucceeded(JSON.stringify(event), 'other/model-1'), false);
  assert.equal(
    ompProbeSucceeded(
      JSON.stringify({ ...event, message: { ...event.message, stopReason: 'error' } }),
      'fixture/model-1',
    ),
    false,
  );
  assert.equal(ompProbeSucceeded('{broken json', 'fixture/model-1'), false);
});

test('OMP registration preserves unrelated settings and servers and honors explicit configuration paths', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'marionette-omp-mcp-'));
  const path = resolve(root, 'mcp.json');
  try {
    const other = { command: 'other', args: [], env: { SETTING: 'preserve' } };
    writeFileSync(path, JSON.stringify({ mcpServers: { other }, defaults: { timeout: 23 } }));
    const server = { command: process.execPath, args: ['/runtime/mcp.js', '--home', '/state'] };
    writeOmpMcp('fixture', server, path);
    assert.deepEqual(readMcpRegistration('omp', 'fixture', path)?.server, server);
    writeOmpMcp('fixture', undefined, path);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
      mcpServers: { other },
      defaults: { timeout: 23 },
    });
    writeFileSync(path, '{broken');
    assert.throws(() => writeOmpMcp('fixture', server, path));
    assert.equal(readFileSync(path, 'utf8'), '{broken');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
