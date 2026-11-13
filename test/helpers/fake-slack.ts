import type {
  SlackEvent,
  SlackResult,
  SlackTransport,
} from '../../src/drivers/channel/slack/transport.js';

/** A stand-in for Slack: records Web API calls and delivers events the test makes up. */
export class FakeSlack implements SlackTransport {
  readonly calls: { method: string; args: Record<string, unknown> }[] = [];
  readonly reactions = new Set<string>();
  channels: { id: string; name: string; member?: boolean }[] = [
    { id: 'C0GENERAL1', name: 'general' },
  ];
  /** Slack error codes to return for a method, once each. */
  failures = new Map<string, string>();
  private onEvent: ((event: SlackEvent) => Promise<void>) | undefined;
  private ts = 1_700_000_000;

  start(onEvent: (event: SlackEvent) => Promise<void>): Promise<void> {
    this.onEvent = onEvent;
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.onEvent = undefined;
    return Promise.resolve();
  }

  call(method: string, args: Record<string, unknown>): Promise<SlackResult> {
    this.calls.push({ method, args });
    const failure = this.failures.get(method);
    if (failure !== undefined) {
      this.failures.delete(method);
      return Promise.reject(
        Object.assign(new Error(`An API error occurred: ${failure}`), {
          data: { ok: false, error: failure },
        }),
      );
    }
    switch (method) {
      case 'auth.test':
        return Promise.resolve({ ok: true, user: 'wheems', user_id: 'UBOT', team: 'Test team' });
      case 'chat.postMessage':
        return Promise.resolve({ ok: true, channel: args.channel, ts: this.nextTs() });
      case 'reactions.add': {
        const key = `${String(args.channel)}/${String(args.timestamp)}/${String(args.name)}`;
        if (this.reactions.has(key)) return this.fail('already_reacted');
        this.reactions.add(key);
        return Promise.resolve({ ok: true });
      }
      case 'reactions.remove': {
        const key = `${String(args.channel)}/${String(args.timestamp)}/${String(args.name)}`;
        if (!this.reactions.delete(key)) return this.fail('no_reaction');
        return Promise.resolve({ ok: true });
      }
      case 'conversations.list': {
        // Two pages, so pagination is exercised.
        const half = Math.ceil(this.channels.length / 2);
        if (args.cursor === undefined) {
          return Promise.resolve({
            ok: true,
            channels: this.channels.slice(0, half),
            response_metadata: { next_cursor: 'page2' },
          });
        }
        return Promise.resolve({
          ok: true,
          channels: this.channels.slice(half),
          response_metadata: { next_cursor: '' },
        });
      }
      case 'conversations.info': {
        const channel = this.channels.find((c) => c.id === args.channel);
        if (!channel) return this.fail('channel_not_found');
        return Promise.resolve({
          ok: true,
          channel: { id: channel.id, name: channel.name, is_member: channel.member ?? true },
        });
      }
      default:
        return this.fail('unknown_method');
    }
  }

  /** Delivers a Slack event as Socket Mode would. */
  async emit(event: Record<string, unknown>): Promise<void> {
    await this.onEvent?.({ type: 'message', ...event });
  }

  /** Delivers a plain message from a person. Returns its ts. */
  async message(options: {
    channel: string;
    text: string;
    user?: string;
    thread_ts?: string;
    im?: boolean;
  }): Promise<string> {
    const ts = this.nextTs();
    await this.emit({
      channel: options.channel,
      text: options.text,
      user: options.user ?? 'UPERSON',
      ts,
      ...(options.thread_ts !== undefined && { thread_ts: options.thread_ts }),
      channel_type: options.im === true ? 'im' : 'channel',
    });
    return ts;
  }

  private fail(code: string): Promise<SlackResult> {
    return Promise.reject(
      Object.assign(new Error(`An API error occurred: ${code}`), {
        data: { ok: false, error: code },
      }),
    );
  }

  private nextTs(): string {
    return `${String(this.ts++)}.000100`;
  }
}
