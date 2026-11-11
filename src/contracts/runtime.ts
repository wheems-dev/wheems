import type { Driver, HealthCheck } from './driver.js';

/**
 * The runtime contract: starts, sends to, reads and waits on agent sessions.
 * Version one ships the Herdr core driver; plain sessions without Herdr may follow.
 *
 * A session is one long-lived terminal program, usually an agent CLI such as
 * Claude Code. Sessions are addressed by the id the runtime gives them or by
 * the unique name given at start.
 */
export interface RuntimeDriver extends Driver<'runtime'> {
  /** Health checks for doctor: is the runtime installed, new enough and answering. */
  check(): Promise<HealthCheck[]>;

  /** Starts a program in a new session and returns at once, without waiting for it. */
  start(options: StartOptions): Promise<SessionInfo>;

  /**
   * Types text into a session and presses Enter.
   * Throws `DriverError` `not_found` for an unknown session, and `blocked` when
   * the program is waiting for a person (a permission prompt or question).
   */
  send(session: string, text: string, options?: SendOptions): Promise<SendResult>;

  /** Prints what the session's screen shows, plus history above it when asked. */
  read(session: string, options?: ReadOptions): Promise<ReadResult>;

  /**
   * Waits until the session stops working or exits, or until it prints
   * `options.output`. A timeout is a check-in, not a failure: `ended` is false.
   */
  wait(session: string, options?: WaitOptions): Promise<WaitResult>;

  /** One session, live or finished, or `null` when there is none by that id or name. */
  get(session: string): Promise<SessionInfo | null>;

  /** Live sessions, optionally only those carrying all the given labels. */
  list(options?: ListOptions): Promise<SessionInfo[]>;

  /** Ends the session's program. The session stays, finished, until removed. */
  stop(session: string): Promise<SessionInfo>;

  /** Removes a finished session. */
  remove(session: string): Promise<void>;
}

/** The status an agent program reports about itself. Plain programs report none (`null`). */
export type SessionStatus = 'idle' | 'working' | 'done' | 'blocked' | 'error';

export interface StartOptions {
  /** Unique among live sessions: 1 to 32 of a-z, 0-9, `-` and `_`. */
  name: string;
  /** The program and its arguments. Not run through a shell. */
  command: string[];
  /** Working directory. Defaults to the runtime's own choice. */
  cwd?: string;
  /** Labels to find the session by later, such as `workspace=acme`. */
  labels?: Record<string, string>;
  /** Run it on another machine the runtime knows about. */
  machine?: string;
}

export interface SessionInfo {
  /** The runtime's id for the session, stable for its lifetime. */
  id: string;
  name: string | null;
  state: 'live' | 'finished';
  /** What the program last reported, or `null` when it reports nothing. */
  status: SessionStatus | null;
  /** Counts the program's turns; it advances each time it starts working. */
  turn: number;
  /** The folder the session was started in. */
  cwd: string;
  /** The program and its arguments, when the runtime reports them. */
  command: string[] | null;
  /** Set once the program has exited with a code. */
  exitCode: number | null;
  labels: Record<string, string>;
}

export interface SendOptions {
  /** Only type if the status is exactly this. */
  ifStatus?: 'idle' | 'working';
  /** Then wait for the turn this send started. */
  wait?: boolean;
  /** With `wait`: seconds before it checks in. */
  timeoutSeconds?: number;
}

export interface SendResult {
  /** The turn when the text went in. */
  turn: number;
  /** The program's status when the text went in. */
  status: SessionStatus | null;
  /** With `wait`: how that turn ended. */
  wait: WaitResult | null;
}

export interface ReadOptions {
  /** Lines of history above the screen. 0, the default, reads only the screen. */
  lines?: number;
}

export interface ReadResult {
  text: string;
  /** False when part of what was asked for may be missing. */
  complete: boolean;
}

export interface WaitOptions {
  /** Seconds before the wait checks in. */
  timeoutSeconds?: number;
  /** For plain programs: end when output printed after the wait started contains this text. */
  output?: string;
}

export type WaitReason =
  /** The program reported a status other than working. */
  | 'status'
  /** The program exited. */
  | 'exit'
  /** The awaited output appeared. */
  | 'output'
  /** The wait checked in before anything happened. */
  | 'timeout'
  /** After a send: the program did not start working. */
  | 'not_started'
  /** Someone messaged the waiter. */
  | 'message';

export interface WaitResult {
  /** False on timeout: the session is still running. */
  ended: boolean;
  reason: WaitReason;
  status: SessionStatus | null;
  exitCode: number | null;
  turn: number;
}

export interface ListOptions {
  labels?: Record<string, string>;
}

export const SESSION_NAME_PATTERN = /^[a-z0-9_-]{1,32}$/;
