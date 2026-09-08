import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  HerdrClient,
  HERDR_METHODS,
  HERDR_PROTOCOL,
  HERDR_SCHEMA_SHA256,
} from '../src/herdr-sdk.js';
import { createHash } from 'node:crypto';
// @ts-expect-error The generator is a development-only JavaScript tool.
import { generateProtocol } from '../scripts/generate-herdr-sdk.mjs';
const source = readFileSync(
  new URL('../vendor/herdr-0.9.0/api.schema.json', import.meta.url),
  'utf8',
);
const schema = JSON.parse(source);

function sample(node: any): any {
  if (node.$ref)
    return sample(
      node.$ref
        .slice(2)
        .split('/')
        .reduce((s: any, key: string) => s[key], schema),
    );
  if (Object.hasOwn(node, 'const')) return node.const;
  if (node.enum) return node.enum[0];
  if (node.oneOf || node.anyOf) return sample((node.oneOf ?? node.anyOf)[0]);
  if (Array.isArray(node.type)) return sample({ ...node, type: node.type[0] });
  if (node.type === 'object')
    return Object.fromEntries(
      (node.required ?? []).map((key: string) => [key, sample(node.properties[key])]),
    );
  if (node.type === 'array') return [];
  if (node.type === 'string') return '/fixture/value';
  if (node.type === 'boolean') return false;
  if (node.type === 'number' || node.type === 'integer') return 1;
  return null;
}

test('SDK registry and generated types match the pinned installed protocol 22 schema', async () => {
  assert.equal(HERDR_PROTOCOL, 22);
  assert.equal(HERDR_SCHEMA_SHA256, createHash('sha256').update(source).digest('hex'));
  assert.deepEqual(
    HERDR_METHODS,
    schema.schemas.request.oneOf.map((r: any) => r.properties.method.const),
  );
  assert.equal(HERDR_METHODS.length, 102);
  assert.equal(
    await generateProtocol(source),
    readFileSync(new URL('../src/herdr-protocol.ts', import.meta.url), 'utf8'),
  );
});

test('every schema method routes through the typed API without renaming or losing parameters', async () => {
  const root = mkdtempSync(join(tmpdir(), 'herdr-api-'));
  const path = join(root, 'h.sock');
  const sockets = new Set<net.Socket>();
  const received: any[] = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let input = '';
    socket.on('data', (data) => {
      input += data;
      if (!input.includes('\n')) return;
      const request = JSON.parse(input.slice(0, input.indexOf('\n')));
      received.push(request);
      const response =
        JSON.stringify({
          id: request.id,
          result: { type: request.method === 'events.subscribe' ? 'subscription_started' : 'ok' },
        }) + '\n';
      if (request.method === 'events.subscribe' || request.method === 'pane.graphics.stream')
        socket.write(response);
      else socket.end(response);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  try {
    const h = new HerdrClient(path);
    assert.deepEqual(Object.keys(h.api).sort(), [...HERDR_METHODS, 'pane.graphics.stream'].sort());
    for (const request of schema.schemas.request.oneOf) {
      const method = request.properties.method.const;
      const params = sample(request.properties.params ?? { type: 'object' });
      const result = await (h.api as any)[method](params);
      assert.equal(received.at(-1).method, method);
      assert.deepEqual(received.at(-1).params, params, method);
      if (method === 'events.subscribe') result.close();
    }
    const graphics = await h.api['pane.graphics.stream']({
      pane_id: 'w1:p1',
      layer_id: 'tests',
      z_index: 2,
    });
    assert.deepEqual(received.at(-1).params, { pane_id: 'w1:p1', layer_id: 'tests', z_index: 2 });
    graphics.close();
    await assert.rejects(h.call('events.subscribe'), /streaming method/);
    await assert.rejects(h.call('pane.graphics.stream'), /streaming method/);
    assert.equal(received.length, 103);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

// Compiled by npm run check; never execute mutations merely to validate their types.
function typeContract(h: HerdrClient) {
  void h.api['workspace.close']({ workspace_id: 'w1', close_group: true });
  void h.api['pane.move']({
    pane_id: 'w1:p1',
    destination: { type: 'new_tab', workspace_id: 'w1' },
  });
  void h.request('integration.list');
  void h.api['plugin.log.list']({ plugin_id: 'example', limit: 20 });
  void h.subscribe([{ type: 'layout.updated' }]);
  // @ts-expect-error pane.move requires a source pane.
  void h.api['pane.move']({ destination: { type: 'new_tab' } });
  // @ts-expect-error pane.split requires direction.
  void h.request('pane.split', { target_pane_id: 'w1:p1' });
  // @ts-expect-error Unknown methods belong to the explicit call() escape hatch.
  void h.request('invented.method', {});
  // @ts-expect-error Events need a persistent transport, not a one-shot request.
  void h.request('events.subscribe', { subscriptions: [] });
  // @ts-expect-error No such subscription exists in protocol 22.
  void h.subscribe([{ type: 'made.up' }]);
}
void typeContract;
