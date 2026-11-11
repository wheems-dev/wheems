import { DriverError, type HealthCheck } from '../../../contracts/driver.js';
import {
  SESSION_NAME_PATTERN,
  type ListOptions,
  type ReadOptions,
  type ReadResult,
  type RuntimeDriver,
  type SendOptions,
  type SendResult,
  type SessionInfo,
  type SessionStatus,
  type StartOptions,
  type WaitOptions,
  type WaitReason,
  type WaitResult,
} from '../../../contracts/runtime.js';
import { isAtLeast } from '../../../util/version.js';
import { Hc, HcError, type HcOptions, type HcTerminal, type HcWaitResult } from './hc.js';

/** The oldest Herdr core this version of Opinr was tested with. */
export const HERDR_MINIMUM_VERSION = '0.1.20';

export interface HerdrRuntimeOptions extends HcOptions {
  /** A minimum above the built-in one, such as `herdr.version` from install.yaml. */
  minimumVersion?: string;
}

/**
 * The Herdr core runtime driver. Sessions are hc terminals; ids are hc addresses
 * such as `t7` or `machine/t7`.
 */
export class HerdrRuntime implements RuntimeDriver {
  readonly kind = 'runtime' as const;
  readonly name = 'herdr';
  readonly minimumVersion: string;
  private readonly hc: Hc;
  private versionChecked: Promise<void> | undefined;

  constructor(options: HerdrRuntimeOptions = {}) {
    this.hc = new Hc(options);
    const pinned = options.minimumVersion;
    this.minimumVersion =
      pinned !== undefined && isAtLeast(pinned, HERDR_MINIMUM_VERSION)
        ? pinned
        : HERDR_MINIMUM_VERSION;
  }

  async check(): Promise<HealthCheck[]> {
    const checks: HealthCheck[] = [];
    let version: string;
    try {
      version = await this.hc.version();
    } catch (error) {
      checks.push({
        name: 'hc installed',
        status: 'fail',
        message: describe(error),
        hint: 'Install Herdr core and make sure hc is on PATH.',
      });
      return checks;
    }
    checks.push({ name: 'hc installed', status: 'pass', message: `hc ${version}` });

    if (!isAtLeast(version, this.minimumVersion)) {
      checks.push({
        name: 'hc version',
        status: 'fail',
        message: `hc ${version} is older than the minimum ${this.minimumVersion}`,
        hint: 'Run hc update.',
      });
      return checks;
    }
    checks.push({
      name: 'hc version',
      status: 'pass',
      message: `${version} meets the minimum ${this.minimumVersion}`,
    });

    try {
      const status = await this.hc.serverStatus();
      if (!isAtLeast(status.version, this.minimumVersion)) {
        checks.push({
          name: 'Herdr core',
          status: 'fail',
          message: `The running core is ${status.version}, older than the minimum ${this.minimumVersion}`,
          hint: 'Run hc update, which restarts an older core and keeps terminals running.',
        });
      } else {
        checks.push({
          name: 'Herdr core',
          status: 'pass',
          message: `Core ${status.version} is running`,
        });
      }
    } catch (error) {
      checks.push({
        name: 'Herdr core',
        status: 'fail',
        message: `The core does not answer: ${describe(error)}`,
        hint: 'Run hc server status to see why.',
      });
    }
    return checks;
  }

  async start(options: StartOptions): Promise<SessionInfo> {
    if (!SESSION_NAME_PATTERN.test(options.name)) {
      throw new DriverError(
        this.name,
        'invalid',
        `Session names are 1 to 32 of a-z, 0-9, - and _: "${options.name}"`,
      );
    }
    if (options.command.length === 0) {
      throw new DriverError(this.name, 'invalid', 'A session needs a command');
    }
    return this.call(async () => {
      const terminal = await this.hc.run(options.command, {
        name: options.name,
        ...(options.cwd !== undefined && { cwd: options.cwd }),
        ...(options.labels !== undefined && { labels: options.labels }),
        ...(options.machine !== undefined && { machine: options.machine }),
      });
      // hc run's result leaves out argv and labels; fill them in from what was asked for.
      const session = toSession(terminal, options.command);
      return Object.keys(session.labels).length > 0
        ? session
        : { ...session, labels: { ...options.labels } };
    });
  }

