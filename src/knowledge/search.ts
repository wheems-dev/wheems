import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { parseDocument } from 'yaml';
import type { LoadedWorkspace } from '../config/load.js';
import type { InstallConfig } from '../config/schemas.js';
import type { EmbeddingsDriver } from '../contracts/embeddings.js';
import type { DriverRegistry } from '../contracts/registry.js';
import type { VectorCollection, VectorStoreDriver } from '../contracts/vector-store.js';
import { openDatabase, requireFullTextSearch } from '../util/sqlite.js';
import { knowledgePaths, looksLikeSecret, noteTitle } from './notes.js';

/**
 * Searching a workspace's knowledge base: its pages and notes, by keyword with SQLite's
 * full-text search, and by meaning when an embeddings driver is set up. The two rankings
 * are combined, and notes from automated jobs rank below people's own work.
 *
 * The index is running state in `.wheems/index/<workspace>/`, never committed, and always
 * rebuildable from the files. Each build is a generation: a SQLite file for the text and a
 * vector collection for the meanings. A rebuild fills a new generation and swaps it in by
 * rewriting `current.json`, so search keeps working while it runs, and a failed rebuild
 * leaves the old one in place.
 */

/** Files larger than this aren't indexed: notes are capped at 32 KB, and pages are short. */
export const MAX_FILE_SIZE = 1024 * 1024;

/** The most text in one chunk: a few paragraphs, well inside an embedding model's limit. */
export const CHUNK_SIZE = 1200;
/** How much an automated note's score counts, against a person's. */
export const AUTOMATED_WEIGHT = 0.5;
/** Reciprocal rank fusion's constant: higher evens out the two rankings more. */
const RRF_K = 60;
/** How many chunks each ranking contributes before they're combined. */
const CANDIDATES = 50;
/**
 * Matches by meaning are kept only within this much similarity of the best one, so a query
 * about something the knowledge base doesn't hold doesn't fill the results with its
 * least-unrelated pages.
 */
export const MEANING_WINDOW = 0.1;
/** Chunks embedded per request to the embeddings driver. */
const EMBED_BATCH = 32;

export interface SearchResult {
  /** The file's full path. */
  path: string;
  /** Its path inside the knowledge folder, such as `pages/boat-name.md`. */
  file: string;
  kind: 'page' | 'note';
  title: string;
  /** The passage that matched best. */
  snippet: string;
  score: number;
  /** How it was found. */
  matched: ('keyword' | 'meaning')[];
  origin: 'person' | 'automated';
  /** When it was last updated or written, as its front matter says. */
  updated: string | null;
}

export interface SearchAnswer {
  results: SearchResult[];
  /** `keyword` when there's no embeddings driver, or it couldn't be reached. */
  mode: 'hybrid' | 'keyword';
  /** Why search fell back to keywords, when it did. */
  warning?: string;
}

export interface IndexStatus {
  built: boolean;
  generation: number | null;
  documents: number;
  chunks: number;
  /** Chunks with a vector; the rest are found by keyword only until they get one. */
  embedded: number;
  /** The embeddings the index was built with. */
  embeddings: { driver: string; model: string } | null;
  /** True when the configured embeddings differ, so the next sync rebuilds it. */
  stale: boolean;
}

export interface SearchIndexOptions {
  workspace: string;
  workspaceDir: string;
  /** Where every workspace's index lives: `.wheems/index`. */
  indexDir: string;
  embeddings: EmbeddingsDriver | null;
  /** Where vectors go; needed only with embeddings. */
  vectors: VectorStoreDriver | null;
  log?: (message: string) => void;
  /**
   * Throws when SQLite can't do full-text search, which the index needs. Defaults to checking
   * this Node's `node:sqlite`; tests pass their own.
   */
  requireFullTextSearch?: () => Promise<void>;
}

interface Current {
  generation: number;
  embeddings: { driver: string; model: string } | null;
  built: string;
}

interface Connection {
  generation: number;
  db: DatabaseSync;
  collection: VectorCollection | null;
  /** Searches and writes using it now. It is closed only once none are. */
  users: number;
  /** Set once a newer generation replaces it: what to do when the last user is done. */
  retired: (() => Promise<void>) | null;
}

