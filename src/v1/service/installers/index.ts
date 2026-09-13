import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

export interface ServiceDefinitionInput {
  projectId: string;
  hostId: string;
  executable: string;
  arguments: readonly string[];
  workingDirectory: string;
  stateDirectory: string;
  homeDirectory: string;
  platform: 'darwin' | 'linux';
  uid: number;
}
export interface ServiceDefinition {
  platform: 'darwin' | 'linux';
  label: string;
  path: string;
  content: string;
  uid: number;
}
function xml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
function unit(value: string, expandEnvironment = true) {
  return (
    '"' +
    value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/%/g, '%%')
      .replace(/\$/g, () => (expandEnvironment ? '$$' : '$')) +
    '"'
  );
}
export function serviceDefinition(input: ServiceDefinitionInput): ServiceDefinition {
  for (const value of [
    input.executable,
    input.workingDirectory,
    input.stateDirectory,
    input.homeDirectory,
    ...input.arguments,
  ])
    // eslint-disable-next-line no-control-regex -- Native definitions must reject embedded directives.
    if (/[\x00-\x1f\x7f]/.test(value))
      throw new Error('service definition does not permit control characters');
  for (const path of [
    input.executable,
    input.workingDirectory,
    input.stateDirectory,
    input.homeDirectory,
  ])
    if (!isAbsolute(path)) throw new Error('service paths must be absolute');
  if (!Number.isInteger(input.uid) || input.uid < 0) throw new Error('invalid service uid');
  const label =
    'com.marionette.project.' +
    createHash('sha256')
      .update(input.projectId + '\0' + input.hostId)
      .digest('hex')
      .slice(0, 24);
  if (input.platform === 'darwin')
    return {
      platform: input.platform,
      label,
      uid: input.uid,
      path: join(input.homeDirectory, 'Library/LaunchAgents', label + '.plist'),
      content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${[input.executable, ...input.arguments].map((value) => '<string>' + xml(value) + '</string>').join('')}</array><key>WorkingDirectory</key><string>${xml(input.workingDirectory)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer><key>StandardOutPath</key><string>${xml(join(input.stateDirectory, 'service.log'))}</string><key>StandardErrorPath</key><string>${xml(join(input.stateDirectory, 'service.log'))}</string></dict></plist>\n`,
    };
  return {
    platform: input.platform,
    label,
    uid: input.uid,
    path: join(input.homeDirectory, '.config/systemd/user', label + '.service'),
    content: `[Unit]\nDescription=Marionette project service\n[Service]\nType=simple\nExecStart=${[input.executable, ...input.arguments].map((value) => unit(value)).join(' ')}\nWorkingDirectory=${unit(input.workingDirectory, false)}\nRestart=always\nRestartSec=5\nUMask=0077\n[Install]\nWantedBy=default.target\n`,
  };
}
export interface ServiceCommandPort {
  run(command: string, args: readonly string[]): Promise<string>;
}
export const localServiceCommands: ServiceCommandPort = {
  run(command, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        output += String(chunk);
      });
      child.once('error', reject);
      child.once('close', (code) =>
        code === 0 ? resolve(output) : reject(new Error(`${command} exited ${code}: ${output}`)),
      );
    });
  },
};
/** Installation only writes a definition; no implicit service start or database migration. */
export function installService(definition: ServiceDefinition) {
  if (existsSync(definition.path) && readFileSync(definition.path, 'utf8') !== definition.content)
    throw new Error(
      'existing service definition differs; preserve and explicitly remove it before replacement',
    );
  mkdirSync(dirname(definition.path), { recursive: true, mode: 0o700 });
  writeFileSync(definition.path, definition.content, { mode: 0o600 });
  return definition.path;
}
export async function startService(
  d: ServiceDefinition,
  port: ServiceCommandPort = localServiceCommands,
) {
  if (d.platform === 'darwin') return port.run('launchctl', ['bootstrap', `gui/${d.uid}`, d.path]);
  await port.run('systemctl', ['--user', 'daemon-reload']);
  return port.run('systemctl', ['--user', 'enable', '--now', d.label + '.service']);
}
export function stopService(d: ServiceDefinition, port: ServiceCommandPort = localServiceCommands) {
  return d.platform === 'darwin'
    ? port.run('launchctl', ['bootout', `gui/${d.uid}/${d.label}`])
    : port.run('systemctl', ['--user', 'disable', '--now', d.label + '.service']);
}
export function serviceStatus(
  d: ServiceDefinition,
  port: ServiceCommandPort = localServiceCommands,
) {
  return d.platform === 'darwin'
    ? port.run('launchctl', ['print', `gui/${d.uid}/${d.label}`])
    : port.run('systemctl', ['--user', 'status', d.label + '.service']);
}
export async function uninstallService(
  d: ServiceDefinition,
  port: ServiceCommandPort = localServiceCommands,
) {
  if (existsSync(d.path) && readFileSync(d.path, 'utf8') !== d.content)
    throw new Error('service definition differs; refusing to remove it');
  await stopService(d, port);
  if (existsSync(d.path)) unlinkSync(d.path);
  if (d.platform === 'linux') await port.run('systemctl', ['--user', 'daemon-reload']);
}
