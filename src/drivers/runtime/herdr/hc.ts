/**
 * The one module that calls Herdr core's `hc` command. A change in Herdr means
 * fixing this file. It always asks for JSON and never reads screen text to
 * learn state; the only text it reads is `hc --version`, which has no JSON form.
 */
import { execFile, type ExecFileException } from 'node:child_process';
import { z } from 'zod';
import { extractVersion } from '../../../util/version.js';

export interface HcOptions {
  /** The `hc` executable. Defaults to `hc` on PATH. */
  binary?: string;
  /** Environment for every call. Defaults to this process's environment. */
  env?: NodeJS.ProcessEnv;
  /** Extra seconds allowed beyond a command's own timeout before the call is abandoned. */
  graceSeconds?: number;
}

/** Why an hc call failed. The kinds hc reports itself, plus `missing` and `bad_output`. */
export class HcError extends Error {
  constructor(
    /** hc's own error kind (such as `not_found`, `blocked`, `usage`), or `missing` or `bad_output`. */
    readonly kind: string,
    message: string,
    readonly hint: string | undefined,
    readonly exitCode: number | null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'HcError';
  }
}

const labels = z.record(z.string(), z.string()).default({});

/**
 * An agent's status. `hc ls` reports the word; `hc get` and `hc run` report the whole
 * status record (`{app, state, ...}`). Either way, only the word is kept.
 */
const status = z
  .union([z.string(), z.looseObject({ state: z.string() })])
  .nullish()
  .transform((value) => (value == null ? null : typeof value === 'string' ? value : value.state));

export const hcTerminal = z.looseObject({
  address: z.string(),
  name: z.string().nullish(),
  argv: z.array(z.string()).optional(),
  agent: z.string().nullish(),
  cwd: z.string(),
  state: z.string(),
  status,
  turn: z.number().int().nonnegative(),
  exit_code: z.number().int().nullish(),
  labels,
});
export type HcTerminal = z.infer<typeof hcTerminal>;

export const hcWaitResult = z.looseObject({
  terminal: z.string(),
  ended: z.boolean(),
  reason: z.string(),
  status: z.string().nullish(),
  exit_code: z.number().int().nullish(),
  turn: z.number().int().nonnegative(),
});
export type HcWaitResult = z.infer<typeof hcWaitResult>;

export const hcSendResult = z.looseObject({
  turn: z.number().int().nonnegative(),
  status: z.string().nullish(),
  started: z.boolean().nullish(),
  wait: hcWaitResult.nullish(),
});
export type HcSendResult = z.infer<typeof hcSendResult>;

export const hcReadResult = z.looseObject({
  text: z.string(),
  complete: z.boolean(),
  how: z.string().optional(),
});
export type HcReadResult = z.infer<typeof hcReadResult>;

export const hcListResult = z.looseObject({
  terminals: z.array(hcTerminal),
});

export const hcServerStatus = z.looseObject({
  version: z.string(),
  pid: z.number().int().optional(),
  live: z.number().int().optional(),
});
export type HcServerStatus = z.infer<typeof hcServerStatus>;

const hcErrorBody = z.object({
  error: z.object({
    kind: z.string(),
    message: z.string(),
    hint: z.string().nullish(),
  }),
});

export interface HcRunOptions {
  name?: string;
  cwd?: string;
  labels?: Record<string, string>;
  machine?: string;
}

const DEFAULT_TIMEOUT_SECONDS = 30;
/** hc's own default for waits. */
const DEFAULT_WAIT_SECONDS = 180;

export class Hc {
  private readonly binary: string;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly graceSeconds: number;

  constructor(options: HcOptions = {}) {
    this.binary = options.binary ?? 'hc';
    this.env = options.env;
    this.graceSeconds = options.graceSeconds ?? 15;
  }

  /** The installed `hc` version, from `hc --version` (such as `0.1.20`). */
  async version(): Promise<string> {
    const { stdout } = await this.exec(['--version'], DEFAULT_TIMEOUT_SECONDS);
    const version = extractVersion(stdout);
    if (!version) {
      throw new HcError(
        'bad_output',
        `Could not read a version from "hc --version": ${stdout.trim()}`,
        undefined,
        0,
      );
    }
    return version;
  }

  /** The running core's status. Starts the core if it is not running. */
  async serverStatus(): Promise<HcServerStatus> {
    return this.json(['server', 'status'], hcServerStatus);
  }

  /** Stops the core. Only for test sessions: it affects every terminal on that core. */
  async serverStop(): Promise<void> {
    await this.exec(['server', 'stop', '--json'], DEFAULT_TIMEOUT_SECONDS);
  }

