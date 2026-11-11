import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { access, readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { LoadedInstall } from '../config/load.js';
import { paths } from '../home.js';
import { readSecrets } from '../secrets.js';
import { request } from '../service/control.js';
import { serviceStatus } from '../service/launchd.js';
import { crossCheck } from '../config/check.js';
import { loadInstall, type Problem } from '../config/load.js';
import type { HealthCheck } from '../contracts/driver.js';
import type { DriverRegistry } from '../contracts/registry.js';
import type { RuntimeDriver } from '../contracts/runtime.js';
import { HERDR_MINIMUM_VERSION } from '../drivers/runtime/herdr/herdr-runtime.js';
import { compareVersions, isAtLeast } from '../util/version.js';
export { defaultHome } from '../home.js';

export const NODE_MINIMUM_VERSION = '22.12.0';

export interface DoctorOptions {
  /** The install folder. */
  home: string;
  registry: DriverRegistry;
  /** Skip starting a test session in the runtime. */
  quick?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Overrides for tests. */
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  /** Whether Claude Code trusts a folder: true, false, or null when it can't tell. */
  claudeTrust?: (dir: string) => Promise<boolean | null>;
  /** Whether the service is installed and answering. */
  service?: (home: string) => Promise<{ installed: boolean; answering: boolean }>;
}

export interface DoctorSection {
  title: string;
  checks: HealthCheck[];
}

export interface DoctorReport {
  ok: boolean;
  sections: DoctorSection[];
}

/** Runs every health check: the system, the runtime, and the install's config. */
export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const sections: DoctorSection[] = [];
  sections.push({ title: 'System', checks: systemChecks(options) });

  const installFile = join(options.home, 'install.yaml');
  const hasInstall = await exists(installFile);
  const install = hasInstall ? await loadInstall(options.home) : null;

  const herdr = install?.config?.herdr;
  const runtime = options.registry.create('runtime', 'herdr', {
    ...(herdr?.binary !== undefined && { binary: herdr.binary }),
    ...(herdr?.version !== undefined && { minimumVersion: herdr.version }),
  });
  const runtimeChecks = await runtime.check();
  if (!options.quick && !runtimeChecks.some((c) => c.status === 'fail')) {
    runtimeChecks.push(await roundTrip(runtime));
  }
  if (herdr?.version !== undefined && compareVersions(herdr.version, HERDR_MINIMUM_VERSION) < 0) {
    runtimeChecks.push({
      name: 'pinned version',
      status: 'warn',
      message: `install.yaml pins Herdr core ${herdr.version}, below Opinr's minimum ${HERDR_MINIMUM_VERSION}, so ${HERDR_MINIMUM_VERSION} applies`,
      hint: `Set herdr.version to ${HERDR_MINIMUM_VERSION} or later.`,
    });
  }
  sections.push({ title: 'Herdr core', checks: runtimeChecks });

  const configChecks: HealthCheck[] = [];
  if (!install) {
    configChecks.push({
      name: 'install',
      status: 'skip',
      message: `No install at ${options.home} yet`,
      hint: 'opinr setup creates one. Set OPINR_HOME or --home to check another folder.',
    });
  } else {
    const problems = [
      ...install.problems,
      ...crossCheck(install, { engines: options.registry.names('engine') }),
    ];
    const errors = problems.filter((p) => p.level === 'error');
    configChecks.push({
      name: 'install',
      status: errors.length > 0 ? 'fail' : 'pass',
      message:
        errors.length > 0
          ? `${errors.length} ${errors.length === 1 ? 'problem' : 'problems'} in ${options.home}`
          : `${options.home}: ${install.workspaces.length} ${install.workspaces.length === 1 ? 'workspace' : 'workspaces'}`,
    });
    for (const problem of problems) configChecks.push(problemCheck(problem));
  }
  sections.push({ title: 'Config', checks: configChecks });

  if (install?.config) {
    sections.push({ title: 'Agents', checks: await agentChecks(install, options) });
    sections.push({ title: 'Channels', checks: await channelChecks(install, options) });
    sections.push({ title: 'Service', checks: [await serviceCheck(options)] });
  }

  const ok = sections.every((s) => s.checks.every((c) => c.status !== 'fail'));
  return { ok, sections };
}

