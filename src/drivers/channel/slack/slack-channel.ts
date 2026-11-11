import type {
  ChannelCapabilities,
  ChannelDriver,
  InboundHandler,
  MessageRef,
  OutboundMessage,
  SentMessage,
} from '../../../contracts/channel.js';
import { DriverError, type HealthCheck } from '../../../contracts/driver.js';
import type { SlackEvent, SlackResult, SlackTransport } from './transport.js';

/** Slack's limit for one markdown block is 12,000 characters; stay under it. */
const MAX_BLOCK = 11_000;

/**
 * The Slack channel driver. One driver is one Slack app (an install-level
 * connection), shared by every workspace that binds channels on it.
 */
export class SlackChannel implements ChannelDriver {
  readonly kind = 'channel' as const;
  readonly name = 'slack';
  readonly capabilities: ChannelCapabilities = {
    threads: true,
    buttons: false,
    reactions: true,
    identities: true,
  };
  private readonly transport: SlackTransport;
  private handler: InboundHandler | undefined;
  private started = false;
  private botUserId: string | undefined;
  private readonly channelIds = new Map<string, string>();

  constructor(transport: SlackTransport) {
    this.transport = transport;
  }

  async check(): Promise<HealthCheck[]> {
    try {
      const auth = await this.transport.call('auth.test', {});
      return [
        {
          name: 'Slack',
          status: 'pass',
          message: `Signed in as ${String(auth.user)} in ${String(auth.team)}`,
        },
      ];
    } catch (error) {
      return [
        {
          name: 'Slack',
          status: 'fail',
          message: `Slack refused the bot token: ${slackError(error)}`,
          hint: 'Run opinr setup to enter the Slack tokens again.',
        },
      ];
    }
  }

  async start(handler: InboundHandler): Promise<void> {
    if (this.started) throw new DriverError(this.name, 'invalid', 'Already started');
    this.started = true;
    this.handler = handler;
    try {
      const auth = await this.transport.call('auth.test', {});
      this.botUserId = typeof auth.user_id === 'string' ? auth.user_id : undefined;
      await this.transport.start((event) => this.onEvent(event));
    } catch (error) {
      this.started = false;
      this.handler = undefined;
      throw this.toDriverError(error, 'Could not connect to Slack');
    }
  }

  async send(message: OutboundMessage): Promise<SentMessage> {
    if (message.buttons && message.buttons.length > 0) {
      throw new DriverError(
        this.name,
        'unsupported',
        'Buttons arrive in a later version of the Slack driver',
      );
    }
    const identity = message.identity
      ? {
          username: message.identity.name,
          ...(message.identity.icon?.startsWith(':') === true
            ? { icon_emoji: message.identity.icon }
            : message.identity.icon !== undefined
              ? { icon_url: message.identity.icon }
              : {}),
        }
      : {};
    let first: SlackResult | undefined;
    for (const chunk of chunks(message.text, MAX_BLOCK)) {
      try {
        const result = await this.transport.call('chat.postMessage', {
          channel: message.channel,
          text: chunk,
          blocks: [{ type: 'markdown', text: chunk }],
          ...(message.threadId !== undefined && { thread_ts: message.threadId }),
          ...identity,
          unfurl_links: false,
        });
        first ??= result;
      } catch (error) {
        throw this.toDriverError(error, 'Slack did not take the message');
      }
    }
    return {
      channel: typeof first?.channel === 'string' ? first.channel : message.channel,
      messageId: String(first?.ts),
      threadId: message.threadId ?? null,
    };
  }

  async react(message: MessageRef, reaction: string, on: boolean): Promise<void> {
    try {
      await this.transport.call(on ? 'reactions.add' : 'reactions.remove', {
        channel: message.channel,
        timestamp: message.messageId,
        name: reaction,
      });
    } catch (error) {
      const code = slackError(error);
      if (code === 'already_reacted' || code === 'no_reaction') return;
      throw this.toDriverError(error, 'Slack did not take the reaction');
    }
  }

  /**
   * The id of a channel given by name (`personal-chat` or `#personal-chat`) or id.
   * Returns null when the bot cannot see a channel by that name.
   */
  async resolveChannel(nameOrId: string): Promise<string | null> {
    const name = nameOrId.replace(/^#/, '');
    if (/^[CGD][A-Z0-9]{6,}$/.test(name)) return name;
    const known = this.channelIds.get(name);
    if (known !== undefined) return known;
    let cursor: string | undefined;
    do {
      const page = await this.transport.call('conversations.list', {
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit: 200,
        ...(cursor !== undefined && { cursor }),
      });
      for (const channel of (page.channels as { id: string; name: string }[] | undefined) ?? []) {
        this.channelIds.set(channel.name, channel.id);
      }
      const next = (page.response_metadata as { next_cursor?: string } | undefined)?.next_cursor;
      cursor = next !== undefined && next !== '' ? next : undefined;
    } while (cursor !== undefined && !this.channelIds.has(name));
    return this.channelIds.get(name) ?? null;
  }

  async stop(): Promise<void> {
    this.handler = undefined;
    if (!this.started) return;
    this.started = false;
    await this.transport.stop();
  }

  private async onEvent(event: SlackEvent): Promise<void> {
    const handler = this.handler;
    if (!handler || event.type !== 'message') return;
    // Edits, deletions, joins and bot posts arrive as subtypes; only plain messages count.
    if (typeof event.subtype === 'string') return;
    if (typeof event.bot_id === 'string' || event.user === this.botUserId) return;
    if (
      typeof event.user !== 'string' ||
      typeof event.ts !== 'string' ||
      typeof event.channel !== 'string'
    ) {
      return;
    }
    const threadTs =
      typeof event.thread_ts === 'string' && event.thread_ts !== event.ts ? event.thread_ts : null;
    await handler({
      type: 'message',
      channel: event.channel,
      messageId: event.ts,
      threadId: threadTs,
      userId: event.user,
      text: typeof event.text === 'string' ? event.text : '',
      direct: event.channel_type === 'im',
      receivedAt: new Date(Number.parseFloat(event.ts) * 1000),
    });
  }

  private toDriverError(error: unknown, what: string): DriverError {
    const code = slackError(error);
    const kind =
      code === 'channel_not_found' || code === 'thread_not_found' || code === 'message_not_found'
        ? 'not_found'
        : code === 'invalid_auth' ||
            code === 'not_authed' ||
            code === 'account_inactive' ||
            code === 'token_revoked'
          ? 'unavailable'
          : 'failed';
    return new DriverError(this.name, kind, `${what}: ${code}`, { cause: error });
  }
}

/** Slack's error code from a Web API error, or the error's message. */
export function slackError(error: unknown): string {
  const data = (error as { data?: { error?: unknown } } | undefined)?.data;
  if (typeof data?.error === 'string') return data.error;
  return error instanceof Error ? error.message : String(error);
}

function chunks(text: string, size: number): string[] {
  if (text.length <= size) return [text.length > 0 ? text : ' '];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > size) {
    // Prefer breaking at a paragraph, then a line, then anywhere.
    const paragraph = rest.lastIndexOf('\n\n', size);
    const line = rest.lastIndexOf('\n', size);
    const at = paragraph > size / 2 ? paragraph : line > size / 2 ? line : size;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n+/, '');
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}
