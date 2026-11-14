/**
 * The session store, `.wheems/state.sqlite`: the one module that reads and writes it.
 *
 * Herdr says whether a session is alive; the store says what it's for. Only the service
 * writes to it (doctor opens it read-only). Queries made on behalf of a caller go through
 * `workspace(id)`, where every one is filtered by that workspace; the install-wide ones are
 * for the service itself: writing agents from config, importing `conversations.json`, matching
 * the store against Herdr at start, and routing chat threads, whose keys carry their workspace.
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { z } from 'zod';
import type { SessionInfo } from '../contracts/runtime.js';
import { ftsQuery } from '../knowledge/search.js';
import { openDatabase } from '../util/sqlite.js';
import { SCHEMA_VERSION, migrate, schemaVersion } from './schema.js';

export const conversationSchema = z.object({
  workspace: z.string(),
  connection: z.string(),
  channel: z.string(),
  /** The thread's id in the channel: the message that started it. */
  thread: z.string(),
  /** Wheems's id for the session: the engine's id for the conversation, so it can be resumed. */
  sessionId: z.string(),
  /** The runtime session's name. */
  sessionName: z.string(),
  createdAt: z.string(),
  lastActiveAt: z.string(),
  /**
   * The engine's id for the last answer posted. Empty when none has been posted yet in a
   * conversation that started here; missing when it is not known.
   */
  lastAnswerId: z.string().optional(),
  /** The engine's own id for the conversation, for engines that choose their own ids. */
  engineSessionId: z.string().optional(),
  /** When the current engine session started, and the tag on its first message, to find its id. */
  startedAt: z.string().optional(),
  launchTag: z.string().optional(),
  /**
   * When the runtime had launched the session's program: messages typed into an engine that
   * reports no status wait until it has had its start-up time from here.
   */
  launchedAt: z.string().optional(),
  /**
   * How many messages are waiting for their answers. While any are, the session is never
   * stopped, and after a restart the service follows it until they are all answered.
   */
  pending: z.number().int().nonnegative().optional(),
  /** When the agent last wrote a note, or was asked for one. Work after it has no note yet. */
  notedAt: z.string().optional(),
  /** Wheems asked for a note and its answer, which is never posted, may not be skipped yet. */
  noting: z.boolean().optional(),
});

/** A chat thread and the session it talks to, as the conversation manager sees them. */
export type Conversation = z.infer<typeof conversationSchema>;

export type SessionKind = 'thread' | 'adhoc' | 'task';
export type SessionState = 'starting' | 'working' | 'idle' | 'stopped' | 'ended';

/** A standing agent, written from config: a workspace's chief or, later, a project's lead. */
export interface StandingAgent {
  id: string;
  workspace: string;
  project: string | null;
  name: string;
  role: 'chief' | 'lead';
  engine: string;
}

export interface SessionRecord {
  id: string;
  workspace: string;
  project: string | null;
  agent: string | null;
  kind: SessionKind;
  owner: string | null;
  parent: string | null;
  title: string | null;
  purpose: string | null;
  summary: string | null;
  state: SessionState;
  herdrName: string | null;
  engineSessionId: string | null;
  folder: string | null;
  /** When the current engine session started, and the tag on its first message, to find its id. */
  launchStartedAt: string | null;
  launchTag: string | null;
  launchedAt: string | null;
  createdAt: string;
  lastActiveAt: string;
  endedAt: string | null;
}

/** A new ad-hoc session's row. */
export interface NewSession {
  id: string;
  project: string | null;
  agent: string;
  owner: string | null;
  parent: string | null;
  title: string;
  purpose: string;
  herdrName: string;
  folder: string;
  createdAt: string;
}

/** Fields of a session that change while it runs. */
export interface SessionChange {
  state?: SessionState;
  summary?: string;
  engineSessionId?: string;
  launchStartedAt?: string;
  launchTag?: string | null;
  launchedAt?: string;
  lastActiveAt?: string;
  endedAt?: string;
}

export type MessageState = 'sent' | 'answered' | 'failed';
/** A message sent (or a session's purpose), or an answer handed back to its sender. */
export type MessageKind = 'message' | 'handback';

