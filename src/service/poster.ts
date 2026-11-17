/**
 * Posts from a workspace's chief that aren't answers to a message: approvals waiting on the
 * person, their outcome, and one-way updates (`wheems chat post`). Every post is in the chief's
 * name, in the chief's own chat thread when the work came from one, or else to a named channel.
 */
import type { LoadedWorkspace } from '../config/load.js';
import type { InstallConfig } from '../config/schemas.js';
import type { Button, ChannelDriver, MessageRef, OutboundMessage } from '../contracts/channel.js';
import type { StateStore } from '../state/store.js';
import type { Binding } from './conversations.js';

/** Where a post went. */
export interface Posted {
  connection: string;
  channel: string;
  /** The thread it's in, or null when it started none. */
  thread: string | null;
  message: string;
}

/** What to post. */
export interface Post {
  text: string;
  buttons?: Button[];
  /** Mention the person, so their phone buzzes. */
  mention?: boolean;
}

export interface ChatPosterOptions {
  install: InstallConfig;
  /** The service's bindings: the same array the service keeps up to date. */
  bindings: readonly Binding[];
  channels: Map<string, ChannelDriver>;
  state: StateStore;
  log?: (message: string) => void;
}

export class ChatPoster {
  private readonly log: (message: string) => void;

  constructor(private readonly options: ChatPosterOptions) {
    this.log = options.log ?? (() => undefined);
  }

  /**
   * Posts in a chief's chat thread, by its session's id, as the chief. Null when that session
   * has no thread, or its connection isn't running.
   */
  async inThread(
    workspace: LoadedWorkspace,
    sessionId: string,
    post: Post,
  ): Promise<Posted | null> {
    const key = this.options.state.threadKeyOf(sessionId);
    const thread = key === undefined ? undefined : this.options.state.conversation(key);
    if (!thread || thread.workspace !== workspace.id) return null;
    const channel = this.options.channels.get(thread.connection);
    if (!channel) return null;
    const sent = await channel.send(
      this.message(
        workspace,
        channel,
        thread.connection,
        {
          channel: thread.channel,
          threadId: thread.thread,
        },
        post,
      ),
    );
    this.options.state.workspace(workspace.id).addChat({
      session: sessionId,
      author: 'agent',
      text: post.text,
      at: new Date().toISOString(),
    });
    return {
      connection: thread.connection,
      channel: sent.channel,
      thread: thread.thread,
      message: sent.messageId,
    };
  }

  /**
   * Posts to one of a workspace's named channels, such as `approvals` or `updates`, as a new
   * top-level post. Without that channel in workspace.yaml, it goes to the workspace's chat
   * channel instead; any other name must be in workspace.yaml.
   */
  async toChannel(workspace: LoadedWorkspace, name: string, post: Post): Promise<Posted> {
    const target = await this.channelFor(workspace, name);
    const channel = this.options.channels.get(target.connection);
    if (!channel) throw new Error(`The ${target.connection} connection isn't running`);
    const sent = await channel.send(
      this.message(workspace, channel, target.connection, { channel: target.channel }, post),
    );
    return {
      connection: target.connection,
      channel: sent.channel,
      thread: null,
      message: sent.messageId,
    };
  }

  /**
   * Changes a post in place, buttons and all. A driver that can't change posts gets a reply
   * under it instead, saying the same.
   */
  async update(workspace: LoadedWorkspace, posted: Posted, post: Post): Promise<void> {
    const channel = this.options.channels.get(posted.connection);
    if (!channel) throw new Error(`The ${posted.connection} connection isn't running`);
    const ref: MessageRef = { channel: posted.channel, messageId: posted.message };
    const identity = workspace.config?.identity;
    if (channel.update) {
      await channel.update(ref, {
        text: post.text,
        ...(post.buttons !== undefined &&
          channel.capabilities.buttons && { buttons: post.buttons }),
        ...(identity && channel.capabilities.identities && { identity }),
      });
      return;
    }
    await channel.send(
      this.message(
        workspace,
        channel,
        posted.connection,
        {
          channel: posted.channel,
          ...(channel.capabilities.threads && { threadId: posted.thread ?? posted.message }),
        },
        { text: post.text },
      ),
    );
  }

  /** Whether a connection's channel shows buttons. */
  hasButtons(connection: string): boolean {
    return this.options.channels.get(connection)?.capabilities.buttons === true;
  }

  /** The people a connection lets talk to agents: who's mentioned, and whose presses count. */
  people(connection: string): string[] {
    return this.options.install.connections[connection]?.allowed_users ?? [];
  }

  private message(
    workspace: LoadedWorkspace,
    channel: ChannelDriver,
    connection: string,
    where: { channel: string; threadId?: string },
    post: Post,
  ): OutboundMessage {
    const identity = workspace.config?.identity;
    const people = post.mention === true ? this.people(connection) : [];
    return {
      ...where,
      text: post.text,
      ...(post.buttons !== undefined &&
        post.buttons.length > 0 &&
        channel.capabilities.buttons && { buttons: post.buttons }),
      ...(identity && channel.capabilities.identities && { identity }),
      ...(people.length > 0 && { mentions: people }),
    };
  }

  /** The connection and channel id a named channel posts to. */
  private async channelFor(
    workspace: LoadedWorkspace,
    name: string,
  ): Promise<{ connection: string; channel: string }> {
    const config = workspace.config;
    if (!config)
      throw new Error(`Workspace ${workspace.id} has config problems; run wheems doctor`);
    const named = config.channels[name];
    if (named) {
      const channel = this.options.channels.get(named.connection);
      if (!channel) throw new Error(`The ${named.connection} connection isn't running`);
      if ('direct' in named)
        return {
          connection: named.connection,
          channel: await this.direct(channel, named.connection),
        };
      const id =
        (await channel.resolveChannel?.(named.channel)) ??
        (channel.resolveChannel ? null : named.channel);
      if (id === null) {
        throw new Error(
          `The app can't see ${named.channel}, the ${name} channel in workspace.yaml`,
        );
      }
      return { connection: named.connection, channel: id };
    }
    if (name !== 'approvals' && name !== 'updates' && name !== 'chat') {
      throw new Error(
        `Workspace ${workspace.id} has no ${name} channel. Name one under channels: in workspace.yaml, or post to updates.`,
      );
    }
    const binding = this.options.bindings.find((b) => b.workspace.id === workspace.id);
    if (!binding) throw new Error(`Workspace ${workspace.id} has no chat channel running`);
    const channel = this.options.channels.get(binding.connection);
    if (!channel) throw new Error(`The ${binding.connection} connection isn't running`);
    if (binding.channel !== null)
      return { connection: binding.connection, channel: binding.channel };
    return {
      connection: binding.connection,
      channel: await this.direct(channel, binding.connection),
    };
  }

  /** The direct messages with the connection's person. */
  private async direct(channel: ChannelDriver, connection: string): Promise<string> {
    const person = this.people(connection)[0];
    if (person === undefined || !channel.openDirect) {
      throw new Error(`There's no one on ${connection} to send direct messages to`);
    }
    try {
      return await channel.openDirect(person);
    } catch (error) {
      this.log(`Couldn't open direct messages on ${connection}: ${String(error)}`);
      throw error;
    }
  }
}
