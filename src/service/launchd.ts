/**
 * Runs the service under launchd on macOS, as a user agent that starts at login
 * and restarts if it stops. Linux (systemd) arrives with the always-on milestone (10).
 */
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { runCommand } from '../util/process.js';

export const LABEL = 'dev.wheems.service';

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

/**
 * The launchd job. ProcessType is Interactive because launchd otherwise throttles an agent's CPU
 * and disk, which made the service take ten seconds to start rather than one.
 */
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
    <key>WHEEMS_HOME</key>
    <string>${xml(spec.home)}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${xml(spec.home)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
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
  // Replace a running copy, if there is one, and undo a stop: launchd won't load a disabled job.
  await runCommand('launchctl', ['bootout', `${domain()}/${LABEL}`]);
  await runCommand('launchctl', ['enable', `${domain()}/${LABEL}`]);
  const result = await runCommand('launchctl', ['bootstrap', domain(), plistPath()]);
  if (result.code !== 0) throw new Error(`launchctl bootstrap failed: ${result.stderr.trim()}`);
}

export async function uninstallService(): Promise<void> {
  ensureMac();
  await bootout();
  await runCommand('launchctl', ['enable', `${domain()}/${LABEL}`]);
  await rm(plistPath(), { force: true });
}

/** Unloads the service. Unloading one that isn't loaded is fine; failing to unload isn't. */
async function bootout(): Promise<void> {
  const result = await runCommand('launchctl', ['bootout', `${domain()}/${LABEL}`]);
  if (result.code === 0) return;
  // It failed: fine only if launchd says plainly that it has no such job.
  const print = await runCommand('launchctl', ['print', `${domain()}/${LABEL}`]);
  if (jobAbsent(print)) return;
  throw new Error(
    print.code === 0
      ? `launchctl bootout failed, so the service is still running: ${result.stderr.trim()}`
      : `launchctl bootout failed, and launchd didn't say whether the service stopped: ${result.stderr.trim()}. Check with: wheems status`,
  );
}

/** Whether `launchctl print` said the job doesn't exist (exit 113, "Could not find service"). */
export function jobAbsent(print: { code: number | null; stdout: string; stderr: string }): boolean {
  return print.code === 113 || /Could not find service/.test(`${print.stdout}${print.stderr}`);
}

/**
 * Stops the service and keeps it stopped, even across logins, until it is installed again
 * (`wheems start`). The plist stays, so nothing about how it runs is forgotten.
 */
export async function stopService(): Promise<void> {
  ensureMac();
  // Disabled first, so a stop that fails halfway can't leave it to come back at login unnoticed.
  const disabled = await runCommand('launchctl', ['disable', `${domain()}/${LABEL}`]);
  if (disabled.code !== 0) {
    throw new Error(
      `launchctl disable failed, so the service would start again at login: ${disabled.stderr.trim()}`,
    );
  }
  await bootout();
}

/** The install folder the service was installed for, from its plist; null when there's none. */
export async function installedHome(): Promise<string | null> {
  const text = await readFile(plistPath(), 'utf8').catch(() => null);
  return text === null ? null : homeInPlist(text);
}

/** The `--home` argument in a plist made by renderPlist. */
export function homeInPlist(plist: string): string | null {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1];
  if (array === undefined) return null;
  const args = [...array.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unxml(m[1] ?? ''));
  const at = args.indexOf('--home');
  return at === -1 ? null : (args[at + 1] ?? null);
}

function unxml(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&');
}

/** Whether launchd has the service's plist, running or stopped. */
export async function serviceInstalled(): Promise<boolean> {
  return access(plistPath()).then(
    () => true,
    () => false,
  );
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
      'The service runs under launchd on macOS for now; systemd on Linux comes with the always-on milestone (10).',
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