/** One workspace's search index. Writes run one at a time; searches can run alongside. */
export class SearchIndex {
  readonly workspace: string;
  private readonly dir: string;
  private readonly knowledge: string;
  private readonly log: (message: string) => void;
  private chain: Promise<unknown> = Promise.resolve();
  private connection: Connection | null = null;
  /** The last embedding failure logged, so a stopped Ollama is reported once, not every sync. */
  private lastEmbedError: string | null = null;
  /** Files left out of the index and already logged, by path, size and time. */
  private readonly skipped = new Set<string>();

  constructor(private readonly options: SearchIndexOptions) {
    this.workspace = options.workspace;
    this.dir = join(options.indexDir, options.workspace);
    this.knowledge = knowledgePaths(options.workspaceDir).root;
    this.log = options.log ?? (() => undefined);
  }

  /**
   * Brings the index up to date with the files: indexes what's new or changed, forgets what's
   * gone, and embeds chunks that have no vector yet. Rebuilds it when there's none, or when
   * the embeddings driver or model has changed.
   */
  sync(): Promise<void> {
    return this.enqueue(async () => {
      const current = await this.readCurrent();
      if (current === null || !(await exists(this.dbFile(current.generation)))) {
        await this.build(current);
        return;
      }
      if (!sameEmbeddings(current.embeddings, this.configured())) {
        this.log(`Search in ${this.workspace}: the embedding model changed, so rebuilding`);
        await this.build(current);
        return;
      }
      await this.using(current, async (connection) => {
        await this.update(connection);
        await this.checkVectors(connection);
        await this.embedMissing(connection);
      });
    });
  }

  /** Rebuilds the index from the files into a new generation, and swaps it in. */
  rebuild(): Promise<IndexStatus> {
    return this.enqueue(async () => {
      await this.build(await this.readCurrent());
      return this.statusNow();
    });
  }

  async search(query: string, limit = 5): Promise<SearchAnswer> {
    for (let attempt = 0; ; attempt++) {
      const current = await this.readCurrent();
      if (current === null) {
        throw new Error(
          `The ${this.workspace} workspace has no search index yet. The service builds it when it starts, or run: wheems knowledgebase reindex`,
        );
      }
      try {
        return await this.using(current, (connection) =>
          this.searchIn(current, connection, query, limit),
        );
      } catch (error) {
        // A rebuild, here or in another process, swapped in a new generation meanwhile.
        const now = await this.readCurrent();
        if (attempt >= 2 || now === null || now.generation === current.generation) throw error;
      }
    }
  }

