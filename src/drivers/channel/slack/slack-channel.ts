import type {
  ButtonPress,
  LookupOptions,
  ChannelCapabilities,
  ChannelDriver,
  InboundHandler,
  Button,
  MessageRef,
  OutboundMessage,
  PostChange,
  SentMessage,
} from '../../../contracts/channel.js';
import { DriverError, type HealthCheck } from '../../../contracts/driver.js';
import { noAnswer, type SlackEvent, type SlackResult, type SlackTransport } from './transport.js';

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
    buttons: true,
    reactions: true,
    identities: true,
    joins: true,
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
      const auth = await this.transport.call('auth.test', {}, { quick: true });
      return [
        {
          name: 'Slack',
          status: 'pass',
          message: `Signed in as ${String(auth.user)} in ${String(auth.team)}`,
        },
      ];
    } catch (error) {
      const why = noAnswer(error);
      if (why !== null) return [{ name: 'Slack', status: 'fail', ...why }];
      return [
        {
          name: 'Slack',
          status: 'fail',
          message: `Slack refused the bot token: ${slackError(error)}`,
          hint: 'Run wheems setup to enter the Slack tokens again.',
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
    const parts = chunks(message.text, MAX_BLOCK);
    const mentions = (message.mentions ?? []).map((id) => `<@${id}>`).join(' ');
    for (const [index, chunk] of parts.entries()) {
      // Mentions and buttons go with the last part, under the whole text.
      const last = index === parts.length - 1;
      try {
        const result = await this.transport.call('chat.postMessage', {
          channel: message.channel,
          // What a notification shows: the mention first, so it says who it's for.
          text: last && mentions !== '' ? `${mentions} ${chunk}` : chunk,
          blocks: blocksFor(chunk, last ? message.buttons : undefined, last ? mentions : ''),
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

  /** Changes a message the app posted: its text, and its buttons (none removes them). */
  async update(message: MessageRef, change: PostChange): Promise<void> {
    const text =
      change.text.length > MAX_BLOCK ? `${change.text.slice(0, MAX_BLOCK)}…` : change.text;
    try {
      await this.transport.call('chat.update', {
        channel: message.channel,
        ts: message.messageId,
        text,
        blocks: blocksFor(text, change.buttons, ''),
      });
    } catch (error) {
      throw this.toDriverError(error, 'Slack did not change the message');
    }
  }

  /**
   * The id of a channel given by name (`acme-chat` or `#acme-chat`) or id.
   * Returns null when the bot cannot see a channel by that name.
   */
  async resolveChannel(nameOrId: string, options?: LookupOptions): Promise<string | null> {
    const name = nameOrId.replace(/^#/, '');
    if (/^[CGD][A-Z0-9]{6,}$/.test(name)) return name;
    const known = this.channelIds.get(name);
    if (known !== undefined) return known;
    let cursor: string | undefined;
    do {
      const page = await this.transport.call(
        'conversations.list',
        {
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          ...(cursor !== undefined && { cursor }),
        },
        options,
      );
      for (const channel of (page.channels as { id: string; name: string }[] | undefined) ?? []) {
        this.channelIds.set(channel.name, channel.id);
      }
      const next = (page.response_metadata as { next_cursor?: string } | undefined)?.next_cursor;
      cursor = next !== undefined && next !== '' ? next : undefined;
    } while (cursor !== undefined && !this.channelIds.has(name));
    return this.channelIds.get(name) ?? null;
  }

  async openDirect(userId: string): Promise<string> {
    try {
      const result = await this.transport.call('conversations.open', { users: userId });
      const id = (result.channel as { id?: unknown } | undefined)?.id;
      if (typeof id !== 'string') throw new Error('Slack returned no channel');
      return id;
    } catch (error) {
      throw this.toDriverError(error, `Could not open direct messages with ${userId}`);
    }
  }

  async listChannels(options?: LookupOptions): Promise<{ id: string; name: string }[]> {
    const found: { id: string; name: string }[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.transport.call(
        'conversations.list',
        {
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          ...(cursor !== undefined && { cursor }),
        },
        options,
      );
      for (const channel of (page.channels as { id: string; name: string }[] | undefined) ?? []) {
        this.channelIds.set(channel.name, channel.id);
        found.push({ id: channel.id, name: channel.name });
      }
      const next = (page.response_metadata as { next_cursor?: string } | undefined)?.next_cursor;
      cursor = next !== undefined && next !== '' ? next : undefined;
    } while (cursor !== undefined);
    return found;
  }

  async channelName(channelId: string): Promise<string | null> {
    try {
      const info = await this.transport.call('conversations.info', { channel: channelId });
      const name = (info.channel as { name?: unknown } | undefined)?.name;
      if (typeof name !== 'string') return null;
      this.channelIds.set(name, channelId);
      return name;
    } catch {
      return null;
    }
  }

  async isMember(channelId: string, options?: LookupOptions): Promise<boolean | null> {
    try {
      const info = await this.transport.call('conversations.info', { channel: channelId }, options);
      const member = (info.channel as { is_member?: unknown } | undefined)?.is_member;
      return typeof member === 'boolean' ? member : null;
    } catch {
      return null;
    }
  }

  async stop(): Promise<void> {
    this.handler = undefined;
    if (!this.started) return;
    this.started = false;
    await this.transport.stop();
  }

  private async onEvent(event: SlackEvent): Promise<void> {
    const handler = this.handler;
    if (!handler) return;
    // A press of a button on one of the app's posts, from an interactive envelope.
    if (event.type === 'block_actions') {
      const press = buttonPress(event);
      if (press) await handler(press);
      return;
    }
    // The app was added to a channel: member_joined_channel (needs that bot event), or the
    // channel_join message Slack also posts, for apps that only get message events.
    const joined =
      event.type === 'member_joined_channel' ||
      (event.type === 'message' && event.subtype === 'channel_join');
    if (joined) {
      if (event.user !== this.botUserId || typeof event.channel !== 'string') return;
      await handler({
        type: 'joined',
        channel: event.channel,
        userId: typeof event.inviter === 'string' ? event.inviter : null,
        receivedAt: new Date(),
      });
      return;
    }
    if (event.type !== 'message') return;
    // Edits, deletions, joins and bot posts arrive as subtypes; only plain messages, and
    // messages with files attached, count.
    if (typeof event.subtype === 'string' && event.subtype !== 'file_share') return;
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
      text: typeof event.text === 'string' ? this.withoutLeadingMention(event.text) : '',
      direct: event.channel_type === 'im',
      receivedAt: new Date(Number.parseFloat(event.ts) * 1000),
      ...(Array.isArray(event.files) &&
        event.files.length > 0 && { files: fileNames(event.files) }),
    });
  }

  /** "@Wheems Marketing" reads as "Marketing": a mention of the app that starts a message. */
  private withoutLeadingMention(text: string): string {
    if (this.botUserId === undefined) return text;
    const mention = `<@${this.botUserId}>`;
    const trimmed = text.trimStart();
    return trimmed.startsWith(mention) ? trimmed.slice(mention.length).trimStart() : text;
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

/** The names of the files on a Slack message. */
function fileNames(files: unknown[]): { name: string }[] {
  return files.map((file) => {
    const f = (file ?? {}) as { name?: unknown; title?: unknown };
    const name =
      typeof f.name === 'string' ? f.name : typeof f.title === 'string' ? f.title : 'a file';
    return { name };
  });
}

/**
 * A post's blocks: its Markdown, then any mentions, then any buttons. Slack's markdown block
 * doesn't notify for mentions, so they go in a section of their own.
 */
function blocksFor(
  text: string,
  buttons: Button[] | undefined,
  mentions: string,
): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [{ type: 'markdown', text }];
  if (mentions !== '') blocks.push({ type: 'section', text: { type: 'mrkdwn', text: mentions } });
  if (buttons !== undefined && buttons.length > 0) {
    blocks.push({
      type: 'actions',
      elements: buttons.map((button) => ({
        type: 'button',
        action_id: button.id,
        value: button.id,
        text: { type: 'plain_text', text: button.label.slice(0, 75) },
        ...(button.style !== undefined && { style: button.style }),
      })),
    });
  }
  return blocks;
}

/** A button press from a `block_actions` payload, or null when it isn't one Wheems can read. */
function buttonPress(payload: SlackEvent): ButtonPress | null {
  const user = (payload.user as { id?: unknown } | undefined)?.id;
  const container = (payload.container ?? {}) as {
    channel_id?: unknown;
    message_ts?: unknown;
    thread_ts?: unknown;
  };
  const message = (payload.message ?? {}) as { ts?: unknown; thread_ts?: unknown };
  const channel = (payload.channel as { id?: unknown } | undefined)?.id ?? container.channel_id;
  const ts = message.ts ?? container.message_ts;
  const action = (payload.actions as { action_id?: unknown }[] | undefined)?.[0];
  if (
    typeof user !== 'string' ||
    typeof channel !== 'string' ||
    typeof ts !== 'string' ||
    typeof action?.action_id !== 'string'
  ) {
    return null;
  }
  const thread = message.thread_ts ?? container.thread_ts;
  return {
    type: 'button',
    channel,
    messageId: ts,
    threadId: typeof thread === 'string' && thread !== ts ? thread : null,
    userId: user,
    buttonId: action.action_id,
    receivedAt: new Date(),
  };
}
