import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'bun:test';

for (const initialized of [false, true]) {
  test(`MCP exits when client disconnects ${initialized ? 'after initialization' : 'immediately'}`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'marionette-mcp-eof-'));
    const child = spawn(
      process.execPath,
      [resolve(process.env.MARIONETTE_TEST_MCP ?? 'src/mcp.ts'), '--home', home],
      { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 },
    );
    const exited = once(child, 'exit');
    const lines = createInterface({ input: child.stdout });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    try {
      if (initialized) {
        const response = once(lines, 'line');
        child.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 'lifecycle-test', version: '1' },
            },
          }) + '\n',
        );
        const [line] = await response;
        assert.equal(JSON.parse(line).id, 1);
      }
      child.stdin.end();
      const [code, signal] = await exited;
      assert.equal(
        child.killed,
        false,
        'Client EOF must exit without the timeout killing the MCP server',
      );
      assert.equal(signal, null);
      assert.equal(code, 0, stderr);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      lines.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
}