  private async searchIn(
    current: Current,
    connection: Connection,
    query: string,
    limit: number,
  ): Promise<SearchAnswer> {
    const { db } = connection;
    const scores = new Map<number, { score: number; keyword: boolean; meaning: boolean }>();
    const add = (id: number, rank: number, how: 'keyword' | 'meaning') => {
      const entry = scores.get(id) ?? { score: 0, keyword: false, meaning: false };
      entry.score += 1 / (RRF_K + rank + 1);
      entry[how] = true;
      scores.set(id, entry);
    };

    const terms = ftsQuery(query);
    const snippets = new Map<number, string>();
    if (terms !== null) {
      const rows = db
        .prepare(
          `SELECT rowid AS id, snippet(fts, 1, '', '', '…', 40) AS snippet FROM fts WHERE fts MATCH ? ORDER BY bm25(fts, 2.0, 1.0) LIMIT ?`,
        )
        .all(terms, CANDIDATES);
      rows.forEach((row, rank) => {
        add(Number(row.id), rank, 'keyword');
        snippets.set(Number(row.id), String(row.snippet));
      });
    }

    let mode: SearchAnswer['mode'] = 'keyword';
    let warning: string | undefined;
    const embeddings = this.options.embeddings;
    const built = current.embeddings;
    if (embeddings && !sameEmbeddings(built, this.configured())) {
      // Vectors from another model can't be compared with this one's.
      warning = `Searched by keyword only: the index was built ${built ? `with ${built.model}` : 'for keyword search'} and is being rebuilt with ${embeddings.model}`;
    } else if (embeddings && connection.collection) {
      try {
        const [vector] = await embeddings.embed([query], 'query');
        if (vector) {
          const matches = await connection.collection.nearest(vector, CANDIDATES);
          const floor = Math.max(
            embeddings.minimumSimilarity ?? -1,
            (matches[0]?.score ?? 0) - MEANING_WINDOW,
          );
          matches
            .filter((match) => match.score >= floor)
            .forEach((match, rank) => {
              add(Number(match.id), rank, 'meaning');
            });
          mode = 'hybrid';
        }
      } catch (error) {
        warning = `Searched by keyword only: ${describe(error)}`;
      }
    } else if (embeddings) {
      warning = 'Searched by keyword only: the index has no vectors yet';
    }

    // The best chunk of each file stands for it.
    const chunk = db.prepare('SELECT path, text FROM chunks WHERE id = ?');
    const best = new Map<
      string,
      { id: number; text: string; score: number; keyword: boolean; meaning: boolean }
    >();
    for (const [id, entry] of scores) {
      const row = chunk.get(id);
      if (!row) continue;
      const path = String(row.path);
      const seen = best.get(path);
      if (!seen || entry.score > seen.score) {
        best.set(path, {
          id,
          text: String(row.text),
          score: entry.score,
          keyword: entry.keyword || (seen?.keyword ?? false),
          meaning: entry.meaning || (seen?.meaning ?? false),
        });
      } else {
        seen.keyword ||= entry.keyword;
        seen.meaning ||= entry.meaning;
      }
    }

    const doc = db.prepare('SELECT kind, title, origin, sources, updated FROM docs WHERE path = ?');
    const noteOrigin = db.prepare(`SELECT origin FROM docs WHERE kind = 'note' AND name = ?`);
    const results: SearchResult[] = [];
    for (const [file, hit] of best) {
      const row = doc.get(file);
      if (!row) continue;
      const kind = row.kind === 'note' ? 'note' : 'page';
      let origin: SearchResult['origin'] = row.origin === 'automated' ? 'automated' : 'person';
      if (kind === 'page') {
        // A page counts as automated only when every note it came from was automated.
        const sources = JSON.parse(String(row.sources)) as string[];
        // A note that isn't indexed any more counts as a person's: never demote on a guess.
        const automated =
          sources.length > 0 &&
          sources.every((name) => noteOrigin.get(name)?.origin === 'automated');
        origin = automated ? 'automated' : 'person';
      }
      results.push({
        path: join(this.knowledge, ...file.split('/')),
        file,
        kind,
        title: String(row.title),
        snippet: tidySnippet(snippets.get(hit.id) ?? hit.text),
        score: hit.score * (origin === 'automated' ? AUTOMATED_WEIGHT : 1),
        matched: [
          ...(hit.keyword ? (['keyword'] as const) : []),
          ...(hit.meaning ? (['meaning'] as const) : []),
        ],
        origin,
        updated: row.updated === null ? null : String(row.updated),
      });
    }
    results.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
    return {
      results: results.slice(0, Math.max(1, limit)),
      mode,
      ...(warning !== undefined && { warning }),
    };
  }

  async status(): Promise<IndexStatus> {
    return this.statusNow();
  }

  /** Waits for any write in progress, then lets go of the index files once searches finish. */
  async close(): Promise<void> {
    await this.chain.catch(() => undefined);
    await this.disconnect();
  }

  /** Runs work on a generation's connection, keeping it open until the work is done. */
  private async using<T>(
    current: Current,
    work: (connection: Connection) => Promise<T>,
  ): Promise<T> {
    const connection = await this.connect(current);
    connection.users++;
    try {
      return await work(connection);
    } finally {
      connection.users--;
      if (connection.users === 0 && connection.retired) {
        const cleanup = connection.retired;
        connection.retired = null;
        await cleanup();
      }
    }
  }

  /**
   * Stops handing out a connection, and runs \`cleanup\` (which should close it) now or, if
   * a search is still using it, once it finishes.
   */
  private async retire(connection: Connection, cleanup: () => Promise<void>): Promise<void> {
    if (this.connection === connection) this.connection = null;
    if (connection.users === 0) await cleanup();
    else connection.retired = cleanup;
  }

