import type { Driver, HealthCheck } from './driver.js';

/**
 * The channel contract: sends and receives messages, buttons and threads.
 * Version one ships Slack (milestone 1) and Telegram (milestone 8).
 *
 * A channel driver holds one connection, such as one Slack app. Channels inside
 * it are addressed by the driver's own channel id.
 */
export interface ChannelDriver extends Driver<'channel'> {
  readonly capabilities: ChannelCapabilities;

  /** Health checks for doctor: are the credentials present and does the service answer. */
  check(): Promise<HealthCheck[]>;

  /**
   * Connects and starts delivering inbound messages and button presses to the handler.
   * Calling it again while started throws `DriverError` `invalid`.
   */
  start(handler: InboundHandler): Promise<void>;

  /**
   * Sends a message. With `threadId` it replies in that thread. With buttons on a
   * driver without button support it throws `DriverError` `unsupported`.
   */
  send(message: OutboundMessage): Promise<SentMessage>;

  /** Disconnects. No handler calls happen after it resolves. Safe to call twice. */
  stop(): Promise<void>;
}

export interface ChannelCapabilities {
  /** Replies can be kept in threads. */
  threads: boolean;
  /** Messages can carry buttons whose presses come back as inbound events. */
  buttons: boolean;
}

export type InboundHandler = (event: InboundEvent) => void | Promise<void>;

export type InboundEvent = InboundMessage | ButtonPress;

export interface InboundMessage {
  type: 'message';
  channel: string;
  messageId: string;
  /** The thread the message is in. A message that starts a thread has none. */
  threadId: string | null;
  /** The driver's id for the person who wrote it. */
  userId: string;
  text: string;
  receivedAt: Date;
}

export interface ButtonPress {
  type: 'button';
  channel: string;
  /** The message that carried the button. */
  messageId: string;
  threadId: string | null;
  userId: string;
  /** The `id` the button was sent with. */
  buttonId: string;
  receivedAt: Date;
}

export interface OutboundMessage {
  channel: string;
  /** Reply in this thread. */
  threadId?: string;
  text: string;
  buttons?: Button[];
}

export interface Button {
  id: string;
  label: string;
  style?: 'primary' | 'danger';
}

export interface SentMessage {
  channel: string;
  messageId: string;
  /** The thread the message landed in, or `null` when it started none. */
  threadId: string | null;
}

/** The thread to reply in to keep a conversation together. */
export function replyThread(event: InboundEvent): string {
  return event.threadId ?? event.messageId;
}
