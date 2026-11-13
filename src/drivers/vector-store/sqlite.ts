import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DriverError, type HealthCheck } from '../../contracts/driver.js';
import {
  COLLECTION_NAME,
  type VectorCollection,
  type VectorItem,
  type VectorMatch,
  type VectorStoreDriver,
} from '../../contracts/vector-store.js';
import { openDatabase, sqlite } from '../../util/sqlite.js';

export interface SqliteVectorStoreOptions {
  /** The folder each collection's file goes in. */
  dir: string;
}

/**
 * Vectors in SQLite files, one per collection, compared in code. Every search reads every
 * vector, which takes a few milliseconds for thousands of pages and needs nothing installed.
 * Vectors are stored normalised, so similarity is a dot product.
 */
export class SqliteVectorStore implements VectorStoreDriver {
  readonly kind = 'vector-store' as const;
  readonly name = 'sqlite';
  private readonly dir: string;

  constructor(options: SqliteVectorStoreOptions) {
    this.dir = options.dir;
  }

  async open(name: string): Promise<VectorCollection> {
    await mkdir(this.dir, { recursive: true });
    const db = await openDatabase(this.file(name));
    db.exec(
      'CREATE TABLE IF NOT EXISTS vectors (id TEXT PRIMARY KEY, vector BLOB NOT NULL) WITHOUT ROWID',
    );
    return new SqliteCollection(name, db);
  }

  async drop(name: string): Promise<void> {
    const file = this.file(name);
    for (const suffix of ['', '-wal', '-shm']) await rm(`${file}${suffix}`, { force: true });
  }

  async check(): Promise<HealthCheck[]> {
    try {
      await sqlite();
      return [{ name: 'vector store', status: 'pass', message: `SQLite files in ${this.dir}` }];
    } catch (error) {
      return [
        {
          name: 'vector store',
          status: 'fail',
          message: `Node's SQLite isn't available: ${error instanceof Error ? error.message : String(error)}`,
          hint: 'Use Node.js 22.13 or later.',
        },
      ];
    }
  }

  private file(name: string): string {
    if (!COLLECTION_NAME.test(name)) {
      throw new DriverError(
        this.name,
        'invalid',
        `"${name}" isn't a collection name: use lowercase letters, digits, dots and dashes`,
      );
    }
    return join(this.dir, `${name}.sqlite`);
  }
}

/* eslint-disable @typescript-eslint/require-await -- Node's SQLite is synchronous; async methods
   turn its errors into rejected promises, as the contract says. */
class SqliteCollection implements VectorCollection {
  /** Every vector, read once and kept until the collection changes. */
  private cache: { id: string; vector: Float32Array }[] | null = null;

  constructor(
    readonly name: string,
    private readonly db: DatabaseSync,
  ) {}

  async upsert(items: VectorItem[]): Promise<void> {
    if (items.length === 0) return;
    const length = this.dimensions() ?? items[0]?.vector.length;
    for (const item of items) {
      if (item.vector.length !== length || length === 0) {
        throw new DriverError(
          'sqlite',
          'invalid',
          `Vectors in ${this.name} have ${String(length)} numbers, not ${String(item.vector.length)}`,
        );
      }
    }
    const insert = this.db.prepare(
      'INSERT INTO vectors (id, vector) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET vector = excluded.vector',
    );
    this.transaction(() => {
      for (const item of items) insert.run(item.id, toBlob(normalise(item.vector)));
    });
    this.cache = null;
  }

  async remove(ids: string[]): Promise<void> {
    const remove = this.db.prepare('DELETE FROM vectors WHERE id = ?');
    this.transaction(() => {
      for (const id of ids) remove.run(id);
    });
    this.cache = null;
  }

  async nearest(vector: Float32Array, k: number): Promise<VectorMatch[]> {
    const query = normalise(vector);
    this.cache ??= this.db
      .prepare('SELECT id, vector FROM vectors')
      .all()
      .map((row) => ({ id: String(row.id), vector: fromBlob(row.vector as Uint8Array) }));
    const matches: VectorMatch[] = [];
    for (const { id, vector: stored } of this.cache) {
      if (stored.length !== query.length) continue;
      let dot = 0;
      for (let i = 0; i < stored.length; i++) dot += (stored[i] ?? 0) * (query[i] ?? 0);
      matches.push({ id, score: dot });
    }
    matches.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return matches.slice(0, Math.max(0, k));
  }

  async count(): Promise<number> {
    const row = this.db.prepare('SELECT count(*) AS n FROM vectors').get();
    return Number(row?.n ?? 0);
  }

  async clear(): Promise<void> {
    this.db.exec('DELETE FROM vectors');
    this.cache = null;
  }

  async close(): Promise<void> {
    if (this.db.isOpen) this.db.close();
  }

  private dimensions(): number | undefined {
    const row = this.db.prepare('SELECT vector FROM vectors LIMIT 1').get();
    return row ? (row.vector as Uint8Array).byteLength / 4 : undefined;
  }

  private transaction(work: () => void): void {
    this.db.exec('BEGIN');
    try {
      work();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

/* eslint-enable @typescript-eslint/require-await */

function normalise(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const x of vector) sum += x * x;
  const norm = Math.sqrt(sum);
  return norm === 0 ? Float32Array.from(vector) : vector.map((x) => x / norm);
}

function toBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

function fromBlob(blob: Uint8Array): Float32Array {
  // Copied, because SQLite's buffer may not be aligned for floats.
  return new Float32Array(blob.slice().buffer);
}
