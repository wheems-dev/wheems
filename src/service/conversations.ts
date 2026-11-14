import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { NOTE_REQUEST, withBuiltins, type SessionBuiltins } from '../agents/builtin.js';
import type { LoadedWorkspace } from '../config/load.js';
import type { InstallConfig } from '../config/schemas.js';
import {
  replyThread,
  type ChannelDriver,
  type InboundEvent,
  type MessageRef,
} from '../contracts/channel.js';
import { isDriverError } from '../contracts/driver.js';
import { conversationTag, type EngineDriver, type FinalMessage } from '../contracts/engine.js';
import type { RuntimeDriver, SessionInfo } from '../contracts/runtime.js';
import {
  ABOUT_YOU_LIMIT,
  BRIEF_LIMIT,
  knowledgePaths,
  readCapped,
  writeNote,
} from '../knowledge/notes.js';
import { sessionLabels } from '../state/store.js';
import { launchSession } from './launch.js';
import type { Conversation, ConversationStore } from './store.js';

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
  /** Environment every agent session gets, such as PATH with the `wheems` command first. */
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
  /** For engines that report no status: how often to check for an answer, and for how long. */
  answerPollMs?: number;
  answerWaitSeconds?: number;
  /** For engines that report no status: how long to let a program start before typing into it. */
  typeDelayMs?: number;
  /** The page about the person that every agent loads (`about-you.md`). */
  aboutYouFile?: string;
  /**
   * How often to look for conversations gone quiet that need a note, in milliseconds. 0 (the
   * default) asks for notes only before stopping a session, and only when this is above 0.
   */
  noteSweepMs?: number;
  /** How long an agent gets to write a note it was asked for. */
  noteTurnSeconds?: number;
  /**
   * The generated Sessions section for a chief's new thread session: the open sessions its
   * owner (the chief's agent id) has. Left out when not given.
   */
  sessionsSection?: (
    workspace: LoadedWorkspace,
    owner: string,
  ) => SessionBuiltins['sessions'] | undefined;
  /** Called when a note lands in a workspace's inbox, to file it. */
  onNote?: (workspace: string) => void;
  /**
   * Why an engine can't start a session in a folder it hasn't been told to trust, said to the
   * person; null when it can. Checked before each new session, since the trust question
   * would only wait at the Mac where nobody in chat can answer it.
   */
  trustProblem?: (engine: string, dir: string) => Promise<string | null>;
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
  /**
   * Messages that arrived while a turn was being followed. After a restart, the messages
   * still waiting are known only by their number, so they are held as nulls.
   */
  queued: (MessageRef | null)[];
  /** Set the moment the watch decides to finish; later messages start a new watch. */
  closed: boolean;
  /**
   * Taken up again after the service restarted: its answer may already have been posted,
   * so it never says the agent finished without replying.
   */
  recovered: boolean;
}

/**
 * Routes chat messages to agent sessions: one conversation, and one engine
 * session, per chat thread. A thread's later messages go to the same session;
 * if that session has ended, the engine resumes the conversation in a new one.
 * Agents answer with `wheems reply`, which arrives here through `reply()`.
 */
export class ConversationManager {
  private readonly options: Required<
    Omit<
      ConversationManagerOptions,
      'writeFile' | 'log' | 'aboutYouFile' | 'onNote' | 'trustProblem' | 'sessionsSection'
    >
  > & {
    sessionsSection: ConversationManagerOptions['sessionsSection'];
    aboutYouFile: string | undefined;
    onNote: ((workspace: string) => void) | undefined;
    trustProblem: (engine: string, dir: string) => Promise<string | null>;
    writeFile: (path: string, content: string) => Promise<void>;
    log: (message: string) => void;
  };
  private readonly queues = new Map<string, Promise<void>>();
  private readonly watches = new Map<string, Watch>();
  /** The latest `wheems reply` in each conversation. */
  private readonly lastReply = new Map<string, { at: number; text: string }>();
  private readonly watchers = new Set<Promise<void>>();
  private stopped = false;
  private sweepTimer: NodeJS.Timeout | undefined;
  private sweeping = false;
  private trimming: Promise<void> = Promise.resolve();