/** A message sent into a session with `wheems session send`, or its purpose at start. */
export interface MessageRecord {
  id: string;
  workspace: string;
  kind: MessageKind;
  /** The sending session's id; null for the person. For a hand-back, the session that answered. */
  sender: string | null;
  receiver: string;
  messageFile: string;
  answerFile: string | null;
  state: MessageState;
  sentAt: string;
  answeredAt: string | null;
}

export interface SessionFilter {
  kind?: SessionKind;
  state?: SessionState;
  agent?: string;
  /** null for sessions the person owns. */
  owner?: string | null;
  project?: string;
}

/** What importing `conversations.json` did. */
export type ImportResult =
  | { status: 'none' }
  | { status: 'imported'; conversations: number; skipped: number; renamedTo: string }
  | { status: 'unreadable'; problem: string };

/** What matching the store against the runtime's live sessions found. */
export interface RuntimeMatch {
  /** Sessions whose runtime session has gone, now marked stopped. */
  stopped: string[];
  /** Live sessions with a Wheems label and no row, left alone. */
  unknown: SessionInfo[];
}

/** The Herdr label every session Wheems starts carries: `wheems=<session id>`. */
export const SESSION_LABEL = 'wheems';

/**
 * Values of the `wheems` label that aren't session ids: runs that aren't sessions in the
 * store (the filer's, until tasks arrive, and doctor's test session), and `conversation`,
 * which thread sessions carried before the store, matched by their name instead.
 */
const NOT_SESSION_IDS = new Set(['filer', 'doctor']);
const LEGACY_THREAD_LABEL = 'conversation';

/** The labels for a session Wheems starts in the runtime. */
export function sessionLabels(sessionId: string, workspace: string): Record<string, string> {
  return { [SESSION_LABEL]: sessionId, workspace };
}

type Row = Record<string, SQLOutputValue>;

export class StateStore {
  private constructor(
    private readonly db: DatabaseSync,
    readonly readOnly: boolean,
  ) {}

