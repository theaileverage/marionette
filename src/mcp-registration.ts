import { Effect, Schema } from 'effect';
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { sync } from './effect-runtime.js';
import { inside } from './files.js';
import { execEffect } from './process.js';
import { privateJson } from './private-json.js';
import { AppError, type LeadAgent, type Kind } from './types.js';
import { trustSettingsPath } from './workspace-trust.js';
const quote = (s: string) =>
  /^[a-zA-Z0-9_@%+=:,./-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'";
const object = Schema.Record(Schema.String, Schema.MutableJson);
const serverSchema = Schema.Struct({
  command: Schema.String,
  args: Schema.mutable(Schema.Array(Schema.String)),
});
export type McpServer = Schema.Schema.Type<typeof serverSchema>;
export const clientReceiptSchema = Schema.Struct({
  name: Schema.String,
  runtime: Schema.String,
  server: Schema.optional(serverSchema),
  projectId: Schema.optional(Schema.String),
});
export function mcpServerName(project: string, lead: string) {
  const slug = (value: string, fallback: string, length: number) =>
    value
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, length)
      .replace(/-+$/g, '') || fallback;
  return `mnett-${slug(project, 'project', 28)}-${slug(lead, 'lead', 20)}`;
}
export function mcpAddArgs(binary: string, name: string, server: McpServer) {
  const prefix =
    binary === 'codex'
      ? ['mcp', 'add', name, '--']
      : binary === 'claude'
        ? ['mcp', 'add', '--scope', 'user', '--transport', 'stdio', name, '--']
        : ['mcp', 'add', '--type', 'stdio', name, '--'];
  return [...prefix, server.command, ...server.args];
}
export function mcpRemoveArgs(binary: string, name: string) {
  return binary === 'claude' ? ['mcp', 'remove', '--scope', 'user', name] : ['mcp', 'remove', name];
}
export function mcpCommand(agent: LeadAgent, name: string, runtime: string, home: string) {
  const binary = agent === 'codex-desktop' ? 'codex' : agent;
  const server = {
    command: process.execPath,
    args: [resolve(runtime, 'dist/mcp.js'), '--home', home],
  };
  const args = mcpAddArgs(binary, name, server);
  return { binary, name, args, server, shell: [binary, ...args].map(quote).join(' ') };
}
function mcpEntries(binary: Kind): Schema.Schema.Type<typeof object> {
  const path = trustSettingsPath(binary);
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8');
  const settings = Schema.decodeUnknownSync(object)(
    binary === 'codex' ? Bun.TOML.parse(text) : JSON.parse(text),
  );
  return Schema.decodeUnknownSync(object)(
    settings[binary === 'codex' ? 'mcp_servers' : 'mcpServers'] ?? {},
  );
}
export function readMcpRegistration(binary: Kind, name: string) {
  const entries = mcpEntries(binary);
  if (entries[name] === undefined) return undefined;
  const raw = Schema.decodeUnknownSync(object)(entries[name]);
  return { server: Schema.decodeUnknownSync(serverSchema)(raw), raw };
}
export function sameMcpServer(left: McpServer, right: McpServer) {
  return left.command === right.command && JSON.stringify(left.args) === JSON.stringify(right.args);
}
export function listClientReceipts(home: string, binary: Kind) {
  const dir = resolve(home, 'clients');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(
      (name) =>
        name === binary + '.json' || (name.startsWith(binary + '--') && name.endsWith('.json')),
    )
    .map((name) => {
      const path = resolve(dir, name);
      const receipt = Schema.decodeUnknownSync(clientReceiptSchema)(
        JSON.parse(readFileSync(path, 'utf8')),
      );
      if (name !== binary + '.json' && name !== `${binary}--${receipt.name}.json`)
        throw new Error(`MCP receipt name mismatch: ${path}`);
      return { path, receipt };
    });
}
export function readClientReceipt(home: string, binary: Kind, name?: string) {
  return listClientReceipts(home, binary).find((item) =>
    name ? item.receipt.name === name : item.path === resolve(home, 'clients', binary + '.json'),
  )?.receipt;
}
export function projectMcpName(
  agent: LeadAgent,
  home: string,
  projectId: string,
  projectName: string,
  leadName: string,
  runtime: string,
) {
  const binary = agent === 'codex-desktop' ? 'codex' : agent;
  const base = mcpServerName(projectName, leadName),
    entries = mcpEntries(binary),
    receipts = listClientReceipts(home, binary);
  const current = receipts.find(
    ({ receipt }) =>
      receipt.projectId === projectId &&
      (receipt.name === base || new RegExp('^' + base + '-[0-9]+$').test(receipt.name)),
  );
  if (current) return current.receipt.name;
  for (let number = 1; number <= 100; number++) {
    const name = number === 1 ? base : `${base}-${number}`;
    if (receipts.some(({ receipt }) => receipt.name === name && receipt.projectId !== projectId))
      continue;
    if (entries[name] === undefined) return name;
    const found = Schema.decodeUnknownOption(serverSchema)(entries[name]);
    if (
      found._tag === 'Some' &&
      sameMcpServer(found.value, mcpCommand(agent, name, runtime, home).server)
    )
      return name;
  }
  throw new Error(
    `No available MCP name for ${projectName} and ${leadName}. Rename the project or lead and retry.`,
  );
}
function mcpScriptArgs(server: McpServer) {
  // Setup through 0.2.2 launched Node with this exact flag before the script.
  // Do not normalize other flags: they may change which program Node executes.
  return basename(server.command) === 'node' && server.args[0] === '--no-warnings'
    ? server.args.slice(1)
    : server.args;
}
export function ownsMcpServer(home: string, binary: Kind, name: string, server: McpServer) {
  const receipt = readClientReceipt(home, binary, name);
  if (!receipt || receipt.name !== name) return false;
  if (receipt.server) return sameMcpServer(receipt.server, server);
  // Legacy receipts recorded the runtime only. Require exact argument identity, never substring matches.
  let runtime = receipt.runtime;
  const scriptArgs = mcpScriptArgs(server);
  // 0.3.0 derived the receipt from the --home argument, producing ".".
  // Recover only an exact MCP entry point in this instance's completed runtime store.
  if (runtime === '.' && scriptArgs[0]) {
    const candidate = dirname(dirname(scriptArgs[0]));
    if (inside(resolve(home, 'runtimes'), candidate) && existsSync(resolve(candidate, '.complete')))
      runtime = candidate;
  }
  return (
    JSON.stringify(scriptArgs) === JSON.stringify([resolve(runtime, 'dist/mcp.js'), '--home', home])
  );
}
/** Read-only preflight; shared-instance upgrades run this before stopping the supervisor. */
export function inspectMcpInstall(
  command: ReturnType<typeof mcpCommand>,
  name: string,
  home: string,
) {
  const found = readMcpRegistration(command.binary, name);
  if (found && !sameMcpServer(found.server, command.server)) {
    if (!ownsMcpServer(home, command.binary, name, found.server))
      throw new AppError({
        code: 'mcp_conflict',
        message: `MCP server ${name} has another configuration. Use setup --mcp print to review it.`,
        status: 409,
      });
    const custom = Object.keys(found.raw).filter(
      (key) => !['type', 'command', 'args'].includes(key),
    );
    if (custom.length)
      throw new AppError({
        code: 'mcp_customized',
        message: `${command.binary} MCP server ${name} has custom settings (${custom.join(', ')}). Update its runtime path manually to preserve those settings.`,
        status: 409,
      });
  }
  return found;
}
export const installMcpEffect = Effect.fn('MCP.install')(function* (
  command: ReturnType<typeof mcpCommand>,
  name: string,
  home: string,
  projectId?: string,
) {
  const found = yield* sync('MCP.inspect', () => inspectMcpInstall(command, name, home));
  const unchanged = found && sameMcpServer(found.server, command.server);
  if (found && !unchanged) {
    yield* execEffect(command.binary, mcpRemoveArgs(command.binary, name), { timeout: 15000 });
  }
  if (!unchanged) {
    yield* Effect.gen(function* () {
      yield* execEffect(command.binary, command.args, { timeout: 30000 });
      const actual = yield* sync('MCP.verify', () => readMcpRegistration(command.binary, name));
      if (!actual || !sameMcpServer(actual.server, command.server))
        return yield* new AppError({
          code: 'mcp_verification',
          message: `${command.binary} did not save the expected Marionette MCP registration.`,
          status: 409,
        });
    }).pipe(
      Effect.tapError(() =>
        Effect.gen(function* () {
          const actual = yield* sync('MCP.inspectFailedInstall', () =>
            readMcpRegistration(command.binary, name),
          );
          if (actual && !sameMcpServer(actual.server, command.server)) return;
          if (actual)
            yield* execEffect(command.binary, mcpRemoveArgs(command.binary, name), {
              timeout: 15000,
            });
          if (found)
            yield* execEffect(command.binary, mcpAddArgs(command.binary, name, found.server), {
              timeout: 30000,
            });
        }),
      ),
    );
  }
  yield* sync('MCP.receipt', () => {
    const previous = listClientReceipts(home, command.binary).find(
      (item) => item.receipt.name === name,
    );
    if (projectId && !/^[a-zA-Z0-9_-]+$/.test(name))
      throw new Error('Invalid MCP registration name');
    const path =
      previous?.path ??
      resolve(
        home,
        'clients',
        projectId ? `${command.binary}--${name}.json` : command.binary + '.json',
      );
    privateJson(path, {
      name,
      runtime: dirname(dirname(mcpScriptArgs(command.server)[0])),
      server: command.server,
      projectId: projectId ?? previous?.receipt.projectId,
    });
  });
  return unchanged ? 'already-configured' : 'installed';
});
export const removeMcpEffect = Effect.fn('MCP.remove')(function* (
  home: string,
  binary: Kind,
  name: string,
) {
  const found = yield* sync('MCP.inspect', () => readMcpRegistration(binary, name));
  if (found) {
    if (!ownsMcpServer(home, binary, name, found.server))
      return yield* new AppError({
        code: 'mcp_conflict',
        message: `Refusing to remove changed ${binary} MCP registration ${name}. Restore or remove it manually.`,
        status: 409,
      });
    yield* execEffect(binary, mcpRemoveArgs(binary, name), { timeout: 15000 });
    if (yield* sync('MCP.verifyRemoval', () => readMcpRegistration(binary, name)))
      return yield* new AppError({
        code: 'mcp_remove_failed',
        message: `${binary} did not remove ${name}.`,
        status: 409,
      });
  }
  yield* sync('MCP.removeReceipt', () => {
    for (const item of listClientReceipts(home, binary))
      if (item.receipt.name === name) unlinkSync(item.path);
  });
  return { binary, name, removed: !!found };
});

