/** Run after installing the candidate tarball in the isolated cache. No agents launched. */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import net from 'node:net';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const root = '/private/tmp/marionette-v02-package-smoke',
  cache = resolve(root, 'npm-cache-final'),
  home = mkdtempSync(resolve(root, 'state-'));
const installs = readdirSync(resolve(cache, '_npx'))
  .map((d) => resolve(cache, '_npx', d, 'node_modules/@theaileverage/marionette'))
  .filter((p) => existsSync(resolve(p, 'dist/cli.js')));
assert.equal(installs.length, 1);
const installed = installs[0],
  cli = resolve(installed, 'dist/cli.js'),
  exec = promisify(execFile);
assert.equal(JSON.parse(readFileSync(resolve(installed, 'package.json'), 'utf8')).version, '0.2.0');
assert.ok(JSON.parse(readFileSync(resolve(root, 'setup-schema.json'), 'utf8')).leadProfile);
const run = async (path, args) =>
  (await exec(process.execPath, ['--no-warnings', path, ...args], { cwd: root, timeout: 30000 }))
    .stdout;
const portProbe = net.createServer();
await new Promise((r) => portProbe.listen(0, '127.0.0.1', r));
const port = portProbe.address().port;
await new Promise((r) => portProbe.close(r));
await run(cli, ['start', '--home', home, '--port', String(port)]);
let runtime;
const client = new Client({ name: 'v02-package-smoke', version: '1' });
try {
  const config = JSON.parse(readFileSync(resolve(home, 'config.json'), 'utf8'));
  const url = `http://127.0.0.1:${config.port}`,
    health = await (await fetch(url + '/health')).json();
  assert.equal(health.version, '0.2.0');
  assert.equal(health.setupVersion, 2);
  const dirs = readdirSync(resolve(home, 'runtimes')).filter((d) => d.startsWith('0.2.0-'));
  assert.equal(dirs.length, 1);
  runtime = resolve(home, 'runtimes', dirs[0]);
  assert.equal(existsSync(resolve(runtime, 'node_modules')), false);
  rmSync(cache, { recursive: true, force: true });
  assert.equal((await fetch(url + '/')).status, 200);
  assert.equal((await run(resolve(runtime, 'dist/cli.js'), ['--version'])).trim(), '0.2.0');
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['--no-warnings', resolve(runtime, 'dist/mcp.js'), '--home', home],
      stderr: 'pipe',
    }),
  );
  assert.equal((await client.listTools()).tools.length, 40);
  const response = await client.callTool({ name: 'project_list', arguments: {} });
  assert.equal(response.isError, undefined);
  assert.deepEqual(JSON.parse(response.content[0].text), []);
  const result = {
    passed: true,
    version: '0.2.0',
    setupVersion: 2,
    tools: 40,
    checks: [
      'Exact tarball installed from independent offline npm cache',
      'Version and setup schema include model profile support',
      'Copied runtime works after npm cache deletion without node_modules',
      'Supervisor health and dashboard respond',
      'Bundled STDIO MCP lists 40 tools and reads durable state',
    ],
    runtime,
  };
  writeFileSync(resolve(root, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  await client.close();
  if (runtime) await run(resolve(runtime, 'dist/cli.js'), ['stop', '--home', home]);
}
