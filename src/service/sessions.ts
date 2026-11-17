import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  END_NOTE_REQUEST,
  builtinSkills,
  withBuiltins,
  workerInstructions,
  type OpenSession,
} from '../agents/builtin.js';
import { isChief } from '../agents/team.js';
import { GOAL_FILE, type LoadedAgent, type LoadedWorkspace } from '../config/load.js';
import type { InstallConfig } from '../config/schemas.js';
import { isDriverError } from '../contracts/driver.js';
import { conversationTag, type EngineDriver, type FinalMessage } from '../contracts/engine.js';
import type { RuntimeDriver, SessionInfo } from '../contracts/runtime.js';
import {
  ABOUT_YOU_LIMIT,
  BRIEF_LIMIT,
  GOAL_LIMIT,
  knowledgePaths,
  looksLikeSecret,
  noteTitle,
  readCapped,
} from '../knowledge/notes.js';
import {
  SESSION_LABEL,
  sessionLabels,
  type MessageKind,
  type MessageRecord,
  type SessionFilter,
  type SessionKind,
  type SessionRecord,
  type SessionState,
  type StateStore,
  type WorkspaceSessions,
} from '../state/store.js';
import { launchSession } from './launch.js';

/** Who a request says is calling: the ids Wheems put in a session's environment, or neither. */
export interface CallerRef {
  /** `WHEEMS_SESSION`. */
  session?: string;
  /** `WHEEMS_CONVERSATION`, for thread sessions started before sessions had ids. */
  conversation?: string;
  /** For the person at a terminal, who isn't a session: the workspace to act in. */
  workspace?: string;
}

/** The caller, as the service knows it. */
export interface Caller {
  workspace: LoadedWorkspace;
  /** The calling session, or null for the person. */
  session: SessionRecord | null;
  /**
   * Who owns the sessions this caller starts: a chief's thread session starts them for the
   * chief (its agent id), an ad-hoc session for itself (its id), the person for nobody (null).
   */
  owner: string | null;
}

export interface NewSessionRequest {
  agent?: string;
  title: string;
  purpose: string;
  /** What must be true when the job is done, in things that can be checked. A chief must give it. */
  doneWhen?: string;
  project?: string;
}

export interface ListRequest {
  mine?: boolean;
  agent?: string;
  project?: string;
  state?: SessionState;
  kind?: SessionKind;
  /** Include ended sessions. */
  all?: boolean;
}

/** One session for `show`: its record, what Herdr says about it now, and its latest answer. */
export interface SessionDetails {
  session: SessionRecord;
  /** Herdr's id for its running session, or null when it isn't running. */
  runtimeId: string | null;
  status: string | null;
  latestAnswer: string | null;
  /** Its latest messages, sent or received, newest first, each with its first line. */
  messages: (MessageRecord & { preview: string })[];
}

export interface SendRequest {
  /** The session's id, or `owner` for the calling session's owner. */
  id: string;
  text: string;
  /** Wait for the answer, up to `waitSeconds`. */
  wait?: boolean;
  waitSeconds?: number;
}

export interface SendResult {
  message: MessageRecord;
  /** The answer, when the caller waited and it came in time. */
  answer: string | null;
  /** What happens next, when there's no answer here. */
  next: string;
}

/** How following a message ended: its answer, or why there's none. */
type Outcome = { answer: string; problem: null } | { answer: null; problem: string };

export interface SessionServiceOptions {
  install: InstallConfig;
  /** The workspaces the service runs. */
  workspaces: LoadedWorkspace[];
  state: StateStore;
  runtime: RuntimeDriver;
  engine: (name: string) => EngineDriver;
  /**
   * Where ad-hoc sessions' folders go: `<stateDir>/sessions/<workspace>/adhoc/<id>/`, under
   * `adhoc/` so an id can never collide with a per-agent folder beside it.
   */
  stateDir: string;
  /** Environment every agent session gets, such as PATH with the `wheems` command first. */
  sessionEnv: Record<string, string>;
  /**
   * Why an engine can't start in a folder, because it doesn't trust it and would wait at its
   * "trust this folder?" question, which nobody sees; null when it can (or can't tell). Asked
   * before a session starts or resumes.
   */
  trustProblem?: (engine: string, dir: string) => Promise<string | null>;
  aboutYouFile?: string;
  startupSeconds?: number;
  pollMs?: number;
  typeDelayMs?: number;
  answerPollMs?: number;
  /** How long a session gets to write its note when it's ended. */
  noteTurnSeconds?: number;
  /** How long a session gets to answer a message before it counts as unanswered. */
  answerWaitSeconds?: number;
  /** How long `send --wait` waits by default before the answer is handed back later instead. */
  sendWaitSeconds?: number;
  /**
   * Hands a message from Wheems to a thread session, through its conversation, so its answer
   * reaches the person on whatever channel that is. The sessions code never posts anything.
   */
  tell?: (threadSessionId: string, text: string) => Promise<void>;
  /** Called once an ad-hoc session has ended, such as to withdraw the approvals it asked. */
  onEnded?: (session: SessionRecord) => void;
  log?: (message: string) => void;
}

const TITLE_LIMIT = 80;
const PURPOSE_LIMIT = 2000;
const DONE_WHEN_LIMIT = 1000;
/** From this many answers to the same sender, its hand-back says to stop sending the job back. */
const SEND_BACK_ANSWERS = 3;
const MESSAGE_LIMIT = 20_000;
const LONGEST_WAIT_SECONDS = 3600;

/**
 * Ad-hoc sessions: started on the fly by a chief, another session or the person, for one piece
 * of work, and open until ended. Everything here acts for a caller, in the caller's workspace
 * only, and goes through the store's workspace filter.
 */
export class SessionService {
  private readonly options: Required<
    Omit<SessionServiceOptions, 'aboutYouFile' | 'tell' | 'onEnded'>
  > & {
    aboutYouFile: string | undefined;
    tell: SessionServiceOptions['tell'];
    onEnded: SessionServiceOptions['onEnded'];
  };
  private readonly ending = new Set<string>();
  /** Starting and resuming sessions, one at a time, so none slips past a limit. */
  private admitting: Promise<unknown> = Promise.resolve();
  /**
   * Each ad-hoc session's messages, delivered and followed one at a time, so every answer is
   * matched to its message. A session with one here has its state kept by the follower.
   */
  private readonly inbox = new Map<string, Promise<unknown>>();
  /** Who's waiting on whom with `send --wait`: a session's id, then the ones it waits on. */
  private readonly waits = new Map<string, string[]>();
  private stopped = false;
  /** Workspaces no longer served (archived or removed): no session starts or resumes in them. */
  private readonly retired = new Set<string>();
  /**
   * Ad-hoc sessions whose turn didn't finish and couldn't be stopped: the runtime session, and
   * the answer before that turn. Nothing more is typed into one until that turn is over.
   */
  private readonly unfinished = new Map<string, { runtimeId: string; after: string | null }>();

  constructor(options: SessionServiceOptions) {
    this.options = {
      startupSeconds: 90,
      pollMs: 1000,
      typeDelayMs: 5000,
      answerPollMs: 2000,
      noteTurnSeconds: 600,
      answerWaitSeconds: 3600,
      sendWaitSeconds: 600,
      log: () => undefined,
      trustProblem: () => Promise.resolve(null),
      aboutYouFile: undefined,
      tell: undefined,
      onEnded: undefined,
      ...options,
    };
  }

  /**
   * Stops following messages, and waits for the followers to let go. Sessions themselves keep
   * running; a message still waiting for its answer is marked failed when the service next
   * starts.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    while (this.inbox.size > 0) await Promise.allSettled([...this.inbox.values()]);
  }

  /**
   * Starts and resumes nothing more in a workspace, and waits for what was already admitted or
   * queued for its sessions to end. The service then stops its sessions.
   */
  async retire(workspace: string): Promise<void> {
    this.retired.add(workspace);
    await this.admitting.catch(() => undefined);
    const pending = [...this.inbox].filter(
      ([id]) => this.options.state.callingSession(id)?.workspace === workspace,
    );
    await Promise.allSettled(pending.map(([, work]) => work));
  }

