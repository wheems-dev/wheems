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
  type StartOptions,
  type WaitOptions,
  type WaitResult,
} from '../contracts/runtime.js';

/** What a simulated program can do. */
export interface ProgramIo {
  print(text: string): void;
  exit(code: number): void;
}

/** A simulated program: it gets each line typed into it. */
export interface Program {
  input(line: string, io: ProgramIo): void;
}

export type ProgramFactory = (args: string[]) => Program;

/** Prints `got:<line>` for the first line it reads, then exits 0. */
export const echoLineProgram: ProgramFactory = () => ({
  input(line, io) {
    io.print(`got:${line}`);
    io.exit(0);
  },
});

/** Runs until stopped and ignores input. */
export const sleepProgram: ProgramFactory = () => ({ input: () => undefined });

interface MemorySession {
  info: SessionInfo;
  program: Program;
  screen: string[];
  exitWaiters: (() => void)[];
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

  constructor(programs: Record<string, ProgramFactory> = {}) {
    this.programs = { 'echo-line': echoLineProgram, sleep: sleepProgram, ...programs };
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
    this.sessions.set(info.id, { info, program: factory(args), screen: [], exitWaiters: [] });
    return Promise.resolve({ ...info, labels: { ...info.labels } });
  }

  send(id: string, text: string, _options: SendOptions = {}): Promise<SendResult> {
    const session = this.find(id);
    if (!session) return Promise.reject(this.notFound(id));
    if (session.info.state === 'finished') {
      return Promise.reject(new DriverError(this.name, 'failed', `Session ${id} has finished`));
    }
    session.screen.push(text);
    session.program.input(text, {
      print: (line) => session.screen.push(line),
      exit: (code) => {
        this.finish(session, code);
      },
    });
    return Promise.resolve({ turn: session.info.turn, status: session.info.status, wait: null });
  }

  read(id: string, _options: ReadOptions = {}): Promise<ReadResult> {
    const session = this.find(id);
    if (!session) return Promise.reject(this.notFound(id));
    return Promise.resolve({ text: session.screen.join('\n'), complete: true });
  }

  async wait(id: string, options: WaitOptions = {}): Promise<WaitResult> {
    const session = this.find(id);
    if (!session) throw this.notFound(id);
    if (session.info.state === 'live') {
      const ms = (options.timeoutSeconds ?? 180) * 1000;
      const exited = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          resolve(false);
        }, ms);
        session.exitWaiters.push(() => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      if (!exited) {
        return {
          ended: false,
          reason: 'timeout',
          status: session.info.status,
          exitCode: null,
          turn: session.info.turn,
        };
      }
    }
    return {
      ended: true,
      reason: 'exit',
      status: session.info.status,
      exitCode: session.info.exitCode,
      turn: session.info.turn,
    };
  }

  get(id: string): Promise<SessionInfo | null> {
    const session = this.find(id);
    return Promise.resolve(
      session ? { ...session.info, labels: { ...session.info.labels } } : null,
    );
  }

  list(options: ListOptions = {}): Promise<SessionInfo[]> {
    const wanted = Object.entries(options.labels ?? {});
    return Promise.resolve(
      [...this.sessions.values()]
        .filter((s) => s.info.state === 'live')
        .filter((s) => wanted.every(([k, v]) => s.info.labels[k] === v))
        .map((s) => ({ ...s.info, labels: { ...s.info.labels } })),
    );
  }

  stop(id: string): Promise<SessionInfo> {
    const session = this.find(id);
    if (!session) return Promise.reject(this.notFound(id));
    if (session.info.state === 'live') this.finish(session, null);
    return Promise.resolve({ ...session.info });
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
    for (const wake of session.exitWaiters.splice(0)) wake();
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
