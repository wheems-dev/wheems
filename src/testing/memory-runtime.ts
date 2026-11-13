import { DriverError, type HealthCheck } from '../contracts/driver.js';
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
  type WaitResult,
} from '../contracts/runtime.js';

/** What a simulated program can do. */
export interface ProgramIo {
  print(text: string): void;
  exit(code: number): void;
  /** Reports a status, as agent programs do. `working` starts a new turn. */
  status(status: SessionStatus): void;
}

/** A simulated program: it may act on start, and gets each line typed into it. */
export interface Program {
  start?(io: ProgramIo): void;
  input(line: string, io: ProgramIo): void;
}

export interface ProgramContext {
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /** The session's id in the runtime. */
  sessionId: string;
}

export type ProgramFactory = (context: ProgramContext) => Program;

/** Prints `got:<line>` for the first line it reads, then exits 0. */
export const echoLineProgram: ProgramFactory = () => ({
  input(line, io) {
    io.print(`got:${line}`);
    io.exit(0);
  },
});

/** Prints `got:<value of CONTRACT_VALUE>` once it reads a line, then exits 0. */
export const echoEnvProgram: ProgramFactory = ({ env }) => ({
  input(_line, io) {
    io.print(`got:${env.CONTRACT_VALUE ?? ''}`);
    io.exit(0);
  },
});

/** Runs until stopped and ignores input. */
export const sleepProgram: ProgramFactory = () => ({ input: () => undefined });

interface MemorySession {
  info: SessionInfo;
  program: Program;
  io: ProgramIo;
  screen: string[];
  waiters: (() => void)[];
  /** Whether the program has started; text sent before then waits in `typedAhead`. */
  started: boolean;
  typedAhead: string[];
}

/**
 * A runtime driver that keeps sessions in memory and runs simulated programs.
 * For testing code that sits above the runtime contract without Herdr.
 */
export class MemoryRuntime implements RuntimeDriver {
  readonly kind = 'runtime' as const;
  readonly name = 'memory';
  private readonly programs: Record<string, ProgramFactory>;
  private readonly sessions = new Map<string, MemorySession>();
  private nextId = 1;

  private readonly waitDelayMs: number;

  /**
   * `waitDelayMs` holds back each wait's answer, as a slow runtime would, so the session
   * may have moved on by the time the caller hears.
   */
  constructor(
    programs: Record<string, ProgramFactory> = {},
    options: { waitDelayMs?: number } = {},
  ) {
    this.waitDelayMs = options.waitDelayMs ?? 0;
    this.programs = {
      'echo-line': echoLineProgram,
      'echo-env': echoEnvProgram,
      sleep: sleepProgram,
      ...programs,
    };
  }

  check(): Promise<HealthCheck[]> {
    return Promise.resolve([
      { name: 'memory runtime', status: 'pass', message: 'Sessions are kept in memory' },
    ]);
  }

  start(options: StartOptions): Promise<SessionInfo> {
    if (!SESSION_NAME_PATTERN.test(options.name)) {
      return Promise.reject(
        new DriverError(this.name, 'invalid', `Invalid session name "${options.name}"`),
      );
    }
    const [program, ...args] = options.command;
    const factory = program === undefined ? undefined : this.programs[program];
    if (!factory) {
      return Promise.reject(
        new DriverError(this.name, 'invalid', `No simulated program "${program ?? ''}"`),
      );
    }
    for (const session of this.sessions.values()) {
      if (session.info.name === options.name && session.info.state === 'live') {
        return Promise.reject(
          new DriverError(
            this.name,
            'invalid',
            `A live session is already named "${options.name}"`,
          ),
        );
      }
    }
    const info: SessionInfo = {
      id: `m${this.nextId++}`,
      name: options.name,
      state: 'live',
      status: null,
      turn: 0,
      cwd: options.cwd ?? process.cwd(),
      command: [...options.command],
      exitCode: null,
      labels: { ...options.labels },
    };
    const session: MemorySession = {
      info,
      program: factory({ args, env: { ...options.env }, cwd: info.cwd, sessionId: info.id }),
      screen: [],
      waiters: [],
      started: false,
      typedAhead: [],
      io: {
        print: (line) => session.screen.push(line),
        exit: (code) => {
          this.finish(session, code);
        },
        status: (status) => {
          if (session.info.state !== 'live') return;
          if (status === 'working' && session.info.status !== 'working') session.info.turn++;
          session.info.status = status;
          if (status !== 'working') this.wake(session);
        },
      },
    };
    this.sessions.set(info.id, session);
    const snapshot = copy(info);
    // Like a real runtime, start returns before the program has done anything. Text sent
    // before then waits, as a terminal holds typing until the program reads it.
    setTimeout(() => {
      if (session.info.state !== 'live') return;
      session.program.start?.(session.io);
      session.started = true;
      // A program that exits takes no more input; what's left is dropped, as it would be.
      const exited = () => session.info.state !== 'live';
      for (const line of session.typedAhead.splice(0)) {
        if (exited()) break;
        session.program.input(line, session.io);
      }
    }, 0);
    return Promise.resolve(snapshot);
  }

