import type { DatabaseSync } from 'node:sqlite';
import { NODE_SUPPORTED } from './node-support.js';

type Sqlite = typeof import('node:sqlite');

let loaded: Promise<Sqlite> | undefined;

/**
 * Node's built-in SQLite, loaded without its "experimental" warning, which would otherwise
 * be printed by every `wheems` command that touches the search index. Only that one warning
 * is hidden.
 */
export function sqlite(): Promise<Sqlite> {
  loaded ??= (async () => {
    const emit = process.emitWarning.bind(process);
    process.emitWarning = (warning: string | Error, ...rest: unknown[]) => {
      const text = typeof warning === 'string' ? warning : warning.message;
      const first = rest[0];
      const type =
        typeof first === 'string'
          ? first
          : typeof first === 'object' && first !== null && 'type' in first
            ? String(first.type)
            : typeof warning === 'string'
              ? undefined
              : warning.name;
      if (type === 'ExperimentalWarning' && /SQLite/i.test(text)) return;
      (emit as (...args: unknown[]) => void)(warning, ...rest);
    };
    try {
      return await import('node:sqlite');
    } finally {
      process.emitWarning = emit;
    }
  })();
  return loaded;
}

/** Opens a SQLite file, in WAL mode when it may be written, so readers never wait on a writer. */
export async function openDatabase(
  file: string,
  options: { readOnly?: boolean } = {},
): Promise<DatabaseSync> {
  const { DatabaseSync } = await sqlite();
  const db = new DatabaseSync(file, { readOnly: options.readOnly === true });
  db.exec('PRAGMA busy_timeout = 5000');
  if (options.readOnly !== true) db.exec('PRAGMA journal_mode = WAL');
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
    return `Node's SQLite isn't available: ${describe(error)}. Use ${NODE_SUPPORTED}.`;
  }
  try {
    db.exec('CREATE VIRTUAL TABLE probe USING fts5(text)');
    return null;
  } catch (error) {
    return `This Node.js (${process.versions.node}, ${process.execPath}) has SQLite without full-text search (FTS5), which Wheems's search needs (${describe(error)}). Use ${NODE_SUPPORTED}, from nodejs.org or a package that bundles Node's own SQLite.`;
  } finally {
    db.close();
  }
}

let checked: Promise<string | null> | undefined;

/** Throws a plain explanation when this Node's SQLite has no full-text search. Checks once. */
export async function requireFullTextSearch(): Promise<void> {
  checked ??= fullTextSearchProblem();
  const problem = await checked;
  if (problem !== null) throw new Error(problem);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
