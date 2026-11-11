import type {
  ChannelCapabilities,
  ChannelDriver,
  InboundHandler,
  OutboundMessage,
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
  private handler: InboundHandler | undefined;
  private nextId = 1;

  constructor(capabilities: Partial<ChannelCapabilities> = {}) {
    this.capabilities = { threads: true, buttons: true, ...capabilities };
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
  }): Promise<string> {
    const messageId = this.id();
    await this.handler?.({
      type: 'message',
      channel: message.channel,
      messageId,
      threadId: message.threadId ?? null,
      userId: message.userId ?? 'person',
      text: message.text,
      receivedAt: new Date(),
    });
    return messageId;
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