  async send(session: string, text: string, options: SendOptions = {}): Promise<SendResult> {
    return this.call(async () => {
      const result = await this.hc.send(session, text, {
        ...(options.wait !== undefined && { wait: options.wait }),
        ...(options.ifStatus !== undefined && { ifStatus: options.ifStatus }),
        ...(options.timeoutSeconds !== undefined && { timeoutSeconds: options.timeoutSeconds }),
      });
      return {
        turn: result.turn,
        status: toStatus(result.status),
        wait: result.wait ? toWait(result.wait) : null,
      };
    });
  }

  async read(session: string, options: ReadOptions = {}): Promise<ReadResult> {
    return this.call(async () => {
      const result = await this.hc.read(session, {
        ...(options.lines !== undefined && { lines: options.lines }),
      });
      return { text: result.text, complete: result.complete };
    });
  }

  async wait(session: string, options: WaitOptions = {}): Promise<WaitResult> {
    return this.call(async () => {
      const result = await this.hc.wait(session, {
        ...(options.timeoutSeconds !== undefined && { timeoutSeconds: options.timeoutSeconds }),
        ...(options.output !== undefined && { output: options.output }),
      });
      return toWait(result);
    });
  }

  async get(session: string): Promise<SessionInfo | null> {
    try {
      return await this.call(async () => toSession(await this.hc.get(session)));
    } catch (error) {
      if (error instanceof DriverError && error.kind === 'not_found') return null;
      throw error;
    }
  }

  async list(options: ListOptions = {}): Promise<SessionInfo[]> {
    return this.call(async () => {
      const terminals = await this.hc.list({
        ...(options.labels !== undefined && { labels: options.labels }),
      });
      return terminals.map((t) => toSession(t));
    });
  }

  async stop(session: string): Promise<SessionInfo> {
    return this.call(async () => toSession(await this.hc.kill(session)));
  }

  async remove(session: string): Promise<void> {
    await this.call(() => this.hc.remove(session));
  }

  /** Runs an hc call after the version check, turning hc errors into driver errors. */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      this.versionChecked ??= this.ensureVersion();
      await this.versionChecked;
      return await fn();
    } catch (error) {
      throw this.toDriverError(error);
    }
  }

  /** Refuses to run against an hc older than the minimum, once per driver instance. */
  private async ensureVersion(): Promise<void> {
    let version: string;
    try {
      version = await this.hc.version();
    } catch (error) {
      this.versionChecked = undefined;
      throw error;
    }
    if (!isAtLeast(version, this.minimumVersion)) {
      throw new DriverError(
        this.name,
        'version',
        `hc ${version} is older than the minimum ${this.minimumVersion} that Opinr needs`,
        { hint: 'Run hc update.' },
      );
    }
  }

  private toDriverError(error: unknown): unknown {
    if (error instanceof DriverError) return error;
    if (!(error instanceof HcError)) return error;
    const kind =
      error.kind === 'not_found'
        ? 'not_found'
        : error.kind === 'blocked'
          ? 'blocked'
          : error.kind === 'missing'
            ? 'unavailable'
            : error.kind === 'usage'
              ? 'invalid'
              : 'failed';
    return new DriverError(this.name, kind, error.message, { hint: error.hint, cause: error });
  }
}

const STATUSES = new Set<string>(['idle', 'working', 'done', 'blocked', 'error']);
const WAIT_REASONS = new Set<string>([
  'status',
  'exit',
  'output',
  'timeout',
  'not_started',
  'message',
]);

function toStatus(status: string | null | undefined): SessionStatus | null {
  return status != null && STATUSES.has(status) ? (status as SessionStatus) : null;
}

function toSession(terminal: HcTerminal, command?: string[]): SessionInfo {
  return {
    id: terminal.address,
    name: terminal.name ?? null,
    state: terminal.state === 'finished' ? 'finished' : 'live',
    status: toStatus(terminal.status),
    turn: terminal.turn,
    cwd: terminal.cwd,
    command: terminal.argv ?? command ?? null,
    exitCode: terminal.exit_code ?? null,
    labels: terminal.labels,
  };
}

function toWait(result: HcWaitResult): WaitResult {
  // Reasons a newer hc may add are treated as a status change, the safest reading.
  const reason: WaitReason = WAIT_REASONS.has(result.reason)
    ? (result.reason as WaitReason)
    : 'status';
  return {
    ended: result.ended,
    reason,
    status: toStatus(result.status),
    exitCode: result.exit_code ?? null,
    turn: result.turn,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
