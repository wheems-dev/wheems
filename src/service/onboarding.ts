import type { LoadedWorkspace } from '../config/load.js';
import { nameSchema, type InstallConfig } from '../config/schemas.js';
import {
  replyThread,
  type ChannelDriver,
  type InboundEvent,
  type InboundMessage,
} from '../contracts/channel.js';
import type { Binding } from './conversations.js';

/** A workspace whose channel the app couldn't see when the service started. */
export interface WaitingWorkspace {
  workspace: LoadedWorkspace;
  connection: string;
  /** The channel as workspace.yaml names it. */
  channel: string;
}

/** What setting up a channel needs: a new workspace with its chief, bound to the channel. */
export interface NewChannelWorkspace {
  connection: string;
  channelId: string;
  /** The channel's name, when the driver can tell, to write in workspace.yaml. */
  channelName: string | null;
  id: string;
  name: string;
}

export interface OnboardingOptions {
  install: InstallConfig;
  channels: Map<string, ChannelDriver>;
  /** The conversation manager's bindings: whatever is added here is answered at once. */
  bindings: Binding[];
  /** Every workspace the service runs, to tell whether a name is taken. */
  workspaces: LoadedWorkspace[];
  waiting: WaitingWorkspace[];
  /** Creates the workspace and its chief, as `wheems init <id> --channel`, and loads it. */
  create: (request: NewChannelWorkspace) => Promise<LoadedWorkspace>;
  /** Called once a workspace is bound to a channel while the service runs. */
  bound: (binding: Binding) => void;
  /** Hands an event on to the conversation manager. */
  deliver: (connection: string, event: InboundEvent) => Promise<void>;
  log?: (message: string) => void;
}

interface Offer {
  /** The thread a name may be given in. */
  thread: string | null;
}

/**
 * Setting Wheems up by inviting it to a channel. Channel-agnostic: a driver only reports the
 * app being added to a channel (`joined`, on drivers with `joins`) and passes on messages from
 * channels no workspace uses; everything else happens here.
 *
 * - A workspace whose configured channel the app couldn't see is bound as soon as the app is
 *   in it, and answers there from then on.
 * - In a channel no workspace uses, an allowed user (and only one) is offered a chief of staff,
 *   once per channel. They reply with a name, and the workspace is created and bound there, with
 *   no restart.
 */
export class Onboarding {
  private readonly options: Required<OnboardingOptions>;
  private readonly offers = new Map<string, Offer>();
  /** Channels already checked against the waiting workspaces, outside a join. */
  private readonly checked = new Set<string>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(options: OnboardingOptions) {
    this.options = { log: () => undefined, ...options };
  }

  /** Takes every inbound event: those for bound channels and direct messages go straight on. */
  handle(connection: string, event: InboundEvent): Promise<void> {
    if (event.type === 'button') return this.options.deliver(connection, event);
    if (event.type === 'message' && event.direct) return this.options.deliver(connection, event);
    if (this.isBound(connection, event.channel)) {
      return event.type === 'joined' ? Promise.resolve() : this.options.deliver(connection, event);
    }
    // One event at a time per channel, so a name and a second offer can't cross.
    const key = `${connection}:${event.channel}`;
    const next = (this.queues.get(key) ?? Promise.resolve())
      .then(() => this.unbound(connection, event))
      .catch((error: unknown) => {
        this.options.log(`Setting up ${key}: ${describe(error)}`);
      });
    this.queues.set(key, next);
    return next;
  }

  private async unbound(connection: string, event: InboundEvent): Promise<void> {
    if (event.type === 'button') return;
    const channel = event.channel;
    // Bound meanwhile, by an earlier event in this channel's queue.
    if (this.isBound(connection, channel)) {
      if (event.type === 'message') await this.options.deliver(connection, event);
      return;
    }
    // A workspace configured for this channel takes it, whoever added the app.
    const waiting = await this.waitingFor(connection, channel, event.type === 'joined');
    if (waiting) {
      this.bind({ workspace: waiting.workspace, connection, channel });
      this.options.log(`Workspace ${waiting.workspace.id}: now in ${channel} on ${connection}`);
      if (event.type === 'joined') {
        await this.say(
          connection,
          channel,
          null,
          `${waiting.workspace.config?.name ?? waiting.workspace.id}'s chief of staff is here. Start a thread with what you need.`,
          waiting.workspace,
        );
      } else {
        await this.options.deliver(connection, event);
      }
      return;
    }

    const allowed = this.options.install.connections[connection]?.allowed_users ?? [];
    if (event.userId === null || !allowed.includes(event.userId)) {
      this.options.log(
        `Ignored ${event.type === 'joined' ? 'being added to' : 'a message in'} ${channel} on ${connection}${event.userId !== null ? ` from ${event.userId}, who is not in allowed_users` : ''}: no workspace uses it`,
      );
      return;
    }
    const key = `${connection}:${channel}`;
    const offer = this.offers.get(key);
    if (event.type === 'joined') {
      if (!offer) await this.offer(connection, channel, null);
      return;
    }
    if (!offer) {
      await this.offer(connection, channel, replyThread(event));
      return;
    }
    await this.named(connection, event, offer);
  }

