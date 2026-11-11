import { randomBytes } from 'node:crypto';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { crossCheck } from '../config/check.js';
import { loadInstall, type Problem } from '../config/load.js';
import type { HealthCheck } from '../contracts/driver.js';
import type { DriverRegistry } from '../contracts/registry.js';
import type { RuntimeDriver } from '../contracts/runtime.js';
import { HERDR_MINIMUM_VERSION } from '../drivers/runtime/herdr/herdr-runtime.js';
import { compareVersions, isAtLeast } from '../util/version.js';

export const NODE_MINIMUM_VERSION = '22.12.0';

export interface DoctorOptions {
  /** The install folder. */
  home: string;
  registry: DriverRegistry;
  /** Skip starting a test session in the runtime. */
  quick?: boolean;
  /** Overrides for tests. */
  nodeVersion?: string;
  platform?: NodeJS.Platform;
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
      hint: 'opinr setup creates one (milestone 1). Set OPINR_HOME or --home to check another folder.',
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

  const ok = sections.every((s) => s.checks.every((c) => c.status !== 'fail'));
  return { ok, sections };
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

export function defaultHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPINR_HOME && env.OPINR_HOME.length > 0 ? env.OPINR_HOME : join(homedir(), 'opinr');
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