  send(id: string, text: string, options: SendOptions = {}): Promise<SendResult> {
    const session = this.find(id);
    if (!session) return Promise.reject(this.notFound(id));
    if (session.info.state === 'finished') {
      return Promise.reject(new DriverError(this.name, 'failed', `Session ${id} has finished`));
    }
    if (session.info.status === 'blocked') {
      return Promise.reject(new DriverError(this.name, 'blocked', `Session ${id} needs a person`));
    }
    if (options.ifStatus !== undefined && session.info.status !== options.ifStatus) {
      return Promise.reject(
        new DriverError(this.name, 'failed', `Session ${id} is not ${options.ifStatus}`),
      );
    }
    const turn = session.info.turn;
    const status = session.info.status;
    session.screen.push(text);
    if (session.started) session.program.input(text, session.io);
    else session.typedAhead.push(text);
    return Promise.resolve({ turn, status, wait: null });
  }

  read(id: string, _options: ReadOptions = {}): Promise<ReadResult> {
    const session = this.find(id);
    if (!session) return Promise.reject(this.notFound(id));
    return Promise.resolve({ text: session.screen.join('\n'), complete: true });
  }

  async wait(id: string, options: WaitOptions = {}): Promise<WaitResult> {
    const session = this.find(id);
    if (!session) throw this.notFound(id);
    const settled = () =>
      session.info.state === 'finished' ||
      (session.info.status !== null && session.info.status !== 'working');
    if (!settled()) {
      const ms = (options.timeoutSeconds ?? 180) * 1000;
      const woke = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          resolve(false);
        }, ms);
        session.waiters.push(() => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      if (!woke) {
        return {
          ended: false,
          reason: 'timeout',
          status: session.info.status,
          exitCode: null,
          turn: session.info.turn,
        };
      }
    }
    const result: WaitResult = {
      ended: true,
      reason: session.info.state === 'finished' ? 'exit' : 'status',
      status: session.info.status,
      exitCode: session.info.exitCode,
      turn: session.info.turn,
    };
    if (this.waitDelayMs > 0) await new Promise((r) => setTimeout(r, this.waitDelayMs));
    return result;
  }

  get(id: string): Promise<SessionInfo | null> {
    const session = this.find(id);
    return Promise.resolve(session ? copy(session.info) : null);
  }

  list(options: ListOptions = {}): Promise<SessionInfo[]> {
    const wanted = Object.entries(options.labels ?? {});
    return Promise.resolve(
      [...this.sessions.values()]
        .filter((s) => s.info.state === 'live')
        .filter((s) => wanted.every(([k, v]) => s.info.labels[k] === v))
        .map((s) => copy(s.info)),
    );
  }

  stop(id: string): Promise<SessionInfo> {
    const session = this.find(id);
    if (!session) return Promise.reject(this.notFound(id));
    if (session.info.state === 'live') this.finish(session, null);
    return Promise.resolve(copy(session.info));
  }

  remove(id: string): Promise<void> {
    const session = this.find(id);
    if (!session) return Promise.reject(this.notFound(id));
    if (session.info.state === 'live') {
      return Promise.reject(new DriverError(this.name, 'invalid', `Session ${id} is still live`));
    }
    this.sessions.delete(session.info.id);
    return Promise.resolve();
  }

  private finish(session: MemorySession, code: number | null): void {
    session.info.state = 'finished';
    session.info.exitCode = code;
    this.wake(session);
  }

  private wake(session: MemorySession): void {
    for (const wake of session.waiters.splice(0)) wake();
  }

  private find(idOrName: string): MemorySession | undefined {
    const byId = this.sessions.get(idOrName);
    if (byId) return byId;
    const named = [...this.sessions.values()].filter((s) => s.info.name === idOrName);
    return named.find((s) => s.info.state === 'live') ?? named.at(-1);
  }

  private notFound(id: string): DriverError {
    return new DriverError(this.name, 'not_found', `No session "${id}"`);
  }
}

function copy(info: SessionInfo): SessionInfo {
  return { ...info, labels: { ...info.labels }, command: info.command ? [...info.command] : null };
}