  /** Serves a workspace again: one made afresh under the name of one retired earlier. */
  unretire(workspace: string): void {
    this.retired.delete(workspace);
  }

  /** Refuses work in a workspace that's no longer served. */
  private served(workspace: string): void {
    if (this.retired.has(workspace)) throw new Error(`Workspace ${workspace} is no longer served`);
  }

  /** Works out who's calling. The workspace comes from the calling session when there is one. */
  caller(ref: CallerRef): Caller {
    const { state } = this.options;
    let id = ref.session;
    if (
      (id === undefined || id === '') &&
      ref.conversation !== undefined &&
      ref.conversation !== ''
    ) {
      id = state.conversation(ref.conversation)?.sessionId;
      if (id === undefined) throw new Error(`No conversation ${ref.conversation}`);
    }
    if (id !== undefined && id !== '') {
      const session = state.callingSession(id);
      if (!session) throw new Error(`No session ${id}`);
      if (session.state === 'ended') throw new Error(`Session ${id} has ended`);
      if (ref.workspace !== undefined && ref.workspace !== session.workspace) {
        throw new Error(
          `A session can only act in its own workspace, ${session.workspace}, not ${ref.workspace}`,
        );
      }
      this.served(session.workspace);
      const owner = session.kind === 'thread' ? (session.agent ?? session.id) : session.id;
      return { workspace: this.workspace(session.workspace), session, owner };
    }
    if (ref.workspace === undefined) {
      const running = this.options.workspaces.filter((w) => w.config !== null);
      if (running.length !== 1 || !running[0]) {
        throw new Error(
          `Say which workspace with --workspace: ${running.map((w) => w.id).join(', ')}`,
        );
      }
      return { workspace: running[0], session: null, owner: null };
    }
    return { workspace: this.workspace(ref.workspace), session: null, owner: null };
  }

  /** Starts an ad-hoc session owned by the caller, working on its purpose at once. */
  create(caller: Caller, request: NewSessionRequest): Promise<SessionRecord> {
    return this.admit(() => this.createNow(caller, request));
  }

  /** Runs work that starts a session after the work already admitted, one at a time. */
  private admit<T>(work: () => Promise<T>): Promise<T> {
    const next = this.admitting.then(work);
    this.admitting = next.catch(() => undefined);
    return next;
  }

  private async createNow(caller: Caller, request: NewSessionRequest): Promise<SessionRecord> {
    const workspace = caller.workspace;
    this.served(workspace.id);
    const config = workspace.config;
    if (!config)
      throw new Error(`Workspace ${workspace.id} has config problems; run wheems doctor`);
    const title = request.title.trim();
    const purpose = request.purpose.trim();
    checkText('title', title, TITLE_LIMIT);
    checkText('purpose', purpose, PURPOSE_LIMIT);
    const doneWhen = request.doneWhen?.trim() ?? '';
    if (doneWhen !== '') checkText('done-when line', doneWhen, DONE_WHEN_LIMIT);
    // A chief hands every job on, so each one needs a finish line to check the answer against.
    if (doneWhen === '' && caller.session?.kind === 'thread') {
      throw new Error(
        "A chief of staff's session needs --done-when: what must be true when the job is finished, in things you can check, such as a test that passes, a page that loads or a file that exists.",
      );
    }
    if (title.includes('\n')) throw new Error('The title is one line.');
    if (request.project !== undefined) {
      throw new Error('Projects arrive in milestone 4; leave out --project for now.');
    }

    const agent = this.agentFor(caller, request.agent);
    const sessions = this.sessions(caller);
    const limits = config.sessions;
    const open = sessions.openCount(caller.owner);
    if (open >= limits.max_open_per_owner) {
      throw new Error(
        `${ownerName(caller)} already has ${String(open)} open sessions, the most allowed (sessions.max_open_per_owner). End one first with wheems session end <id>.`,
      );
    }
    const depth = caller.session ? sessions.depth(caller.session.id) + 1 : 1;
    if (depth > limits.max_depth) {
      throw new Error(
        `Sessions can only start sessions ${String(limits.max_depth)} levels deep (sessions.max_depth), so this session can't start another. Do the work yourself, or ask your owner.`,
      );
    }
    await this.checkAccountLimit(agent.definition.account);
    // Its folder will be in this one, so an engine that doesn't trust this won't trust that.
    const adhoc = join(this.options.stateDir, 'sessions', workspace.id, 'adhoc');
    await mkdir(adhoc, { recursive: true });
    await this.checkTrust(agent.definition.engine, adhoc);

    const id = randomUUID();
    const folder = join(adhoc, id);
    await mkdir(folder, { recursive: true });
    const now = new Date();
    const record = sessions.create({
      id,
      project: null,
      agent: `${workspace.id}/${agent.definition.name}`,
      owner: caller.owner,
      parent: caller.session?.id ?? null,
      title,
      purpose,
      // The person's ask carries down from the session that started this one. When the person
      // starts it themselves, its purpose is their ask.
      ask: caller.session ? caller.session.ask : purpose,
      doneWhen: doneWhen === '' ? null : doneWhen,
      herdrName: `${workspace.id.slice(0, 20)}-s${id.slice(0, 8)}`,
      folder,
      createdAt: now.toISOString(),
    });
    const engine = this.options.engine(agent.definition.engine);
    // An engine that chooses its own ids finds this session by a tag on its first message.
    const launchTag = engine.findSession
      ? conversationTag(id, randomBytes(8).toString('hex'))
      : undefined;
    let started: SessionInfo;
    try {
      started = await this.launch(caller.workspace, record, agent, engine, {
        resume: false,
        engineId: engine.findSession ? null : id,
        task: launchTag !== undefined ? `${purpose}\n\n${launchTag}` : purpose,
      });
      // Retired while it started: the catch below stops it.
      this.served(workspace.id);
      sessions.update(id, {
        state: 'working',
        launchStartedAt: now.toISOString(),
        launchedAt: new Date().toISOString(),
        ...(launchTag !== undefined && { launchTag }),
      });
      this.options.log(
        `Started session ${id} (${started.id}) in ${workspace.id} for ${ownerName(caller)}: ${title}`,
      );
    } catch (error) {
      // It may have started before the launch failed, such as when typing its first message.
      if (await this.stopRuntimeSession(record.herdrName ?? '')) {
        sessions.update(id, { state: 'ended', endedAt: new Date().toISOString() });
      } else {
        sessions.update(id, { state: 'stopped' });
        this.options.log(
          `Session ${id} failed to start, and its Herdr session couldn't be stopped`,
        );
      }
      throw error;
    }
    // The purpose is its first message, from whoever started it: its answer goes back to them
    // as a send's does.
    const first = await this.record(workspace, caller.session?.id ?? null, id, purpose);
    void this.enqueue(id, () => this.follow(workspace, id, first, started.id, 0, null)).then(
      (outcome) => this.handBack(workspace, caller.session?.id ?? null, id, outcome),
    );
    return sessions.session(id) ?? record;
  }