  /** Offers a chief of staff in a channel, once. */
  private async offer(connection: string, channel: string, thread: string | null): Promise<void> {
    const key = `${connection}:${channel}`;
    const driver = this.driver(connection);
    const inThread = driver.capabilities.threads;
    const sent = await this.say(
      connection,
      channel,
      thread,
      `I'm not set up in this channel yet. ${inThread ? 'Reply in this thread' : 'Reply'} with a name for its workspace, such as *Marketing*, and I'll set up a chief of staff that answers here.`,
    );
    this.offers.set(key, { thread: thread ?? (inThread ? sent : null) });
    this.options.log(`Offered to set up ${channel} on ${connection}`);
  }

  /** A message after the offer: a name, given in the offer's thread or on its own. */
  private async named(connection: string, event: InboundMessage, offer: Offer): Promise<void> {
    const inThread = offer.thread !== null && event.threadId === offer.thread;
    // Elsewhere in the channel, only a message that's just a name counts; the rest is chatter.
    if (!inThread && event.threadId !== null) return;
    const thread = inThread ? offer.thread : replyThread(event);
    const parsed = workspaceName(event.text);
    if (!parsed) {
      if (inThread) {
        await this.say(
          connection,
          event.channel,
          thread,
          "That doesn't look like a name. Reply with a short one, such as *Marketing* or *Acme UK*: up to four words, with letters and digits.",
        );
      }
      return;
    }
    if (this.options.workspaces.some((w) => w.id === parsed.id)) {
      await this.say(
        connection,
        event.channel,
        thread,
        `There's already a workspace called ${parsed.id}. Reply with another name.`,
      );
      return;
    }
    const driver = this.driver(connection);
    const channelName = (await driver.channelName?.(event.channel).catch(() => null)) ?? null;
    let workspace: LoadedWorkspace;
    try {
      workspace = await this.options.create({
        connection,
        channelId: event.channel,
        channelName,
        id: parsed.id,
        name: parsed.name,
      });
    } catch (error) {
      await this.say(
        connection,
        event.channel,
        thread,
        `I couldn't set up ${parsed.name}: ${describe(error)}`,
      );
      throw error;
    }
    this.offers.delete(`${connection}:${event.channel}`);
    this.bind({ workspace, connection, channel: event.channel });
    this.options.log(`Set up workspace ${workspace.id} in ${event.channel} on ${connection}`);
    await this.say(
      connection,
      event.channel,
      thread,
      `Done: ${parsed.name} is set up, in \`workspaces/${parsed.id}\`, and its chief of staff answers in this channel from now on. Start a thread with what you need.`,
      workspace,
    );
  }

  /**
   * The waiting workspace configured for this channel, if there is one. Checked on every join,
   * and otherwise once per channel, since it asks the driver.
   */
  private async waitingFor(
    connection: string,
    channel: string,
    joined: boolean,
  ): Promise<WaitingWorkspace | undefined> {
    const candidates = this.options.waiting.filter((w) => w.connection === connection);
    if (candidates.length === 0) return undefined;
    const key = `${connection}:${channel}`;
    if (!joined && this.checked.has(key)) return undefined;
    this.checked.add(key);
    const driver = this.driver(connection);
    const name = (await driver.channelName?.(channel).catch(() => null)) ?? null;
    for (const candidate of candidates) {
      const wanted = candidate.channel.replace(/^#/, '');
      const matches =
        wanted === channel ||
        (name !== null && wanted === name) ||
        (name === null && (await driver.resolveChannel?.(wanted).catch(() => null)) === channel);
      if (matches) {
        this.options.waiting.splice(this.options.waiting.indexOf(candidate), 1);
        return candidate;
      }
    }
    return undefined;
  }

  private bind(binding: Binding): void {
    this.options.bindings.push(binding);
    this.options.bound(binding);
  }

  private isBound(connection: string, channel: string): boolean {
    return this.options.bindings.some((b) => b.connection === connection && b.channel === channel);
  }

  /** Posts in a channel, in a thread when given, as the workspace when given. Returns its id. */
  private async say(
    connection: string,
    channel: string,
    thread: string | null,
    text: string,
    workspace?: LoadedWorkspace,
  ): Promise<string> {
    const driver = this.driver(connection);
    const identity = workspace?.config?.identity;
    const sent = await driver.send({
      channel,
      text,
      ...(thread !== null && driver.capabilities.threads && { threadId: thread }),
      ...(identity && driver.capabilities.identities && { identity }),
    });
    return sent.messageId;
  }

  private driver(connection: string): ChannelDriver {
    const driver = this.options.channels.get(connection);
    if (!driver) throw new Error(`No connection ${connection}`);
    return driver;
  }
}

/**
 * A workspace's display name and id from what someone typed, such as `Marketing` (marketing)
 * or `Acme UK` (acme-uk). Null for anything that isn't a short name.
 */
export function workspaceName(text: string): { name: string; id: string } | null {
  const name = text
    .trim()
    .replace(/^["'“‘*_]+|["'”’*_.!]+$/gu, '')
    .trim();
  if (name === '' || name.length > 40 || /\s{2,}|\n/.test(name)) return null;
  if (!/^[\p{L}\p{N}][\p{L}\p{N} &'’-]*$/u.test(name)) return null;
  if (name.split(' ').length > 4) return null;
  const id = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  if (!nameSchema.safeParse(id).success) return null;
  return { name, id };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
