import type { DatabaseSync } from 'node:sqlite';

type Sqlite = typeof import('node:sqlite');

let loaded: Promise<Sqlite> | undefined;

/**
 * Node's built-in SQLite, loaded without its "experimental" warning, which would otherwise
 * be printed by every `opinr` command that touches the search index. Only that one warning
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
