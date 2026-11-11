import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { withBuiltins } from '../agents/builtin.js';
import type { LoadedWorkspace } from '../config/load.js';
import type { InstallConfig } from '../config/schemas.js';
import {
  replyThread,
  type ChannelDriver,
  type InboundEvent,
  type MessageRef,
} from '../contracts/channel.js';
import { isDriverError } from '../contracts/driver.js';
import type { EngineDriver, FinalMessage, LaunchPlan } from '../contracts/engine.js';
import type { RuntimeDriver, SessionInfo } from '../contracts/runtime.js';
import type { ConversationStore } from './store.js';

export interface Binding {
  workspace: LoadedWorkspace;
  connection: string;
  /** The channel's id, or null for the connection's direct messages. */
  channel: string | null;
}

export interface ConversationManagerOptions {
  install: InstallConfig;
  bindings: Binding[];
  channels: Map<string, ChannelDriver>;
  runtime: RuntimeDriver;
  engine: (name: string) => EngineDriver;
  store: ConversationStore;
  /** Environment every agent session gets, such as PATH with the `opinr` command first. */
  sessionEnv: Record<string, string>;
  /** Most live sessions per workspace; the least recently used idle ones are stopped. */
  maxLiveSessions?: number;
  /** Seconds a new session gets to start working before the person is told. */
  startupSeconds?: number;
  /** Milliseconds between checks while a session has not started its turn. */
  pollMs?: number;
  /**
   * Seconds to wait, after a turn ends with messages queued during it, for the agent to
   * start a turn on them.
   */
  followUpSeconds?: number;
  log?: (message: string) => void;
  writeFile?: (path: string, content: string) => Promise<void>;
}

interface Watch {
  sessionName: string;
  /** The engine's id for the conversation, and the folder its session runs in. */
  conversation: { id: string; dir: string };
  engine: EngineDriver;
  /** The turn the agent was on when the latest message went in. */
  fromTurn: number;
  /** When the first message of this turn went in. */
  sentAt: number;
  /** Messages marked as seen until the agent replies. */
  seen: MessageRef[];
  /** Messages that arrived while a turn was being followed. */
  queued: MessageRef[];
  /** Set the moment the watch decides to finish; later messages start a new watch. */
  closed: boolean;
}

/**
 * Routes chat messages to agent sessions: one conversation, and one engine
 * session, per chat thread. A thread's later messages go to the same session;
 * if that session has ended, the engine resumes the conversation in a new one.
 * Agents answer with `opinr reply`, which arrives here through `reply()`.
 */
export class ConversationManager {
  private readonly options: Required<Omit<ConversationManagerOptions, 'writeFile' | 'log'>> & {
    writeFile: (path: string, content: string) => Promise<void>;
    log: (message: string) => void;
  };
  private readonly queues = new Map<string, Promise<void>>();
  private readonly watches = new Map<string, Watch>();
  /** The latest `opinr reply` in each conversation. */
  private readonly lastReply = new Map<string, { at: number; text: string }>();
  private readonly watchers = new Set<Promise<void>>();
  private stopped = false;

