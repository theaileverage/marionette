import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { prepareGuardLaunch } from '../src/harness-guard.js';
import { terminalLeadArgs } from '../src/lead-terminal.js';
import { terminalPath } from '../src/terminal-path.js';
import { validateTerminalArguments } from '../src/terminal-arguments.js';

test('guard launch stays short with long quoted paths and preserves the exact MCP argv and environment', () => {
  const root = mkdtempSync('/tmp/marionette-launch-test-');
  const directory = join(root, "user's directory " + 'long'.repeat(40), 'guards/worker-attempt');
  mkdirSync(directory, { recursive: true });
  let alias = '';
  try {
    const entry = join(root, 'echo.mjs');
    writeFileSync(
      entry,
      'console.log(JSON.stringify({args:process.argv.slice(2),token:process.env.MARIONETTE_WORKER_TOKEN}))',
    );
    const payload = [
      'spaces here',
      "quote's",
      '$(do-not-execute)',
      '`do-not-execute`',
      '\nnewline',
    ];
    const input = {
      kind: 'codex' as const,
      directory,
      executable: process.execPath,
      cliPath: '/runtime/cli.js',
      policy: {
        version: 1 as const,
        root,
        role: 'inspect' as const,
        instructions: 'Restore role',
        mcpName: 'marionette_worker',
        ownership: [],
      },
      server: { command: process.execPath, args: [entry, ...payload] },
    };
    const args = prepareGuardLaunch(input);
    alias = terminalPath(directory);
    assert.deepEqual(prepareGuardLaunch(input), args);
    assert.doesNotThrow(() =>
      validateTerminalArguments('codex', terminalLeadArgs('codex', args, '', true)),
    );
    const config: any = Bun.TOML.parse(args.filter((arg) => arg.includes('=')).join('\n'));
    assert.match(config.hooks.SessionStart[0].matcher, /compact/);
    assert.ok(config.hooks.PreToolUse[0].hooks[0].command.includes(alias));
    const server = config.mcp_servers.marionette_worker;
    assert.equal(server.required, true);
    assert.ok(server.env_vars.includes('MARIONETTE_WORKER_TOKEN'));
    const child = Bun.spawnSync([server.command, ...server.args], {
      env: { ...process.env, MARIONETTE_WORKER_TOKEN: 'fixture-only' },
    });
    assert.equal(child.exitCode, 0, child.stderr.toString());
    assert.deepEqual(JSON.parse(child.stdout.toString()), { args: payload, token: 'fixture-only' });
    assert.equal(statSync(join(directory, 'm')).mode & 0o777, 0o700);
    assert.match(readFileSync(join(directory, 'h'), 'utf8'), /guard-hook/);
    rmSync(dirname(alias), { recursive: true });
    const recovered = terminalPath(directory);
    assert.notEqual(recovered, alias);
    alias = recovered;
    assert.equal(terminalPath(directory), recovered);
  } finally {
    if (alias) rmSync(dirname(alias), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
