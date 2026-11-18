/**
 * The session store, `.wheems/state.sqlite`: the one module that reads and writes it.
 *
 * Herdr says whether a session is alive; the store says what it's for. Only the service
 * writes to it (doctor opens it read-only). Queries made on behalf of a caller go through
 * `workspace(id)`, where every one is filtered by that workspace; the install-wide ones are
 * for the service itself: writing agents from config, importing `conversations.json`, matching
 * the store against Herdr at start, and routing chat threads, whose keys carry their workspace.
 */
import { randomUUID } from 'node:crypto';
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
  /**
   * How many times the thread has started afresh, handed over or not: each start has an engine
   * session id of its own. Missing for 0.
   */
  generation: z.number().int().nonnegative().optional(),
  /**
   * What the thread's next session starts from, when it doesn't resume: a handover's id, or
   * 'fresh' for nothing but the thread's ask.
   */
  handover: z.string().optional(),
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
  /**
   * The person's own words that started the work: the chat thread's first message, inherited
   * by every session started for it. Null when unknown, such as for sessions from before 0.2.
   */
  ask: string | null;
  /** What must be true when its job is done, in things that can be checked. Null when none. */
  doneWhen: string | null;
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
  ask: string | null;
  doneWhen?: string | null;
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

/** Who said a turn in a chat thread: the person, the agent, or Wheems itself. */
export type ChatAuthor = 'person' | 'agent' | 'wheems';

/** One turn in a chat thread, as said in chat. */
export interface ChatTurn {
  id: string;
  session: string;
  author: ChatAuthor;
  text: string;
  at: string;
}

/** The most of one chat turn kept in the store; the chat app keeps the whole of it. */
export const CHAT_TURN_MAX = 20_000;

/** Who wrote a handover: the agent handing over, or Wheems, from what it keeps, when it couldn't. */
export type HandoverAuthor = 'agent' | 'wheems';

/** What a thread's next session starts from, written when its last one was handed over. */
export interface Handover {
  id: string;
  workspace: string;
  session: string;
  text: string;
  author: HandoverAuthor;
  fromEngine: string | null;
  fromModel: string | null;
  writtenAt: string;
  toEngine: string | null;
  toModel: string | null;
  usedAt: string | null;
}

/** The longest handover kept; anything longer is cut short. */
export const HANDOVER_MAX = 40_000;

function capText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
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

/** What an approval is for: a request from an agent now; the broker's actions and others later. */
export type ApprovalKind = 'request' | 'action' | 'purchase' | 'folder' | 'workflow';
/** Who decides an approval: the chief (for a request from its team) or the person. */
export type Decider = 'chief' | 'person';
export type ApprovalState = 'waiting' | 'escalated' | 'answered' | 'expired' | 'withdrawn';
/** How an approval was answered: by the chief's session, or by the person in chat, the web app or a terminal. */
export type AnsweredVia = 'session' | 'chat' | 'web' | 'terminal';

/** Where an approval was posted for the person. */
export interface ApprovalPost {
  connection: string;
  channel: string;
  /** The thread it was posted in, or null for a post that started none. */
  thread: string | null;
  message: string;
}

/** A question waiting for a decision, and what became of it (docs/approvals.md). */
export interface ApprovalRecord {
  id: string;
  workspace: string;
  kind: ApprovalKind;
  /** The session that asked, and its agent; null when a rule asked. */
  askerSession: string | null;
  askerAgent: string | null;
  decider: Decider;
  /** Only the person may answer it: the chief carries it but can't. */
  personOnly: boolean;
  /** The chief's chat thread the work came from, or null when it came from none. */
  chiefSession: string | null;
  question: string;
  details: string | null;
  choices: string[];
  fingerprint: string;
  state: ApprovalState;
  answer: string | null;
  reason: string | null;
  answeredBy: Decider | null;
  answeredVia: AnsweredVia | null;
  /** The chief's note when it brought the request to the person. */
  note: string | null;
  post: ApprovalPost | null;
  askedAt: string;
  escalatedAt: string | null;
  /** When it was answered, expired or withdrawn. */
  answeredAt: string | null;
  /** When its outcome was kept for everyone who must hear it, to be delivered (again after a restart). */
  deliveredAt: string | null;
  /** The sessions its outcome has been kept for so far, so a retry skips them. */
  deliveredTo: string[];
  expiresAt: string;
  /** When a chief's decision went in its daily list to the person. */
  reportedAt: string | null;
}