  /** Starts a program in the background, with no parent, and returns at once. */
  async run(command: string[], options: HcRunOptions = {}): Promise<HcTerminal> {
    const args = ['run', '--bg', '--no-parent', '--no-notify'];
    if (options.name !== undefined) args.push('--name', options.name);
    if (options.cwd !== undefined) args.push('--cwd', options.cwd);
    if (options.machine !== undefined) args.push('--on', options.machine);
    for (const [key, value] of Object.entries(options.labels ?? {})) {
      args.push('--label', `${key}=${value}`);
    }
    args.push('--', ...command);
    return this.json(args, hcTerminal);
  }

  async send(
    terminal: string,
    text: string,
    options: { wait?: boolean; ifStatus?: string; timeoutSeconds?: number } = {},
  ): Promise<HcSendResult> {
    const args = ['send'];
    if (options.ifStatus !== undefined) args.push('--if', options.ifStatus);
    // A waiting send gets the same explicit timeout as hc and as the subprocess deadline,
    // so a long agent turn is never cut off here before hc gives up.
    const waitTimeout =
      options.wait === true ? (options.timeoutSeconds ?? DEFAULT_WAIT_SECONDS) : undefined;
    if (waitTimeout !== undefined) args.push('--wait', '--timeout', String(waitTimeout));
    else if (options.timeoutSeconds !== undefined)
      args.push('--timeout', String(options.timeoutSeconds));
    args.push('--', terminal, text);
    return this.json(args, hcSendResult, waitTimeout);
  }

  async read(terminal: string, options: { lines?: number } = {}): Promise<HcReadResult> {
    const args = ['read'];
    if (options.lines !== undefined) args.push('--lines', String(options.lines));
    args.push('--', terminal);
    return this.json(args, hcReadResult);
  }

  async wait(
    terminal: string,
    options: { timeoutSeconds?: number; output?: string } = {},
  ): Promise<HcWaitResult> {
    const timeout = options.timeoutSeconds ?? DEFAULT_WAIT_SECONDS;
    const args = ['wait', '--timeout', String(timeout)];
    if (options.output !== undefined) args.push('--output', options.output);
    args.push('--', terminal);
    return this.json(args, hcWaitResult, timeout);
  }

  async get(terminal: string): Promise<HcTerminal> {
    return this.json(['get', '--', terminal], hcTerminal);
  }

  async list(
    options: { all?: boolean; labels?: Record<string, string> } = {},
  ): Promise<HcTerminal[]> {
    const args = ['ls'];
    if (options.all === true) args.push('--all');
    for (const [key, value] of Object.entries(options.labels ?? {})) {
      args.push('--label', `${key}=${value}`);
    }
    const result = await this.json(args, hcListResult);
    return result.terminals;
  }

  async kill(terminal: string): Promise<HcTerminal> {
    return this.json(['kill', '--', terminal], hcTerminal);
  }

  async remove(terminal: string): Promise<void> {
    await this.exec(['rm', '--json', '--', terminal], DEFAULT_TIMEOUT_SECONDS);
  }

  private async json<T>(args: string[], schema: z.ZodType<T>, timeoutSeconds?: number): Promise<T> {
    const [command, ...rest] = args;
    const { stdout } = await this.exec(
      [command ?? '', '--json', ...rest],
      timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (cause) {
      throw new HcError('bad_output', `hc ${command ?? ''} did not print JSON`, undefined, 0, {
        cause,
      });
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new HcError(
        'bad_output',
        `hc ${command ?? ''} printed JSON in a shape this version of Opinr does not know: ${z.prettifyError(result.error)}`,
        'Check that hc is a version Opinr supports (opinr doctor).',
        0,
      );
    }
    return result.data;
  }

  private exec(
    args: string[],
    timeoutSeconds: number,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile(
        this.binary,
        args,
        {
          env: this.env ?? process.env,
          timeout: (timeoutSeconds + this.graceSeconds) * 1000,
          maxBuffer: 64 * 1024 * 1024,
          encoding: 'utf8',
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ stdout, stderr });
            return;
          }
          reject(toHcError(error, stderr, this.binary));
        },
      );
    });
  }
}

function toHcError(error: ExecFileException, stderr: string, binary: string): HcError {
  if (error.code === 'ENOENT') {
    return new HcError(
      'missing',
      `Herdr core's hc command was not found (${binary})`,
      'Install Herdr core, or make sure hc is on PATH.',
      null,
      { cause: error },
    );
  }
  const exitCode = typeof error.code === 'number' ? error.code : null;
  if (error.killed === true) {
    return new HcError('timeout', `hc did not answer in time`, undefined, exitCode, {
      cause: error,
    });
  }
  for (const line of stderr.split('\n').reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const body = hcErrorBody.safeParse(JSON.parse(trimmed));
      if (body.success) {
        const { kind, message, hint } = body.data.error;
        return new HcError(kind, message, hint ?? undefined, exitCode, { cause: error });
      }
    } catch {
      // Not JSON; keep looking.
    }
  }
  const detail = stderr.trim() || error.message;
  return new HcError('failed', `hc failed: ${detail}`, undefined, exitCode, { cause: error });
}