  /**
   * Opens the store, creating it and bringing its schema up to date unless `readOnly`. A
   * read-only store must already be at this Wheems's schema version.
   */
  static async open(file: string, options: { readOnly?: boolean } = {}): Promise<StateStore> {
    const readOnly = options.readOnly === true;
    if (!readOnly) {
      await mkdir(dirname(file), { recursive: true });
      // Made owner-only before SQLite opens it: its -wal and -shm files take the database's mode.
      await writeFile(file, '', { flag: 'a', mode: 0o600 });
      await ownerOnly(file);
    }
    const db = await openDatabase(file, { readOnly });
    try {
      if (readOnly) {
        const version = schemaVersion(db);
        if (version !== SCHEMA_VERSION) {
          throw new Error(
            `The session store is at schema version ${String(version)}; this Wheems uses ${String(SCHEMA_VERSION)}. The service updates it when it starts.`,
          );
        }
      } else {
        db.exec('PRAGMA foreign_keys = ON');
        migrate(db);
        // Stores from before this, and their -wal and -shm files, were readable by everyone.
        for (const companion of [`${file}-wal`, `${file}-shm`]) await ownerOnly(companion);
      }
    } catch (error) {
      db.close();
      throw error;
    }
    return new StateStore(db, readOnly);
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  /** Queries on behalf of a caller in one workspace. Every one is filtered by it. */
  workspace(id: string): WorkspaceSessions {
    return new WorkspaceSessions(this.db, id);
  }

  // The service's own, install-wide ------------------------------------------

  /** Replaces the standing agents with those in config, in one write. */
  writeAgents(agents: readonly StandingAgent[], now = new Date()): void {
    this.transaction(() => {
      this.db.exec('DELETE FROM agents');
      const insert = this.db.prepare(
        'INSERT INTO agents (id, workspace, project, name, role, engine, written_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      for (const a of agents) {
        insert.run(a.id, a.workspace, a.project, a.name, a.role, a.engine, now.toISOString());
      }
    });
  }

  /**
   * Imports the conversations a Wheems from before the store kept in `conversations.json`,
   * then renames it `conversations.json.imported`. Never replaces a thread already in the
   * store. A file that can't be read is left where it is, and nothing is imported from it: the
   * service then refuses to start until it's fixed or removed, since its threads' sessions may
   * still be running.
   */
  async importConversations(file: string): Promise<ImportResult> {
    const read = await readConversationsFile(file);
    if (read.status !== 'read') return read;
    const conversations = read.conversations;
    let imported = 0;
    this.transaction(() => {
      for (const [key, conversation] of Object.entries(conversations)) {
        if (this.threadRow(key) !== undefined) continue;
        this.saveConversation(key, conversation);
        imported++;
      }
    });
    const renamedTo = `${file}.imported`;
    await rename(file, renamedTo);
    return {
      status: 'imported',
      conversations: imported,
      skipped: Object.keys(conversations).length - imported,
      renamedTo,
    };
  }

  /**
   * At service start: messages still waiting for an answer lost whoever followed them when the
   * service stopped, so they're marked failed. Returns them as they were, in every workspace,
   * so their senders can be told.
   */
  failWaitingMessages(at: string): MessageRecord[] {
    let lost: MessageRecord[] = [];
    this.transaction(() => {
      lost = this.db
        .prepare(`${MESSAGE_SELECT} WHERE state = 'sent' ORDER BY sent_at, id`)
        .all()
        .map(toMessage);
      this.db
        .prepare("UPDATE messages SET state = 'failed', answered_at = ? WHERE state = 'sent'")
        .run(at);
    });
    return lost;
  }

  /**
   * Matches the store against the runtime's live sessions, at service start: a session whose
   * runtime session has gone becomes stopped, still resumable.
   */
  matchRuntime(live: readonly SessionInfo[]): RuntimeMatch {
    const names = new Set(live.flatMap((s) => (s.name === null ? [] : [s.name])));
    const gone = (
      this.db
        .prepare(
          "SELECT id, herdr_name FROM sessions WHERE state NOT IN ('stopped', 'ended') AND herdr_name IS NOT NULL",
        )
        .all() as { id: string; herdr_name: string }[]
    ).filter((row) => !names.has(row.herdr_name));
    this.transaction(() => {
      const stop = this.db.prepare("UPDATE sessions SET state = 'stopped' WHERE id = ?");
      for (const row of gone) stop.run(row.id);
    });
    return { stopped: gone.map((row) => row.id), unknown: this.unknownSessions(live) };
  }

  /**
   * Live runtime sessions labelled as Wheems sessions that have no row in the store. They're
   * reported, never adopted or removed.
   */
  unknownSessions(live: readonly SessionInfo[]): SessionInfo[] {
    const byId = this.db.prepare('SELECT 1 FROM sessions WHERE id = ?');
    const byName = this.db.prepare(
      "SELECT 1 FROM sessions WHERE kind = 'thread' AND herdr_name = ?",
    );
    return live.filter((session) => {
      const value = session.labels[SESSION_LABEL];
      if (value === undefined || NOT_SESSION_IDS.has(value)) return false;
      if (value === LEGACY_THREAD_LABEL) {
        return session.name === null || byName.get(session.name) === undefined;
      }
      return byId.get(value) === undefined;
    });
  }

  /**
   * The session a caller says it is, from the id Wheems put in its environment, in whichever
   * workspace it belongs to. Who's calling decides the workspace, never an argument.
   */
  callingSession(id: string): SessionRecord | undefined {
    const row = this.db.prepare(`${SESSION_SELECT} WHERE id = ?`).get(id);
    return row === undefined ? undefined : toSession(row);
  }

  /** The conversation key of a thread session, for callers that know only its session id. */
  threadKeyOf(sessionId: string): string | undefined {
    const row = this.db.prepare('SELECT key FROM threads WHERE session = ?').get(sessionId);
    return row === undefined ? undefined : String(row.key);
  }

  /** Whether a live runtime session is one of the store's chat-thread sessions. */
  isThreadSession(session: SessionInfo): boolean {
    const value = session.labels[SESSION_LABEL];
    if (value === LEGACY_THREAD_LABEL) return true;
    if (value === undefined || NOT_SESSION_IDS.has(value)) return false;
    return (
      this.db.prepare("SELECT 1 FROM sessions WHERE id = ? AND kind = 'thread'").get(value) !==
      undefined
    );
  }

  // Chat threads, by conversation key -----------------------------------------

  conversation(key: string): Conversation | undefined {
    const row = this.threadRow(key);
    return row === undefined ? undefined : toConversation(row);
  }

  conversations(): [string, Conversation][] {
    return (this.db.prepare(`${THREAD_SELECT} ORDER BY s.created_at, t.key`).all() as Row[]).map(
      (row) => [String(row.key), toConversation(row)],
    );
  }

  /** Records a thread and its session, replacing what was recorded for them. */
  saveConversation(key: string, c: Conversation): void {
    const pending = c.pending ?? 0;
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO sessions (id, workspace, agent, kind, state, herdr_name, engine_session_id,
             launch_started_at, launch_tag, launched_at, created_at, last_active_at)
           VALUES (:id, :workspace,
             (SELECT id FROM agents WHERE workspace = :workspace AND project IS NULL AND role = 'chief'),
             'thread', :state, :herdr_name, :engine_session_id, :launch_started_at, :launch_tag,
             :launched_at, :created_at, :last_active_at)
           ON CONFLICT (id) DO UPDATE SET
             agent = coalesce(sessions.agent, excluded.agent),
             state = excluded.state,
             herdr_name = excluded.herdr_name,
             engine_session_id = excluded.engine_session_id,
             launch_started_at = excluded.launch_started_at,
             launch_tag = excluded.launch_tag,
             launched_at = excluded.launched_at,
             created_at = excluded.created_at,
             last_active_at = excluded.last_active_at,
             ended_at = NULL
           WHERE sessions.workspace = excluded.workspace`,
        )
        .run({
          id: c.sessionId,
          workspace: c.workspace,
          state: pending > 0 ? 'working' : 'idle',
          herdr_name: c.sessionName,
          engine_session_id: c.engineSessionId ?? null,
          launch_started_at: c.startedAt ?? null,
          launch_tag: c.launchTag ?? null,
          launched_at: c.launchedAt ?? null,
          created_at: c.createdAt,
          last_active_at: c.lastActiveAt,
        });
      const owner = this.db.prepare('SELECT workspace FROM sessions WHERE id = ?').get(c.sessionId);
      if (owner?.workspace !== c.workspace) {
        throw new Error(`Session ${c.sessionId} belongs to another workspace`);
      }
      this.db
        .prepare(
          `INSERT INTO threads (key, workspace, connection, channel, thread, session,
             last_answer_id, pending, noted_at, noting)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET
             workspace = excluded.workspace, connection = excluded.connection,
             channel = excluded.channel, thread = excluded.thread, session = excluded.session,
             last_answer_id = excluded.last_answer_id, pending = excluded.pending,
             noted_at = excluded.noted_at, noting = excluded.noting`,
        )
        .run(
          key,
          c.workspace,
          c.connection,
          c.channel,
          c.thread,
          c.sessionId,
          c.lastAnswerId ?? null,
          pending,
          c.notedAt ?? null,
          c.noting === true ? 1 : 0,
        );
    });
  }

  /** Changes a thread's own fields. Does nothing for a thread that isn't recorded. */
  updateThread(
    key: string,
    change: {
      lastAnswerId?: string;
      /** Waiting messages answered, taken off the count (never below 0). */
      answered?: number;
      /** One more message waiting. */
      addPending?: boolean;
      pending?: number;
      notedAt?: string;
      noting?: boolean;
    },
  ): void {
    const sets: string[] = [];
    const values: SQLInputValue[] = [];
    if (change.lastAnswerId !== undefined) {
      sets.push('last_answer_id = ?');
      values.push(change.lastAnswerId);
    }
    if (change.answered !== undefined) {
      sets.push('pending = max(0, pending - ?)');
      values.push(change.answered);
    } else if (change.addPending === true) {
      sets.push('pending = pending + 1');
    } else if (change.pending !== undefined) {
      sets.push('pending = ?');
      values.push(change.pending);
    }
    if (change.notedAt !== undefined) {
      sets.push('noted_at = ?');
      values.push(change.notedAt);
    }
    if (change.noting !== undefined) {
      sets.push('noting = ?');
      values.push(change.noting ? 1 : 0);
    }
    if (sets.length === 0) return;
    const touchesPending =
      change.answered !== undefined || change.addPending === true || change.pending !== undefined;
    this.transaction(() => {
      // One statement: the answer position and the waiting count change together or not at all.
      this.db.prepare(`UPDATE threads SET ${sets.join(', ')} WHERE key = ?`).run(...values, key);
      if (touchesPending) {
        // A session with messages waiting is working; with none, idle. Stopped and ended
        // sessions keep their state: that comes from Herdr, and from ending one.
        this.db
          .prepare(
            `UPDATE sessions SET state = CASE WHEN t.pending > 0 THEN 'working' ELSE 'idle' END
             FROM threads t WHERE t.key = ? AND sessions.id = t.session
               AND sessions.state IN ('starting', 'working', 'idle')`,
          )
          .run(key);
      }
    });
  }

  /** Changes a thread's session's fields. Does nothing for a thread that isn't recorded. */
  updateThreadSession(
    key: string,
    change: { engineSessionId?: string; lastActiveAt?: string },
  ): void {
    const sets: string[] = [];
    const values: SQLInputValue[] = [];
    if (change.engineSessionId !== undefined) {
      sets.push('engine_session_id = ?');
      values.push(change.engineSessionId);
    }
    if (change.lastActiveAt !== undefined) {
      sets.push('last_active_at = ?');
      values.push(change.lastActiveAt);
    }
    if (sets.length === 0) return;
    this.db
      .prepare(
        `UPDATE sessions SET ${sets.join(', ')} WHERE id = (SELECT session FROM threads WHERE key = ?)`,
      )
      .run(...values, key);
  }

  private threadRow(key: string): Row | undefined {
    return this.db.prepare(`${THREAD_SELECT} WHERE t.key = ?`).get(key);
  }

  private transaction(work: () => void): void {
    if (this.db.isTransaction) {
      work();
      return;
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      work();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

/** Sessions and agents in one workspace. Every query here is filtered by it. */
export class WorkspaceSessions {
  constructor(
    private readonly db: DatabaseSync,
    readonly workspace: string,
  ) {}

  agents(): StandingAgent[] {
    return (
      this.db
        .prepare(
          'SELECT id, workspace, project, name, role, engine FROM agents WHERE workspace = ? ORDER BY id',
        )
        .all(this.workspace) as unknown as StandingAgent[]
    ).map((a) => ({ ...a }));
  }

  session(id: string): SessionRecord | undefined {
    const row = this.db
      .prepare(`${SESSION_SELECT} WHERE workspace = ? AND id = ?`)
      .get(this.workspace, id);
    return row === undefined ? undefined : toSession(row);
  }

  /** Sessions in the workspace, most recently active first. */
  sessions(filter: SessionFilter = {}): SessionRecord[] {
    const where = ['workspace = ?'];
    const values: SQLInputValue[] = [this.workspace];
    for (const [column, value] of [
      ['kind', filter.kind],
      ['state', filter.state],
      ['agent', filter.agent],
      ['owner', filter.owner],
      ['project', filter.project],
    ] as const) {
      if (value === undefined) continue;
      // IS matches null too: the person's sessions have no owner.
      where.push(`${column} IS ?`);
      values.push(value);
    }
    return this.db
      .prepare(`${SESSION_SELECT} WHERE ${where.join(' AND ')} ORDER BY last_active_at DESC, id`)
      .all(...values)
      .map(toSession);
  }

  /** Records a new ad-hoc session, starting. */
  create(session: NewSession): SessionRecord {
    this.db
      .prepare(
        `INSERT INTO sessions (id, workspace, project, agent, kind, owner, parent, title, purpose,
           summary, state, herdr_name, folder, created_at, last_active_at)
         VALUES (?, ?, ?, ?, 'adhoc', ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        this.workspace,
        session.project,
        session.agent,
        session.owner,
        session.parent,
        session.title,
        session.purpose,
        // The summary is written by code: the purpose at first, then the latest note's title.
        session.purpose,
        session.herdrName,
        session.folder,
        session.createdAt,
        session.createdAt,
      );
    const created = this.session(session.id);
    if (!created) throw new Error(`Session ${session.id} wasn't recorded`);
    return created;
  }

  /**
   * Changes a session in this workspace. Does nothing for one that isn't here, or, with
   * `ifState`, for one no longer in that state, so a change worked out from an earlier read
   * never overwrites a newer one.
   */
  update(id: string, change: SessionChange, ifState?: SessionState): void {
    const columns: [string, SQLInputValue | undefined][] = [
      ['state', change.state],
      ['summary', change.summary],
      ['engine_session_id', change.engineSessionId],
      ['launch_started_at', change.launchStartedAt],
      ['launch_tag', change.launchTag],
      ['launched_at', change.launchedAt],
      ['last_active_at', change.lastActiveAt],
      ['ended_at', change.endedAt],
    ];
    const set = columns.filter(([, value]) => value !== undefined);
    if (set.length === 0) return;
    this.db
      .prepare(
        `UPDATE sessions SET ${set.map(([column]) => `${column} = ?`).join(', ')} WHERE workspace = ? AND id = ?${ifState !== undefined ? ' AND state = ?' : ''}`,
      )
      .run(
        ...set.map(([, value]) => value ?? null),
        this.workspace,
        id,
        ...(ifState !== undefined ? [ifState] : []),
      );
  }

  /** How many ad-hoc sessions an owner (null for the person) has open: not ended. */
  openCount(owner: string | null): number {
    const row = this.db
      .prepare(
        "SELECT count(*) AS n FROM sessions WHERE workspace = ? AND kind = 'adhoc' AND state != 'ended' AND owner IS ?",
      )
      .get(this.workspace, owner);
    return Number(row?.n ?? 0);
  }

  /**
   * How many levels of ad-hoc sessions lead to this one: 0 for a thread session, 1 for one a
   * chief's thread or the person started, and one more for each ad-hoc session above it.
   */
  depth(id: string): number {
    let depth = 0;
    let current = this.session(id);
    while (current?.kind === 'adhoc' && depth < 100) {
      depth++;
      current = current.parent === null ? undefined : this.session(current.parent);
    }
    return depth;
  }

  /** Records a message sent into one of this workspace's sessions. */
  addMessage(message: {
    id: string;
    kind?: MessageKind;
    sender: string | null;
    receiver: string;
    messageFile: string;
    sentAt: string;
  }): MessageRecord {
    this.db
      .prepare(
        `INSERT INTO messages (id, workspace, kind, sender, receiver, message_file, state, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, 'sent', ?)`,
      )
      .run(
        message.id,
        this.workspace,
        message.kind ?? 'message',
        message.sender,
        message.receiver,
        message.messageFile,
        message.sentAt,
      );
    const added = this.message(message.id);
    if (!added) throw new Error(`Message ${message.id} wasn't recorded`);
    return added;
  }

  message(id: string): MessageRecord | undefined {
    const row = this.db
      .prepare(`${MESSAGE_SELECT} WHERE workspace = ? AND id = ?`)
      .get(this.workspace, id);
    return row === undefined ? undefined : toMessage(row);
  }

  /** Marks a sent message answered (with the file holding its answer, if any) or failed. */
  finishMessage(
    id: string,
    state: 'answered' | 'failed',
    answerFile: string | null,
    at: string,
  ): void {
    this.db
      .prepare(
        "UPDATE messages SET state = ?, answer_file = ?, answered_at = ? WHERE workspace = ? AND id = ? AND state = 'sent'",
      )
      .run(state, answerFile, at, this.workspace, id);
  }

  /** A session's latest messages, sent or received, newest first. */
  messages(sessionId: string, limit = 5): MessageRecord[] {
    return this.db
      .prepare(
        `${MESSAGE_SELECT} WHERE workspace = ? AND (receiver = ? OR sender = ?)
         ORDER BY sent_at DESC, id DESC LIMIT ?`,
      )
      .all(this.workspace, sessionId, sessionId, limit)
      .map(toMessage);
  }

  /**
   * Sessions whose title, purpose, summary, agent or project has every one of the words,
   * most recently active first.
   */
  search(words: string, limit = 20): SessionRecord[] {
    const query = ftsQuery(words, { all: true });
    if (query === null) return [];
    return this.db
      .prepare(
        `${SESSION_SELECT} WHERE workspace = ? AND id IN (
           SELECT session FROM session_search WHERE session_search MATCH ? AND workspace = ?
         ) ORDER BY last_active_at DESC, id LIMIT ?`,
      )
      .all(this.workspace, query, this.workspace, limit)
      .map(toSession);
  }
}

/** Reads `conversations.json` from a Wheems before the store, without changing it. */
export async function readConversationsFile(
  file: string,
): Promise<
  | { status: 'none' }
  | { status: 'unreadable'; problem: string }
  | { status: 'read'; conversations: Record<string, Conversation> }
> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'none' };
    return { status: 'unreadable', problem: describe(error) };
  }
  try {
    const parsed = z.record(z.string(), conversationSchema).safeParse(JSON.parse(raw) as unknown);
    if (!parsed.success) return { status: 'unreadable', problem: z.prettifyError(parsed.error) };
    return { status: 'read', conversations: parsed.data };
  } catch (error) {
    return { status: 'unreadable', problem: describe(error) };
  }
}

