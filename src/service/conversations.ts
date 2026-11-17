import { createHash, randomBytes } from 'node:crypto';
import { holdsCredential } from '../knowledge/notes.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  HANDOVER_REQUEST,
  NOTE_REQUEST,
  builtinSkills,
  withBuiltins,
  type SessionBuiltins,
} from '../agents/builtin.js';
import { teamOf } from '../agents/team.js';
import { GOAL_FILE, type LoadedWorkspace } from '../config/load.js';
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
  GOAL_LIMIT,
  knowledgePaths,
  readCapped,
  writeNote,
} from '../knowledge/notes.js';
import { sessionLabels, type ChatAuthor } from '../state/store.js';
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
  /** Why an engine can't start because it isn't signed in, with the step that fixes it, or null. */
  signInProblem?: (engine: string) => Promise<string | null>;
  /**
   * The engine a workspace's chief of staff's agent file names now, which the service runs once
   * it restarts. Throws when it can't be read. Carry on is refused when it isn't the engine the
   * service runs, since the next session would resume the conversation on an engine that never
   * had it. Without this, the engine the service runs is assumed.
   */
  savedChiefEngine?: (workspace: string) => Promise<string>;
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
 * Agents answer with `wheems chat reply`, which arrives here through `reply()`.
 */
export class ConversationManager {
  private readonly options: Required<
    Omit<
      ConversationManagerOptions,
      | 'writeFile'
      | 'log'
      | 'aboutYouFile'
      | 'onNote'
      | 'trustProblem'
      | 'signInProblem'
      | 'sessionsSection'
      | 'savedChiefEngine'
    >
  > & {
    sessionsSection: ConversationManagerOptions['sessionsSection'];
    aboutYouFile: string | undefined;
    onNote: ((workspace: string) => void) | undefined;
    trustProblem: (engine: string, dir: string) => Promise<string | null>;
    signInProblem: (engine: string) => Promise<string | null>;
    savedChiefEngine: ((workspace: string) => Promise<string>) | undefined;
    writeFile: (path: string, content: string) => Promise<void>;
    log: (message: string) => void;
  };
  private readonly queues = new Map<string, Promise<void>>();
  private readonly watches = new Map<string, Watch>();
  /**
   * Workspaces whose conversations are being set up for a restart that's coming: until it, the
   * old service starts no session in them, new or resumed, so none starts on the old settings.
   */
  private readonly held = new Set<string>();
  /** Messages from Wheems waiting for a workspace's hold to end. */
  private waitingForRelease: {
    workspace: string;
    resolve: () => void;
    reject: (error: Error) => void;
  }[] = [];
  /** Conversations whose agent was asked for a handover, and the handover once it came. */
  private readonly handingOver = new Map<string, string | null>();
  /** The latest `wheems chat reply` in each conversation. */
  private readonly lastReply = new Map<string, { at: number; text: string }>();
  private readonly watchers = new Set<Promise<void>>();
  private stopped = false;
  /** Workspaces no longer served (archived or removed): no session starts for them. */
  private readonly retired = new Set<string>();
  /**
   * Why each workspace's chief can't answer, as already said in chat: each problem is said once,
   * until the chief answers again, so a person isn't told the same thing on every message.
   */
  private readonly problems = new Map<string, Set<Problem>>();
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
      signInProblem: () => Promise.resolve(null),
      savedChiefEngine: undefined,
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
        return this.problem(
          key,
          binding,
          replyThread(event),
          'failed',
          `I couldn't start on this: ${describe(error)}. At the Mac, run \`wheems doctor --fix\` to find and fix what's wrong.`,
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
   * Saves a note an agent wrote (`wheems knowledgebase note`) to its workspace's inbox, and counts the
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

  /**
   * Keeps a handover an agent wrote (`wheems session handover`) for its conversation, during the
   * handover turn Wheems asked it for. A handover outside one is refused: it would have nothing to
   * start.
   */
  handover(key: string, text: string): Promise<void> {
    if (!this.handingOver.has(key)) {
      return Promise.reject(
        new Error(
          "Wheems hasn't asked this conversation for a handover, so there's nothing to hand over to.",
        ),
      );
    }
    this.handingOver.set(key, text);
    this.options.log(`Handover from ${key}: ${String(text.length)} characters`);
    return Promise.resolve();
  }

  /**
   * The workspace's chat threads, newest first, with what each would need to start afresh: for
   * choosing, when its chief's settings change, what happens to each.
   */
  async openConversations(workspace: string): Promise<OpenConversation[]> {
    const open: OpenConversation[] = [];
    for (const [key, conversation] of await this.options.store.all()) {
      if (conversation.workspace !== workspace) continue;
      const session = await this.options.runtime.get(conversation.sessionName).catch(() => null);
      const { ask } = await this.options.store.record(key, 0);
      open.push({
        key,
        session: conversation.sessionId,
        ask,
        lastActiveAt: conversation.lastActiveAt,
        running: session?.state === 'live',
        busy:
          (conversation.pending ?? 0) > 0 ||
          session?.status === 'working' ||
          session?.status === 'blocked',
        startsAfresh: conversation.handover !== undefined,
      });
    }
    return open.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  }

  /**
   * Holds a workspace's conversations until the coming restart: the old service starts no session
   * in it meanwhile, for a new thread or an old one. `release` lets them go, when the restart
   * doesn't happen.
   */
  async hold(workspace: string, settleMs = 150_000): Promise<boolean> {
    this.held.add(workspace);
    // Work already under way in it, such as a session starting for a message that came just
    // before, must finish first, so what's listed next is what will be. A session's start can
    // take a minute and a half; work still going after this long means the hold has failed.
    const pending = [...this.queues].filter(([key]) => key.startsWith(`${workspace}:`));
    const settled = await Promise.race([
      Promise.allSettled(pending.map(([, work]) => work)).then(() => true),
      sleep(settleMs).then(() => false),
    ]);
    if (!settled) this.release(workspace);
    return settled;
  }

  release(workspace: string): void {
    this.held.delete(workspace);
    const waiting = this.waitingForRelease.filter((w) => w.workspace === workspace);
    this.waitingForRelease = this.waitingForRelease.filter((w) => w.workspace !== workspace);
    for (const w of waiting) w.resolve();
  }

  /**
   * Restarts a conversation, as the person chose, when its chief's settings changed or it should
   * start over. Waits its turn in the conversation's queue, so no message slips in between.
   *
   * - `carry-on`: stops its session; the next message resumes it, on the settings then.
   * - `hand-over`: asks the agent for a handover, or writes one from the thread when it can't;
   *   the next message starts a new session from it.
   * - `fresh`: the next message starts a new session with only the thread's ask.
   */
  restart(key: string, choice: RestartChoice): Promise<RestartOutcome> {
    let outcome: RestartOutcome = { key, done: false, text: 'It could not be restarted.' };
    return this.enqueue(key, async () => {
      outcome = await this.restartNow(key, choice).catch((error: unknown) => {
        this.options.log(`Conversation ${key}: not restarted: ${describe(error)}`);
        return { key, done: false, text: `It was left as it is: ${describe(error)}` };
      });
    }).then(() => outcome);
  }

  private async restartNow(key: string, choice: RestartChoice): Promise<RestartOutcome> {
    const conversation = await this.options.store.get(key);
    if (!conversation) return { key, done: false, text: `There's no conversation ${key}.` };
    const binding = this.bindingFor(conversation);
    if (!binding) {
      return { key, done: false, text: "Its workspace or chat connection isn't running." };
    }
    // Whether its session runs must be known: a restart that couldn't stop it would leave its
    // messages going to the old session while answers are read from the new one.
    const session = await this.sessionState(conversation.sessionName);
    const live = session?.state === 'live' ? session : null;
    const watch = this.watches.get(key);
    if (
      (conversation.pending ?? 0) > 0 ||
      (watch !== undefined && !watch.closed) ||
      live?.status === 'working' ||
      live?.status === 'blocked'
    ) {
      return {
        key,
        done: false,
        text: "It's working on a message, so it was left as it is. Try again once it has answered.",
      };
    }
    if (choice === 'carry-on') {
      // A session never carries on across an engine change: the new engine never had it. The
      // agent file is read now, not when the choice was made, so no page or earlier answer can
      // send Carry on for settings that have since changed.
      const running = this.chiefOfStaff(binding).definition.engine;
      const saved = this.options.savedChiefEngine
        ? await this.options.savedChiefEngine(binding.workspace.id)
        : running;
      if (saved !== running) {
        this.options.log(
          `Conversation ${key}: not carried on, its chief changes from ${running} to ${saved}`,
        );
        return {
          key,
          done: false,
          text: `Its chief of staff now runs on ${saved}, not ${running}, so its session can't carry on. Choose Hand over or Start fresh.`,
        };
      }
      if (live && !(await this.stopSession(live))) {
        return {
          key,
          done: false,
          text: "Its session couldn't be stopped, so it carries on as it was.",
        };
      }
      return {
        key,
        done: true,
        text: 'Its next message resumes it, with the settings then.',
      };
    }
    let handover: {
      text: string;
      author: 'agent' | 'wheems';
      fromEngine: string | null;
      fromModel: string | null;
      at: Date;
    } | null = null;
    if (choice === 'hand-over') {
      const chief = this.chiefOfStaff(binding).definition;
      const written = live ? await this.askForHandover(key, binding, live) : null;
      handover = {
        text: written ?? (await this.handoverFromThread(key)),
        author: written !== null ? 'agent' : 'wheems',
        fromEngine: chief.engine,
        fromModel: chief.model,
        at: new Date(),
      };
    }
    const still = await this.sessionState(conversation.sessionName);
    if (still?.state === 'live' && !(await this.stopSession(still))) {
      return {
        key,
        done: false,
        text: "Its session couldn't be stopped, so it was left as it is.",
      };
    }
    await this.options.store.restart(key, handover);
    this.options.log(
      `Conversation ${key}: ${handover === null ? 'starts afresh' : `handed over (${handover.author === 'agent' ? 'its agent' : 'Wheems'} wrote it)`} at its next message`,
    );
    return {
      key,
      done: true,
      text:
        handover === null
          ? "Its next message starts a new session, with only the thread's ask."
          : handover.author === 'agent'
            ? 'Handed over: its next message starts a new session from the handover.'
            : "Its chief couldn't write a handover, so Wheems wrote one from the thread. Its next message starts a new session from that.",
    };
  }

  /** A session as the runtime has it, or null when there's none; throws when it can't tell. */
  private async sessionState(name: string): Promise<SessionInfo | null> {
    try {
      return (await this.options.runtime.get(name)) ?? null;
    } catch (error) {
      throw new Error(`Herdr couldn't say whether its session is running (${describe(error)})`, {
        cause: error,
      });
    }
  }

  /**
   * Asks a conversation's agent for its handover, as a turn of its own whose answer is never
   * posted, as a note turn is. Returns the handover, or null when none came in time.
   */
  private async askForHandover(
    key: string,
    binding: Binding,
    session: SessionInfo,
  ): Promise<string | null> {
    const engine = this.options.engine(this.chiefOfStaff(binding).definition.engine);
    // Without its answers, the turn's answer couldn't be kept out of the thread.
    if (!engine.answers) return null;
    this.handingOver.set(key, null);
    try {
      await this.options.store.setNoting(key, true);
      this.options.log(`Asking ${session.name ?? session.id} for a handover on ${key}`);
      let fromTurn: number;
      try {
        fromTurn = (await this.options.runtime.send(session.id, HANDOVER_REQUEST)).turn;
      } catch (error) {
        await this.options.store.setNoting(key, false);
        this.options.log(`Conversation ${key}: couldn't ask for a handover: ${describe(error)}`);
        return null;
      }
      const target = await this.conversationFor(key, binding);
      if (await this.untilTurnEnds(key, session.id, fromTurn, target)) {
        await this.skipNoteAnswers(key, binding);
      } else {
        this.options.log(`${session.name ?? session.id} did not finish its handover in time`);
      }
      return this.handingOver.get(key) ?? null;
    } finally {
      this.handingOver.delete(key);
    }
  }

  /** A handover Wheems writes from what it keeps, when the agent couldn't write one. */
  private async handoverFromThread(key: string): Promise<string> {
    const { ask, chat } = await this.options.store.record(key, HANDOVER_TURNS);
    const who = { person: 'The person', agent: 'Chief of staff', wheems: 'Wheems' } as const;
    const lines = [
      'The chief of staff before you could not write a handover, so Wheems wrote this from what it keeps of the thread. It has no record of work done outside the thread: check before relying on it.',
      '',
      `**What the person asked:** ${ask ?? 'not recorded'}`,
    ];
    if (chat.length > 0) {
      lines.push('', `**The thread's latest messages, oldest first:**`);
      for (const turn of chat) {
        const text =
          turn.text.length > HANDOVER_TURN_CHARS
            ? `${turn.text.slice(0, HANDOVER_TURN_CHARS)}…`
            : turn.text;
        lines.push('', `${who[turn.author]}, ${turn.at}:`, text);
      }
    }
    return lines.join('\n');
  }

  /**
   * What a thread's next session starts from: its handover, or just the thread's ask, and the
   * line Wheems posts in the thread once it has started.
   */
  private async startingFrom(
    key: string,
    afresh: string,
  ): Promise<{ brief: string; line: (engine: string, model: string) => string }> {
    const handover = afresh === 'fresh' ? undefined : await this.options.store.handover(afresh);
    if (handover === undefined) {
      const { ask } = await this.options.store.record(key, 0);
      return {
        brief: [
          '<wheems-start-afresh>',
          'This conversation starts afresh: you have none of its history, and should say so if the person refers to it.',
          ...(ask !== null ? [`The person first asked: ${ask}`] : []),
          '</wheems-start-afresh>',
        ].join('\n'),
        line: () => "This conversation starts afresh: your chief of staff doesn't remember it.",
      };
    }
    const from =
      handover.fromEngine !== null
        ? ` It ran on ${handover.fromEngine}${handover.fromModel !== null ? ` (${handover.fromModel})` : ''}.`
        : '';
    return {
      brief: [
        '<wheems-handover>',
        `You're taking over this conversation from an earlier session of its chief of staff, which won't answer any more.${from} ${
          handover.author === 'agent'
            ? 'Below is the handover it wrote for you.'
            : "It couldn't write a handover, so Wheems wrote one from the thread."
        } Treat it as context, and check anything that matters before you act on it. Then answer the message after it, in the thread as usual.`,
        '',
        handover.text,
        '</wheems-handover>',
      ].join('\n'),
      line: (engine, model) => {
        const moved =
          engine !== handover.fromEngine || model !== handover.fromModel
            ? `Your chief of staff now runs on ${engine} (${model}).`
            : 'Your chief of staff started a new session for this conversation.';
        return handover.author === 'agent'
          ? `${moved} It has a handover of this conversation so far.`
          : `${moved} It couldn't get a handover from the last one, so it has a summary of this thread from Wheems.`;
      },
    };
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

  /** Posts an agent's reply (`wheems chat reply`) into its conversation's thread. */
  async reply(key: string, text: string): Promise<void> {
    await this.post(key, text);
    const workspace = (await this.options.store.get(key))?.workspace;
    if (workspace !== undefined) this.solved(workspace);
    this.lastReply.set(key, { at: Date.now(), text: text.trim() });
  }

  private async post(key: string, text: string): Promise<void> {
    const conversation = await this.options.store.get(key);
    if (!conversation) throw new Error(`No conversation ${key}`);
    const at = new Date();
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
    await this.chat(key, 'agent', text, at);
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
        await this.conversationFor(key, binding),
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
    // Messages from Wheems held for the restart: their senders keep them, to deliver after it.
    for (const w of this.waitingForRelease.splice(0)) {
      w.reject(new Error('The service stopped for its restart'));
    }
    clearInterval(this.sweepTimer);
    await Promise.allSettled([...this.watchers]);
  }

  /**
   * Hands a message from Wheems, not the person, to a conversation's session, such as the
   * answer from an ad-hoc session it sent work to. It's delivered after anything queued for
   * the conversation, resuming the session if it has stopped, and the agent's answer is
   * posted to the conversation's thread as any answer is.
   */
  tell(key: string, text: string): Promise<void> {
    return this.options.store.get(key).then(async (conversation) => {
      if (!conversation) throw new Error(`No conversation ${key}`);
      const binding = this.bindingFor(conversation);
      if (!binding) throw new Error(`Conversation ${key}'s workspace or connection isn't running`);
      // Held for a restart: it waits outside the conversation's queue, which setting the
      // conversation up needs, until the hold ends, then goes in. If the service stops first,
      // the caller keeps it, and it's delivered after the restart.
      if (this.held.has(binding.workspace.id)) {
        await this.untilReleased(binding.workspace.id);
        return this.tell(key, text);
      }
      // Set inside the queued work, so an object TypeScript can't see change.
      const meanwhile = { held: false };
      const event: InboundEvent & { type: 'message' } = {
        type: 'message',
        channel: conversation.channel,
        messageId: conversation.thread,
        threadId: conversation.thread,
        userId: '',
        text,
        direct: false,
        receivedAt: new Date(),
      };
      await this.enqueue(key, async () => {
        // Held after it was queued: it leaves the queue at once, and waits as above.
        if (this.held.has(binding.workspace.id)) {
          meanwhile.held = true;
          return;
        }
        await this.deliver(key, binding, event, null).catch((error: unknown) => {
          this.options.log(`Conversation ${key}: ${describe(error)}`);
          return this.notice(
            key,
            binding,
            conversation.thread,
            `Something went wrong passing a message on to the agent: ${describe(error)}`,
          );
        });
      });
      if (meanwhile.held) return this.tell(key, text);
    });
  }

  /** Resolves when a workspace's hold ends; rejects when the service stops first. */
  private untilReleased(workspace: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.waitingForRelease.push({ workspace, resolve, reject });
    });
  }