  constructor(options: ConversationManagerOptions) {
    this.options = {
      maxLiveSessions: 4,
      startupSeconds: 90,
      pollMs: 1000,
      followUpSeconds: 15,
      answerPollMs: 2000,
      answerWaitSeconds: 3600,
      typeDelayMs: 5000,
      noteSweepMs: 0,
      noteTurnSeconds: 600,
      aboutYouFile: undefined,
      onNote: undefined,
      sessionsSection: undefined,
      trustProblem: () => Promise.resolve(null),
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
    let message = event;
    // Files can't reach the agent yet. Say so, rather than leave them unanswered.
    if (event.files !== undefined && event.files.length > 0) {
      const names = event.files.map((f) => f.name).join(', ');
      if (event.text.trim() === '') {
        return this.enqueue(key, () =>
          this.notice(
            key,
            binding,
            replyThread(event),
            `I can't open files yet (${names}). Paste the text, or say in words what you need.`,
          ).catch((error: unknown) => {
            this.options.log(`Conversation ${key}: ${describe(error)}`);
          }),
        );
      }
      message = {
        ...event,
        text: `${event.text}\n\n(The person attached ${event.files.length === 1 ? 'a file' : `${String(event.files.length)} files`}: ${names}. Wheems can't pass files to you yet, so if you need what's in them, ask the person to paste it.)`,
      };
    }
    return this.enqueue(key, () =>
      this.deliver(key, binding, message).catch((error: unknown) => {
        this.options.log(`Conversation ${key}: ${describe(error)}`);
        return this.notice(
          key,
          binding,
          replyThread(event),
          `Something went wrong: ${describe(error)}`,
        );
      }),
    );
  }

  /** Runs work for one conversation after the work already queued for it, one at a time. */
  private enqueue(key: string, work: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(work).catch((error: unknown) => {
      this.options.log(`Conversation ${key}: ${describe(error)}`);
    });
    this.queues.set(key, next);
    return next;
  }

  /**
   * Saves a note an agent wrote (`wheems note`) to its workspace's inbox, and counts the
   * conversation's work so far as noted. Returns the note's file.
   */
  async note(key: string, text: string): Promise<string> {
    const conversation = await this.options.store.get(key);
    if (!conversation) throw new Error(`No conversation ${key}`);
    const binding = this.bindingFor(conversation);
    if (!binding) throw new Error(`Workspace ${conversation.workspace} is not running here`);
    const agent = this.chiefOfStaff(binding).definition;
    const file = await writeNote(
      binding.workspace.dir,
      {
        workspace: binding.workspace.id,
        agent: agent.name,
        engine: agent.engine,
        conversation: key,
        origin: 'person',
      },
      text,
    );
    await this.options.store.setNoted(key, new Date());
    this.options.log(`Note from ${key}: ${file}`);
    this.options.onNote?.(binding.workspace.id);
    return file;
  }

  /** The workspace and agent a conversation belongs to, as Wheems knows them. */
  async owner(key: string): Promise<{ workspace: string; agent: string }> {
    const conversation = await this.options.store.get(key);
    if (!conversation) throw new Error(`No conversation ${key}`);
    const binding = this.bindingFor(conversation);
    if (!binding) throw new Error(`Workspace ${conversation.workspace} is not running here`);
    return { workspace: binding.workspace.id, agent: this.chiefOfStaff(binding).definition.name };
  }

  /** Starts looking, every `noteSweepMs`, for quiet conversations that need a note. */
  startNotes(): void {
    if (this.options.noteSweepMs <= 0 || this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      void this.sweepNotes();
    }, this.options.noteSweepMs);
    this.sweepTimer.unref();
  }

  /**
   * Asks for a note in each conversation that has been quiet, after new work, for longer than
   * its workspace's `knowledge.note_after_idle`. Resolves once those notes are written.
   */
  async sweepNotes(now = Date.now()): Promise<void> {
    if (this.sweeping || this.stopped) return;
    this.sweeping = true;
    try {
      const asks: Promise<void>[] = [];
      for (const [key, conversation] of await this.options.store.all()) {
        const binding = this.bindingFor(conversation);
        const minutes = binding?.workspace.config?.knowledge.note_after_idle ?? 0;
        if (!binding || minutes <= 0 || !needsNote(conversation)) continue;
        if (now - Date.parse(conversation.lastActiveAt) < minutes * 60_000) continue;
        asks.push(this.enqueue(key, () => this.askForNote(key, binding)));
      }
      await Promise.all(asks);
    } finally {
      this.sweeping = false;
    }
  }