  /**
   * Starts the vectors afresh when the store holds fewer than the index says it embedded, as
   * when its files were lost or \`knowledge.vector_store\` now points somewhere new.
   */
  private async checkVectors(connection: Connection): Promise<void> {
    const { db, collection } = connection;
    if (!collection) return;
    const embedded = Number(
      db.prepare('SELECT count(*) AS n FROM chunks WHERE embedded = 1').get()?.n ?? 0,
    );
    if ((await collection.count()) >= embedded) return;
    this.log(`Search in ${this.workspace}: the vector store lost vectors, so embedding again`);
    await collection.clear();
    db.exec('UPDATE chunks SET embedded = 0');
  }

  private async statusNow(): Promise<IndexStatus> {
    const current = await this.readCurrent();
    const configured = this.configured();
    if (current === null) {
      return {
        built: false,
        generation: null,
        documents: 0,
        chunks: 0,
        embedded: 0,
        embeddings: null,
        stale: false,
      };
    }
    return this.using(current, async ({ db, collection }) => {
      const count = (sql: string) => Number(db.prepare(sql).get()?.n ?? 0);
      const flagged = count('SELECT count(*) AS n FROM chunks WHERE embedded = 1');
      return {
        built: true,
        generation: current.generation,
        documents: count('SELECT count(*) AS n FROM docs'),
        chunks: count('SELECT count(*) AS n FROM chunks'),
        // What the vector store really holds, if it has lost some.
        embedded: collection ? Math.min(flagged, await collection.count()) : flagged,
        embeddings: current.embeddings,
        stale: !sameEmbeddings(current.embeddings, configured),
      };
    });
  }

  private configured(): Current['embeddings'] {
    const e = this.options.embeddings;
    return e ? { driver: e.name, model: e.model } : null;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.catch(() => undefined).then(work);
    this.chain = next;
    return next;
  }

  private async readCurrent(): Promise<Current | null> {
    const text = await readFile(join(this.dir, 'current.json'), 'utf8').catch(() => null);
    if (text === null) return null;
    try {
      const parsed = JSON.parse(text) as Partial<Current>;
      if (typeof parsed.generation !== 'number') return null;
      return {
        generation: parsed.generation,
        embeddings: parsed.embeddings ?? null,
        built: parsed.built ?? '',
      };
    } catch {
      return null;
    }
  }

  /** The open connection to a generation, opened (or reopened after a swap) as needed. */
  private async connect(current: Current): Promise<Connection> {
    if (this.connection?.generation === current.generation) return this.connection;
    await this.disconnect();
    // Never create a generation here: only a build does.
    if (!(await exists(this.dbFile(current.generation)))) {
      throw new Error(
        `The ${this.workspace} workspace's search index is missing. The service rebuilds it, or run: wheems knowledgebase reindex`,
      );
    }
    await (this.options.requireFullTextSearch ?? requireFullTextSearch)();
    const db = await openDatabase(this.dbFile(current.generation));
    createSchema(db);
    const collection =
      current.embeddings !== null && this.options.vectors
        ? await this.options.vectors.open(this.collectionName(current.generation))
        : null;
    this.connection = { generation: current.generation, db, collection, users: 0, retired: null };
    return this.connection;
  }

  /** Lets go of the current connection, once nothing is using it. */
  private async disconnect(): Promise<void> {
    const connection = this.connection;
    if (connection) await this.retire(connection, () => closeConnection(connection));
  }

  private async build(previous: Current | null): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const generation = (previous?.generation ?? 0) + 1;
    const embeddings = this.configured();
    const file = this.dbFile(generation);
    await removeDatabase(file);
    const vectors = embeddings !== null ? this.options.vectors : null;
    if (vectors) await vectors.drop(this.collectionName(generation));

