import type {
  ChannelCapabilities,
  ChannelDriver,
  InboundHandler,
  MessageRef,
  OutboundMessage,
  PostChange,
  SentMessage,
} from '../contracts/channel.js';
import { DriverError, type HealthCheck } from '../contracts/driver.js';

/**
 * A channel driver that keeps messages in memory. For testing code that sits
 * above the channel contract without Slack or Telegram.
 */
export class MemoryChannel implements ChannelDriver {
  readonly kind = 'channel' as const;
  readonly name = 'memory';
  readonly capabilities: ChannelCapabilities;
  /** Everything sent through the driver, oldest first. */
  readonly sent: (OutboundMessage & { messageId: string })[] = [];
  /** Every change to a sent message, oldest first. `sent` shows each message as it is now. */
  readonly updates: (PostChange & MessageRef)[] = [];
  /** Reactions currently on messages, as `<channel>/<messageId>` to reaction names. */
  readonly reactions = new Map<string, Set<string>>();
  private handler: InboundHandler | undefined;
  private nextId = 1;
  /** With `channels`: the channels the app can see, name to id. Without it, names are ids. */
  private readonly visible: Map<string, string> | undefined;
  resolveChannel?: (nameOrId: string) => Promise<string | null>;
  channelName?: (channelId: string) => Promise<string | null>;
  update?: (message: MessageRef, change: PostChange) => Promise<void>;

  constructor(
    capabilities: Partial<ChannelCapabilities> = {},
    options: { channels?: Record<string, string>; updates?: boolean } = {},
  ) {
    this.capabilities = {
      threads: true,
      buttons: true,
      reactions: true,
      identities: true,
      joins: true,
      ...capabilities,
    };
    if (options.updates !== false) {
      this.update = (message, change) => {
        const sent = this.sent.find(
          (m) => m.messageId === message.messageId && m.channel === message.channel,
        );
        if (!sent) {
          return Promise.reject(
            new DriverError(this.name, 'not_found', `No message ${message.messageId}`),
          );
        }
        sent.text = change.text;
        if (change.buttons !== undefined && change.buttons.length > 0) {
          sent.buttons = change.buttons;
        } else {
          delete sent.buttons;
        }
        this.updates.push({ ...change, ...message });
        return Promise.resolve();
      };
    }
    if (options.channels !== undefined) {
      const visible = new Map(Object.entries(options.channels));
      this.visible = visible;
      this.resolveChannel = (nameOrId) => {
        const name = nameOrId.replace(/^#/, '');
        if ([...visible.values()].includes(name)) return Promise.resolve(name);
        return Promise.resolve(visible.get(name) ?? null);
      };
      this.channelName = (channelId) =>
        Promise.resolve([...visible].find(([, id]) => id === channelId)?.[0] ?? null);
    }
  }

  check(): Promise<HealthCheck[]> {
    return Promise.resolve([
      { name: 'memory channel', status: 'pass', message: 'Messages are kept in memory' },
    ]);
  }

  start(handler: InboundHandler): Promise<void> {
    if (this.handler)
      return Promise.reject(new DriverError(this.name, 'invalid', 'Already started'));
    this.handler = handler;
    return Promise.resolve();
  }

  send(message: OutboundMessage): Promise<SentMessage> {
    if (message.buttons && message.buttons.length > 0 && !this.capabilities.buttons) {
      return Promise.reject(
        new DriverError(this.name, 'unsupported', 'This channel has no buttons'),
      );
    }
    if (message.threadId !== undefined && !this.capabilities.threads) {
      return Promise.reject(
        new DriverError(this.name, 'unsupported', 'This channel has no threads'),
      );
    }
    const messageId = this.id();
    this.sent.push({ ...message, messageId });
    return Promise.resolve({
      channel: message.channel,
      messageId,
      threadId: message.threadId ?? null,
    });
  }

  react(message: MessageRef, reaction: string, on: boolean): Promise<void> {
    if (!this.capabilities.reactions) {
      return Promise.reject(
        new DriverError(this.name, 'unsupported', 'This channel has no reactions'),
      );
    }
    const key = `${message.channel}/${message.messageId}`;
    const set = this.reactions.get(key) ?? new Set<string>();
    if (on) set.add(reaction);
    else set.delete(reaction);
    this.reactions.set(key, set);
    return Promise.resolve();
  }

  /** Direct messages with a person are the channel `D-<their id>`. */
  openDirect(userId: string): Promise<string> {
    return Promise.resolve(`D-${userId}`);
  }

  stop(): Promise<void> {
    this.handler = undefined;
    return Promise.resolve();
  }

  /** Delivers a message as if a person wrote it. Returns its id. */
  async receive(message: {
    channel: string;
    text: string;
    threadId?: string;
    userId?: string;
    direct?: boolean;
    files?: { name: string }[];
  }): Promise<string> {
    const messageId = this.id();
    await this.handler?.({
      type: 'message',
      channel: message.channel,
      messageId,
      threadId: message.threadId ?? null,
      userId: message.userId ?? 'person',
      text: message.text,
      direct: message.direct ?? false,
      receivedAt: new Date(),
      ...(message.files !== undefined && { files: message.files }),
    });
    return messageId;
  }

  /**
   * The app is added to a channel: it can see it from now on (by `name`, when given), and a
   * `joined` event is delivered, from `userId` (null when the driver wouldn't know who).
   */
  async join(
    channel: { id: string; name?: string },
    userId: string | null = 'person',
  ): Promise<void> {
    if (channel.name !== undefined) this.visible?.set(channel.name, channel.id);
    await this.handler?.({ type: 'joined', channel: channel.id, userId, receivedAt: new Date() });
  }

  /** Delivers a press of a button on a message the driver sent. */
  async press(press: {
    channel: string;
    messageId: string;
    buttonId: string;
    userId?: string;
  }): Promise<void> {
    const message = this.sent.find((m) => m.messageId === press.messageId);
    if (!message?.buttons?.some((b) => b.id === press.buttonId)) {
      throw new DriverError(
        this.name,
        'not_found',
        `No button "${press.buttonId}" on message ${press.messageId}`,
      );
    }
    await this.handler?.({
      type: 'button',
      channel: press.channel,
      messageId: press.messageId,
      threadId: message.threadId ?? null,
      userId: press.userId ?? 'person',
      buttonId: press.buttonId,
      receivedAt: new Date(),
    });
  }

  private id(): string {
    return String(this.nextId++);
  }
}