const THREAD_SELECT = `SELECT t.key, t.workspace, t.connection, t.channel, t.thread, t.session,
  t.last_answer_id, t.pending, t.noted_at, t.noting, s.herdr_name, s.engine_session_id,
  s.launch_started_at, s.launch_tag, s.launched_at, s.created_at, s.last_active_at
  FROM threads t JOIN sessions s ON s.id = t.session`;

const SESSION_SELECT = `SELECT id, workspace, project, agent, kind, owner, parent, title, purpose,
  summary, state, herdr_name, engine_session_id, folder, launch_started_at, launch_tag,
  launched_at, created_at, last_active_at, ended_at FROM sessions`;

function toConversation(row: Row): Conversation {
  const optional = (value: SQLOutputValue | undefined) =>
    value === null || value === undefined ? undefined : String(value);
  const conversation: Conversation = {
    workspace: String(row.workspace),
    connection: String(row.connection),
    channel: String(row.channel),
    thread: String(row.thread),
    sessionId: String(row.session),
    sessionName: String(row.herdr_name),
    createdAt: String(row.created_at),
    lastActiveAt: String(row.last_active_at),
  };
  const fields: [keyof Conversation, string | undefined][] = [
    ['lastAnswerId', optional(row.last_answer_id)],
    ['engineSessionId', optional(row.engine_session_id)],
    ['startedAt', optional(row.launch_started_at)],
    ['launchTag', optional(row.launch_tag)],
    ['launchedAt', optional(row.launched_at)],
    ['notedAt', optional(row.noted_at)],
  ];
  for (const [field, value] of fields) {
    if (value !== undefined) (conversation as Record<string, unknown>)[field] = value;
  }
  conversation.pending = Number(row.pending);
  if (Number(row.noting) === 1) conversation.noting = true;
  return conversation;
}

