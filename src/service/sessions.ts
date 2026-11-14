import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { END_NOTE_REQUEST, withBuiltins, type OpenSession } from '../agents/builtin.js';
import type { LoadedAgent, LoadedWorkspace } from '../config/load.js';
import type { InstallConfig } from '../config/schemas.js';
import { isDriverError } from '../contracts/driver.js';
import { conversationTag, type EngineDriver, type FinalMessage } from '../contracts/engine.js';
import type { RuntimeDriver, SessionInfo } from '../contracts/runtime.js';
import {
  ABOUT_YOU_LIMIT,
  BRIEF_LIMIT,
  knowledgePaths,
  looksLikeSecret,
  noteTitle,
  readCapped,
} from '../knowledge/notes.js';
import {
  SESSION_LABEL,
  sessionLabels,
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
  log?: (message: string) => void;
}

const TITLE_LIMIT = 80;
const PURPOSE_LIMIT = 2000;
const MESSAGE_LIMIT = 20_000;
const LONGEST_WAIT_SECONDS = 3600;

/**
 * Ad-hoc sessions: started on the fly by a chief, another session or the person, for one piece
 * of work, and open until ended. Everything here acts for a caller, in the caller's workspace
 * only, and goes through the store's workspace filter.
 */
export class SessionService {
  private readonly options: Required<Omit<SessionServiceOptions, 'aboutYouFile' | 'tell'>> & {
    aboutYouFile: string | undefined;
    tell: SessionServiceOptions['tell'];
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
      aboutYouFile: undefined,
      tell: undefined,
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
    const config = workspace.config;
    if (!config)
      throw new Error(`Workspace ${workspace.id} has config problems; run wheems doctor`);
    const title = request.title.trim();
    const purpose = request.purpose.trim();
    checkText('title', title, TITLE_LIMIT);
    checkText('purpose', purpose, PURPOSE_LIMIT);
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

    const id = randomUUID();
    const folder = join(this.options.stateDir, 'sessions', workspace.id, 'adhoc', id);
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

    if (wait && from !== null && this.waitsOn(target.id, from.id)) {
      throw new Error(
        `Session ${target.id} is waiting on you, so you can't wait on it: the two of you would wait for ever. Send without --wait.`,
      );
    }
    const message = await this.record(workspace, from?.id ?? null, target.id, text);
    if (wait && from !== null) this.addWait(from.id, target.id);
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
      return { message: sessions.message(message.id) ?? message, answer: result.answer, next: '' };
    } finally {
      timer.cancel();
      if (from !== null) this.removeWait(from.id, target.id);
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
      return { session: sessions.session(id) ?? session, noted };
    } finally {
      this.ending.delete(id);
    }
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
  ): Promise<MessageRecord> {
    const id = randomUUID();
    const dir = join(this.options.stateDir, 'messages', workspace.id);
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${id}.md`);
    await writeFile(file, `${text}\n`);
    return this.options.state.workspace(workspace.id).addMessage({
      id,
      sender,
      receiver,
      messageFile: file,
      sentAt: new Date().toISOString(),
    });
  }

  /**
   * Types a message into an ad-hoc session, resuming it first if it has stopped, and follows
   * the turn it starts to its answer. A null message is a notice from Wheems, such as an answer
   * handed back: followed the same way, so the next message's answer is its own, but not kept.
   */
  private async deliver(
    workspace: LoadedWorkspace,
    targetId: string,
    message: MessageRecord | null,
    text: string,
  ): Promise<Outcome> {
    const sessions = this.options.state.workspace(workspace.id);
    const caller = workspaceCaller(workspace);
    const fail = (problem: string): Outcome => {
      if (message && !this.stopped)
        sessions.finishMessage(message.id, 'failed', null, new Date().toISOString());
      return { answer: null, problem };
    };
    try {
      const target = sessions.session(targetId);
      if (!target || target.state === 'ended') return fail('it has ended');
      const engine = this.engineOf(caller, target);
      const before = (await this.answers(caller, target, null).catch(() => [])).at(-1)?.id ?? null;
      const live =
        target.herdrName !== null ? await this.options.runtime.get(target.herdrName) : null;
      if (live?.state !== 'live') {
        const started = await this.admit(() => this.resume(workspace, target, engine, text));
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
    message: MessageRecord | null,
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
      if (message) sessions.finishMessage(message.id, state, answerFile, now);
      sessions.update(targetId, { state: 'idle', lastActiveAt: now }, 'working');
    };
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
          problem: ended ? 'it finished without answering' : 'it gave no answer in time',
        };
      }
      let answerFile: string | null = null;
      if (message) {
        answerFile = message.messageFile.replace(/\.md$/, '.answer.md');
        await writeFile(answerFile, `${answer}\n`);
      }
      finish('answered', answerFile);
      return { answer, problem: null };
    } catch (error) {
      finish('failed', null);
      return { answer: null, problem: describe(error) };
    }
  }

  /** Starts a stopped ad-hoc session again, resuming its engine session, with a message. */
  private async resume(
    workspace: LoadedWorkspace,
    target: SessionRecord,
    engine: EngineDriver,
    text: string,
  ): Promise<SessionInfo> {
    const name = target.agent?.split('/').at(-1);
    const agent = workspace.agents.find((a) => a.definition.name === name);
    if (!agent) throw new Error(`its agent ${String(name)} has no agent file`);
    const engineId = engine.findSession ? target.engineSessionId : target.id;
    if (engineId === null) {
      throw new Error(
        "it has stopped and can't be resumed: its engine's id for it was never found",
      );
    }
    const herdrName = target.herdrName ?? '';
    const old = await this.options.runtime.get(herdrName);
    if (old?.state === 'live') throw new Error('it started again meanwhile; send again');
    if (old) await this.options.runtime.remove(old.id).catch(() => undefined);
    await this.checkAccountLimit(agent.definition.account);
    const sessions = this.options.state.workspace(workspace.id);
    try {
      const started = await this.launch(workspace, target, agent, engine, {
        resume: true,
        engineId,
        task: text,
      });
      sessions.update(target.id, { state: 'working', launchedAt: new Date().toISOString() });
      this.options.log(`Resumed session ${target.id} (${started.id}) in ${workspace.id}`);
      return started;
    } catch (error) {
      await this.stopRuntimeSession(herdrName);
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
        ? `Wheems: answer from ${who}:\n\n${outcome.answer}`
        : `Wheems: no answer from ${who}, because ${outcome.problem}. See it with wheems session show ${targetId}.`;
    try {
      if (from.kind === 'thread') {
        if (!this.options.tell) throw new Error("its conversation can't be reached");
        await this.options.tell(from.id, text);
      } else if (from.kind === 'adhoc') {
        await this.enqueue(from.id, () => this.deliver(workspace, from.id, null, text));
      }
    } catch (error) {
      this.options.log(
        `Couldn't hand the answer from ${who} back to ${fromId}: ${describe(error)}`,
      );
    }
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
    };
    const startsSessions =
      config !== null && depth < config.sessions.max_depth
        ? { maxOpen: config.sessions.max_open_per_owner, open: [] }
        : undefined;
    const instructions = withBuiltins(agent.definition.instructions, knowledge, {
      adhoc: {
        title: session.title ?? '',
        purpose: session.purpose ?? '',
        owner: ownerLabel(sessions, session),
      },
      ...(startsSessions && { sessions: startsSessions }),
    });
    return launchSession({
      runtime: this.options.runtime,
      engine,
      agent: { ...agent.definition, instructions },
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
      if (this.inbox.has(session.id)) continue;
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