  /**
   * Starts nothing more for a workspace, and waits for the work already queued for its
   * conversations to end. The service then stops its sessions.
   */
  async retire(workspace: string): Promise<void> {
    this.retired.add(workspace);
    const pending = [...this.queues].filter(([key]) => key.startsWith(`${workspace}:`));
    await Promise.allSettled(pending.map(([, work]) => work));
  }

  /** Serves a workspace again: one made afresh under the name of one retired earlier. */
  unretire(workspace: string): void {
    this.retired.delete(workspace);
  }

  private async deliver(
    key: string,
    binding: Binding,
    event: InboundEvent & { type: 'message' },
    /** The person's message, to mark as seen; null for a message from Wheems. */
    seen: MessageRef | null = { channel: event.channel, messageId: event.messageId },
  ): Promise<void> {
    if (this.retired.has(binding.workspace.id)) {
      this.options.log(`Conversation ${key}: its workspace is no longer served`);
      return;
    }
    // A message from Wheems never gets here while held: tell() keeps it waiting outside.
    if (this.held.has(binding.workspace.id) && seen !== null) {
      this.options.log(`Conversation ${key}: a message came while it waits for the restart`);
      await this.notice(
        key,
        binding,
        replyThread(event),
        'Your chief of staff is restarting with new settings. Send that again in a moment.',
      );
      return;
    }
    const channel = this.channel(binding.connection);
    if (seen && channel.capabilities.reactions)
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
        if (seen) await this.chat(key, 'person', event.text, new Date(sentAt));
        await this.options.store.touch(key, now);
        await this.options.store.addPending(key);
        this.watchTurn(
          key,
          binding,
          sessionName,
          sent.turn,
          seen,
          await this.conversationFor(key, binding),
          false,
          sentAt,
        );
      } catch (error) {
        if (!isDriverError(error, 'blocked')) throw error;
        if (seen) await this.unmark(channel, seen);
        await this.problem(key, binding, replyThread(event), 'blocked', blockedText(session));
      }
      return;
    }

    const engineName = this.chiefOfStaff(binding).definition.engine;
    const untrusted = await this.options.trustProblem(engineName, binding.workspace.dir);
    if (untrusted !== null) {
      this.options.log(`Conversation ${key}: not started, ${engineName} doesn't trust the folder`);
      if (seen) await this.unmark(channel, seen);
      await this.problem(key, binding, replyThread(event), 'untrusted', untrusted);
      return;
    }
    this.solved(binding.workspace.id, 'untrusted');
    const signedOut = await this.options.signInProblem(engineName).catch(() => null);
    if (signedOut !== null) {
      this.options.log(`Conversation ${key}: not started, ${engineName} isn't signed in`);
      if (seen) await this.unmark(channel, seen);
      await this.problem(key, binding, replyThread(event), 'signed-out', signedOut);
      return;
    }
    this.solved(binding.workspace.id, 'signed-out');
    if (session) await this.options.runtime.remove(session.id).catch(() => undefined);
    const engine = this.options.engine(engineName);
    // Handed over, or set to start afresh: a new engine session, not the old one resumed.
    const afresh = existing?.handover;
    // An engine that chooses its own ids can only resume once its id has been found; one that
    // takes Wheems's gets an id of its own for each fresh start.
    const engineId = engine.findSession
      ? afresh !== undefined
        ? null
        : (existing?.engineSessionId ?? null)
      : engineIdFor(key, existing?.generation ?? 0);
    const resume = existing !== undefined && afresh === undefined && engineId !== null;
    if (existing !== undefined && !resume && afresh === undefined) {
      this.options.log(
        `Conversation ${key}: the engine's session id was never found, so it starts afresh`,
      );
    }
    // An engine that picks its own ids finds this launch's session by a tag on the first message.
    const launchTag =
      engine.findSession && !resume
        ? conversationTag(uuidFor(key), randomBytes(8).toString('hex'))
        : undefined;
    const start = afresh !== undefined ? await this.startingFrom(key, afresh) : null;
    const started = await this.startSession(
      key,
      binding,
      start === null ? event.text : `${start.brief}\n\n${event.text}`,
      sessionName,
      resume,
      engineId,
      launchTag,
    );
    if (this.retired.has(binding.workspace.id)) {
      // Retired while it started: it mustn't keep running.
      await this.options.runtime.stop(started.id).catch(() => undefined);
      await this.options.runtime.remove(started.id).catch(() => undefined);
      return;
    }
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
    const chief = this.chiefOfStaff(binding).definition;
    if (start !== null) {
      await this.options.store.startedAfresh(key, {
        engine: chief.engine,
        model: chief.model,
        at: launchedAt,
      });
    }
    // A new thread's first message is the person's ask, which every session started for it keeps.
    const ask = askFrom(event.text);
    if (existing === undefined && ask !== '') await this.options.store.recordAsk(uuidFor(key), ask);
    if (seen) await this.chat(key, 'person', event.text, now);
    // A new session's turns count from 0; its first turn is the message it was started with.
    // `now` was taken before the session started, so a reply to its first message counts.
    this.watchTurn(
      key,
      binding,
      sessionName,
      0,
      seen,
      await this.conversationFor(key, binding),
      false,
      now.getTime(),
    );
    this.options.log(`Started ${started.id} (${sessionName}) for ${key}`);
    if (start !== null) {
      // After its answer is being followed: the line is worth saying, never worth losing the
      // answer over, so a failure to post it is only logged.
      await this.notice(
        key,
        binding,
        replyThread(event),
        start.line(chief.engine, chief.model),
      ).catch((error: unknown) => {
        this.options.log(`Conversation ${key}: couldn't say it started afresh: ${describe(error)}`);
      });
    }
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

  /** The engine conversation to read a thread's answers from: its current generation's. */
  private async conversationFor(
    key: string,
    binding: Binding,
  ): Promise<Pick<Watch, 'conversation' | 'engine'>> {
    const generation = (await this.options.store.get(key))?.generation ?? 0;
    return {
      conversation: { id: engineIdFor(key, generation), dir: binding.workspace.dir },
      engine: this.options.engine(this.chiefOfStaff(binding).definition.engine),
    };
  }

  private async startSession(
    key: string,
    binding: Binding,
    /** The session's first message: the person's, after a handover when there is one. */
    task: string,
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
      goal: await readCapped(join(workspace.dir, GOAL_FILE), GOAL_LIMIT),
    };
    const sessions = this.options.sessionsSection?.(
      workspace,
      `${workspace.id}/${agent.definition.name}`,
    );
    const runtimeSkill = (await this.options.runtime.agentSkill?.()) ?? null;
    const builtins = {
      ...(sessions && { sessions }),
      chief: { team: teamOf(workspace) },
      ...(runtimeSkill !== null && { runtime: runtimeSkill }),
    };
    this.options.log(`Starting ${sessionName} for ${key}${resume ? ' (resuming)' : ''}`);
    const started = await launchSession({
      runtime: this.options.runtime,
      engine,
      agent: {
        ...agent.definition,
        instructions: withBuiltins(agent.definition.instructions, knowledge, builtins),
      },
      skills: builtinSkills(builtins),
      workspace: { id: workspace.id, dir: workspace.dir },
      sessionDir: workspace.dir,
      account: { name: agent.definition.account, driver: account?.driver ?? 'unknown' },
      session: {
        // The engine's name for this generation of the thread; Wheems's id for the session stays.
        id: engineIdFor(key, (await this.options.store.get(key))?.generation ?? 0),
        name: sessionName,
        resume,
        task: launchTag !== undefined ? `${task}\n\n${launchTag}` : task,
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
      // in the next one, so it is followed into the next turn too. A message from Wheems has
      // nothing to mark, but is followed the same way.
      active.queued.push(seen);
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
    const done = async (text: string | null, problem?: Problem) => {
      // Close before any await, so a message arriving from here on is followed afresh.
      watch.closed = true;
      if (this.watches.get(key) === watch) this.watches.delete(key);
      await this.options.store.setPending(key, 0);
      await unmarkSeen();
      for (const message of watch.queued.splice(0)) {
        if (message) await this.unmark(channel, message);
      }
      if (text === null) return;
      if (problem) await this.problem(key, binding, thread, problem, text);
      else await this.notice(key, binding, thread, text);
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
      if (session.status === 'blocked') return done(blockedText(session), 'blocked');
      if (session.status === 'error') {
        return done(
          `The agent hit an error, so it can't answer. See what happened at the Mac: \`hc attach ${session.id}\`.`,
          'error',
        );
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
            'not-started',
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
   * sent word for word with `wheems chat reply` during this turn is not posted again. Returns
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
    // The chief answered: whatever stopped it before is fixed.
    const workspace = (await this.options.store.get(key))?.workspace;
    if (workspace !== undefined) this.solved(workspace);
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
    const target = await this.conversationFor(key, binding);
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
      await this.untilSettled(key, session.id, await this.conversationFor(key, binding));
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
    const target = await this.conversationFor(key, binding);
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

  /**
   * Says why the chief can't answer, unless that was already said for this workspace and
   * hasn't been fixed since. Then it's only logged.
   */
  private async problem(
    key: string,
    binding: Binding,
    thread: string,
    problem: Problem,
    text: string,
  ): Promise<void> {
    const workspace = binding.workspace.id;
    const said = this.problems.get(workspace) ?? new Set<Problem>();
    if (said.has(problem)) {
      this.options.log(`Conversation ${key}: still ${problem}; already said in chat`);
      return;
    }
    said.add(problem);
    this.problems.set(workspace, said);
    try {
      await this.notice(key, binding, thread, text);
    } catch (error) {
      // Not said after all: the next message tries again.
      said.delete(problem);
      throw error;
    }
  }

  /** A workspace's problem is fixed (or all of them, when the chief answers). */
  private solved(workspace: string, problem?: Problem): void {
    if (problem === undefined) this.problems.delete(workspace);
    else this.problems.get(workspace)?.delete(problem);
  }

  private async notice(key: string, binding: Binding, thread: string, text: string): Promise<void> {
    const channel = this.channel(binding.connection);
    const conversation = await this.options.store.get(key);
    const target = conversation?.channel ?? key.split(':')[2] ?? '';
    await channel.send({ channel: target, threadId: thread, text: `_Wheems:_ ${text}` });
    if (conversation) await this.chat(key, 'wheems', text, new Date());
  }

  /**
   * Keeps a turn said in a conversation's thread, to read back in the web app. A turn that
   * seems to hold a password, token or key is kept only as a line saying so, never the text.
   * Keeping it is never worth failing the conversation over, so a failure is only logged.
   */
  private async chat(key: string, author: ChatAuthor, text: string, at: Date): Promise<void> {
    const kept = holdsCredential(text) ? CHAT_WITHHELD : text;
    await this.options.store.recordChat(key, author, kept, at).catch((error: unknown) => {
      this.options.log(`Conversation ${key}: couldn't keep its chat: ${describe(error)}`);
    });
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

/** What's kept of a chat turn that seemed to hold a password, token or key. */
export const CHAT_WITHHELD =
  '(Not kept here: it seemed to hold a password, token or key. It is in the chat.)';

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
/**
 * The engine's id for a thread's session, for engines that take Wheems's: the thread's own at
 * first, and a new one each time it starts afresh, so the old session is never resumed.
 */
export function engineIdFor(key: string, generation: number): string {
  return generation === 0 ? uuidFor(key) : uuidFor(`${key}#${String(generation)}`);
}

/** How a conversation restarts: see `ConversationManager.restart`. */
export type RestartChoice = 'carry-on' | 'hand-over' | 'fresh';

export interface RestartOutcome {
  key: string;
  /** Whether it was restarted as chosen; when not, it's left as it was. */
  done: boolean;
  text: string;
}

/** A chat thread, as the person sees it when choosing how it restarts. */
export interface OpenConversation {
  key: string;
  session: string;
  ask: string | null;
  lastActiveAt: string;
  /** Its session is running in Herdr now, so a handover can come from its agent. */
  running: boolean;
  /** It's answering a message, so it can't be restarted just now. */
  busy: boolean;
  /** It's already set to start afresh at its next message. */
  startsAfresh: boolean;
}

/** How many of a thread's latest turns a handover Wheems writes includes, and how much of each. */
const HANDOVER_TURNS = 20;
const HANDOVER_TURN_CHARS = 2000;

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

/** Why a chief can't answer: each is said in chat once until it's fixed. */
type Problem = 'untrusted' | 'signed-out' | 'blocked' | 'not-started' | 'error' | 'failed';

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

/** The most of a person's message kept as a session's ask. */
const ASK_LIMIT = 2000;

/**
 * A first message as a session's ask: trimmed, and cut short when it's very long. Empty when it
 * seems to hold a password, token or key, so no ask is kept and none is passed on.
 */
export function askFrom(text: string): string {
  const trimmed = text.trim();
  if (holdsCredential(trimmed)) return '';
  return trimmed.length <= ASK_LIMIT ? trimmed : `${trimmed.slice(0, ASK_LIMIT - 1)}…`;
}