const MESSAGE_SELECT = `SELECT id, workspace, kind, sender, receiver, message_file, answer_file,
  state, sent_at, answered_at FROM messages`;

function toMessage(row: Row): MessageRecord {
  const text = (value: SQLOutputValue | undefined) =>
    value === null || value === undefined ? null : String(value);
  return {
    id: String(row.id),
    workspace: String(row.workspace),
    kind: String(row.kind) as MessageKind,
    sender: text(row.sender),
    receiver: String(row.receiver),
    messageFile: String(row.message_file),
    answerFile: text(row.answer_file),
    state: String(row.state) as MessageState,
    sentAt: String(row.sent_at),
    answeredAt: text(row.answered_at),
  };
}

function toSession(row: Row): SessionRecord {
  const text = (value: SQLOutputValue | undefined) =>
    value === null || value === undefined ? null : String(value);
  return {
    id: String(row.id),
    workspace: String(row.workspace),
    project: text(row.project),
    agent: text(row.agent),
    kind: String(row.kind) as SessionKind,
    owner: text(row.owner),
    parent: text(row.parent),
    title: text(row.title),
    purpose: text(row.purpose),
    summary: text(row.summary),
    state: String(row.state) as SessionState,
    herdrName: text(row.herdr_name),
    engineSessionId: text(row.engine_session_id),
    folder: text(row.folder),
    launchStartedAt: text(row.launch_started_at),
    launchTag: text(row.launch_tag),
    launchedAt: text(row.launched_at),
    createdAt: String(row.created_at),
    lastActiveAt: String(row.last_active_at),
    endedAt: text(row.ended_at),
  };
}

/** Makes a file readable and writable by its owner only, if it exists. */
async function ownerOnly(file: string): Promise<void> {
  try {
    await chmod(file, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