  /** Posts an agent's reply (`wheems reply`) into its conversation's thread. */
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

  /**
   * Takes up following the turns that were in progress when the service last stopped, so
   * their answers still reach their threads. Call it once the channels are connected.
   */
  async recover(): Promise<void> {
    for (const [key, conversation] of await this.options.store.all()) {
      const pending = conversation.pending ?? 0;
      if (pending === 0) continue;
      const binding = this.options.bindings.find(
        (b) =>
          b.workspace.id === conversation.workspace && b.connection === conversation.connection,
      );
      const session = binding ? await this.options.runtime.get(conversation.sessionName) : null;
      if (!binding || session?.state !== 'live') {
        await this.options.store.setPending(key, 0);
        continue;
      }
      this.options.log(`Taking up ${key} again after a restart`);
      // Its turn may have ended while the service was away. Answers are posted from the last
      // one posted, so none is posted twice and none is missed.
      this.watchTurn(
        key,
        binding,
        conversation.sessionName,
        Math.max(0, session.turn - 1),
        null,
        this.conversationFor(key, binding),
        true,
      );
      // The others still waiting follow the first, as messages queued during its turn.
      this.watches.get(key)?.queued.push(...new Array<null>(pending - 1).fill(null));
    }
  }

  /** Resolves once no turn is being followed. */
  async whenIdle(): Promise<void> {
    while (this.watchers.size > 0) await Promise.allSettled([...this.watchers]);
  }