  /**
   * Sends a message into a session, resuming it first if it has stopped. With `wait`, returns
   * its answer if it comes in time; otherwise the answer goes back to the sender when it comes:
   * typed into an ad-hoc session, or into a chief's conversation, which answers on its channel.
   */
  async send(caller: Caller, request: SendRequest): Promise<SendResult> {
    const text = request.text.trim();
    if (text === '') throw new Error('The message is empty.');
    if (text.length > MESSAGE_LIMIT) {
      throw new Error(`The message is longer than ${String(MESSAGE_LIMIT)} characters.`);
    }
    const target = this.target(caller, request.id);
    const wait = request.wait === true;
    this.checkMaySend(caller, target, wait);
    if (target.kind !== 'thread') await this.checkTrustToResume(caller.workspace, target);
    const from = caller.session;
    const workspace = caller.workspace;
    const sessions = this.sessions(caller);
    const typed = `Wheems: message from ${ownerName(caller)}:\n\n${text}`;

    if (target.kind === 'thread') {
      const tell = this.options.tell;
      if (!tell) throw new Error(`Session ${target.id}'s conversation can't be reached`);
      const message = await this.record(workspace, from?.id ?? null, target.id, text);
      try {
        await tell(target.id, typed);
      } catch (error) {
        sessions.finishMessage(message.id, 'failed', null, new Date().toISOString());
        throw error;
      }
      sessions.finishMessage(message.id, 'answered', null, new Date().toISOString());
      return {
        message: sessions.message(message.id) ?? message,
        answer: null,
        next: 'It answers in its own conversation, in its own time.',
      };
    }

    const waiter = wait ? from : null;
    if (waiter !== null) {
      if (this.waitsOn(target.id, waiter.id)) {
        throw new Error(
          `Session ${target.id} is waiting on you, so you can't wait on it: the two of you would wait for ever. Send without --wait.`,
        );
      }
      // Taken at once, with nothing awaited since the check, so two waits can't cross.
      this.addWait(waiter.id, target.id);
    }
    let message: MessageRecord;
    try {
      message = await this.record(workspace, from?.id ?? null, target.id, text);
    } catch (error) {
      if (waiter !== null) this.removeWait(waiter.id, target.id);
      throw error;
    }
    const outcome = this.enqueue(target.id, () =>
      this.deliver(workspace, target.id, message, typed),
    );
    const handBack = () =>
      void outcome.then((o) => this.handBack(workspace, from?.id ?? null, target.id, o));
    const later =
      from === null
        ? `Its answer is kept: see it with wheems session show ${target.id}.`
        : from.kind === 'thread'
          ? 'Its answer will come to you in this conversation, as a message from Wheems.'
          : 'Its answer will be typed into your session, as a message from Wheems.';
    if (!wait) {
      handBack();
      return { message, answer: null, next: later };
    }
    const seconds = Math.min(
      LONGEST_WAIT_SECONDS,
      Math.max(1, request.waitSeconds ?? this.options.sendWaitSeconds),
    );
    const timer = timeout(seconds * 1000);
    try {
      const result = await Promise.race([outcome, timer.done]);
      if (result === null) {
        handBack();
        return {
          message: sessions.message(message.id) ?? message,
          answer: null,
          next: `It hasn't answered within ${String(seconds)} seconds. ${later}`,
        };
      }
      if (result.answer === null) {
        throw new Error(`No answer from session ${target.id}: ${result.problem}`);
      }
      // A session waiting on the answer checks it against the finish line, as a hand-back would.
      const answer =
        from !== null
          ? `${result.answer}${finishLine(target.doneWhen, sessions.answerCount(from.id, target.id))}`
          : result.answer;
      return { message: sessions.message(message.id) ?? message, answer, next: '' };
    } finally {
      timer.cancel();
      if (waiter !== null) this.removeWait(waiter.id, target.id);
    }
  }

  /** The caller's workspace's sessions: open ones unless asked for ended ones too. */
  async list(caller: Caller, request: ListRequest = {}): Promise<SessionRecord[]> {
    await this.refresh(caller);
    const filter: SessionFilter = {
      ...(request.kind !== undefined && { kind: request.kind }),
      ...(request.state !== undefined && { state: request.state }),
      ...(request.project !== undefined && { project: request.project }),
      ...(request.agent !== undefined && {
        agent: request.agent.includes('/')
          ? request.agent
          : `${caller.workspace.id}/${request.agent}`,
      }),
      ...(request.mine === true && { owner: caller.owner }),
    };
    const found = this.sessions(caller).sessions(filter);
    return request.all === true || request.state !== undefined
      ? found
      : found.filter((s) => s.state !== 'ended');
  }

  async search(caller: Caller, words: string): Promise<SessionRecord[]> {
    await this.refresh(caller);
    return this.sessions(caller).search(words);
  }

  /** One session in the caller's workspace, with what Herdr says now and its latest answer. */
  async show(caller: Caller, id: string): Promise<SessionDetails> {
    await this.refresh(caller);
    const session = this.find(caller, id);
    const live =
      session.herdrName !== null && session.state !== 'ended'
        ? await this.options.runtime.get(session.herdrName)
        : null;
    let latestAnswer: string | null = null;
    if (session.kind === 'adhoc') {
      const answers = await this.answers(caller, session, null).catch(() => []);
      latestAnswer = answers.at(-1)?.text ?? null;
    }
    const messages = await Promise.all(
      this.sessions(caller)
        .messages(session.id)
        .map(async (m) => ({ ...m, preview: await firstLine(m.messageFile) })),
    );
    return {
      session,
      runtimeId: live?.state === 'live' ? live.id : null,
      status: live?.state === 'live' ? live.status : null,
      latestAnswer,
      messages,
    };
  }

  /**
   * Ends an ad-hoc session, run by its owner or the person: asks it for its note first, as
   * Wheems does before stopping any session, then stops it and marks it ended. An ended
   * session stays in the store and in search, as a record.
   */
  async end(caller: Caller, id: string): Promise<{ session: SessionRecord; noted: boolean }> {
    const session = this.find(caller, id);
    if (session.kind !== 'adhoc')
      throw new Error(`Only ad-hoc sessions can be ended; ${id} isn't one`);
    if (session.state === 'ended') throw new Error(`Session ${id} has already ended`);
    if (caller.session !== null && caller.owner !== session.owner) {
      throw new Error(`Only its owner or the person can end session ${id}`);
    }
    if (this.ending.has(id)) throw new Error(`Session ${id} is already being ended`);
    this.ending.add(id);
    try {
      const sessions = this.sessions(caller);
      const live =
        session.herdrName !== null ? await this.options.runtime.get(session.herdrName) : null;
      let noted = false;
      if (live?.state === 'live') noted = await this.askForNote(caller, session, live);
      if (session.herdrName !== null && !(await this.stopRuntimeSession(session.herdrName))) {
        throw new Error(
          `Couldn't stop session ${id}'s agent, so it hasn't ended. Its Herdr session is ${session.herdrName}; try again, or stop it with hc kill.`,
        );
      }
      const now = new Date().toISOString();
      sessions.update(id, { state: 'ended', endedAt: now, lastActiveAt: now });
      this.options.log(
        `Ended session ${id} in ${caller.workspace.id}${noted ? ', with its note' : ''}`,
      );
      const ended = sessions.session(id) ?? session;
      try {
        this.options.onEnded?.(ended);
      } catch (error) {
        this.options.log(`After ending session ${id}: ${describe(error)}`);
      }
      return { session: ended, noted };
    } finally {
      this.ending.delete(id);
    }
  }

  /**
   * Delivers a message from Wheems to a session, such as an approval's answer: typed into an
   * ad-hoc session, or told to a chief's conversation. It's kept as a hand-back first, so a
   * restart doesn't lose it, and resolves once it's kept; delivery carries on after. False when
   * there's no such session, or it has ended.
   */
  async notify(
    workspaceId: string,
    toId: string,
    /** The session it's about, or null for none, such as when the person answered. */
    aboutId: string | null,
    text: string,
  ): Promise<boolean> {
    const workspace = this.workspace(workspaceId);
    const to = this.options.state.workspace(workspaceId).session(toId);
    if (!to || to.state === 'ended' || this.stopped) return false;
    const kept = await this.record(workspace, aboutId, to.id, text, 'handback');
    void this.passBack(workspace, to, aboutId ?? 'wheems', text, kept);
    return true;
  }

