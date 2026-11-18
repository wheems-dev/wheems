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
  /**
   * Connects and delivers each event, and each button press as a `block_actions` event. Both
   * are acknowledged before delivery.
   */
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
 * A Web API client for checks and setup: one retry, ten seconds a try, no waiting out Slack's
 * rate limits, and none of the SDK's own warnings, so a Mac that is offline gets a plain answer
 * in seconds rather than half an hour of retries.
 */
export function quickClient(token: string): WebClient {
  return new WebClient(token, {
    retryConfig: { retries: 1 },
    timeout: 10_000,
    rejectRateLimitedCalls: true,
    logLevel: LogLevel.ERROR,
  });
}

/** Why a call got no answer from Slack itself, as a check reports it. */
export interface NoAnswer {
  message: string;
  hint: string;
}

/**
 * Why a call got no answer from Slack: this Mac couldn't reach it, or Slack is limiting requests.
 * Null when the error is Slack's own answer (a refused token, a missing channel).
 */
export function noAnswer(error: unknown): NoAnswer | null {
  const e = error as
    | {
        code?: unknown;
        original?: { message?: unknown; cause?: { code?: unknown } };
        statusCode?: unknown;
        retryAfter?: unknown;
      }
    | undefined;
  const offline = (reason: string): NoAnswer => ({
    message: `Couldn't reach Slack (${reason})`,
    hint: "Check this Mac's internet connection. Wheems keeps trying on its own.",
  });
  if (e?.code === ErrorCode.RequestError) {
    const cause = e.original?.cause?.code;
    const message = typeof e.original?.message === 'string' ? e.original.message : 'no answer';
    return offline(typeof cause === 'string' ? `${message}, ${cause}` : message);
  }
  if (e?.code === ErrorCode.HTTPError) {
    return offline(`HTTP ${typeof e.statusCode === 'number' ? String(e.statusCode) : 'error'}`);
  }
  if (e?.code === ErrorCode.RateLimitedError) {
    const after = typeof e.retryAfter === 'number' ? ` for ${String(e.retryAfter)} seconds` : '';
    return {
      message: `Slack is limiting requests${after}`,
      hint: 'Wait, then try again. Wheems keeps trying on its own.',
    };
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
  body?: { event?: SlackEvent; type?: unknown };
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
      if (envelope.type === 'events_api' && envelope.body?.event) {
        await onEvent(envelope.body.event);
      } else if (envelope.type === 'interactive' && envelope.body?.type === 'block_actions') {
        // A press of a button on one of the app's posts: its payload, as an event.
        await onEvent({ ...envelope.body, type: 'block_actions' });
      }
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