    await (this.options.requireFullTextSearch ?? requireFullTextSearch)();
    const db = await openDatabase(file);
    createSchema(db);
    const connection: Connection = {
      generation,
      db,
      collection: vectors ? await vectors.open(this.collectionName(generation)) : null,
      users: 0,
      retired: null,
    };
    const discard = async () => {
      await connection.collection?.close();
      db.close();
      await removeDatabase(file);
      if (vectors) await vectors.drop(this.collectionName(generation));
    };
    let embedded: { ok: true } | { ok: false; error: string };
    try {
      await this.update(connection);
      embedded = await this.embedMissing(connection);
    } catch (error) {
      await discard();
      throw error;
    }
    // An explicit rebuild while the embeddings are down would lose every vector the old
    // index has: keep the old one. Otherwise a keyword index now beats none, and the
    // vectors are filled in by a later sync.
    if (!embedded.ok && previous !== null && sameEmbeddings(previous.embeddings, embeddings)) {
      await discard();
      throw new Error(`Kept the current index, because embedding failed: ${embedded.error}`);
    }

    const current: Current = { generation, embeddings, built: new Date().toISOString() };
    const temporary = join(this.dir, 'current.json.tmp');
    await writeFile(temporary, `${JSON.stringify(current, null, 2)}\n`);
    await rename(temporary, join(this.dir, 'current.json'));

    // The old generation goes once no search here is using it. A search in another process
    // that has it open keeps reading it; one about to open it retries on the new one.
    const removeOld = async () => {
      if (previous === null) return;
      await removeDatabase(this.dbFile(previous.generation));
      if (previous.embeddings !== null && this.options.vectors)
        await this.options.vectors
          .drop(this.collectionName(previous.generation))
          .catch((error: unknown) => {
            this.log(`Search in ${this.workspace}: couldn't drop old vectors: ${describe(error)}`);
          });
    };
    const old = this.connection;
    this.connection = connection;
    if (old) {
      await this.retire(old, async () => {
        await closeConnection(old);
        if (old.generation === previous?.generation) await removeOld();
      });
      if (old.generation !== previous?.generation) await removeOld();
    } else {
      await removeOld();
    }
    const docs = Number(db.prepare('SELECT count(*) AS n FROM docs').get()?.n ?? 0);
    this.log(
      `Search in ${this.workspace}: indexed ${String(docs)} ${docs === 1 ? 'file' : 'files'}${embeddings ? ` with ${embeddings.model}` : ', keyword only'}`,
    );
  }

  /** Indexes new and changed files, and forgets removed ones. */
  private async update(connection: Connection): Promise<void> {
    const { db } = connection;
    const files = await this.files();
    const known = new Map(
      db
        .prepare('SELECT path, hash, mtime, size FROM docs')
        .all()
        .map((row) => [
          String(row.path),
          { hash: String(row.hash), mtime: Number(row.mtime), size: Number(row.size) },
        ]),
    );
    const removedChunks: string[] = [];
    for (const [file, kind] of files) {
      const full = join(this.knowledge, ...file.split('/'));
      // Never follows a link: it could point anywhere on the machine.
      const info = await lstat(full).catch(() => null);
      if (!info) continue;
      const leaveOut = (reason: string) => {
        const key = `${file}:${String(info.size)}:${String(info.mtimeMs)}`;
        if (!this.skipped.has(key)) {
          this.skipped.add(key);
          this.log(`Search in ${this.workspace}: left ${file} out, because ${reason}`);
        }
      };
      // A file left out stays in `known`, so whatever the index had of it is forgotten.
      if (!info.isFile()) {
        if (info.isSymbolicLink()) leaveOut('it is a link');
        continue;
      }
      if (info.size > MAX_FILE_SIZE) {
        leaveOut(`it is larger than ${String(MAX_FILE_SIZE / 1024 / 1024)} MB`);
        continue;
      }
      const seen = known.get(file);
      if (seen && seen.mtime === info.mtimeMs && seen.size === info.size) {
        known.delete(file);
        continue;
      }
      const text = await readFile(full, 'utf8').catch(() => null);
      if (text === null) continue;
      // Never stored in the index, nor sent to an embeddings service.
      if (looksLikeSecret(text)) {
        leaveOut('it looks like it holds a credential');
        continue;
      }
      known.delete(file);
      const hash = createHash('sha1').update(text).digest('hex');
      if (seen?.hash === hash) {
        db.prepare('UPDATE docs SET mtime = ?, size = ? WHERE path = ?').run(
          info.mtimeMs,
          info.size,
          file,
        );
        continue;
      }
      removedChunks.push(
        ...transaction(db, () => {
          const removed = forget(db, file);
          remember(db, file, kind, parseDocumentFile(file, kind, text), {
            hash,
            mtime: info.mtimeMs,
            size: info.size,
          });
          return removed;
        }),
      );
    }
    for (const file of known.keys()) removedChunks.push(...transaction(db, () => forget(db, file)));
    if (removedChunks.length > 0) await connection.collection?.remove(removedChunks);
  }

  /** Gives every chunk without a vector one. Reports a failure instead of throwing. */
  private async embedMissing(
    connection: Connection,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const embeddings = this.options.embeddings;
    const { db, collection } = connection;
    if (!embeddings || !collection) return { ok: true };
    const pending = db.prepare(
      `SELECT chunks.id AS id, chunks.text AS text, docs.title AS title FROM chunks JOIN docs ON docs.path = chunks.path WHERE chunks.embedded = 0 ORDER BY chunks.id LIMIT ?`,
    );
    const mark = db.prepare('UPDATE chunks SET embedded = 1 WHERE id = ?');
    for (;;) {
      const rows = pending.all(EMBED_BATCH);
      if (rows.length === 0) break;
      try {
        const vectors = await embeddings.embed(
          rows.map((row) => `${String(row.title)}\n\n${String(row.text)}`),
          'document',
        );
        await collection.upsert(
          rows.map((row, i) => ({
            id: String(row.id),
            vector: vectors[i] ?? new Float32Array(),
          })),
        );
        transaction(db, () => {
          for (const row of rows) mark.run(Number(row.id));
        });
      } catch (error) {
        const message = describe(error);
        if (message !== this.lastEmbedError) {
          this.log(
            `Search in ${this.workspace}: couldn't embed, so new text is found by keyword only until it can: ${message}`,
          );
        }
        this.lastEmbedError = message;
        return { ok: false, error: message };
      }
    }
    this.lastEmbedError = null;
    return { ok: true };
  }

  /** Every file the index covers, by its path inside the knowledge folder. */
  private async files(): Promise<Map<string, 'page' | 'note'>> {
    const files = new Map<string, 'page' | 'note'>();
    const paths = knowledgePaths(this.options.workspaceDir);
    for (const name of await readdir(paths.pages).catch(() => [] as string[])) {
      if (name.endsWith('.md')) files.set(`pages/${name}`, 'page');
    }
    for (const dir of [paths.inbox, paths.notes]) {
      const names = await readdir(dir, { recursive: true }).catch(() => [] as string[]);
      for (const name of names) {
        if (!name.endsWith('.md')) continue;
        files.set(relative(this.knowledge, join(dir, name)).split(sep).join('/'), 'note');
      }
    }
    return files;
  }

  private dbFile(generation: number): string {
    return join(this.dir, `${String(generation)}.sqlite`);
  }

  private collectionName(generation: number): string {
    return `${this.workspace}.${String(generation)}`;
  }
}