  /** Stops watching sessions. Sessions themselves keep running. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.sweepTimer);
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

    let existing = await this.options.store.get(key);
    if (existing?.noting === true) {
      // A note turn's answer must never reach the thread, even after a restart.
      await this.settleNoteTurn(key, binding);
      existing = await this.options.store.get(key);
    }
    const sessionName = existing?.sessionName ?? sessionNameFor(binding.workspace.id, key);
    const session = await this.options.runtime.get(sessionName);
    const now = new Date();

    if (session?.state === 'live') {
      try {
        // Text sent to an agent that is still starting can be lost, and would arrive ahead
        // of the task it was started with; wait until it reports in.
        const reportsStatus = this.options.engine(this.chiefOfStaff(binding).definition.engine)
          .capabilities.status;
        if (reportsStatus) {
          await this.untilReady(session.id);
        } else if ((existing?.launchedAt ?? existing?.startedAt) !== undefined) {
          // No status to say it has started: give a new session its start-up time first,
          // counted from when it was launched, not from before it was prepared.
          const since = Date.parse(existing?.launchedAt ?? existing?.startedAt ?? '');
          const wait = since + this.options.typeDelayMs - Date.now();
          if (wait > 0) await sleep(wait);
        }
        // Taken before sending: a quick agent can reply before the turn is being followed.
        const sentAt = Date.now();
        const sent = await this.options.runtime.send(session.id, event.text);
        await this.options.store.touch(key, now);
        await this.options.store.addPending(key);
        this.watchTurn(
          key,
          binding,
          sessionName,
          sent.turn,
          seen,
          this.conversationFor(key, binding),
          false,
          sentAt,
        );
      } catch (error) {
        if (!isDriverError(error, 'blocked')) throw error;
        await this.unmark(channel, seen);
        await this.notice(key, binding, replyThread(event), blockedText(session));
      }
      return;
    }

    const engineName = this.chiefOfStaff(binding).definition.engine;
    const untrusted = await this.options.trustProblem(engineName, binding.workspace.dir);
    if (untrusted !== null) {
      this.options.log(`Conversation ${key}: not started, ${engineName} doesn't trust the folder`);
      await this.unmark(channel, seen);
      await this.notice(key, binding, replyThread(event), untrusted);
      return;
    }
    if (session) await this.options.runtime.remove(session.id).catch(() => undefined);
    const engine = this.options.engine(engineName);
    // An engine that chooses its own ids can only resume once its id has been found.
    const engineId = engine.findSession ? (existing?.engineSessionId ?? null) : uuidFor(key);
    const resume = existing !== undefined && engineId !== null;
    if (existing !== undefined && !resume) {
      this.options.log(
        `Conversation ${key}: the engine's session id was never found, so it starts afresh`,
      );
    }
    // An engine that picks its own ids finds this launch's session by a tag on the first message.
    const launchTag =
      engine.findSession && !resume
        ? conversationTag(uuidFor(key), randomBytes(8).toString('hex'))
        : undefined;
    const started = await this.startSession(
      key,
      binding,
      event,
      sessionName,
      resume,
      engineId,
      launchTag,
    );
    const launchedAt = new Date();
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
      lastAnswerId: resume ? existing?.lastAnswerId : '',
      ...(resume && { engineSessionId: engineId }),
      ...(existing?.notedAt !== undefined && { notedAt: existing.notedAt }),
      startedAt: now.toISOString(),
      launchedAt: launchedAt.toISOString(),
      ...(launchTag !== undefined && { launchTag }),
      pending: 1,
    });
    // A new session's turns count from 0; its first turn is the message it was started with.
    // `now` was taken before the session started, so a reply to its first message counts.
    this.watchTurn(
      key,
      binding,
      sessionName,
      0,
      seen,
      this.conversationFor(key, binding),
      false,
      now.getTime(),
    );
    this.options.log(`Started ${started.id} (${sessionName}) for ${key}`);
    this.trimLater(binding.workspace.id, sessionName);
  }

  /**
   * Makes room in the background, one trim at a time: asking a session for its note first
   * can take minutes, and the new conversation shouldn't wait for it.
   */
  private trimLater(workspace: string, keep: string): void {
    const run = (this.trimming = this.trimming
      .then(() => this.trim(workspace, keep))
      .catch((error: unknown) => {
        this.options.log(`Making room in ${workspace}: ${describe(error)}`);
      })
      .finally(() => this.watchers.delete(run)));
    this.watchers.add(run);
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
      throw new Error(`Workspace ${binding.workspace.id} has config problems; run wheems doctor`);
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
    engineId: string | null,
    launchTag: string | undefined,
  ): Promise<SessionInfo> {
    const workspace = binding.workspace;
    const agent = this.chiefOfStaff(binding);
    const account = this.options.install.accounts[agent.definition.account];
    const engine = this.options.engine(agent.definition.engine);
    const knowledge = {
      aboutYou:
        this.options.aboutYouFile !== undefined
          ? await readCapped(this.options.aboutYouFile, ABOUT_YOU_LIMIT)
          : null,
      brief: await readCapped(knowledgePaths(workspace.dir).brief, BRIEF_LIMIT),
    };
    const sessions = this.options.sessionsSection?.(
      workspace,
      `${workspace.id}/${agent.definition.name}`,
    );
    this.options.log(`Starting ${sessionName} for ${key}${resume ? ' (resuming)' : ''}`);
    const started = await launchSession({
      runtime: this.options.runtime,
      engine,
      agent: {
        ...agent.definition,
        instructions: withBuiltins(agent.definition.instructions, knowledge, {
          ...(sessions && { sessions }),
        }),
      },
      workspace: { id: workspace.id, dir: workspace.dir },
      sessionDir: workspace.dir,
      account: { name: agent.definition.account, driver: account?.driver ?? 'unknown' },
      session: {
        id: uuidFor(key),
        name: sessionName,
        resume,
        task: launchTag !== undefined ? `${event.text}\n\n${launchTag}` : event.text,
        engineId,
      },
      env: {
        ...this.options.sessionEnv,
        WHEEMS_WORKSPACE: workspace.id,
        WHEEMS_CONVERSATION: key,
        WHEEMS_SESSION: uuidFor(key),
      },
      labels: sessionLabels(uuidFor(key), workspace.id),
      untilReady: (id) => this.untilReady(id),
      typeDelayMs: this.options.typeDelayMs,
      writeFile: this.options.writeFile,
    });
    return started;
  }

