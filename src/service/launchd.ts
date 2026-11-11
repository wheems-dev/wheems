/**
 * Runs the service under launchd on macOS, as a user agent that starts at login
 * and restarts if it stops. Linux (systemd) arrives with milestone 9.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { runCommand } from '../util/process.js';

export const LABEL = 'dev.opinr.service';

export interface ServiceSpec {
  node: string;
  cli: string;
  home: string;
  logFile: string;
}

export function plistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

/** The PATH the service runs with: this Node.js first, then where hc and claude usually live. */
export function servicePath(node: string): string {
  return [
    dirname(node),
    join(homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].join(':');
}

export function renderPlist(spec: ServiceSpec): string {
  const args = [spec.node, spec.cli, 'service', 'run', '--home', spec.home];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(servicePath(spec.node))}</string>
    <key>OPINR_HOME</key>
    <string>${xml(spec.home)}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${xml(spec.home)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${xml(spec.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(spec.logFile)}</string>
</dict>
</plist>
`;
}

function domain(): string {
  return `gui/${String(userInfo().uid)}`;
}

export async function installService(spec: ServiceSpec): Promise<void> {
  ensureMac();
  await mkdir(dirname(plistPath()), { recursive: true });
  await mkdir(dirname(spec.logFile), { recursive: true });
  await writeFile(plistPath(), renderPlist(spec));
  // Replace a running copy, if there is one.
  await runCommand('launchctl', ['bootout', `${domain()}/${LABEL}`]);
  const result = await runCommand('launchctl', ['bootstrap', domain(), plistPath()]);
  if (result.code !== 0) throw new Error(`launchctl bootstrap failed: ${result.stderr.trim()}`);
}

export async function uninstallService(): Promise<void> {
  ensureMac();
  await runCommand('launchctl', ['bootout', `${domain()}/${LABEL}`]);
  await rm(plistPath(), { force: true });
}

export async function restartService(): Promise<void> {
  ensureMac();
  const result = await runCommand('launchctl', ['kickstart', '-k', `${domain()}/${LABEL}`]);
  if (result.code !== 0) throw new Error(`launchctl kickstart failed: ${result.stderr.trim()}`);
}

export interface LaunchdStatus {
  loaded: boolean;
  running: boolean;
  pid: number | null;
  lastExit: string | null;
}

export async function serviceStatus(): Promise<LaunchdStatus> {
  if (process.platform !== 'darwin')
    return { loaded: false, running: false, pid: null, lastExit: null };
  const result = await runCommand('launchctl', ['print', `${domain()}/${LABEL}`]);
  if (result.code !== 0) return { loaded: false, running: false, pid: null, lastExit: null };
  return parseLaunchctlPrint(result.stdout);
}

export function parseLaunchctlPrint(text: string): LaunchdStatus {
  const state = /^\s*state = (.+)$/m.exec(text)?.[1]?.trim();
  const pid = /^\s*pid = (\d+)$/m.exec(text)?.[1];
  const lastExit = /^\s*last exit code = (.+)$/m.exec(text)?.[1]?.trim() ?? null;
  return { loaded: true, running: state === 'running', pid: pid ? Number(pid) : null, lastExit };
}

function ensureMac(): void {
  if (process.platform !== 'darwin') {
    throw new Error(
      'The service runs under launchd on macOS for now; systemd on Linux comes in milestone 9.',
    );
  }
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
