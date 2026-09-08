#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex test');
  process.exit(0);
}
const path = resolve(process.env.CODEX_HOME, 'config.toml');
mkdirSync(process.env.CODEX_HOME, { recursive: true });
const settings = existsSync(path) ? Bun.TOML.parse(readFileSync(path, 'utf8')) : {};
settings.mcp_servers ??= {};
if (args[1] === 'add') {
  const divider = args.indexOf('--'),
    name = args[divider - 1];
  settings.mcp_servers[name] = { command: args[divider + 1], args: args.slice(divider + 2) };
} else if (args[1] === 'remove') delete settings.mcp_servers[args[2]];
else throw new Error('Unsupported test MCP command');
let text = '# MCP fixture\nmodel = "preserved"\n';
for (const [name, server] of Object.entries(settings.mcp_servers))
  text += `\n[mcp_servers.${JSON.stringify(name)}]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\n`;
writeFileSync(path, text);