/** A new approval's row. */
export interface NewApproval {
  id: string;
  kind: ApprovalKind;
  askerSession: string | null;
  askerAgent: string | null;
  decider: Decider;
  personOnly: boolean;
  chiefSession: string | null;
  question: string;
  details: string | null;
  choices: string[];
  fingerprint: string;
  askedAt: string;
  expiresAt: string;
}

/** An answer to an approval, recorded once. */
export interface ApprovalAnswer {
  answer: string;
  reason: string | null;
  by: Decider;
  via: AnsweredVia;
  at: string;
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
  /**
   * Opens the store. Read-only, it refuses a store at another schema version, unless
   * `olderSchema` is set: then a store from an older Wheems (version 2 or later) is read as if
   * it were current, its missing columns empty, for readers such as the web app that run beside
   * an older service.
   */
  static async open(
    file: string,
    options: { readOnly?: boolean; olderSchema?: boolean } = {},
  ): Promise<StateStore> {
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
        if (options.olderSchema === true && version >= 2 && version < SCHEMA_VERSION) {
          // Temporary views take the tables' place for this connection only; nothing is written.
          if (version < 6) {
            // No session had an ask before version 3, nor a finish line before version 6.
            db.exec(
              `CREATE TEMP VIEW sessions AS SELECT *, ${version < 3 ? 'NULL AS ask, ' : ''}NULL AS done_when FROM main.sessions`,
            );
          }
          if (version < 4) {
            // No chat was recorded before version 4: an empty view stands in for the table.
            db.exec(
              'CREATE TEMP VIEW chat AS SELECT NULL AS id, NULL AS workspace, NULL AS session, NULL AS author, NULL AS text, NULL AS at WHERE 0',
            );
          }
          if (version < 5) {
            // No thread was handed over before version 5.
            db.exec(
              'CREATE TEMP VIEW threads AS SELECT *, 0 AS generation, NULL AS handover FROM main.threads',
            );
            db.exec(
              'CREATE TEMP VIEW handovers AS SELECT NULL AS id, NULL AS workspace, NULL AS session, NULL AS text, NULL AS author, NULL AS from_engine, NULL AS from_model, NULL AS written_at, NULL AS to_engine, NULL AS to_model, NULL AS used_at WHERE 0',
            );
          }
          if (version < 7) {
            // No approval was asked before version 7.
            db.exec(
              `CREATE TEMP VIEW approvals AS SELECT ${APPROVAL_COLUMNS.map((c) => `NULL AS ${c}`).join(', ')} WHERE 0`,
            );
          }
        } else if (version !== SCHEMA_VERSION) {
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
   * At service start: messages still waiting for an answer, in every workspace, oldest first.
   * Whoever followed them went when the service stopped; they're left as they are until each is
   * dealt with, so another restart meanwhile loses none.
   */
  waitingMessages(): MessageRecord[] {
    return this.db
      .prepare(`${MESSAGE_SELECT} WHERE state = 'sent' ORDER BY sent_at, id`)
      .all()
      .map(toMessage);
  }

  // Approvals, install-wide: for button presses, which name only the approval, and the
  // service's own expiry and delivery after a restart.

  /** An approval by id, in whichever workspace it belongs to. */
  approvalAnywhere(id: string): ApprovalRecord | undefined {
    const row = this.db.prepare(`${APPROVAL_SELECT} WHERE id = ?`).get(id);
    return row === undefined ? undefined : toApproval(row);
  }

  /**
   * Expires every approval still open whose time has run out, in one write, and returns them.
   * Their outcome still has to be delivered: see `undeliveredApprovals`.
   */
  expireApprovals(now: Date): ApprovalRecord[] {
    const at = now.toISOString();
    let expired: ApprovalRecord[] = [];
    this.transaction(() => {
      expired = this.db
        .prepare(
          `${APPROVAL_SELECT} WHERE state IN ('waiting', 'escalated') AND expires_at <= ? ORDER BY asked_at, id`,
        )
        .all(at)
        .map(toApproval);
      const expire = this.db.prepare(
        "UPDATE approvals SET state = 'expired', answered_at = ? WHERE id = ? AND state IN ('waiting', 'escalated')",
      );
      for (const approval of expired) expire.run(at, approval.id);
    });
    return expired.map((a) => ({ ...a, state: 'expired' as const, answeredAt: at }));
  }

  /** Approvals answered or expired whose outcome hasn't been kept for its asker yet, oldest first. */
  undeliveredApprovals(): ApprovalRecord[] {
    return this.db
      .prepare(
        `${APPROVAL_SELECT} WHERE state IN ('answered', 'expired') AND delivered_at IS NULL ORDER BY answered_at, id`,
      )
      .all()
      .map(toApproval);
  }

  /**
   * Forgets everything the store holds for a workspace: its standing agents, sessions, threads
   * and messages. For `wheems workspace remove`, which deletes the workspace itself.
   */
  forgetWorkspace(workspace: string): void {
    this.transaction(() => {
      for (const table of [
        'approvals',
        'chat',
        'handovers',
        'messages',
        'threads',
        'sessions',
        'agents',
      ]) {
        this.db.prepare(`DELETE FROM ${table} WHERE workspace = ?`).run(workspace);
      }
    });
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

  /**
   * Records the person's own words that started a thread session: its first message. Never
   * replaces an ask already recorded, so a later message can't take its place.
   */
  recordAsk(sessionId: string, ask: string): void {
    this.db.prepare('UPDATE sessions SET ask = ? WHERE id = ? AND ask IS NULL').run(ask, sessionId);
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

  /**
   * Sets a thread up to start afresh at its next message, in one write: its generation goes up,
   * so the next session has an engine id of its own, the engine's id for the old one is
   * forgotten, and what the next one starts from is kept. With a handover, it is saved and
   * becomes that start; without, the thread starts with only its ask. Returns the handover's id.
   */
  restartThread(
    key: string,
    handover: {
      text: string;
      author: HandoverAuthor;
      fromEngine: string | null;
      fromModel: string | null;
      at: string;
    } | null,
  ): string | null {
    const thread = this.conversation(key);
    if (!thread) throw new Error(`No conversation ${key}`);
    const id = handover === null ? null : randomUUID();
    this.transaction(() => {
      if (handover !== null && id !== null) {
        this.db
          .prepare(
            `INSERT INTO handovers (id, workspace, session, text, author, from_engine, from_model,
               written_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            thread.workspace,
            thread.sessionId,
            capText(handover.text, HANDOVER_MAX),
            handover.author,
            handover.fromEngine,
            handover.fromModel,
            handover.at,
          );
      }
      this.db
        .prepare(
          'UPDATE threads SET generation = generation + 1, handover = ?, noting = 0 WHERE key = ?',
        )
        .run(id ?? 'fresh', key);
      this.db
        .prepare(
          `UPDATE sessions SET engine_session_id = NULL, launch_tag = NULL, launch_started_at = NULL
           WHERE id = ?`,
        )
        .run(thread.sessionId);
    });
    return id;
  }

  /** A handover's text, or undefined when there's no such handover. */
  handover(id: string): Handover | undefined {
    const row = this.db.prepare(`${HANDOVER_SELECT} WHERE id = ?`).get(id);
    return row === undefined ? undefined : toHandover(row);
  }

  /**
   * A thread's next session has started from what it was set to: the handover, if any, is
   * marked used, with the engine and model that took it over.
   */
  startedAfresh(key: string, to: { engine: string; model: string; at: string }): void {
    const thread = this.conversation(key);
    if (thread?.handover === undefined) return;
    this.transaction(() => {
      if (thread.handover !== 'fresh') {
        this.db
          .prepare('UPDATE handovers SET to_engine = ?, to_model = ?, used_at = ? WHERE id = ?')
          .run(to.engine, to.model, to.at, thread.handover ?? '');
      }
      this.db.prepare('UPDATE threads SET handover = NULL WHERE key = ?').run(key);
    });
  }

  private threadRow(key: string): Row | undefined {
    return this.db.prepare(`${THREAD_SELECT} WHERE t.key = ?`).get(key);
  }

  private transaction(work: () => void): void {
    inTransaction(this.db, work);
  }
}

/** Sessions and agents in one workspace. Every query here is filtered by it. */
export class WorkspaceSessions {
  constructor(
    private readonly db: DatabaseSync,
    readonly workspace: string,
  ) {}

  /** A session's handovers, newest first: what each of its fresh starts began from. */
  handovers(session: string, limit = 10): Handover[] {
    return this.db
      .prepare(
        `${HANDOVER_SELECT} WHERE workspace = ? AND session = ? ORDER BY written_at DESC, id DESC LIMIT ?`,
      )
      .all(this.workspace, session, limit)
      .map(toHandover);
  }

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
           ask, done_when, summary, state, herdr_name, folder, created_at, last_active_at)
         VALUES (?, ?, ?, ?, 'adhoc', ?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?)`,
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
        session.ask,
        session.doneWhen ?? null,
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

  /**
   * Marks a lost message failed and records the notice that tells its sender, in one step, so
   * the notice is kept (and delivered after another restart) if the original is marked.
   */
  replaceWithNotice(
    lostId: string,
    notice: { id: string; sender: string; receiver: string; messageFile: string; sentAt: string },
  ): MessageRecord {
    inTransaction(this.db, () => {
      this.finishMessage(lostId, 'failed', null, notice.sentAt);
      this.addMessage({ ...notice, kind: 'handback' });
    });
    const added = this.message(notice.id);
    if (!added) throw new Error(`Notice ${notice.id} wasn't recorded`);
    return added;
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

  /** Records a turn said in a thread session's chat. Very long text is cut short. */
  addChat(turn: { session: string; author: ChatAuthor; text: string; at: string }): void {
    const text =
      turn.text.length > CHAT_TURN_MAX ? `${turn.text.slice(0, CHAT_TURN_MAX)}…` : turn.text;
    this.db
      .prepare(
        'INSERT INTO chat (id, workspace, session, author, text, at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(randomUUID(), this.workspace, turn.session, turn.author, text, turn.at);
  }

  /** A thread session's latest chat turns, newest first. */
  chat(sessionId: string, limit = 10): ChatTurn[] {
    return (
      this.db
        .prepare(
          `SELECT id, session, author, text, at FROM chat WHERE workspace = ? AND session = ?
           ORDER BY at DESC, id DESC LIMIT ?`,
        )
        .all(this.workspace, sessionId, limit) as Row[]
    ).map((row) => ({
      id: String(row.id),
      session: String(row.session),
      author: String(row.author) as ChatAuthor,
      text: String(row.text),
      at: String(row.at),
    }));
  }

  /**
   * How many of one session's messages to another (its purpose among them) have been answered,
   * whether the answer was waited for or handed back.
   */
  answerCount(sender: string, receiver: string): number {
    const row = this.db
      .prepare(
        `SELECT count(*) AS n FROM messages WHERE workspace = ? AND kind = 'message'
         AND sender = ? AND receiver = ? AND state = 'answered'`,
      )
      .get(this.workspace, sender, receiver) as { n: number } | undefined;
    return row?.n ?? 0;
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

  // Approvals -----------------------------------------------------------------

  /** Records a new approval, waiting for its decider. */
  addApproval(approval: NewApproval): ApprovalRecord {
    this.db
      .prepare(
        `INSERT INTO approvals (id, workspace, kind, asker_session, asker_agent, decider,
           person_only, chief_session, question, details, choices, fingerprint, state, asked_at,
           expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?)`,
      )
      .run(
        approval.id,
        this.workspace,
        approval.kind,
        approval.askerSession,
        approval.askerAgent,
        approval.decider,
        approval.personOnly ? 1 : 0,
        approval.chiefSession,
        approval.question,
        approval.details,
        JSON.stringify(approval.choices),
        approval.fingerprint,
        approval.askedAt,
        approval.expiresAt,
      );
    const added = this.approval(approval.id);
    if (!added) throw new Error(`Approval ${approval.id} wasn't recorded`);
    return added;
  }

  approval(id: string): ApprovalRecord | undefined {
    const row = this.db
      .prepare(`${APPROVAL_SELECT} WHERE workspace = ? AND id = ?`)
      .get(this.workspace, id);
    return row === undefined ? undefined : toApproval(row);
  }

  /** The workspace's approvals, newest first, optionally only those in some states. */
  approvals(
    filter: { states?: readonly ApprovalState[]; askerSession?: string; limit?: number } = {},
  ): ApprovalRecord[] {
    const where = ['workspace = ?'];
    const values: SQLInputValue[] = [this.workspace];
    if (filter.states !== undefined && filter.states.length > 0) {
      where.push(`state IN (${filter.states.map(() => '?').join(', ')})`);
      values.push(...filter.states);
    }
    if (filter.askerSession !== undefined) {
      where.push('asker_session = ?');
      values.push(filter.askerSession);
    }
    return this.db
      .prepare(
        `${APPROVAL_SELECT} WHERE ${where.join(' AND ')} ORDER BY asked_at DESC, id DESC LIMIT ?`,
      )
      .all(...values, filter.limit ?? 50)
      .map(toApproval);
  }

  /** How many approvals a session has open: waiting or escalated. */
  openApprovals(askerSession: string): number {
    const row = this.db
      .prepare(
        "SELECT count(*) AS n FROM approvals WHERE workspace = ? AND asker_session = ? AND state IN ('waiting', 'escalated')",
      )
      .get(this.workspace, askerSession) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /**
   * Records an answer, in one update from an open state and before its deadline, so two answers
   * at once can't both count, and none counts once it has run out. True when this one counted.
   */
  answerApproval(id: string, answer: ApprovalAnswer, from: readonly ApprovalState[]): boolean {
    const result = this.db
      .prepare(
        `UPDATE approvals SET state = 'answered', answer = ?, reason = ?, answered_by = ?,
           answered_via = ?, answered_at = ?
         WHERE workspace = ? AND id = ? AND expires_at > ?
         AND state IN (${from.map(() => '?').join(', ')})`,
      )
      .run(
        answer.answer,
        answer.reason,
        answer.by,
        answer.via,
        answer.at,
        this.workspace,
        id,
        answer.at,
        ...from,
      );
    return Number(result.changes) === 1;
  }

  /**
   * Passes a request waiting on the chief to the person. True when it was still waiting, and
   * hadn't run out.
   */
  escalateApproval(id: string, note: string | null, at: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE approvals SET state = 'escalated', note = ?, escalated_at = ? WHERE workspace = ? AND id = ? AND state = 'waiting' AND expires_at > ?",
      )
      .run(note, at, this.workspace, id, at);
    return Number(result.changes) === 1;
  }

  /** Takes back an open approval. True when it was still open. */
  withdrawApproval(id: string, at: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE approvals SET state = 'withdrawn', answered_at = ? WHERE workspace = ? AND id = ? AND state IN ('waiting', 'escalated')",
      )
      .run(at, this.workspace, id);
    return Number(result.changes) === 1;
  }

  /** Records where an approval was posted for the person. */
  setApprovalPost(id: string, post: ApprovalPost): void {
    this.db
      .prepare(
        `UPDATE approvals SET post_connection = ?, post_channel = ?, post_thread = ?,
           post_message = ? WHERE workspace = ? AND id = ?`,
      )
      .run(post.connection, post.channel, post.thread, post.message, this.workspace, id);
  }

  /** Records that an approval's outcome is kept for one session, so a retry skips it. */
  markApprovalDeliveredTo(id: string, session: string): void {
    this.db
      .prepare(
        `UPDATE approvals SET delivered_to = json_insert(delivered_to, '$[#]', ?)
         WHERE workspace = ? AND id = ? AND NOT EXISTS (
           SELECT 1 FROM json_each(approvals.delivered_to) WHERE value = ?
         )`,
      )
      .run(session, this.workspace, id, session);
  }

  /** Marks an approval's outcome as kept for everyone. True the first time only. */
  markApprovalDelivered(id: string, at: string): boolean {
    const result = this.db
      .prepare(
        'UPDATE approvals SET delivered_at = ? WHERE workspace = ? AND id = ? AND delivered_at IS NULL',
      )
      .run(at, this.workspace, id);
    return Number(result.changes) === 1;
  }

  /** The chief's decisions not yet in a daily list, oldest first. */
  unreportedDecisions(): ApprovalRecord[] {
    return this.db
      .prepare(
        `${APPROVAL_SELECT} WHERE workspace = ? AND state = 'answered' AND answered_by = 'chief'
         AND reported_at IS NULL ORDER BY answered_at, id`,
      )
      .all(this.workspace)
      .map(toApproval);
  }

  /** Marks the chief's decisions as reported in a daily list. */
  markReported(ids: readonly string[], at: string): void {
    inTransaction(this.db, () => {
      const mark = this.db.prepare(
        'UPDATE approvals SET reported_at = ? WHERE workspace = ? AND id = ?',
      );
      for (const id of ids) mark.run(at, this.workspace, id);
    });
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
  t.last_answer_id, t.pending, t.noted_at, t.noting, t.generation, t.handover, s.herdr_name,
  s.engine_session_id,
  s.launch_started_at, s.launch_tag, s.launched_at, s.created_at, s.last_active_at
  FROM threads t JOIN sessions s ON s.id = t.session`;

const SESSION_SELECT = `SELECT id, workspace, project, agent, kind, owner, parent, title, purpose,
  ask, done_when, summary, state, herdr_name, engine_session_id, folder, launch_started_at, launch_tag,
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
  const generation = Number(row.generation ?? 0);
  if (generation > 0) conversation.generation = generation;
  const handover = optional(row.handover);
  if (handover !== undefined) conversation.handover = handover;
  return conversation;
}

const HANDOVER_SELECT = `SELECT id, workspace, session, text, author, from_engine, from_model,
  written_at, to_engine, to_model, used_at FROM handovers`;

function toHandover(row: Row): Handover {
  const text = (value: SQLOutputValue | undefined) =>
    value === null || value === undefined ? null : String(value);
  return {
    id: String(row.id),
    workspace: String(row.workspace),
    session: String(row.session),
    text: String(row.text),
    author: String(row.author) as HandoverAuthor,
    fromEngine: text(row.from_engine),
    fromModel: text(row.from_model),
    writtenAt: String(row.written_at),
    toEngine: text(row.to_engine),
    toModel: text(row.to_model),
    usedAt: text(row.used_at),
  };
}

const APPROVAL_COLUMNS = [
  'id',
  'workspace',
  'kind',
  'asker_session',
  'asker_agent',
  'decider',
  'person_only',
  'chief_session',
  'question',
  'details',
  'choices',
  'fingerprint',
  'state',
  'answer',
  'reason',
  'answered_by',
  'answered_via',
  'note',
  'post_connection',
  'post_channel',
  'post_thread',
  'post_message',
  'asked_at',
  'escalated_at',
  'answered_at',
  'delivered_at',
  'delivered_to',
  'expires_at',
  'reported_at',
] as const;

const APPROVAL_SELECT = `SELECT ${APPROVAL_COLUMNS.join(', ')} FROM approvals`;

/** A JSON array of strings from a column; an empty list for one that's empty or unreadable. */
function jsonList(value: SQLOutputValue | undefined): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function toApproval(row: Row): ApprovalRecord {
  const text = (value: SQLOutputValue | undefined) =>
    value === null || value === undefined ? null : String(value);
  const choices = jsonList(row.choices);
  const message = text(row.post_message);
  return {
    id: String(row.id),
    workspace: String(row.workspace),
    kind: String(row.kind) as ApprovalKind,
    askerSession: text(row.asker_session),
    askerAgent: text(row.asker_agent),
    decider: String(row.decider) as Decider,
    personOnly: Number(row.person_only) === 1,
    chiefSession: text(row.chief_session),
    question: String(row.question),
    details: text(row.details),
    choices,
    fingerprint: String(row.fingerprint),
    state: String(row.state) as ApprovalState,
    answer: text(row.answer),
    reason: text(row.reason),
    answeredBy: text(row.answered_by) as Decider | null,
    answeredVia: text(row.answered_via) as AnsweredVia | null,
    note: text(row.note),
    post:
      message === null
        ? null
        : {
            connection: String(row.post_connection),
            channel: String(row.post_channel),
            thread: text(row.post_thread),
            message,
          },
    askedAt: String(row.asked_at),
    escalatedAt: text(row.escalated_at),
    answeredAt: text(row.answered_at),
    deliveredAt: text(row.delivered_at),
    deliveredTo: jsonList(row.delivered_to),
    expiresAt: String(row.expires_at),
    reportedAt: text(row.reported_at),
  };
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
    ask: text(row.ask),
    doneWhen: text(row.done_when),
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

/** Runs work in a transaction, or in the one already open. */
function inTransaction(db: DatabaseSync, work: () => void): void {
  if (db.isTransaction) {
    work();
    return;
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    work();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
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