  /**
   * The chief's chat thread a session's work came from: the session itself for a thread, or the
   * thread above an ad-hoc session's starters. Null when none, as for one the person started.
   */
  chiefThreadOf(session: SessionRecord): SessionRecord | null {
    const sessions = this.options.state.workspace(session.workspace);
    let current: SessionRecord | undefined = session;
    for (let depth = 0; current && depth < 100; depth++) {
      if (current.kind === 'thread') return current;
      current = current.parent === null ? undefined : sessions.session(current.parent);
    }
    return null;
  }

  /**
   * Who hears about an ad-hoc session's work when it can't: its owner's session, or the session
   * that started it. Null when the person started it, or neither is open.
   */
  ownerOf(session: SessionRecord): SessionRecord | null {
    const sessions = this.options.state.workspace(session.workspace);
    const owner =
      (session.owner !== null ? sessions.session(session.owner) : undefined) ??
      (session.parent !== null ? sessions.session(session.parent) : undefined);
    return owner && owner.state !== 'ended' ? owner : null;
  }

  /** A note from an ad-hoc session: its title becomes the session's summary. */
  noted(sessionId: string, text: string): void {
    const session = this.options.state.callingSession(sessionId);
    if (session?.kind !== 'adhoc') return;
    const summary = noteTitle(text).trim().slice(0, 200);
    if (summary === '' || looksLikeSecret(summary)) return;
    this.options.state
      .workspace(session.workspace)
      .update(sessionId, { summary, lastActiveAt: new Date().toISOString() });
  }

  /** The workspace and agent of a session, for notes and skill proposals from it. */
  agentOf(sessionId: string): { workspace: LoadedWorkspace; agent: LoadedAgent } {
    const session = this.options.state.callingSession(sessionId);
    if (!session) throw new Error(`No session ${sessionId}`);
    const workspace = this.workspace(session.workspace);
    const name = session.agent?.split('/').at(-1) ?? workspace.config?.chief_of_staff;
    const agent = workspace.agents.find((a) => a.definition.name === name);
    if (!agent) throw new Error(`Session ${sessionId}'s agent ${String(name)} has no agent file`);
    return { workspace, agent };
  }

  /** The Sessions section for an agent that may start sessions: its owner's open sessions. */
  sessionsSection(
    workspace: LoadedWorkspace,
    owner: string | null,
  ): { maxOpen: number; open: OpenSession[] } | undefined {
    const config = workspace.config;
    if (!config) return undefined;
    const open = this.options.state
      .workspace(workspace.id)
      .sessions({ kind: 'adhoc', owner })
      .filter((s) => s.state !== 'ended')
      .map((s) => ({
        id: s.id,
        title: s.title ?? '',
        state: s.state,
        summary: s.summary ?? '',
      }));
    return { maxOpen: config.sessions.max_open_per_owner, open };
  }

  /** The session a send goes to: by id in the caller's workspace, or the caller's owner. */
  private target(caller: Caller, id: string): SessionRecord {
    if (id !== 'owner') return this.find(caller, id);
    const me = caller.session;
    if (me?.kind !== 'adhoc') throw new Error('Only an ad-hoc session has an owner to send to.');
    if (me.owner === null) {
      throw new Error(
        'The person started you, and reads your answers with wheems session show: there is no owner to send to.',
      );
    }
    const sessions = this.sessions(caller);
    // A chief owns the sessions its threads start: the thread that started this one hears it.
    const owner =
      sessions.session(me.owner) ?? (me.parent !== null ? sessions.session(me.parent) : undefined);
    if (!owner) throw new Error("Your owner's session can't be found.");
    return owner;
  }

  /**
   * Who may send to whom, within the caller's workspace: the person and chiefs to any ad-hoc
   * session; any other session to the sessions it owns and to its owner. A chief hears from the
   * sessions it owns in the thread that started them, and never with a wait.
   */
  private checkMaySend(caller: Caller, target: SessionRecord, wait: boolean): void {
    const me = caller.session;
    if (me?.id === target.id) throw new Error("A session can't send to itself.");
    if (target.state === 'ended') {
      throw new Error(`Session ${target.id} has ended, so it can't be sent messages.`);
    }
    if (this.ending.has(target.id)) throw new Error(`Session ${target.id} is being ended.`);
    if (target.kind === 'thread') {
      const fromItsSession =
        me?.kind === 'adhoc' && me.parent === target.id && me.owner === target.agent;
      if (!fromItsSession) {
        throw new Error(
          `Session ${target.id} is a conversation with the person. Only the sessions it started can send to it, with wheems session send owner.`,
        );
      }
      if (wait) {
        throw new Error(
          "Your owner answers in its own conversation, in its own time, so a send to it can't wait. Send it without --wait.",
        );
      }
      return;
    }
    if (target.kind !== 'adhoc') throw new Error(`Session ${target.id} can't be sent messages.`);
    if (target.state === 'starting') {
      throw new Error(`Session ${target.id} is still starting. Try again in a minute.`);
    }
    if (me === null || me.kind === 'thread') return;
    if (target.owner === me.id || target.id === me.owner) return;
    throw new Error(
      `A session may only send to its owner and to the sessions it owns, and ${target.id} is neither.`,
    );
  }

  /** Whether `from` is waiting on `to`, directly or through sessions waiting on each other. */
  private waitsOn(from: string, to: string, seen = new Set<string>()): boolean {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (this.waits.get(from) ?? []).some((next) => this.waitsOn(next, to, seen));
  }

  private addWait(from: string, to: string): void {
    this.waits.set(from, [...(this.waits.get(from) ?? []), to]);
  }

  private removeWait(from: string, to: string): void {
    const waits = [...(this.waits.get(from) ?? [])];
    const at = waits.indexOf(to);
    if (at >= 0) waits.splice(at, 1);
    if (waits.length === 0) this.waits.delete(from);
    else this.waits.set(from, waits);
  }