/** Add the readable name first; retain old ownership receipts until each old entry is removed. */
export const installProjectMcpEffect = Effect.fn('MCP.installProject')(function* (
  command: ReturnType<typeof mcpCommand>,
  home: string,
  projectId: string,
  retireShared: boolean,
) {
  const obsolete = yield* sync('MCP.renamePreflight', () =>
    listClientReceipts(home, command.binary).filter(
      ({ receipt }) =>
        receipt.name !== command.name &&
        (receipt.projectId === projectId || (retireShared && !receipt.projectId)),
    ),
  );
  for (const { receipt } of obsolete)
    yield* sync('MCP.renameOwnership', () => {
      const found = readMcpRegistration(command.binary, receipt.name);
      if (!found) return;
      if (!ownsMcpServer(home, command.binary, receipt.name, found.server))
        throw new AppError({
          code: 'mcp_conflict',
          message: `MCP server ${receipt.name} changed outside Marionette. Preserve it and resolve the conflict before renaming.`,
          status: 409,
        });
      if (Object.keys(found.raw).some((key) => !['type', 'command', 'args'].includes(key)))
        throw new AppError({
          code: 'mcp_customized',
          message: `MCP server ${receipt.name} has custom settings. Preserve those settings before renaming it.`,
          status: 409,
        });
    });
  const status = yield* installMcpEffect(command, command.name, home, projectId);
  for (const { receipt } of obsolete) yield* removeMcpEffect(home, command.binary, receipt.name);
  return status;
});