async function agentChecks(install: LoadedInstall, options: DoctorOptions): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = [];
  const engines = new Set(
    install.workspaces.flatMap((w) => w.agents.map((a) => a.definition.engine)),
  );
  for (const name of [...engines].sort()) {
    if (!options.registry.has('engine', name)) continue; // Config already warns about these.
    checks.push(...(await options.registry.create('engine', name).check()));
  }
  const trust = options.claudeTrust ?? claudeTrusts;
  for (const workspace of install.workspaces) {
    const chief = workspace.agents.find(
      (a) => a.definition.name === workspace.config?.chief_of_staff,
    );
    if (chief?.definition.engine !== 'claude-code') continue;
    const trusted = await trust(workspace.dir);
    if (trusted === true) {
      checks.push({
        name: `${workspace.id} folder`,
        status: 'pass',
        message: 'Claude Code trusts the workspace folder',
      });
    } else if (trusted === false) {
      checks.push({
        name: `${workspace.id} folder`,
        status: 'warn',
        message:
          "Claude Code hasn't been told to trust the workspace folder, so its first session will wait for that answer at the Mac",
        hint: `cd ${workspace.dir} && claude, choose "Yes, I trust this folder", then /exit.`,
      });
    }
  }
  if (checks.length === 0)
    checks.push({ name: 'engines', status: 'skip', message: 'No agents yet' });
  return checks;
}

async function channelChecks(
  install: LoadedInstall,
  options: DoctorOptions,
): Promise<HealthCheck[]> {
  const config = install.config;
  if (!config) return [];
  const used = new Set<string>();
  for (const workspace of install.workspaces) {
    const chat = workspace.config?.channels.chat;
    if (chat) used.add(chat.connection);
  }
  if (used.size === 0)
    return [{ name: 'chat', status: 'skip', message: 'No workspace has a chat channel yet' }];
  const secrets = await readSecrets(paths(options.home, options.env).secrets);
  const checks: HealthCheck[] = [];
  for (const connection of [...used].sort()) {
    const settings = config.connections[connection];
    if (!settings) continue; // Config already reports it.
    if (!options.registry.has('channel', settings.driver)) {
      checks.push({
        name: connection,
        status: 'warn',
        message: `No channel driver "${settings.driver}" yet`,
      });
      continue;
    }
    if (settings.allowed_users.length === 0) {
      checks.push({
        name: `${connection} allowed users`,
        status: 'warn',
        message: 'Nobody is allowed to talk to agents yet, so every message is ignored',
        hint: 'Run opinr setup, or add Slack member ids to allowed_users in install.yaml.',
      });
    }
    const secret = secrets[settings.secret ?? connection];
    if (secret === undefined) {
      checks.push({
        name: connection,
        status: 'fail',
        message: 'Not connected yet: no credentials saved for it',
        hint: 'Run opinr setup to connect it.',
      });
      continue;
    }
    try {
      const driver = options.registry.create('channel', settings.driver, { ...secret });
      checks.push(
        ...(await driver.check()).map((c) => ({ ...c, name: `${connection}: ${c.name}` })),
      );
    } catch (error) {
      checks.push({
        name: connection,
        status: 'fail',
        message: error instanceof Error ? error.message : String(error),
        hint: 'Run opinr setup to connect it.',
      });
    }
  }
  return checks;
}

async function serviceCheck(options: DoctorOptions): Promise<HealthCheck> {
  const probe = options.service ?? probeService;
  const { installed, answering } = await probe(options.home);
  if (answering) return { name: 'service', status: 'pass', message: 'Running and answering' };
  return {
    name: 'service',
    status: 'warn',
    message: installed ? 'Installed, but not answering' : 'Not running, so nothing answers in chat',
    hint: installed ? 'See opinr service logs.' : 'Run opinr service install.',
  };
}

