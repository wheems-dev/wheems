import type { Driver, HealthCheck } from './driver.js';

/**
 * The channel contract: sends and receives messages, buttons and threads.
 * Version one ships Slack (milestone 1) and Telegram and email (milestone 9).
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

  /**
   * Adds (`on: true`) or removes a reaction on a message, such as `eyes`.
   * Throws `DriverError` `unsupported` on a driver without reactions.
   */
  react(message: MessageRef, reaction: string, on: boolean): Promise<void>;

  /** Disconnects. No handler calls happen after it resolves. Safe to call twice. */
  stop(): Promise<void>;

  /**
   * Optional: a channel's id from its name (or its id), or null when the app can't see it.
   * Drivers without it take channel names as ids.
   */
  resolveChannel?(nameOrId: string): Promise<string | null>;

  /**
   * Optional: whether the app is a member of a channel, so messages there reach it. Null when it
   * can't tell. Seeing a channel isn't enough: Slack lists public channels the app isn't in.
   */
  isMember?(channelId: string): Promise<boolean | null>;
}

export interface MessageRef {
  channel: string;
  messageId: string;
}

export interface ChannelCapabilities {
  /** Replies can be kept in threads. */
  threads: boolean;
  /** Messages can carry buttons whose presses come back as inbound events. */
  buttons: boolean;
  /** Messages can be marked with reactions, such as one that says the agent is on it. */
  reactions: boolean;
  /** Posts can carry a per-workspace name and icon. Drivers without it ignore `identity`. */
  identities: boolean;
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
  /** True for a direct message between the person and the bot. */
  direct: boolean;
  receivedAt: Date;
  /** Files attached to it, by name. Wheems can't pass their contents on yet. */
  files?: { name: string }[];
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
  /** Who the post appears to be from, on drivers with `identities`. */
  identity?: Identity;
}

export interface Identity {
  name: string;
  /** An emoji such as `:robot_face:`, or an image URL. */
  icon?: string;
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