  /** Runs work for one session's inbox after the work already queued for it. */
  private enqueue<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const next = (this.inbox.get(sessionId) ?? Promise.resolve()).then(work);
    const settled = next.catch(() => undefined);
    this.inbox.set(sessionId, settled);
    void settled.then(() => {
      if (this.inbox.get(sessionId) === settled) this.inbox.delete(sessionId);
    });
    return next;
  }

  /** Keeps a message as a file under `.wheems/messages/<workspace>/`, and records it. */
  private async record(
    workspace: LoadedWorkspace,
    sender: string | null,
    receiver: string,
    text: string,
    kind: MessageKind = 'message',
  ): Promise<MessageRecord> {
    const { id, file } = await this.messageFile(workspace, text);
    return this.options.state.workspace(workspace.id).addMessage({
      id,
      kind,
      sender,
      receiver,
      messageFile: file,
      sentAt: new Date().toISOString(),
    });
  }

  /** Writes a message's text to a new file under `.wheems/messages/<workspace>/`. */
  private async messageFile(
    workspace: LoadedWorkspace,
    text: string,
  ): Promise<{ id: string; file: string }> {
    const id = randomUUID();
    const dir = join(this.options.stateDir, 'messages', workspace.id);
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${id}.md`);
    await writeFile(file, `${text}\n`);
    return { id, file };
  }

  /**
   * Types a message into an ad-hoc session, resuming it first if it has stopped, and follows
   * the turn it starts to its answer. Answers handed back come this way too, so the next
   * message's answer is always its own.
   */
  private async deliver(
    workspace: LoadedWorkspace,
    targetId: string,
    message: MessageRecord,
    text: string,
  ): Promise<Outcome> {
    const sessions = this.options.state.workspace(workspace.id);
    const caller = workspaceCaller(workspace);
    const fail = (problem: string): Outcome => {
      if (!this.stopped)
        sessions.finishMessage(message.id, 'failed', null, new Date().toISOString());
      return { answer: null, problem };
    };
    try {
      const target = sessions.session(targetId);
      if (!target || target.state === 'ended') return fail('it has ended');
      const engine = this.engineOf(caller, target);
      if (!(await this.untilFree(caller, target))) {
        const runtimeId = this.unfinished.get(targetId)?.runtimeId ?? target.herdrName ?? '';
        return fail(
          `it's still busy with an earlier turn, which couldn't be stopped. See it with hc attach ${runtimeId}`,
        );
      }
      // Taken once any earlier turn is over, so its late answer isn't taken for this one's.
      const before = (await this.answers(caller, target, null).catch(() => [])).at(-1)?.id ?? null;
      const live =
        target.herdrName !== null ? await this.options.runtime.get(target.herdrName) : null;
      if (live?.state !== 'live') {
        const started = await this.admit(() =>
          this.resume(workspace, target, engine, text, before),
        );
        return await this.follow(workspace, targetId, message, started.id, 0, before);
      }
      if (engine.capabilities.status) {
        await this.untilReady(live.id);
      } else if (target.launchedAt !== null) {
        // No status to say it has started: give a new session its start-up time first.
        const wait = Date.parse(target.launchedAt) + this.options.typeDelayMs - Date.now();
        if (wait > 0) await sleep(wait);
      }
      let fromTurn: number;
      try {
        fromTurn = (await this.options.runtime.send(live.id, text)).turn;
      } catch (error) {
        if (isDriverError(error, 'blocked')) {
          return fail(`it's waiting for an answer at the Mac: hc attach ${live.id}`);
        }
        // The text may have gone in before the error: treat it as a turn that may be running.
        if (!this.stopped) await this.cutShort(workspace, targetId, live.id, before);
        throw error;
      }
      return await this.follow(workspace, targetId, message, live.id, fromTurn, before);
    } catch (error) {
      return fail(describe(error));
    }
  }

  /** Follows a session's turn after `fromTurn` to its answers after `before`, and keeps them. */
  private async follow(
    workspace: LoadedWorkspace,
    targetId: string,
    message: MessageRecord,
    runtimeId: string,
    fromTurn: number,
    before: string | null,
  ): Promise<Outcome> {
    const sessions = this.options.state.workspace(workspace.id);
    const caller = workspaceCaller(workspace);
    const finish = (state: 'answered' | 'failed', answerFile: string | null) => {
      // A service that's stopping leaves the message waiting, to be marked when it next starts.
      if (this.stopped) return;
      const now = new Date().toISOString();
      sessions.finishMessage(message.id, state, answerFile, now);
      if (!this.unfinished.has(targetId)) {
        sessions.update(targetId, { state: 'idle', lastActiveAt: now }, 'working');
      }
    };
    /** Whether the turn is known to be over, so an error after it needs no stopping. */
    let turnOver = false;
    try {
      const target = sessions.session(targetId);
      if (!target) throw new Error('it has gone from the store');
      sessions.update(
        targetId,
        { state: 'working', lastActiveAt: new Date().toISOString() },
        target.state,
      );
      const ended = await this.untilTurnEnds(
        caller,
        target,
        runtimeId,
        fromTurn,
        before,
        this.options.answerWaitSeconds,
      );
      if (this.stopped) return { answer: null, problem: 'the service stopped' };
      turnOver = ended;
      // A turn still running would answer into the next message's turn, so it's stopped.
      const cutShort = ended
        ? null
        : await this.stopUnfinishedTurn(workspace, targetId, runtimeId, before);
      // The engine may still be writing its record when the turn ends; give it a moment. A
      // turn that didn't end as expected may still have answered, such as one that took the
      // message in while it was busy.
      let found: FinalMessage[] = [];
      for (let attempt = 0; attempt < (ended ? 5 : 1) && found.length === 0; attempt++) {
        if (attempt > 0) await sleep(Math.max(50, this.options.pollMs));
        found = await this.answers(caller, sessions.session(targetId) ?? target, before).catch(
          () => [],
        );
      }
      const answer = found
        .map((a) => a.text.trim())
        .filter((t) => t !== '')
        .join('\n\n');
      if (answer === '') {
        finish('failed', null);
        return {
          answer: null,
          problem: ended
            ? 'it finished without answering'
            : (cutShort ?? 'it gave no answer in time'),
        };
      }
      const answerFile = message.messageFile.replace(/\.md$/, '.answer.md');
      await writeFile(answerFile, `${answer}\n`);
      finish('answered', answerFile);
      return { answer, problem: null };
    } catch (error) {
      // Following failed partway: the turn may still be running, so it's stopped or held.
      if (!turnOver && !this.stopped) await this.cutShort(workspace, targetId, runtimeId, before);
      finish('failed', null);
      return { answer: null, problem: describe(error) };
    }
  }

  /** Stops a turn that may still be running, or holds the session if that fails in any way. */
  private async cutShort(
    workspace: LoadedWorkspace,
    targetId: string,
    runtimeId: string,
    before: string | null,
  ): Promise<void> {
    try {
      await this.stopUnfinishedTurn(workspace, targetId, runtimeId, before);
    } catch {
      this.unfinished.set(targetId, { runtimeId, after: before });
    }
  }

  /**
   * After following a turn gave up: if the turn may still be running (working, blocked, or with
   * no status to say), stops the session, so a late answer can't be taken for the next message's.
   * The next message resumes it. Returns why there's no answer, or null if nothing was running.
   */
  private async stopUnfinishedTurn(
    workspace: LoadedWorkspace,
    targetId: string,
    runtimeId: string,
    before: string | null,
  ): Promise<string | null> {
    // A lookup that fails says nothing: the turn may still be running, so it's stopped all the same.
    const live = await this.options.runtime.get(runtimeId).catch(() => undefined);
    if (live === null || live?.state === 'finished') return null;
    if (live?.status === 'idle' || live?.status === 'done') return null;
    const sessions = this.options.state.workspace(workspace.id);
    const name = sessions.session(targetId)?.herdrName ?? runtimeId;
    const minutes = Math.round(this.options.answerWaitSeconds / 60);
    const why =
      live?.status === 'blocked'
        ? 'it was waiting for an answer at the Mac'
        : `it gave no answer within ${String(minutes)} minutes`;
    if (await this.stopRuntimeSession(name)) {
      sessions.update(targetId, { state: 'stopped' }, 'working');
      this.options.log(`Stopped session ${targetId} mid-turn: ${why}`);
      return `${why}, so Wheems stopped it to keep its answers in order. Send again to resume it`;
    }
    this.options.log(`Session ${targetId} didn't finish its turn, and couldn't be stopped`);
    // Held until that turn is over, or it can be stopped: see untilFree.
    this.unfinished.set(targetId, { runtimeId: live?.id ?? runtimeId, after: before });
    return `${why}, and it couldn't be stopped, so its answers may now be out of order. See it with hc attach ${live?.id ?? runtimeId}`;
  }

  /**
   * Waits, up to the time an answer gets, until a session is free for the next message: no
   * earlier turn still running (for engines that report status), and any turn left unfinished
   * over: answered, or stopped (tried again as it waits). False if it isn't free in time.
   */
  private async untilFree(caller: Caller, target: SessionRecord): Promise<boolean> {
    const { runtime } = this.options;
    const engine = this.engineOf(caller, target);
    const deadline = Date.now() + this.options.answerWaitSeconds * 1000;
    const name = target.herdrName ?? '';
    while (!this.stopped) {
      const left = this.unfinished.get(target.id);
      // undefined when the lookup fails: unknown, so a turn left unfinished is still held.
      const live = await runtime.get(left?.runtimeId ?? name).catch(() => undefined);
      let free: boolean;
      if (live === undefined) free = left === undefined;
      else if (live?.state !== 'live') free = true;
      else if (engine.capabilities.status) {
        // Blocked counts as free: typing into it fails at once, saying why.
        free = live.status !== 'working' && (left === undefined || live.status !== 'blocked');
      } else {
        free =
          left === undefined ||
          (await this.answers(caller, target, left.after).catch(() => [])).length > 0;
      }
      if (!free && left !== undefined && (await this.stopRuntimeSession(left.runtimeId))) {
        this.sessions(caller).update(target.id, { state: 'stopped' }, 'working');
        free = true;
      }
      if (free) {
        this.unfinished.delete(target.id);
        return true;
      }
      if (Date.now() > deadline) return false;
      if (live?.state === 'live' && engine.capabilities.status && left === undefined) {
        await runtime.wait(live.id, { timeoutSeconds: Math.min(60, secondsLeft(deadline)) });
      } else {
        await sleep(this.options.answerPollMs);
      }
    }
    return false;
  }

  /** Starts a stopped ad-hoc session again, resuming its engine session, with a message. */
  private async resume(
    workspace: LoadedWorkspace,
    target: SessionRecord,
    engine: EngineDriver,
    text: string,
    /** The answer before this message, for a hold if the launch fails partway. */
    before: string | null,
  ): Promise<SessionInfo> {
    const name = target.agent?.split('/').at(-1);
    const agent = workspace.agents.find((a) => a.definition.name === name);
    if (!agent) throw new Error(`its agent ${String(name)} has no agent file`);
    const sessions = this.options.state.workspace(workspace.id);
    const isEnded = () =>
      this.ending.has(target.id) || (sessions.session(target.id)?.state ?? 'ended') === 'ended';
    // Read again: it may have been ended while this waited its turn.
    if (isEnded()) throw new Error('it has ended');
    this.served(workspace.id);
    const engineId = engine.findSession ? target.engineSessionId : target.id;
    if (engineId === null) {
      throw new Error(
        "it has stopped and can't be resumed: its engine's id for it was never found",
      );
    }
    const herdrName = target.herdrName ?? '';
    const old = await this.options.runtime.get(herdrName);
    if (old?.state === 'live') throw new Error('it started again meanwhile; send again');
    await this.checkTrust(agent.definition.engine, target.folder ?? workspace.dir);
    if (old) await this.options.runtime.remove(old.id).catch(() => undefined);
    await this.checkAccountLimit(agent.definition.account);
    try {
      const started = await this.launch(workspace, target, agent, engine, {
        resume: true,
        engineId,
        task: text,
      });
      // Ended while it started: it mustn't keep running.
      const now = sessions.session(target.id);
      if (isEnded() || !now) throw new Error('it was ended while it started again');
      this.served(workspace.id);
      sessions.update(
        target.id,
        { state: 'working', launchedAt: new Date().toISOString() },
        now.state,
      );
      this.options.log(`Resumed session ${target.id} (${started.id}) in ${workspace.id}`);
      return started;
    } catch (error) {
      if (!(await this.stopRuntimeSession(herdrName))) {
        // It may be running with the message: nothing more goes in until that's over.
        this.unfinished.set(target.id, { runtimeId: herdrName, after: before });
      }
      throw error;
    }
  }

  /**
   * Hands an answer, or why there's none, back to the session that sent the message: typed into
   * an ad-hoc session, or told to a chief's conversation. The person's answers are only kept.
   */
  private async handBack(
    workspace: LoadedWorkspace,
    fromId: string | null,
    targetId: string,
    outcome: Outcome,
  ): Promise<void> {
    if (fromId === null || this.stopped) return;
    const sessions = this.options.state.workspace(workspace.id);
    const from = sessions.session(fromId);
    const target = sessions.session(targetId);
    const who = `session ${targetId} ("${target?.title ?? ''}")`;
    // Ending a session cuts its turn short: its owner knows, and needs no word of it.
    if (outcome.answer === null && target?.state === 'ended') return;
    if (!from || from.state === 'ended') {
      this.options.log(`The answer from ${who} had no one to go back to: ${fromId} has ended`);
      return;
    }
    const text =
      outcome.answer !== null
        ? `Wheems: answer from ${who}:\n\n${outcome.answer}${finishLine(
            target?.doneWhen ?? null,
            sessions.answerCount(fromId, targetId),
          )}`
        : `Wheems: no answer from ${who}, because ${outcome.problem}. See it with wheems session show ${targetId}.`;
    await this.passBack(workspace, from, targetId, text);
  }

  /**
   * Delivers a message from Wheems about a session (`aboutId`) to another (`to`): typed into an
   * ad-hoc session through its inbox, or told to a chief's conversation. Kept as a hand-back
   * from `aboutId`, so it's never lost, even undelivered, and can be delivered again after a
   * restart.
   */
  private async passBack(
    workspace: LoadedWorkspace,
    to: SessionRecord,
    aboutId: string,
    text: string,
    /** The hand-back's record when it's already kept, as after a restart. */
    kept?: MessageRecord,
  ): Promise<void> {
    const sessions = this.options.state.workspace(workspace.id);
    let message: MessageRecord | undefined = kept;
    const failed = (problem: string) => {
      if (message) sessions.finishMessage(message.id, 'failed', null, new Date().toISOString());
      this.options.log(
        `Couldn't pass a message from session ${aboutId} on to ${to.id}: ${problem}${message ? ` (kept as message ${message.id})` : ''}`,
      );
    };
    try {
      message ??= await this.record(workspace, aboutId, to.id, text, 'handback');
      if (to.kind === 'thread') {
        if (!this.options.tell) throw new Error("its conversation can't be reached");
        await this.options.tell(to.id, text);
        sessions.finishMessage(message.id, 'answered', null, new Date().toISOString());
      } else if (to.kind === 'adhoc') {
        const kept = message;
        const delivered = await this.enqueue(to.id, () =>
          this.deliver(workspace, to.id, kept, text),
        );
        // The service may have stopped meanwhile, leaving the message for its next start.
        if (delivered.answer === null && !this.isStopping()) failed(delivered.problem);
      }
    } catch (error) {
      if (!this.isStopping()) failed(describe(error));
    }
  }

  /**
   * After a restart, for the messages that were waiting for an answer: tells the sender of each
   * one lost that it was lost, and delivers again each answer that was being handed back. Each
   * notice is recorded, in the same step as its message is marked failed, before any is
   * delivered, so another restart loses none; and they're delivered side by side, so no sender
   * waits on another's turn. The person's own messages are only marked failed: they read them
   * with `wheems session show`.
   */
  async recoverLost(lost: readonly MessageRecord[]): Promise<void> {
    const deliveries: {
      workspace: LoadedWorkspace;
      to: SessionRecord;
      notice: MessageRecord;
      text: string;
    }[] = [];
    for (const message of lost) {
      if (this.stopped) return;
      const workspace = this.options.workspaces.find((w) => w.id === message.workspace);
      if (!workspace?.config) continue;
      const sessions = this.options.state.workspace(workspace.id);
      const now = new Date().toISOString();
      try {
        if (message.kind === 'handback') {
          const to = sessions.session(message.receiver);
          const text = (await readFile(message.messageFile, 'utf8').catch(() => '')).trim();
          if (!to || to.state === 'ended' || text === '') {
            sessions.finishMessage(message.id, 'failed', null, now);
            continue;
          }
          deliveries.push({ workspace, to, notice: message, text });
          continue;
        }
        const from = message.sender !== null ? sessions.session(message.sender) : undefined;
        if (!from || from.state === 'ended') {
          sessions.finishMessage(message.id, 'failed', null, now);
          continue;
        }
        const target = sessions.session(message.receiver);
        const text = `Wheems: your message to session ${message.receiver} ("${target?.title ?? ''}") was lost when Wheems restarted. Send it again if you still need it.`;
        const { id, file } = await this.messageFile(workspace, text);
        const notice = sessions.replaceWithNotice(message.id, {
          id,
          sender: message.receiver,
          receiver: from.id,
          messageFile: file,
          sentAt: now,
        });
        deliveries.push({ workspace, to: from, notice, text });
      } catch (error) {
        this.options.log(`Couldn't deal with lost message ${message.id}: ${describe(error)}`);
      }
    }
    await Promise.allSettled(
      deliveries.map((d) =>
        this.passBack(d.workspace, d.to, d.notice.sender ?? 'wheems', d.text, d.notice),
      ),
    );
  }

  /** Refuses, with the reason, to start an engine in a folder it doesn't trust. */
  private async checkTrust(engine: string, dir: string): Promise<void> {
    const problem = await this.options.trustProblem(engine, dir);
    if (problem !== null) throw new Error(problem);
  }

  /**
   * Before a message is taken for a session that isn't running, and so would be resumed: refuses
   * at once if its engine doesn't trust its folder, rather than fail it later. Resuming checks
   * again; a session that is running needs no check.
   */
  private async checkTrustToResume(
    workspace: LoadedWorkspace,
    target: SessionRecord,
  ): Promise<void> {
    if (target.state === 'ended') return;
    const name = target.agent?.split('/').at(-1);
    const agent = workspace.agents.find((a) => a.definition.name === name);
    if (!agent) return;
    const live =
      target.herdrName !== null
        ? await this.options.runtime.get(target.herdrName).catch(() => undefined)
        : null;
    // Can't tell whether it's running: resuming checks, if it comes to that.
    if (live === undefined || live?.state === 'live') return;
    await this.checkTrust(agent.definition.engine, target.folder ?? workspace.dir);
  }

  private isStopping(): boolean {
    return this.stopped;
  }

  private async launch(
    workspace: LoadedWorkspace,
    session: SessionRecord,
    agent: LoadedAgent,
    engine: EngineDriver,
    start: { resume: boolean; engineId: string | null; task: string },
  ): Promise<SessionInfo> {
    const config = workspace.config;
    const sessions = this.options.state.workspace(workspace.id);
    const depth = sessions.depth(session.id);
    const knowledge = {
      aboutYou:
        this.options.aboutYouFile !== undefined
          ? await readCapped(this.options.aboutYouFile, ABOUT_YOU_LIMIT)
          : null,
      brief: await readCapped(knowledgePaths(workspace.dir).brief, BRIEF_LIMIT),
      goal: await readCapped(join(workspace.dir, GOAL_FILE), GOAL_LIMIT),
    };
    const startsSessions =
      config !== null && depth < config.sessions.max_depth
        ? { maxOpen: config.sessions.max_open_per_owner, open: [] }
        : undefined;
    // The chief's own file is written for managing: a session started without naming an agent
    // runs on the chief's engine and account, as a member of the team who does the job itself.
    const own = isChief(workspace, agent.definition.name)
      ? workerInstructions(config?.name ?? workspace.id)
      : agent.definition.instructions;
    const runtimeSkill = (await this.options.runtime.agentSkill?.()) ?? null;
    const builtins = {
      adhoc: {
        title: session.title ?? '',
        purpose: session.purpose ?? '',
        ask: session.ask,
        doneWhen: session.doneWhen,
        owner: ownerLabel(sessions, session),
      },
      ...(startsSessions && { sessions: startsSessions }),
      ...(runtimeSkill !== null && { runtime: runtimeSkill }),
    };
    const instructions = withBuiltins(own, knowledge, builtins);
    return launchSession({
      runtime: this.options.runtime,
      engine,
      agent: { ...agent.definition, instructions },
      skills: builtinSkills(builtins),
      workspace: { id: workspace.id, dir: workspace.dir },
      sessionDir: session.folder ?? workspace.dir,
      account: {
        name: agent.definition.account,
        driver: this.options.install.accounts[agent.definition.account]?.driver ?? 'unknown',
      },
      session: {
        id: session.id,
        name: session.herdrName ?? '',
        ...start,
      },
      env: {
        ...this.options.sessionEnv,
        WHEEMS_WORKSPACE: workspace.id,
        WHEEMS_SESSION: session.id,
      },
      labels: sessionLabels(session.id, workspace.id),
      untilReady: (id) => this.untilReady(id),
      typeDelayMs: this.options.typeDelayMs,
    });
  }

  /**
   * Stops and removes a runtime session, if there is one. True once it's certainly not
   * running; false when it may still be.
   */
  private async stopRuntimeSession(name: string): Promise<boolean> {
    const { runtime } = this.options;
    try {
      const live = await runtime.get(name);
      if (!live) return true;
      if (live.state === 'live') await runtime.stop(live.id);
      await runtime.remove(live.id).catch(() => undefined);
      return (await runtime.get(name))?.state !== 'live';
    } catch {
      return false;
    }
  }

  /**
   * Brings the caller's workspace's ad-hoc sessions' states up to date with Herdr before they're
   * read: working while Herdr says so, idle once a turn has finished (which counts as activity),
   * stopped when its Herdr session has gone.
   */
  private async refresh(caller: Caller): Promise<void> {
    const sessions = this.sessions(caller);
    const open = sessions
      .sessions({ kind: 'adhoc' })
      .filter((s) => s.state !== 'ended' && s.state !== 'starting' && s.herdrName !== null);
    if (open.length === 0) return;
    const live = new Map(
      (await this.options.runtime.list({ labels: { workspace: caller.workspace.id } })).map((s) => [
        s.name,
        s,
      ]),
    );
    const now = new Date().toISOString();
    for (const session of open) {
      // A message being followed keeps its session's state itself.
      if (this.inbox.has(session.id) || this.unfinished.has(session.id)) continue;
      const runtime = live.get(session.herdrName);
      let state: SessionState = session.state;
      if (runtime === undefined) state = 'stopped';
      else if (runtime.status === 'working') state = 'working';
      else if (runtime.status !== null) state = 'idle';
      else if (!this.engineOf(caller, session).capabilities.status) {
        // An engine that reports no status has finished its turn once its answer is there.
        const answered = (await this.answers(caller, session, null).catch(() => [])).length > 0;
        state = answered ? 'idle' : 'working';
      }
      if (state === session.state) continue;
      // Only if nothing changed it meanwhile, such as wheems session end.
      sessions.update(
        session.id,
        { state, ...(session.state === 'working' && state === 'idle' && { lastActiveAt: now }) },
        session.state,
      );
    }
  }

  /** Asks a running session for its note and waits for that turn. Returns whether it ended in time. */
  private async askForNote(
    caller: Caller,
    session: SessionRecord,
    live: SessionInfo,
  ): Promise<boolean> {
    if (live.status === 'blocked') return false;
    if (live.status === 'working') {
      // Let the turn it's on finish first, so the note covers it.
      await this.untilTurnEnds(caller, session, live.id, live.turn - 1, null);
    }
    const before = (await this.answers(caller, session, null).catch(() => [])).at(-1)?.id ?? null;
    let fromTurn: number;
    try {
      fromTurn = (await this.options.runtime.send(live.id, END_NOTE_REQUEST)).turn;
    } catch (error) {
      if (isDriverError(error, 'blocked') || isDriverError(error, 'not_found')) return false;
      throw error;
    }
    return this.untilTurnEnds(caller, session, live.id, fromTurn, before);
  }

  /**
   * Waits, up to `seconds` (the time a note gets, by default), for the turn after `fromTurn` to
   * end: by status, or for engines that report none, by a new answer after `after`.
   */
  private async untilTurnEnds(
    caller: Caller,
    session: SessionRecord,
    id: string,
    fromTurn: number,
    after: string | null,
    seconds = this.options.noteTurnSeconds,
  ): Promise<boolean> {
    const engine = this.engineOf(caller, session);
    const deadline = Date.now() + seconds * 1000;
    let startBy = Date.now() + this.options.startupSeconds * 1000;
    while (Date.now() < deadline && !this.stopped) {
      const live = await this.options.runtime.get(id);
      if (live?.state !== 'live') return false;
      if (!engine.capabilities.status) {
        const found = await this.answers(caller, session, after).catch(() => []);
        if (found.length > 0) return true;
        await sleep(this.options.answerPollMs);
        continue;
      }
      if (live.status === 'blocked' || live.status === 'error') return false;
      if (live.turn > fromTurn && live.status !== 'working') return true;
      if (live.status !== 'working' && Date.now() > startBy) return false;
      if (live.status === 'working') {
        // Busy with an earlier turn, perhaps: the start-up time counts from when it's done.
        startBy = Date.now() + this.options.startupSeconds * 1000;
        await this.options.runtime.wait(id, {
          timeoutSeconds: Math.min(60, secondsLeft(deadline)),
        });
      } else {
        await sleep(this.options.pollMs);
      }
    }
    return false;
  }

  /** The session's answers after `after`, read from its engine, finding the engine's id once. */
  private async answers(
    caller: Caller,
    session: SessionRecord,
    after: string | null,
  ): Promise<FinalMessage[]> {
    const engine = this.engineOf(caller, session);
    if (!engine.answers || session.folder === null) return [];
    let engineId = engine.findSession ? session.engineSessionId : session.id;
    if (
      engineId === null &&
      engine.findSession &&
      session.launchStartedAt !== null &&
      session.launchTag !== null
    ) {
      engineId = await engine.findSession({
        dir: session.folder,
        startedAt: new Date(session.launchStartedAt),
        tag: session.launchTag,
      });
      if (engineId !== null)
        this.sessions(caller).update(session.id, { engineSessionId: engineId });
    }
    if (engineId === null) return [];
    return engine.answers({ id: engineId, dir: session.folder }, after);
  }

  private engineOf(caller: Caller, session: SessionRecord): EngineDriver {
    const name = session.agent?.split('/').at(-1);
    const agent = caller.workspace.agents.find((a) => a.definition.name === name);
    if (!agent) throw new Error(`Session ${session.id}'s agent ${String(name)} has no agent file`);
    return this.options.engine(agent.definition.engine);
  }

  /** The agent a new session runs: the one named, else the caller's own. */
  private agentFor(caller: Caller, name: string | undefined): LoadedAgent {
    const workspace = caller.workspace;
    const wanted =
      name ?? caller.session?.agent?.split('/').at(-1) ?? workspace.config?.chief_of_staff;
    const agent = workspace.agents.find((a) => a.definition.name === wanted);
    if (!agent) {
      throw new Error(
        `No agent ${String(wanted)} in ${workspace.id}'s agents/: ${workspace.agents.map((a) => a.definition.name).join(', ')}`,
      );
    }
    return agent;
  }

  /**
   * Refuses a new session when its account already runs `max_sessions` sessions, of every
   * kind and in every workspace, as Herdr reports them.
   */
  private async checkAccountLimit(account: string): Promise<void> {
    const limit = this.options.install.accounts[account]?.max_sessions;
    if (limit === undefined) return;
    const { state } = this.options;
    let running = 0;
    for (const live of await this.options.runtime.list()) {
      // A session that has finished but not been removed isn't running.
      if (live.state !== 'live') continue;
      const label = live.labels[SESSION_LABEL];
      if (label === undefined) continue;
      if (label === 'filer') {
        const workspace = this.options.workspaces.find((w) => w.id === live.labels.workspace);
        if (workspace && filerAccount(workspace) === account) running++;
        continue;
      }
      const session = state.callingSession(label);
      const workspace = this.options.workspaces.find(
        (w) => w.id === (session?.workspace ?? live.labels.workspace),
      );
      // Thread sessions from before the store carry no session id: they run the chief.
      const name =
        session?.agent?.split('/').at(-1) ??
        (label === 'conversation' ? workspace?.config?.chief_of_staff : undefined);
      const agent = workspace?.agents.find((a) => a.definition.name === name);
      if (agent?.definition.account === account) running++;
    }
    if (running >= limit) {
      throw new Error(
        `The ${account} account already runs ${String(running)} sessions, the most allowed (max_sessions in install.yaml). End a session first.`,
      );
    }
  }

  private find(caller: Caller, id: string): SessionRecord {
    const session = this.sessions(caller).session(id);
    if (!session) throw new Error(`No session ${id} in ${caller.workspace.id}`);
    return session;
  }

  private sessions(caller: Caller): WorkspaceSessions {
    return this.options.state.workspace(caller.workspace.id);
  }

  private workspace(id: string): LoadedWorkspace {
    const workspace = this.options.workspaces.find((w) => w.id === id);
    if (!workspace) throw new Error(`Workspace ${id} isn't running here`);
    return workspace;
  }

  private async untilReady(id: string): Promise<void> {
    const deadline = Date.now() + this.options.startupSeconds * 1000;
    for (;;) {
      const session = await this.options.runtime.get(id);
      if (!session || session.state !== 'live' || session.status !== null) return;
      if (Date.now() > deadline) return;
      await sleep(this.options.pollMs);
    }
  }
}