/**
 * The search indexes of every workspace in an install, with the drivers its config names.
 * Without `knowledge.embeddings` in install.yaml, search is keyword-only.
 */
export class KnowledgeSearch {
  private readonly indexes = new Map<string, SearchIndex>();
  readonly embeddings: EmbeddingsDriver | null;
  private readonly vectors: VectorStoreDriver | null;

  constructor(
    private readonly options: {
      install: InstallConfig;
      workspaces: LoadedWorkspace[];
      registry: DriverRegistry;
      /** `.wheems/index` */
      indexDir: string;
      log?: (message: string) => void;
    },
  ) {
    const { embeddings, vector_store } = options.install.knowledge;
    this.embeddings = embeddings ? createEmbeddings(options.registry, embeddings) : null;
    this.vectors = embeddings
      ? createVectorStore(options.registry, vector_store, vectorsDir(options.indexDir))
      : null;
  }

  index(workspace: string): SearchIndex {
    const existing = this.indexes.get(workspace);
    if (existing) return existing;
    const loaded = this.options.workspaces.find((w) => w.id === workspace);
    if (!loaded) throw new Error(`No workspace "${workspace}" in this install`);
    const index = new SearchIndex({
      workspace,
      workspaceDir: loaded.dir,
      indexDir: this.options.indexDir,
      embeddings: this.embeddings,
      vectors: this.vectors,
      ...(this.options.log !== undefined && { log: this.options.log }),
    });
    this.indexes.set(workspace, index);
    return index;
  }