async function probeService(home: string): Promise<{ installed: boolean; answering: boolean }> {
  const status = await serviceStatus();
  const answering = await request(paths(home).socket, { op: 'ping' }, 2000).then(
    (answer) => answer.ok,
    () => false,
  );
  return { installed: status.loaded, answering };
}

/** Reads, never writes, Claude Code's record of trusted folders. */
async function claudeTrusts(dir: string): Promise<boolean | null> {
  let projects: Record<string, { hasTrustDialogAccepted?: boolean }>;
  try {
    const config = JSON.parse(await readFile(join(homedir(), '.claude.json'), 'utf8')) as {
      projects?: Record<string, { hasTrustDialogAccepted?: boolean }>;
    };
    projects = config.projects ?? {};
  } catch {
    return null;
  }
  const real = await realpath(dir).catch(() => dir);
  return trustedIn(projects, real) || trustedIn(projects, dir);
}

/**
 * Whether Claude Code trusts a folder: it records trust for the folder it was asked about,
 * or for the git repository around it, and either covers everything inside.
 */
export function trustedIn(
  projects: Record<string, { hasTrustDialogAccepted?: boolean }>,
  dir: string,
): boolean {
  for (let folder = dir; ; folder = dirname(folder)) {
    if (projects[folder]?.hasTrustDialogAccepted === true) return true;
    if (dirname(folder) === folder) return false;
  }
}

function systemChecks(options: DoctorOptions): HealthCheck[] {
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const platform = options.platform ?? process.platform;
  const checks: HealthCheck[] = [];
  checks.push(
    isAtLeast(nodeVersion, NODE_MINIMUM_VERSION)
      ? {
          name: 'Node.js',
          status: 'pass',
          message: `${nodeVersion} meets the minimum ${NODE_MINIMUM_VERSION}`,
        }
      : {
          name: 'Node.js',
          status: 'fail',
          message: `${nodeVersion} is older than the minimum ${NODE_MINIMUM_VERSION}`,
          hint: 'Install Node.js 22 or later.',
        },
  );
  checks.push(
    platform === 'darwin' || platform === 'linux'
      ? { name: 'platform', status: 'pass', message: platform === 'darwin' ? 'macOS' : 'Linux' }
      : {
          name: 'platform',
          status: 'warn',
          message: `${platform} is not supported yet; Opinr runs on macOS and Linux`,
        },
  );
  return checks;
}

/** Starts a tiny session, sends it a line, waits, reads it back and removes it. */
async function roundTrip(runtime: RuntimeDriver): Promise<HealthCheck> {
  const name = `opinr-doctor-${randomBytes(3).toString('hex')}`;
  let id: string | undefined;
  try {
    const session = await runtime.start({
      name,
      command: ['sh', '-c', 'read line; echo "opinr-doctor:$line"'],
      cwd: homedir(),
      labels: { opinr: 'doctor' },
    });
    id = session.id;
    await runtime.send(id, 'ping');
    const waited = await runtime.wait(id, { timeoutSeconds: 15 });
    const read = await runtime.read(id);
    if (!waited.ended || waited.exitCode !== 0 || !read.text.includes('opinr-doctor:ping')) {
      return {
        name: 'round trip',
        status: 'fail',
        message: `A test session did not answer as expected (wait: ${waited.reason}, exit: ${String(waited.exitCode)})`,
      };
    }
    return {
      name: 'round trip',
      status: 'pass',
      message: 'Started, sent to, waited on and read a test session',
    };
  } catch (error) {
    return {
      name: 'round trip',
      status: 'fail',
      message: `A test session failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (id !== undefined) {
      try {
        const session = await runtime.get(id);
        if (session?.state === 'live') await runtime.stop(id);
        if (session) await runtime.remove(id);
      } catch {
        // Leave it; hc ls --label opinr=doctor shows any left behind.
      }
    }
  }
}

function problemCheck(problem: Problem): HealthCheck {
  const where = problem.line !== undefined ? `${problem.file}:${problem.line}` : problem.file;
  return {
    name: where,
    status: problem.level === 'error' ? 'fail' : 'warn',
    message: problem.message,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
