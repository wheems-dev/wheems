import type { DatabaseSync } from 'node:sqlite';

/**
 * The session store's schema, as numbered migrations. The version reached is kept in
 * `PRAGMA user_version`; each migration runs once, in its own transaction, at service start.
 * Add a migration to change the schema; never edit one that has shipped.
 */
export const MIGRATIONS: readonly string[] = [
  // 1: agents, sessions, threads, messages and the session search index.
  `
  CREATE TABLE agents (
    id TEXT PRIMARY KEY,           -- acme/chief-of-staff, acme/reviews/lead
    workspace TEXT NOT NULL,
    project TEXT,                  -- null for a workspace's own agents
    name TEXT NOT NULL,            -- the agent file's name
    role TEXT NOT NULL CHECK (role IN ('chief', 'lead')),
    engine TEXT NOT NULL,
    written_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX agents_workspace ON agents (workspace);

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL,
    project TEXT,
    agent TEXT,                    -- an agents id, or workspace/name for an ad-hoc agent
    kind TEXT NOT NULL CHECK (kind IN ('thread', 'adhoc', 'task')),
    owner TEXT,                    -- the session that started it; null when a person did
    parent TEXT REFERENCES sessions (id),
    title TEXT,
    purpose TEXT,
    summary TEXT,
    state TEXT NOT NULL CHECK (state IN ('starting', 'working', 'idle', 'stopped', 'ended')),
    herdr_name TEXT,               -- the Herdr session's name, which outlives its address
    engine_session_id TEXT,        -- for engines that choose their own ids
    folder TEXT,
    launch_started_at TEXT,        -- when the current engine session was started
    launch_tag TEXT,               -- the tag on its first message, to find the engine's id
    launched_at TEXT,              -- when the runtime had launched its program
    created_at TEXT NOT NULL,
    last_active_at TEXT NOT NULL,
    ended_at TEXT
  ) STRICT;
  CREATE INDEX sessions_workspace ON sessions (workspace, state, last_active_at);
  CREATE INDEX sessions_herdr_name ON sessions (herdr_name);

  CREATE TABLE threads (
    key TEXT PRIMARY KEY,          -- workspace:connection:channel:thread
    workspace TEXT NOT NULL,
    connection TEXT NOT NULL,
    channel TEXT NOT NULL,
    thread TEXT NOT NULL,
    session TEXT NOT NULL REFERENCES sessions (id),
    last_answer_id TEXT,           -- the last answer posted; '' for none yet, null for unknown
    pending INTEGER NOT NULL DEFAULT 0 CHECK (pending >= 0),
    noted_at TEXT,
    noting INTEGER NOT NULL DEFAULT 0 CHECK (noting IN (0, 1))
  ) STRICT;
  CREATE INDEX threads_workspace ON threads (workspace);
  CREATE INDEX threads_session ON threads (session);

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL,
    sender TEXT,                   -- a session id; null for a person
    receiver TEXT NOT NULL REFERENCES sessions (id),
    message_file TEXT NOT NULL,
    answer_file TEXT,
    state TEXT NOT NULL CHECK (state IN ('sent', 'answered', 'failed')),
    sent_at TEXT NOT NULL,
    answered_at TEXT
  ) STRICT;
  CREATE INDEX messages_receiver ON messages (workspace, receiver, sent_at);

  CREATE VIRTUAL TABLE session_search USING fts5 (
    session UNINDEXED,
    workspace UNINDEXED,
    title,
    purpose,
    summary,
    agent,
    project,
    tokenize = 'porter unicode61'
  );
  CREATE TRIGGER sessions_search_insert AFTER INSERT ON sessions BEGIN
    INSERT INTO session_search (session, workspace, title, purpose, summary, agent, project)
    VALUES (new.id, new.workspace, new.title, new.purpose, new.summary, new.agent, new.project);
  END;
  CREATE TRIGGER sessions_search_update
  AFTER UPDATE OF workspace, title, purpose, summary, agent, project ON sessions BEGIN
    DELETE FROM session_search WHERE session = old.id;
    INSERT INTO session_search (session, workspace, title, purpose, summary, agent, project)
    VALUES (new.id, new.workspace, new.title, new.purpose, new.summary, new.agent, new.project);
  END;
  CREATE TRIGGER sessions_search_delete AFTER DELETE ON sessions BEGIN
    DELETE FROM session_search WHERE session = old.id;
  END;
  `,
  // 2: what a message is: one sent with wheems session send (or a purpose), or an answer
  // handed back to its sender, which can be delivered again after a restart.
  `
  ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'message'
    CHECK (kind IN ('message', 'handback'));
  `,
  // 3: the person's own words that started the work: a chat thread's first message, passed on
  // to every session started for it, so each one can see what was asked. Null when unknown.
  `
  ALTER TABLE sessions ADD COLUMN ask TEXT;
  `,
  // 4: a chat thread's turns, as said in chat: the person's messages, the agent's answers and
  // Wheems's own notices, so they can be read back (in the web app) without the chat app.
  `
  CREATE TABLE chat (
    id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL,
    session TEXT NOT NULL REFERENCES sessions (id),
    author TEXT NOT NULL CHECK (author IN ('person', 'agent', 'wheems')),
    text TEXT NOT NULL,
    at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX chat_session ON chat (workspace, session, at);
  `,
  // 5: handing a chat thread over to a new engine session, or starting it afresh. A thread's
  // generation counts its fresh starts, so each gets an engine session id of its own; its
  // handover is what the next one starts from: a handover's id, 'fresh', or null for none.
  `
  ALTER TABLE threads ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE threads ADD COLUMN handover TEXT;
  CREATE TABLE handovers (
    id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL,
    session TEXT NOT NULL REFERENCES sessions (id),
    text TEXT NOT NULL,
    author TEXT NOT NULL CHECK (author IN ('agent', 'wheems')),
    from_engine TEXT,
    from_model TEXT,
    written_at TEXT NOT NULL,
    to_engine TEXT,
    to_model TEXT,
    used_at TEXT
  ) STRICT;
  CREATE INDEX handovers_session ON handovers (workspace, session, written_at);
  `,
  // 6: an ad-hoc session's finish line: what must be true when its job is done, in things that
  // can be checked. A chief must give one; its hand-backs show it, to check the answer against.
  `
  ALTER TABLE sessions ADD COLUMN done_when TEXT;
  `,
  // 7: approvals: a question that waits for a decision, from the chief (for its team) or from the
  // person. The question, details and choices never change once asked (docs/approvals.md).
  `
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('request', 'action', 'purchase', 'folder', 'workflow')),
    asker_session TEXT,            -- the session that asked; null when a rule did
    asker_agent TEXT,
    decider TEXT NOT NULL CHECK (decider IN ('chief', 'person')),
    person_only INTEGER NOT NULL DEFAULT 0 CHECK (person_only IN (0, 1)),
    chief_session TEXT,            -- the chief's chat thread the work came from; null for none
    question TEXT NOT NULL,
    details TEXT,
    choices TEXT NOT NULL,         -- a JSON array of labels
    fingerprint TEXT NOT NULL,     -- of exactly what was asked
    state TEXT NOT NULL
      CHECK (state IN ('waiting', 'escalated', 'answered', 'expired', 'withdrawn')),
    answer TEXT,
    reason TEXT,
    answered_by TEXT CHECK (answered_by IN ('chief', 'person')),
    answered_via TEXT CHECK (answered_via IN ('session', 'chat', 'web', 'terminal')),
    note TEXT,                     -- the chief's note when it escalated
    post_connection TEXT,
    post_channel TEXT,
    post_thread TEXT,
    post_message TEXT,
    asked_at TEXT NOT NULL,
    escalated_at TEXT,
    answered_at TEXT,              -- answered, expired or withdrawn
    delivered_at TEXT,             -- when the outcome was kept for its asker, to be delivered
    expires_at TEXT NOT NULL,
    reported_at TEXT               -- when a chief's decision went in its daily list
  ) STRICT;
  CREATE INDEX approvals_workspace ON approvals (workspace, state, asked_at);
  CREATE INDEX approvals_asker ON approvals (asker_session, state);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** The schema version a store file is at. */
export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

/**
 * Brings a store up to the current schema. Refuses a store made by a newer Wheems, whose
 * schema this one doesn't know, rather than write to it.
 */
export function migrate(db: DatabaseSync): { from: number; to: number } {
  const from = schemaVersion(db);
  if (from > SCHEMA_VERSION) {
    throw new Error(
      `The session store is at schema version ${String(from)}, from a newer Wheems than this one (which knows up to ${String(SCHEMA_VERSION)}). Update Wheems.`,
    );
  }
  for (let version = from; version < SCHEMA_VERSION; version++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[version] ?? '');
      db.exec(`PRAGMA user_version = ${String(version + 1)}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return { from, to: SCHEMA_VERSION };
}
