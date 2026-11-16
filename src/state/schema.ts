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