  /** Follows the turn a message started, and tells the person if it ends badly or silently. */
  private watchTurn(
    key: string,
    binding: Binding,
    sessionName: string,
    fromTurn: number,
    seen: MessageRef | null,
    target: Pick<Watch, 'conversation' | 'engine'>,
    recovered = false,
    /** When the message was handed to the agent; replies from then on count as its answer. */
    sentAt = Date.now(),
  ): void {
    const active = this.watches.get(key);
    if (active && active.sessionName === sessionName && !active.closed) {
      // A turn is already being followed. The agent takes this message during that turn or
      // in the next one, so it is followed into the next turn too.
      if (seen) active.queued.push(seen);
      return;
    }
    const watch: Watch = {
      sessionName,
      fromTurn,
      sentAt,
      seen: seen ? [seen] : [],
      queued: [],
      closed: false,
      recovered,
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
      await this.options.store.setPending(key, 0);
      await unmarkSeen();
      for (const message of watch.queued.splice(0)) {
        if (message) await this.unmark(channel, message);
      }
      if (text !== null) await this.notice(key, binding, thread, text);
    };

    if (!watch.engine.capabilities.status) {
      // The engine reports no status, so follow the turn by its answers instead.
      let giveUpAt = Date.now() + this.options.answerWaitSeconds * 1000;
      while (!this.stopped) {
        const session = await runtime.get(watch.sessionName);
        if (!session) return done(null);
        const posted = await this.postAnswers(key, watch, 1);
        if (posted > 0) {
          // Each answer is a turn; messages queued meanwhile wait for theirs.
          await unmarkSeen();
          watch.queued.splice(0, posted - 1);
          if (watch.queued.length === 0) return done(null);
          watch.seen = watch.queued.splice(0, 1).filter((m) => m !== null);
          watch.sentAt = Date.now();
          giveUpAt = Date.now() + this.options.answerWaitSeconds * 1000;
          continue;
        }
        if (session.state === 'finished') {
          return done(
            this.repliedSince(key, watch.sentAt) || watch.recovered
              ? null
              : 'The session ended without replying.',
          );
        }
        if (Date.now() > giveUpAt) {
          return done(`There's no answer yet. Its session is \`${session.id}\` in Herdr.`);
        }
        await sleep(this.options.answerPollMs);
      }
      return;
    }

    while (!this.stopped) {
      const session = await runtime.get(watch.sessionName);
      if (!session) return done(null);
      if (session.state === 'finished') {
        if (await this.postAnswers(key, watch)) return done(null);
        return done(
          this.repliedSince(key, watch.sentAt) || watch.recovered
            ? null
            : 'The session ended without replying.',
        );
      }
      if (session.status === 'blocked') return done(blockedText(session));
      if (session.status === 'error') {
        return done(`The agent hit an error. Its session is \`${session.id}\` in Herdr.`);
      }
      if (session.turn > watch.fromTurn && session.status !== 'working') {
        const answered = await this.postAnswers(key, watch);
        if (!answered && !this.repliedSince(key, watch.sentAt) && !watch.recovered) {
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
        watch.seen = watch.queued.splice(0, 1).filter((m) => m !== null);
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
   * sent word for word with `wheems reply` during this turn is not posted again. Returns
   * how many answers there were (0 for none yet).
   */
  private async postAnswers(key: string, watch: Watch, attempts = 5): Promise<number> {
    const engine = watch.engine;
    if (!engine.answers) return 0;
    const cursor = (await this.options.store.get(key))?.lastAnswerId;
    // The engine may still be writing its record when the turn ends; give it a moment.
    let fresh: FinalMessage[] = [];
    for (let attempt = 0; attempt < attempts && fresh.length === 0; attempt++) {
      if (attempt > 0) await sleep(Math.max(50, this.options.pollMs));
      const id = await this.engineSessionId(key, engine, watch);
      if (id === null) continue;
      const found = await engine.answers(
        { id, dir: watch.conversation.dir },
        cursor ? cursor : null,
      );
      // Without a known position (a conversation from before positions were kept), only
      // the latest answer can be new.
      fresh = cursor === undefined ? found.slice(-1) : found;
    }
    if (fresh.length === 0) return 0;
    const reply = this.lastReply.get(key);
    for (const answer of fresh) {
      if (answer.text.trim() === '') continue;
      if (reply && reply.at >= watch.sentAt && reply.text === answer.text.trim()) continue;
      await this.post(key, answer.text);
    }
    await this.options.store.answered(key, fresh[fresh.length - 1]?.id ?? '', fresh.length);
    return fresh.length;
  }

  /**
   * The id to read answers by: Wheems's own for engines that take it, else the engine's
   * own, found once after the session's first turn and kept with the conversation.
   */
  private async engineSessionId(
    key: string,
    engine: EngineDriver,
    watch: Pick<Watch, 'conversation'>,
  ): Promise<string | null> {
    if (!engine.findSession) return watch.conversation.id;
    const conversation = await this.options.store.get(key);
    if (conversation?.engineSessionId !== undefined) return conversation.engineSessionId;
    if (conversation?.startedAt === undefined || conversation.launchTag === undefined) return null;
    const found = await engine.findSession({
      dir: watch.conversation.dir,
      startedAt: new Date(conversation.startedAt),
      tag: conversation.launchTag,
    });
    if (found !== null) await this.options.store.setEngineSession(key, found);
    return found;
  }

  /** Stops the least recently used idle sessions beyond the workspace's limit. */
  private async trim(workspace: string, keep: string): Promise<void> {
    const conversations = await this.options.store.all();
    // This workspace's thread sessions, known by their names in the store. A session with a
    // Wheems label and no row is left alone; doctor reports it.
    const names = new Set(
      conversations.filter(([, c]) => c.workspace === workspace).map(([, c]) => c.sessionName),
    );
    const live = (await this.options.runtime.list({ labels: { workspace } })).filter((s) =>
      names.has(s.name ?? ''),
    );
    if (live.length <= this.options.maxLiveSessions) return;
    const lastActive = new Map<string, string>();
    const busy = new Set<string>();
    for (const [, c] of conversations) {
      lastActive.set(c.sessionName, c.lastActiveAt);
      if ((c.pending ?? 0) > 0) busy.add(c.sessionName);
    }
    // Never stop a session whose turn is still being followed: an engine without status
    // (opencode) can be busy while reporting none.
    const followed = new Set(
      [...this.watches.values()].filter((w) => !w.closed).map((w) => w.sessionName),
    );
    const candidates = live
      .filter(
        (s) =>
          s.name !== keep &&
          !followed.has(s.name ?? '') &&
          !busy.has(s.name ?? '') &&
          s.status !== 'working' &&
          s.status !== 'blocked',
      )
      .sort((a, b) =>
        (lastActive.get(a.name ?? '') ?? '').localeCompare(lastActive.get(b.name ?? '') ?? ''),
      );
    const keys = new Map<string, [string, Conversation]>();
    for (const entry of conversations) keys.set(entry[1].sessionName, entry);
    for (const session of candidates.slice(0, live.length - this.options.maxLiveSessions)) {
      const entry = keys.get(session.name ?? '');
      const binding = entry ? this.bindingFor(entry[1]) : undefined;
      if (!entry || !binding || this.options.noteSweepMs <= 0) {
        await this.stopSession(session);
        continue;
      }
      // Ask for its note first, in its conversation's turn, so no message slips in between.
      const [key] = entry;
      await this.enqueue(key, async () => {
        await this.askForNote(key, binding);
        const current = await this.options.store.get(key);
        const live = await this.options.runtime.get(session.id);
        const watch = this.watches.get(key);
        if ((current?.pending ?? 0) > 0 || (watch && !watch.closed)) return;
        if (live?.status === 'working' || live?.status === 'blocked') return;
        await this.stopSession(session);
      });
    }
  }

  /** Stops and removes a session. Returns whether it is no longer running. */
  private async stopSession(session: SessionInfo): Promise<boolean> {
    this.options.log(
      `Stopping idle session ${session.name ?? session.id}; its conversation resumes when needed`,
    );
    await this.options.runtime.stop(session.id).catch(() => undefined);
    await this.options.runtime.remove(session.id).catch(() => undefined);
    const after = await this.options.runtime.get(session.id).catch(() => undefined);
    return after !== undefined && after?.state !== 'live';
  }

  /** Stops a note turn's session; only once it has certainly stopped is the turn over. */
  private async endNoteTurn(key: string, binding: Binding, session: SessionInfo): Promise<boolean> {
    if (!(await this.stopSession(session))) {
      this.options.log(`Could not stop ${session.name ?? session.id} after its note turn`);
      return false;
    }
    await this.afterStopped(key, binding);
    return true;
  }

  /**
   * Asks a conversation's agent for its note, as a turn of its own, and waits for it. The
   * answer to that turn is skipped, never posted. Does nothing when the work so far is noted,
   * a turn is in progress, or the session isn't running.
   */
  private async askForNote(key: string, binding: Binding): Promise<void> {
    const conversation = await this.options.store.get(key);
    if (!conversation || !needsNote(conversation) || (conversation.pending ?? 0) > 0) return;
    const active = this.watches.get(key);
    if (active && !active.closed) return;
    const session = await this.options.runtime.get(conversation.sessionName);
    if (session?.state !== 'live' || session.status === 'working' || session.status === 'blocked')
      return;
    const engine = this.options.engine(this.chiefOfStaff(binding).definition.engine);
    // Without its answers, the note turn's answer couldn't be kept out of the thread.
    if (!engine.answers) return;
    await this.options.store.setNoted(key, new Date());
    await this.options.store.setNoting(key, true);
    this.options.log(`Asking ${conversation.sessionName} for its note on ${key}`);
    let fromTurn: number;
    try {
      fromTurn = (await this.options.runtime.send(session.id, NOTE_REQUEST)).turn;
    } catch (error) {
      await this.options.store.setNoting(key, false);
      if (isDriverError(error, 'blocked')) return;
      throw error;
    }
    const target = this.conversationFor(key, binding);
    if (await this.untilTurnEnds(key, session.id, fromTurn, target)) {
      // Its answer may not be written yet; then the next message settles it first.
      await this.skipNoteAnswers(key, binding);
      return;
    }
    if (this.stopped) return; // The next message settles it, after the restart.
    // A note turn that didn't end could answer at any time, and that answer would be taken for
    // the reply to the next message. Stop its session instead; the conversation resumes.
    this.options.log(`${conversation.sessionName} did not finish its note in time; stopping it`);
    // If it can't be stopped, it stays marked as noting, and the next message settles it.
    await this.endNoteTurn(key, binding, session);
  }

  /** A note turn's session has ended: skip any answer it wrote before it did. No more can come. */
  private async afterStopped(key: string, binding: Binding): Promise<void> {
    if (!(await this.skipNoteAnswers(key, binding, 1)))
      await this.options.store.setNoting(key, false);
  }

  /**
   * Before a message goes in: makes sure a note turn that was asked for can no longer answer.
   * Lets it finish, skips its answer, and if no answer comes, stops its session so none can
   * arrive later and be taken for the reply to this message.
   */
  private async settleNoteTurn(key: string, binding: Binding): Promise<void> {
    const conversation = await this.options.store.get(key);
    const session = conversation ? await this.options.runtime.get(conversation.sessionName) : null;
    if (session?.state === 'live') {
      await this.untilSettled(key, session.id, this.conversationFor(key, binding));
      if (await this.skipNoteAnswers(key, binding)) return;
      this.options.log(`${session.name ?? session.id}'s note turn gave no answer; stopping it`);
      if (!(await this.endNoteTurn(key, binding, session))) {
        // Its answer could still come and be taken for this message's reply: don't send it in.
        throw new Error(
          `Couldn't stop the agent's session after Wheems asked it for a note, so this message wasn't sent. Its session is \`${session.id}\` in Herdr; try again shortly.`,
        );
      }
      return;
    }
    // No session, so no answer can come any more.
    await this.afterStopped(key, binding);
  }

  /** Waits, up to the time a note gets, until a session isn't working, or has a new answer. */
  private async untilSettled(
    key: string,
    id: string,
    target: Pick<Watch, 'conversation' | 'engine'>,
  ): Promise<void> {
    const deadline = Date.now() + this.options.noteTurnSeconds * 1000;
    const cursor = (await this.options.store.get(key))?.lastAnswerId;
    while (!this.stopped && Date.now() < deadline) {
      const session = await this.options.runtime.get(id);
      if (session?.state !== 'live') return;
      if (target.engine.capabilities.status) {
        if (session.status !== 'working') return;
        await this.options.runtime.wait(id, {
          timeoutSeconds: Math.min(60, secondsLeft(deadline)),
        });
        continue;
      }
      const engineId = await this.engineSessionId(key, target.engine, target);
      if (engineId !== null && target.engine.answers) {
        const found = await target.engine.answers(
          { id: engineId, dir: target.conversation.dir },
          cursor ? cursor : null,
        );
        if (found.length > 0) return;
      }
      await sleep(this.options.answerPollMs);
    }
  }

  /** Waits for the turn after `fromTurn` to end. False when it didn't, in the time a note gets. */
  private async untilTurnEnds(
    key: string,
    id: string,
    fromTurn: number,
    target: Pick<Watch, 'conversation' | 'engine'>,
  ): Promise<boolean> {
    const deadline = Date.now() + this.options.noteTurnSeconds * 1000;
    const startBy = Date.now() + this.options.startupSeconds * 1000;
    const cursor = (await this.options.store.get(key))?.lastAnswerId;
    while (!this.stopped && Date.now() < deadline) {
      const session = await this.options.runtime.get(id);
      if (session?.state !== 'live') return false;
      if (!target.engine.capabilities.status) {
        // No status to follow: the turn has ended once its answer is there.
        const engineId = await this.engineSessionId(key, target.engine, target);
        const found =
          engineId !== null && target.engine.answers
            ? await target.engine.answers(
                { id: engineId, dir: target.conversation.dir },
                cursor ? cursor : null,
              )
            : [];
        if (found.length > 0) return true;
        await sleep(this.options.answerPollMs);
        continue;
      }
      if (session.status === 'blocked' || session.status === 'error') return false;
      if (session.turn > fromTurn && session.status !== 'working') return true;
      if (session.status !== 'working' && Date.now() > startBy) return false;
      if (session.status === 'working') {
        await this.options.runtime.wait(id, {
          timeoutSeconds: Math.min(60, secondsLeft(deadline)),
        });
      } else {
        await sleep(this.options.pollMs);
      }
    }
    return false;
  }

  /**
   * Moves the answer position past a note turn's answers without posting them. Returns false,
   * leaving the conversation marked as noting, when no answer is there yet.
   */
  private async skipNoteAnswers(key: string, binding: Binding, attempts = 5): Promise<boolean> {
    const target = this.conversationFor(key, binding);
    const engine = target.engine;
    const cursor = (await this.options.store.get(key))?.lastAnswerId;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(Math.max(50, this.options.pollMs));
      const id = await this.engineSessionId(key, engine, target);
      if (id === null || !engine.answers) continue;
      const found = await engine.answers(
        { id, dir: target.conversation.dir },
        cursor ? cursor : null,
      );
      const last = found.at(-1);
      if (last) {
        await this.options.store.setNoting(key, false, last.id);
        return true;
      }
    }
    return false;
  }

  private bindingFor(conversation: Conversation): Binding | undefined {
    return this.options.bindings.find(
      (b) => b.workspace.id === conversation.workspace && b.connection === conversation.connection,
    );
  }

  private repliedSince(key: string, since: number): boolean {
    return (this.lastReply.get(key)?.at ?? 0) >= since;
  }

  private async notice(key: string, binding: Binding, thread: string, text: string): Promise<void> {
    const channel = this.channel(binding.connection);
    const conversation = await this.options.store.get(key);
    const target = conversation?.channel ?? key.split(':')[2] ?? '';
    await channel.send({ channel: target, threadId: thread, text: `_Wheems:_ ${text}` });
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
  const hash = createHash('sha1').update(`wheems:${key}`).digest();
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function sessionNameFor(workspace: string, key: string): string {
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 8);
  return `${workspace.slice(0, 20)}-${hash}`;
}

/** Whether a conversation has had work since its last note. */
function needsNote(conversation: Conversation): boolean {
  return conversation.lastActiveAt > (conversation.notedAt ?? '');
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