  /** Syncs every workspace's index, logging failures rather than throwing. */
  async syncAll(): Promise<void> {
    for (const workspace of this.options.workspaces) {
      if (!workspace.config) continue;
      await this.index(workspace.id)
        .sync()
        .catch((error: unknown) => {
          this.options.log?.(`Search in ${workspace.id}: ${describe(error)}`);
        });
    }
  }

  async close(): Promise<void> {
    for (const index of this.indexes.values()) await index.close();
  }
}

/** Where SQLite vectors go: beside the workspaces' folders, under a name no workspace can have. */
export function vectorsDir(indexDir: string): string {
  return join(indexDir, '_vectors');
}

export function createEmbeddings(
  registry: DriverRegistry,
  settings: { driver: string } & Record<string, unknown>,
): EmbeddingsDriver {
  const { driver, ...options } = settings;
  return registry.create('embeddings', driver, options);
}

export function createVectorStore(
  registry: DriverRegistry,
  settings: ({ driver: string } & Record<string, unknown>) | undefined,
  dir: string,
): VectorStoreDriver {
  const { driver, ...options } = settings ?? { driver: 'sqlite' };
  return registry.create('vector-store', driver, { dir, ...options });
}

interface ParsedFile {
  title: string;
  origin: 'person' | 'automated';
  sources: string[];
  updated: string | null;
  body: string;
}

function parseDocumentFile(file: string, kind: 'page' | 'note', text: string): ParsedFile {
  const normalised = text.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalised);
  let data: Record<string, unknown> = {};
  let body = normalised;
  if (match) {
    const doc = parseDocument(match[1] ?? '');
    if (doc.errors.length === 0) {
      const parsed: unknown = doc.toJS();
      if (typeof parsed === 'object' && parsed !== null) data = parsed as Record<string, unknown>;
      body = match[2] ?? '';
    }
  }
  const string = (value: unknown) =>
    typeof value === 'string' && value.trim() !== ''
      ? value.trim()
      : value instanceof Date
        ? value.toISOString()
        : null;
  const name = basename(file, '.md');
  const title =
    string(data.title) ??
    (kind === 'note' && body.trim() !== '' ? noteTitle(body.trim()) : null) ??
    name.replaceAll('-', ' ');
  return {
    title,
    origin: data.origin === 'automated' ? 'automated' : 'person',
    sources: Array.isArray(data.sources)
      ? data.sources.filter((s): s is string => typeof s === 'string')
      : [],
    updated: string(data.updated) ?? string(data.written),
    body,
  };
}

/**
 * Splits text into chunks of whole paragraphs up to `CHUNK_SIZE` characters, starting a
 * new chunk at a heading when the current one has some substance. A paragraph longer than
 * that is cut at sentence ends, or hard when it has none.
 */
export function chunkText(text: string, size = CHUNK_SIZE): string[] {
  const blocks = text
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b !== '');
  const chunks: string[] = [];
  let current = '';
  const flush = () => {
    if (current.trim() !== '') chunks.push(current.trim());
    current = '';
  };
  for (const block of blocks) {
    const pieces = block.length > size ? splitLong(block, size) : [block];
    for (const piece of pieces) {
      const heading = /^#{1,6}\s/.test(piece);
      if (
        current !== '' &&
        (current.length + piece.length + 2 > size || (heading && current.length > size / 4))
      )
        flush();
      current = current === '' ? piece : `${current}\n\n${piece}`;
    }
  }
  flush();
  return chunks;
}

function splitLong(block: string, size: number): string[] {
  const sentences = block.match(/[^.!?\n]+(?:[.!?]+|\n|$)\s*/g) ?? [block];
  const pieces: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current.length + sentence.length > size && current !== '') {
      pieces.push(current.trim());
      current = '';
    }
    if (sentence.length > size) {
      for (let i = 0; i < sentence.length; i += size)
        pieces.push(sentence.slice(i, i + size).trim());
      continue;
    }
    current += sentence;
  }
  if (current.trim() !== '') pieces.push(current.trim());
  return pieces.filter((p) => p !== '');
}

