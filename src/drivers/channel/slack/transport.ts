import { SocketModeClient } from '@slack/socket-mode';
import { ErrorCode, LogLevel, WebClient } from '@slack/web-api';

/** A Slack Events API event, such as a `message`. */
export type SlackEvent = Record<string, unknown> & { type: string };

/** The result of a Web API call: `ok` plus the method's own fields. */
export type SlackResult = Record<string, unknown> & { ok: boolean; error?: string };

/**
 * What the Slack driver needs from Slack: events in over Socket Mode, and Web API
 * calls out. The real one wraps Slack's own clients; tests use a fake.
 */
export interface SlackTransport {
  /** Connects and delivers each event. Events are acknowledged before delivery. */
  start(onEvent: (event: SlackEvent) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  /**
   * Calls a Web API method. Slack errors reject with an error whose `data.error` is Slack's code.
   * A `quick` call, for a check, gives up after a few seconds when Slack can't be reached, and
   * logs nothing; other calls keep trying for half an hour, so a message survives an outage.
   */
  call(
    method: string,
    args: Record<string, unknown>,
    options?: { quick?: boolean },
  ): Promise<SlackResult>;
}

/**
 * A Web API client for checks and setup: one retry, ten seconds a try, and none of the SDK's
 * own warnings, so a Mac that is offline gets a plain answer rather than half an hour of retries.
 */
export function quickClient(token: string): WebClient {
  return new WebClient(token, {
    retryConfig: { retries: 1 },
    timeout: 10_000,
    logLevel: LogLevel.ERROR,
  });
}

/**
 * Why Slack couldn't be reached, such as `fetch failed`, or null when the error came from Slack
 * itself (a refused token, a missing channel) and says nothing about the network.
 */
export function unreachable(error: unknown): string | null {
  const e = error as
    | {
        code?: unknown;
        original?: { message?: unknown; cause?: { code?: unknown } };
        statusCode?: unknown;
      }
    | undefined;
  if (e?.code === ErrorCode.RequestError) {
    const cause = e.original?.cause?.code;
    const message = typeof e.original?.message === 'string' ? e.original.message : 'no answer';
    return typeof cause === 'string' ? `${message}, ${cause}` : message;
  }
  if (e?.code === ErrorCode.HTTPError) {
    return `Slack answered with HTTP ${typeof e.statusCode === 'number' ? e.statusCode : 'error'}`;
  }
  return null;
}

export interface SlackTokens {
  /** The bot token, `xoxb-…`. */
  botToken: string;
  /** The app-level token with `connections:write`, `xapp-…`, for Socket Mode. */
  appToken: string;
}

interface Envelope {
  ack: () => Promise<void>;
  type: string;
  body?: { event?: SlackEvent };
}

/** The real transport: Socket Mode (no public URL needed) and the Web API. */
export class SocketModeTransport implements SlackTransport {
  private readonly web: WebClient;
  private quickWeb: WebClient | undefined;
  private readonly socket: SocketModeClient;
  private readonly botToken: string;

  constructor(tokens: SlackTokens) {
    this.botToken = tokens.botToken;
    this.web = new WebClient(tokens.botToken);
    this.socket = new SocketModeClient({ appToken: tokens.appToken });
  }

  async start(onEvent: (event: SlackEvent) => Promise<void>): Promise<void> {
    this.socket.on('slack_event', (envelope: Envelope) => {
      void this.dispatch(envelope, onEvent);
    });
    await this.socket.start();
  }

  private async dispatch(
    envelope: Envelope,
    onEvent: (event: SlackEvent) => Promise<void>,
  ): Promise<void> {
    try {
      // Acknowledge first: Slack resends events that are not acknowledged within 3 seconds.
      await envelope.ack();
      if (envelope.type === 'events_api' && envelope.body?.event)
        await onEvent(envelope.body.event);
    } catch {
      // The driver handles its own errors; a failed acknowledgement means Slack resends.
    }
  }

  async stop(): Promise<void> {
    await this.socket.disconnect();
  }

  async call(
    method: string,
    args: Record<string, unknown>,
    options: { quick?: boolean } = {},
  ): Promise<SlackResult> {
    const web = options.quick === true ? (this.quickWeb ??= quickClient(this.botToken)) : this.web;
    return (await web.apiCall(method, args)) as SlackResult;
  }
}