/** The account a workspace's filer runs on: its own setting, else the chief's. */
function filerAccount(workspace: LoadedWorkspace): string | undefined {
  const config = workspace.config;
  const chief = workspace.agents.find((a) => a.definition.name === config?.chief_of_staff);
  return config?.knowledge.filer?.account ?? chief?.definition.account;
}

/** How the built-ins and messages name a caller. */
function ownerName(caller: Caller): string {
  if (caller.session === null) return 'the person';
  if (caller.session.kind === 'thread') {
    return caller.session.agent?.split('/').at(-1) ?? 'the chief of staff';
  }
  return `session ${caller.session.id} ("${caller.session.title ?? ''}")`;
}

/** How a session's own owner is named in its built-in instructions. */
function ownerLabel(sessions: WorkspaceSessions, session: SessionRecord): string {
  if (session.owner === null) return 'the person';
  const owner = sessions.session(session.owner);
  if (owner?.kind === 'adhoc') return `session ${owner.id} ("${owner.title ?? ''}")`;
  return session.owner.split('/').at(-1) ?? session.owner;
}

/** Acting in a workspace for no one in particular: Wheems's own work, such as following. */
function workspaceCaller(workspace: LoadedWorkspace): Caller {
  return { workspace, session: null, owner: null };
}

async function firstLine(file: string): Promise<string> {
  const text = await readFile(file, 'utf8').catch(() => '');
  return (text.split('\n').find((line) => line.trim() !== '') ?? '').trim().slice(0, 120);
}