/**
 * Words too common to say anything about what a passage is about. Left out of keyword
 * search, so "what is the boat called" doesn't match every page with "the" in it, unless a
 * query has nothing else.
 */
const STOPWORDS = new Set(
  (
    'a about above after again all also am an and any are as at be because been before being ' +
    'below between both but by can could did do does doing down during each few for from ' +
    'further had has have having he her here hers him his how i if in into is it its just me ' +
    'more most my no nor not now of off on once only or other our ours out over own same she ' +
    'should so some such than that the their theirs them then there these they this those ' +
    'through to too under until up very was we were what when where which while who whom why ' +
    'will with would you your yours'
  ).split(' '),
);

/** The words that say what a text is about: lowercase, each once, without stopwords. */
export function contentWords(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !STOPWORDS.has(w)),
  );
}

/**
 * A full-text query that matches any of the words (or, with `all`, every one of them), or
 * null when there are none.
 */
export function ftsQuery(query: string, options: { all?: boolean } = {}): string | null {
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
  const telling = words.filter((w) => !STOPWORDS.has(w));
  const terms = telling.length > 0 ? telling : words;
  return terms.length === 0
    ? null
    : terms.map((w) => `"${w}"`).join(options.all === true ? ' ' : ' OR ');
}

function createSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS docs (
      path TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      origin TEXT NOT NULL,
      sources TEXT NOT NULL,
      updated TEXT,
      hash TEXT NOT NULL,
      mtime REAL NOT NULL,
      size INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS docs_name ON docs (name);
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL,
      seq INTEGER NOT NULL,
      text TEXT NOT NULL,
      embedded INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS chunks_path ON chunks (path);
    CREATE INDEX IF NOT EXISTS chunks_pending ON chunks (embedded);
    CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(title, body, tokenize = 'porter unicode61');
  `);
}

/** Removes a file from the index. Returns the ids of its chunks, to remove their vectors. */
function forget(db: DatabaseSync, file: string): string[] {
  const ids = db
    .prepare('SELECT id FROM chunks WHERE path = ?')
    .all(file)
    .map((row) => Number(row.id));
  const removeText = db.prepare('DELETE FROM fts WHERE rowid = ?');
  for (const id of ids) removeText.run(id);
  db.prepare('DELETE FROM chunks WHERE path = ?').run(file);
  db.prepare('DELETE FROM docs WHERE path = ?').run(file);
  return ids.map(String);
}

function remember(
  db: DatabaseSync,
  file: string,
  kind: 'page' | 'note',
  parsed: ParsedFile,
  stamp: { hash: string; mtime: number; size: number },
): void {
  db.prepare(
    'INSERT INTO docs (path, name, kind, title, origin, sources, updated, hash, mtime, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    file,
    basename(file),
    kind,
    parsed.title,
    parsed.origin,
    JSON.stringify(parsed.sources),
    parsed.updated,
    stamp.hash,
    stamp.mtime,
    stamp.size,
  );
  const chunks = chunkText(parsed.body);
  const insertChunk = db.prepare('INSERT INTO chunks (path, seq, text) VALUES (?, ?, ?)');
  const insertText = db.prepare('INSERT INTO fts (rowid, title, body) VALUES (?, ?, ?)');
  // A file with no body is still found by its title.
  (chunks.length > 0 ? chunks : ['']).forEach((text, seq) => {
    const { lastInsertRowid } = insertChunk.run(file, seq, text);
    insertText.run(lastInsertRowid, parsed.title, text);
  });
}

function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

async function closeConnection(connection: Connection): Promise<void> {
  await connection.collection?.close();
  if (connection.db.isOpen) connection.db.close();
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function removeDatabase(file: string): Promise<void> {
  for (const suffix of ['', '-wal', '-shm']) await rm(`${file}${suffix}`, { force: true });
}

function sameEmbeddings(a: Current['embeddings'], b: Current['embeddings']): boolean {
  return a === null || b === null ? a === b : a.driver === b.driver && a.model === b.model;
}

function tidySnippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= 300) return flat;
  const cut = flat.slice(0, 300);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 200 ? cut.lastIndexOf(' ') : 300)}…`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
