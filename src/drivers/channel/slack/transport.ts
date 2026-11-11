import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';

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
  /** Calls a Web API method. Slack errors reject with an error whose `data.error` is Slack's code. */
  call(method: string, args: Record<string, unknown>): Promise<SlackResult>;
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
  private readonly socket: SocketModeClient;

  constructor(tokens: SlackTokens) {
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

  async call(method: string, args: Record<string, unknown>): Promise<SlackResult> {
    return (await this.web.apiCall(method, args)) as SlackResult;
  }
}