/** A timer that resolves null after `ms`, unless cancelled first. */
function timeout(ms: number): { done: Promise<null>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const done = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
    }, ms);
  });
  return {
    done,
    cancel: () => {
      clearTimeout(timer);
    },
  };
}

/**
 * What follows a session's answer to the session that sent the message, when it has a finish
 * line: the line again, to check the answer against, and how many of that sender's messages it
 * has answered, waited for or handed back. From the third, the sender is told to stop sending
 * the job back.
 */
export function finishLine(doneWhen: string | null, count: number): string {
  if (doneWhen === null) return '';
  const stop =
    count >= SEND_BACK_ANSWERS
      ? `\n\nIf the job still isn't done, don't send it back again: bring it to the person, saying what was tried and what's missing.`
      : '';
  return `\n\n---\n\nAnswer ${String(count)} from this session. It's done when: ${doneWhen}\n\nCheck its evidence against that before you report.${stop}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function checkText(what: string, text: string, limit: number): void {
  if (text === '') throw new Error(`The ${what} is empty.`);
  if (text.length > limit)
    throw new Error(`The ${what} is longer than ${String(limit)} characters.`);
  if (looksLikeSecret(text)) {
    throw new Error(
      `The ${what} looks like it holds a password, token or key. Titles and purposes appear in search: write it again without it.`,
    );
  }
}

function secondsLeft(deadline: number): number {
  return Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
