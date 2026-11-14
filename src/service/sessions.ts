import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
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
}

export interface SessionServiceOptions {
  install: InstallConfig;
  /** The workspaces the service runs. */
  workspaces: LoadedWorkspace[];
  state: StateStore;
  runtime: RuntimeDriver;
  engine: (name: string) => EngineDriver;
  /** Where ad-hoc sessions' folders go: `<stateDir>/sessions/<workspace>/<id>/`. */
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
  log?: (message: string) => void;
}

const TITLE_LIMIT = 80;
const PURPOSE_LIMIT = 2000;

/**
 * Ad-hoc sessions: started on the fly by a chief, another session or the person, for one piece
 * of work, and open until ended. Everything here acts for a caller, in the caller's workspace
 * only, and goes through the store's workspace filter.
 */
export class SessionService {
  private readonly options: Required<Omit<SessionServiceOptions, 'aboutYouFile'>> & {
    aboutYouFile: string | undefined;
  };
  private readonly ending = new Set<string>();
  private creating: Promise<unknown> = Promise.resolve();

  constructor(options: SessionServiceOptions) {
    this.options = {
      startupSeconds: 90,
      pollMs: 1000,
      typeDelayMs: 5000,
      answerPollMs: 2000,
      noteTurnSeconds: 600,
      log: () => undefined,
      aboutYouFile: undefined,
      ...options,
    };
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
    // One at a time, so two requests can't both pass the limits before either has started.
    const next = this.creating.then(() => this.createNow(caller, request));
    this.creating = next.catch(() => undefined);
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
    const folder = join(this.options.stateDir, 'sessions', workspace.id, id);
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
    try {
      const started = await this.launch(caller, record, agent, engine, launchTag, depth);
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
    return sessions.session(id) ?? record;
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
    return {
      session,
      runtimeId: live?.state === 'live' ? live.id : null,
      status: live?.state === 'live' ? live.status : null,
      latestAnswer,
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

  private async launch(
    caller: Caller,
    session: SessionRecord,
    agent: LoadedAgent,
    engine: EngineDriver,
    launchTag: string | undefined,
    depth: number,
  ): Promise<SessionInfo> {
    const workspace = caller.workspace;
    const config = workspace.config;
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
        owner: ownerName(caller),
      },
      ...(startsSessions && { sessions: startsSessions }),
    });
    const purpose = session.purpose ?? '';
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
        resume: false,
        engineId: engine.findSession ? null : session.id,
        task: launchTag !== undefined ? `${purpose}\n\n${launchTag}` : purpose,
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
      const runtime = live.get(session.herdrName);
      const state: SessionState =
        runtime === undefined ? 'stopped' : runtime.status === 'working' ? 'working' : 'idle';
      if (state === session.state) continue;
      sessions.update(session.id, {
        state,
        ...(session.state === 'working' && state === 'idle' && { lastActiveAt: now }),
      });
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
   * Waits, up to the time a note gets, for the turn after `fromTurn` to end: by status, or for
   * engines that report none, by a new answer after `after`.
   */
  private async untilTurnEnds(
    caller: Caller,
    session: SessionRecord,
    id: string,
    fromTurn: number,
    after: string | null,
  ): Promise<boolean> {
    const engine = this.engineOf(caller, session);
    const deadline = Date.now() + this.options.noteTurnSeconds * 1000;
    const startBy = Date.now() + this.options.startupSeconds * 1000;
    while (Date.now() < deadline) {
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
