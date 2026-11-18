import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { BUN_SUPPORTED } from './bun-support.js';

type Sqlite = typeof import('node:sqlite');

let loaded: Promise<Sqlite> | undefined;

/** SQLite, through Bun's `node:sqlite`, loaded once, when first needed. */
export function sqlite(): Promise<Sqlite> {
  loaded ??= import('node:sqlite');
  return loaded;
}

/**
 * Opens a SQLite file, in WAL mode when it may be written, so readers never wait on a writer.
 *
 * Read-only, it must exist already, and SQLite refuses every change to it (`query_only`).
 * Bun's SQLite can't open a WAL database with the read-only flag, so it's opened as usual and
 * made query-only instead. `beforeQueryOnly` runs first, for anything that only this connection
 * sees, such as temporary views.
 */
export async function openDatabase(
  file: string,
  options: { readOnly?: boolean; beforeQueryOnly?: (db: DatabaseSync) => void } = {},
): Promise<DatabaseSync> {
  const { DatabaseSync } = await sqlite();
  const readOnly = options.readOnly === true;
  if (readOnly && file !== ':memory:' && !existsSync(file)) {
    throw new Error(`unable to open database file: ${file} doesn't exist`);
  }
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    if (readOnly) {
      options.beforeQueryOnly?.(db);
      db.exec('PRAGMA query_only = ON');
    } else {
      db.exec('PRAGMA journal_mode = WAL');
    }
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/** Something that runs SQL, as `DatabaseSync` does; tests pass a stand-in. */
export interface SqlRunner {
  exec(sql: string): void;
  close(): void;
}

/**
 * Why this SQLite can't do full-text search (FTS5), which search needs, or null when it can.
 * `open` makes a scratch database; by default an in-memory one from `node:sqlite`.
 */
export async function fullTextSearchProblem(
  open?: () => Promise<SqlRunner>,
): Promise<string | null> {
  let db: SqlRunner;
  try {
    db = open ? await open() : new (await sqlite()).DatabaseSync(':memory:');
  } catch (error) {
    return `SQLite isn't available: ${describe(error)}. Use ${BUN_SUPPORTED}.`;
  }
  try {
    db.exec('CREATE VIRTUAL TABLE probe USING fts5(text)');
    return null;
  } catch (error) {
    return `This runtime (${process.execPath}) has SQLite without full-text search (FTS5), which Wheems's search needs (${describe(error)}). Use ${BUN_SUPPORTED}.`;
  } finally {
    db.close();
  }
}

let checked: Promise<string | null> | undefined;

/** Throws a plain explanation when this SQLite has no full-text search. Checks once. */
export async function requireFullTextSearch(): Promise<void> {
  checked ??= fullTextSearchProblem();
  const problem = await checked;
  if (problem !== null) throw new Error(problem);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