  constructor(options: ConversationManagerOptions) {
    this.options = {
      maxLiveSessions: 4,
      startupSeconds: 90,
      pollMs: 1000,
      followUpSeconds: 15,
      log: () => undefined,
      writeFile: async (path, content) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
      },
      ...options,
    };
  }

  /** Handles one inbound event from a connection. Events for one thread are handled in order. */
  handle(connection: string, event: InboundEvent): Promise<void> {
    if (event.type !== 'message') return Promise.resolve();
    const allowed = this.options.install.connections[connection]?.allowed_users ?? [];
    if (!allowed.includes(event.userId)) {
      this.options.log(
        `Ignored a message on ${connection} from ${event.userId}, who is not in allowed_users`,
      );
      return Promise.resolve();
    }
    const binding = this.options.bindings.find(
      (b) =>
        b.connection === connection &&
        (b.channel === null ? event.direct : b.channel === event.channel),
    );
    if (!binding) return Promise.resolve();
    const key = conversationKey(
      binding.workspace.id,
      connection,
      event.channel,
      replyThread(event),
    );
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous
      .then(() => this.deliver(key, binding, event))
      .catch((error: unknown) => {
        this.options.log(`Conversation ${key}: ${describe(error)}`);
        return this.notice(
          key,
          binding,
          replyThread(event),
          `Something went wrong: ${describe(error)}`,
        );
      })
      .catch(() => undefined);
    this.queues.set(key, next);
    return next;
  }

  /** Posts an agent's reply (`opinr reply`) into its conversation's thread. */
  async reply(key: string, text: string): Promise<void> {
    await this.post(key, text);
    this.lastReply.set(key, { at: Date.now(), text: text.trim() });
  }

  private async post(key: string, text: string): Promise<void> {
    const conversation = await this.options.store.get(key);
    if (!conversation) throw new Error(`No conversation ${key}`);
    const channel = this.channel(conversation.connection);
    const workspace = this.options.bindings.find(
      (b) => b.workspace.id === conversation.workspace,
    )?.workspace;
    const identity = workspace?.config?.identity;
    await channel.send({
      channel: conversation.channel,
      threadId: conversation.thread,
      text,
      ...(identity && channel.capabilities.identities && { identity }),
    });
    await this.options.store.touch(key, new Date());
    const watch = this.watches.get(key);
    if (watch) {
      for (const message of watch.seen.splice(0)) await this.unmark(channel, message);
    }
  }

  /** Resolves once no turn is being followed. */
  async whenIdle(): Promise<void> {
    while (this.watchers.size > 0) await Promise.allSettled([...this.watchers]);
  }

  /** Stops watching sessions. Sessions themselves keep running. */
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.watchers]);
  }

  private async deliver(
    key: string,
    binding: Binding,
    event: InboundEvent & { type: 'message' },
  ): Promise<void> {
    const channel = this.channel(binding.connection);
    const seen = { channel: event.channel, messageId: event.messageId };
    if (channel.capabilities.reactions)
      await channel.react(seen, 'eyes', true).catch(() => undefined);

    const existing = await this.options.store.get(key);
    const sessionName = existing?.sessionName ?? sessionNameFor(binding.workspace.id, key);
    const session = await this.options.runtime.get(sessionName);
    const now = new Date();

    if (session?.state === 'live') {
      try {
        // Text sent to an agent that is still starting can be lost, and would arrive ahead
        // of the task it was started with; wait until it reports in.
        await this.untilReady(session.id);
        const sent = await this.options.runtime.send(session.id, event.text);
        await this.options.store.touch(key, now);
        this.watchTurn(
          key,
          binding,
          sessionName,
          sent.turn,
          seen,
          this.conversationFor(key, binding),
        );
      } catch (error) {
        if (!isDriverError(error, 'blocked')) throw error;
        await this.unmark(channel, seen);
        await this.notice(key, binding, replyThread(event), blockedText(session));
      }
      return;
    }

    if (session) await this.options.runtime.remove(session.id).catch(() => undefined);
    const started = await this.startSession(
      key,
      binding,
      event,
      sessionName,
      existing !== undefined,
    );
    await this.options.store.set(key, {
      workspace: binding.workspace.id,
      connection: binding.connection,
      channel: event.channel,
      thread: replyThread(event),
      sessionId: uuidFor(key),
      sessionName,
      createdAt: existing?.createdAt ?? now.toISOString(),
      lastActiveAt: now.toISOString(),
      // A conversation that starts here has had no answers posted yet.
      lastAnswerId: existing ? existing.lastAnswerId : '',
    });
    // A new session's turns count from 0; its first turn is the message it was started with.
    this.watchTurn(key, binding, sessionName, 0, seen, this.conversationFor(key, binding));
    this.options.log(`Started ${started.id} (${sessionName}) for ${key}`);
    await this.trim(binding.workspace.id, sessionName);
  }

  /** Waits, up to the startup time, until a session reports a status: it has started. */
  private async untilReady(id: string): Promise<void> {
    const deadline = Date.now() + this.options.startupSeconds * 1000;
    for (;;) {
      const session = await this.options.runtime.get(id);
      if (!session || session.state !== 'live' || session.status !== null) return;
      if (Date.now() > deadline) return;
      await sleep(this.options.pollMs);
    }
  }

  private chiefOfStaff(binding: Binding) {
    const config = binding.workspace.config;
    if (!config)
      throw new Error(`Workspace ${binding.workspace.id} has config problems; run opinr doctor`);
    const agent = binding.workspace.agents.find((a) => a.definition.name === config.chief_of_staff);
    if (!agent)
      throw new Error(`Workspace ${binding.workspace.id} has no chief of staff agent file`);
    return agent;
  }

  private conversationFor(key: string, binding: Binding): Pick<Watch, 'conversation' | 'engine'> {
    return {
      conversation: { id: uuidFor(key), dir: binding.workspace.dir },
      engine: this.options.engine(this.chiefOfStaff(binding).definition.engine),
    };
  }

  private async startSession(
    key: string,
    binding: Binding,
    event: InboundEvent & { type: 'message' },
    sessionName: string,
    resume: boolean,
  ): Promise<SessionInfo> {
    const workspace = binding.workspace;
    const agent = this.chiefOfStaff(binding);
    const account = this.options.install.accounts[agent.definition.account];
    const engine = this.options.engine(agent.definition.engine);
    const plan = await engine.prepare(
      { ...agent.definition, instructions: withBuiltins(agent.definition.instructions) },
      {
        workspace: { id: workspace.id, dir: workspace.dir },
        sessionDir: workspace.dir,
        account: { name: agent.definition.account, driver: account?.driver ?? 'unknown' },
        session: { id: uuidFor(key), resume, task: event.text },
      },
    );
    await this.writePlanFiles(plan);
    this.options.log(`Starting ${sessionName} for ${key}${resume ? ' (resuming)' : ''}`);
    return this.options.runtime.start({
      name: sessionName,
      command: plan.command,
      cwd: plan.cwd,
      env: {
        ...plan.env,
        ...this.options.sessionEnv,
        OPINR_WORKSPACE: workspace.id,
        OPINR_CONVERSATION: key,
      },
      labels: { opinr: 'conversation', workspace: workspace.id },
    });
  }

  private async writePlanFiles(plan: LaunchPlan): Promise<void> {
    for (const file of plan.files) {
      const target = join(plan.cwd, file.path);
      const rel = relative(plan.cwd, target);
      if (isAbsolute(file.path) || rel.startsWith('..')) {
        throw new Error(`The engine planned a file outside its folder: ${file.path}`);
      }
      await this.options.writeFile(target, file.content);
    }
  }

  /** Follows the turn a message started, and tells the person if it ends badly or silently. */
  private watchTurn(
    key: string,
    binding: Binding,
    sessionName: string,
    fromTurn: number,
    seen: MessageRef,
    target: Pick<Watch, 'conversation' | 'engine'>,
  ): void {
    const active = this.watches.get(key);
    if (active && active.sessionName === sessionName && !active.closed) {
      // A turn is already being followed. The agent takes this message during that turn or
      // in the next one, so it is followed into the next turn too.
      active.queued.push(seen);
      return;
    }
    const watch: Watch = {
      sessionName,
      fromTurn,
      sentAt: Date.now(),
      seen: [seen],
      queued: [],
      closed: false,
      ...target,
    };
    this.watches.set(key, watch);
    const run = this.follow(key, binding, watch)
      .catch((error: unknown) => {
        this.options.log(`Watching ${sessionName}: ${describe(error)}`);
      })
      .finally(() => {
        if (this.watches.get(key) === watch) this.watches.delete(key);
        this.watchers.delete(run);
      });
    this.watchers.add(run);
  }

  private async follow(key: string, binding: Binding, watch: Watch): Promise<void> {
    const { runtime } = this.options;
    const channel = this.channel(binding.connection);
    const conversation = await this.options.store.get(key);
    const thread = conversation?.thread ?? '';
    /** Until when to wait for the agent to start a turn. */
    let startBy = Date.now() + this.options.startupSeconds * 1000;
    /** True after a turn ended with messages still queued: a new turn may or may not follow. */
    let followingUp = false;
    const unmarkSeen = async () => {
      for (const message of watch.seen.splice(0)) await this.unmark(channel, message);
    };
    const done = async (text: string | null) => {
      // Close before any await, so a message arriving from here on is followed afresh.
      watch.closed = true;
      if (this.watches.get(key) === watch) this.watches.delete(key);
      await unmarkSeen();
      for (const message of watch.queued.splice(0)) await this.unmark(channel, message);
      if (text !== null) await this.notice(key, binding, thread, text);
    };

    while (!this.stopped) {
      const session = await runtime.get(watch.sessionName);
      if (!session) return done(null);
      if (session.state === 'finished') {
        if (await this.postAnswers(key, watch)) return done(null);
        return done(
          this.repliedSince(key, watch.sentAt) ? null : 'The session ended without replying.',
        );
      }
      if (session.status === 'blocked') return done(blockedText(session));
      if (session.status === 'error') {
        return done(`The agent hit an error. Its session is \`${session.id}\` in Herdr.`);
      }
      if (session.turn > watch.fromTurn && session.status !== 'working') {
        const answered = await this.postAnswers(key, watch);
        if (!answered && !this.repliedSince(key, watch.sentAt)) {
          await this.notice(
            key,
            binding,
            thread,
            `The agent finished without replying here. Its session is \`${session.id}\` in Herdr.`,
          );
        }
        await unmarkSeen();
        if (watch.queued.length === 0) return done(null);
        // Messages arrived during that turn. The agent takes queued messages a turn at a
        // time (or several in one), so follow the next turn for the oldest of them, and keep
        // the rest queued for the turns after.
        watch.seen = watch.queued.splice(0, 1);
        watch.fromTurn = session.turn;
        watch.sentAt = Date.now();
        startBy = Date.now() + this.options.followUpSeconds * 1000;
        followingUp = true;
        continue;
      }
      if (session.status !== 'working') {
        // Not started on the message yet: still booting, idle before its first turn, or
        // showing a question such as whether to trust its folder.
        if (Date.now() > startBy) {
          // After a follow-up wait, no new turn means the agent took the queued messages
          // into the turn that just ended, and answered them there.
          if (followingUp) return done(null);
          return done(
            `The agent hasn't started on this yet. It may be waiting for an answer at the Mac: \`hc attach ${session.id}\`.`,
          );
        }
        if (session.status === null) {
          await runtime.wait(session.id, { timeoutSeconds: Math.min(10, secondsLeft(startBy)) });
        } else {
          await sleep(this.options.pollMs);
        }
        continue;
      }
      followingUp = false;
      await runtime.wait(session.id, { timeoutSeconds: 300 });
    }
  }

  /**
   * Posts the agent's answers since the last one posted, when its engine can read them:
   * usually one, more when turns followed each other quickly. An answer the agent already
   * sent word for word with `opinr reply` during this turn is not posted again. Returns
   * whether the turn has an answer in the thread.
   */
  private async postAnswers(key: string, watch: Watch): Promise<boolean> {
    const engine = watch.engine;
    if (!engine.answers) return false;
    const conversation = await this.options.store.get(key);
    const cursor = conversation?.lastAnswerId;
    // The engine may still be writing its record when the turn ends; give it a moment.
    let fresh: FinalMessage[] = [];
    for (let attempt = 0; attempt < 5 && fresh.length === 0; attempt++) {
      if (attempt > 0) await sleep(Math.max(50, this.options.pollMs));
      const found = await engine.answers(watch.conversation, cursor ? cursor : null);
      // Without a known position (a conversation from before positions were kept), only
      // the latest answer can be new.
      fresh = cursor === undefined ? found.slice(-1) : found;
    }
    if (fresh.length === 0) return false;
    const reply = this.lastReply.get(key);
    for (const answer of fresh) {
      if (answer.text.trim() === '') continue;
      if (reply && reply.at >= watch.sentAt && reply.text === answer.text.trim()) continue;
      await this.post(key, answer.text);
    }
    await this.options.store.setLastAnswer(key, fresh[fresh.length - 1]?.id ?? '');
    return true;
  }

  /** Stops the least recently used idle sessions beyond the workspace's limit. */
  private async trim(workspace: string, keep: string): Promise<void> {
    const live = await this.options.runtime.list({ labels: { opinr: 'conversation', workspace } });
    if (live.length <= this.options.maxLiveSessions) return;
    const lastActive = new Map<string, string>();
    for (const [, c] of await this.options.store.all())
      lastActive.set(c.sessionName, c.lastActiveAt);
    const candidates = live
      .filter((s) => s.name !== keep && s.status !== 'working' && s.status !== 'blocked')
      .sort((a, b) =>
        (lastActive.get(a.name ?? '') ?? '').localeCompare(lastActive.get(b.name ?? '') ?? ''),
      );
    for (const session of candidates.slice(0, live.length - this.options.maxLiveSessions)) {
      this.options.log(
        `Stopping idle session ${session.name ?? session.id}; its conversation resumes when needed`,
      );
      await this.options.runtime.stop(session.id).catch(() => undefined);
      await this.options.runtime.remove(session.id).catch(() => undefined);
    }
  }

  private repliedSince(key: string, since: number): boolean {
    return (this.lastReply.get(key)?.at ?? 0) >= since;
  }

  private async notice(key: string, binding: Binding, thread: string, text: string): Promise<void> {
    const channel = this.channel(binding.connection);
    const conversation = await this.options.store.get(key);
    const target = conversation?.channel ?? key.split(':')[2] ?? '';
    await channel.send({ channel: target, threadId: thread, text: `_Opinr:_ ${text}` });
  }

  private async unmark(channel: ChannelDriver, message: MessageRef): Promise<void> {
    if (channel.capabilities.reactions)
      await channel.react(message, 'eyes', false).catch(() => undefined);
  }

  private channel(connection: string): ChannelDriver {
    const channel = this.options.channels.get(connection);
    if (!channel) throw new Error(`No channel driver for connection ${connection}`);
    return channel;
  }
}

/** One conversation per thread: `<workspace>:<connection>:<channel>:<thread>`. */
export function conversationKey(
  workspace: string,
  connection: string,
  channel: string,
  thread: string,
): string {
  return `${workspace}:${connection}:${channel}:${thread}`;
}

/** A stable UUID for a conversation (version 5 style, from SHA-1), so its engine session can be resumed. */
export function uuidFor(key: string): string {
  const hash = createHash('sha1').update(`opinr:${key}`).digest();
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function sessionNameFor(workspace: string, key: string): string {
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 8);
  return `${workspace.slice(0, 20)}-${hash}`;
}

function blockedText(session: SessionInfo): string {
  return `The agent is waiting for an answer at the Mac, such as a permission prompt: \`hc attach ${session.id}\`.`;
}

function secondsLeft(deadline: number): number {
  return Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
