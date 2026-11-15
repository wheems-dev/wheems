import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatAnswer } from '../src/cli/commands/knowledgebase.js';
import { DriverError } from '../src/contracts/driver.js';
import { OllamaEmbeddings, hasModel } from '../src/drivers/embeddings/ollama.js';
import { SqliteVectorStore } from '../src/drivers/vector-store/sqlite.js';
import { knowledgePaths, writeNote } from '../src/knowledge/notes.js';
import { chunkText, ftsQuery, MAX_FILE_SIZE, SearchIndex } from '../src/knowledge/search.js';
import {
  embeddingsContract,
  HashEmbeddings,
  MemoryVectorStore,
  vectorStoreContract,
} from '../src/testing/index.js';

const scratch: string[] = [];
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// The suites run against the reference drivers and the built-in ones.
embeddingsContract('hash', { create: () => new HashEmbeddings() });
embeddingsContract('ollama', {
  create: () =>
    new OllamaEmbeddings({ model: process.env.WHEEMS_TEST_OLLAMA_MODEL ?? 'nomic-embed-text' }),
  // Only where Ollama runs with the model, such as a developer's Mac.
  available: process.env.WHEEMS_TEST_OLLAMA_MODEL !== undefined,
});
vectorStoreContract('memory', { create: () => new MemoryVectorStore(), persistent: false });
vectorStoreContract('sqlite', {
  create: () => new SqliteVectorStore({ dir: tempDir('wheems-vectors-') }),
});

describe('the Ollama driver', () => {
  const answering = (handler: (url: string, body: unknown) => unknown, status = 200) => {
    const calls: { url: string; body: unknown }[] = [];
    const fake = ((url: string, init?: RequestInit) => {
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, body });
      const payload = handler(url, body);
      return Promise.resolve(
        new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status }),
      );
    }) as typeof fetch;
    return { fake, calls };
  };

  it('marks documents and queries for nomic models, and sends texts in batches', async () => {
    const { fake, calls } = answering((_url, body) => ({
      embeddings: (body as { input: string[] }).input.map(() => [0.1, 0.2, 0.3]),
    }));
    const driver = new OllamaEmbeddings({ model: 'nomic-embed-text:v1.5', fetch: fake });
    const texts = Array.from({ length: 20 }, (_, i) => `text ${String(i)}`);
    const vectors = await driver.embed(texts, 'document');
    expect(vectors).toHaveLength(20);
    expect(vectors[0]).toBeInstanceOf(Float32Array);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe('http://127.0.0.1:11434/api/embed');
    const first = calls[0]?.body as { model: string; input: string[] };
    expect(first.model).toBe('nomic-embed-text:v1.5');
    expect(first.input).toHaveLength(16);
    expect(first.input[0]).toBe('search_document: text 0');
    await driver.embed(['boat'], 'query');
    expect((calls[2]?.body as { input: string[] }).input).toEqual(['search_query: boat']);
  });

  it('adds no marks for other models', async () => {
    const { fake, calls } = answering(() => ({ embeddings: [[1, 2]] }));
    await new OllamaEmbeddings({ model: 'mxbai-embed-large', fetch: fake }).embed(['x'], 'query');
    expect((calls[0]?.body as { input: string[] }).input).toEqual(['x']);
  });

  it('says Ollama is unavailable when nothing answers, or when the model is missing', async () => {
    const down = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    const error = await new OllamaEmbeddings({ fetch: down })
      .embed(['x'], 'document')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DriverError);
    expect((error as DriverError).kind).toBe('unavailable');

    const { fake } = answering(() => ({ error: 'model "nomic-embed-text" not found' }), 404);
    const missing = await new OllamaEmbeddings({ fetch: fake })
      .embed(['x'], 'document')
      .catch((e: unknown) => e);
    expect((missing as DriverError).kind).toBe('unavailable');
    expect((missing as DriverError).hint).toBe('Run: ollama pull nomic-embed-text');
  });

  it('checks that Ollama answers and has the model', async () => {
    const { fake } = answering(() => ({ models: [{ name: 'nomic-embed-text:v1.5' }] }));
    const has = await new OllamaEmbeddings({ model: 'nomic-embed-text:v1.5', fetch: fake }).check();
    expect(has[0]?.status).toBe('pass');
    const lacks = await new OllamaEmbeddings({ model: 'nomic-embed-text', fetch: fake }).check();
    expect(lacks[0]).toMatchObject({ status: 'warn', hint: 'Run: ollama pull nomic-embed-text' });
    const down = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    expect((await new OllamaEmbeddings({ fetch: down }).check())[0]?.status).toBe('warn');
  });

  it('treats a model name without a tag as :latest', () => {
    expect(hasModel(['nomic-embed-text:latest'], 'nomic-embed-text')).toBe(true);
    expect(hasModel(['nomic-embed-text'], 'nomic-embed-text:latest')).toBe(true);
    expect(hasModel(['nomic-embed-text:v1.5'], 'nomic-embed-text')).toBe(false);
  });
});

describe('chunking and queries', () => {
  it('keeps short text whole and splits long text at paragraphs', () => {
    expect(chunkText('One paragraph.')).toEqual(['One paragraph.']);
    const paragraph = 'A sentence about boats. '.repeat(20).trim();
    const chunks = chunkText([paragraph, paragraph, paragraph].join('\n\n'), 1200);
    expect(chunks.length).toBe(2);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(1200);
  });

  it('starts a new chunk at a heading once the current one has substance', () => {
    const intro = 'Intro text. '.repeat(30).trim();
    const chunks = chunkText(`${intro}\n\n## Next topic\n\nMore.`, 1200);
    expect(chunks).toEqual([intro, '## Next topic\n\nMore.']);
  });

  it('cuts a paragraph longer than a chunk at sentence ends, or hard', () => {
    const long = 'Word '.repeat(600);
    for (const chunk of chunkText(long, 500)) expect(chunk.length).toBeLessThanOrEqual(500);
    const sentences = 'This is one sentence. '.repeat(60);
    const chunks = chunkText(sentences, 500);
    expect(chunks.every((c) => c.endsWith('.'))).toBe(true);
  });

  it('turns any query into a safe full-text query', () => {
    expect(ftsQuery('Boat name?')).toBe('"boat" OR "name"');
    expect(ftsQuery('"quoted" AND NOT (x) * name:value')).toBe(
      '"quoted" OR "x" OR "name" OR "value"',
    );
    // Common words are left out, unless there's nothing else.
    expect(ftsQuery('What is the boat called?')).toBe('"boat" OR "called"');
    expect(ftsQuery('who is it')).toBe('"who" OR "is" OR "it"');
    expect(ftsQuery('?!')).toBeNull();
    expect(ftsQuery('café naïve')).toBe('"café" OR "naïve"');
  });
});

const page = (title: string, sources: string[], body: string) =>
  `---\ntitle: ${title}\nsources:\n${sources.map((s) => `  - ${s}\n`).join('')}updated: 2026-11-11\n---\n\n${body}\n`;

describe('the search index', () => {
  let workspace: string;
  let indexDir: string;
  let embeddings: HashEmbeddings;
  let vectors: MemoryVectorStore;
  let index: SearchIndex;
  let logs: string[];

  const make = (overrides: { embeddings?: HashEmbeddings | null } = {}) =>
    new SearchIndex({
      workspace: 'personal',
      workspaceDir: workspace,
      indexDir,
      embeddings: overrides.embeddings === undefined ? embeddings : overrides.embeddings,
      vectors,
      log: (message) => logs.push(message),
    });

  beforeEach(() => {
    const dir = tempDir('wheems-search-');
    workspace = join(dir, 'personal');
    indexDir = join(dir, '.wheems', 'index');
    const knowledge = knowledgePaths(workspace);
    mkdirSync(knowledge.pages, { recursive: true });
    mkdirSync(join(knowledge.notes, '2026', '11'), { recursive: true });
    writeFileSync(
      join(knowledge.pages, 'boat-name.md'),
      page(
        'Boat name',
        ['a.md'],
        'The vessel is called Halcyon, chosen over Kestrel because it is calmer.',
      ),
    );
    writeFileSync(
      join(knowledge.pages, 'invoices.md'),
      page('Invoices', ['b.md'], 'Invoices go out every Friday from the accounts inbox.'),
    );
    embeddings = new HashEmbeddings({
      synonyms: { boat: 'vessel', called: 'name', named: 'name' },
    });
    vectors = new MemoryVectorStore();
    logs = [];
    index = make();
  });
  afterEach(async () => {
    await index.close();
  });

  it('has nothing to search until it is built', async () => {
    await expect(index.search('boat')).rejects.toThrow(/no search index yet/);
    expect((await index.status()).built).toBe(false);
  });

  it("says plainly when Node's SQLite has no full-text search, rather than failing in SQLite", async () => {
    const missing = new SearchIndex({
      workspace: 'personal',
      workspaceDir: workspace,
      indexDir,
      embeddings,
      vectors,
      requireFullTextSearch: () =>
        Promise.reject(new Error('This Node.js has SQLite without full-text search (FTS5)')),
    });
    try {
      await expect(missing.sync()).rejects.toThrow(/without full-text search \(FTS5\)/);
      await expect(missing.rebuild()).rejects.toThrow(/without full-text search/);
      // An index built by a Node.js that had it is refused the same way.
      await index.sync();
      await expect(missing.search('Kestrel')).rejects.toThrow(/without full-text search/);
    } finally {
      await missing.close();
    }
  });

  it('finds pages by keyword', async () => {
    await index.sync();
    const answer = await index.search('Kestrel');
    expect(answer.results[0]).toMatchObject({
      file: 'pages/boat-name.md',
      kind: 'page',
      title: 'Boat name',
      updated: '2026-11-11',
      origin: 'person',
    });
    expect(answer.results[0]?.matched).toContain('keyword');
    expect(answer.results[0]?.path).toBe(join(workspace, 'knowledge', 'pages', 'boat-name.md'));
    expect(answer.results[0]?.snippet).toContain('Kestrel');
  });

  it('finds pages by meaning when no word matches', async () => {
    await index.sync();
    // "boat" and "named" never appear in the page; the model knows they mean "vessel" and "called".
    const answer = await index.search('boat named');
    expect(answer.mode).toBe('hybrid');
    expect(answer.results[0]).toMatchObject({ file: 'pages/boat-name.md' });
    expect(answer.results[0]?.matched).toContain('meaning');
    expect(embeddings.calls.at(-1)?.purpose).toBe('query');
  });

  it('searches by keyword only without an embeddings driver', async () => {
    await index.close();
    index = make({ embeddings: null });
    await index.sync();
    const answer = await index.search('Halcyon');
    expect(answer.mode).toBe('keyword');
    expect(answer.warning).toBeUndefined();
    expect(answer.results[0]).toMatchObject({ file: 'pages/boat-name.md', matched: ['keyword'] });
    expect(vectors.names()).toEqual([]);
    expect((await index.status()).embeddings).toBeNull();
  });

  it("ranks notes from automated jobs below people's own", async () => {
    const source = { workspace: 'personal', agent: 'chief-of-staff', engine: 'stub' } as const;
    await writeNote(
      workspace,
      { ...source, origin: 'automated' },
      '# Mooring\n\nThe mooring fee is due in March.',
      new Date('2026-11-11T09:00:00Z'),
    );
    await writeNote(
      workspace,
      { ...source, origin: 'person' },
      '# Mooring\n\nThe mooring fee is due in March.',
      new Date('2026-11-11T10:00:00Z'),
    );
    await index.sync();
    const { results } = await index.search('mooring fee');
    expect(results.map((r) => r.origin).slice(0, 2)).toEqual(['person', 'automated']);
    expect(results[0]?.kind).toBe('note');
    expect(results[0]?.title).toBe('Mooring');
    expect(results[0]?.file).toMatch(/^inbox\//);
  });

  it('counts a page as automated only when every note it came from was', async () => {
    const pages = knowledgePaths(workspace).pages;
    writeFileSync(
      join(knowledgePaths(workspace).notes, '2026', '11', 'job.md'),
      '---\norigin: automated\n---\n\n# Job\n\nA nightly report.',
    );
    writeFileSync(join(pages, 'report.md'), page('Report', ['job.md'], 'Nightly mooring report.'));
    writeFileSync(join(pages, 'mixed.md'), page('Mixed', ['job.md', 'a.md'], 'Mooring notes.'));
    await index.sync();
    const { results } = await index.search('mooring', 10);
    const origin = (file: string) => results.find((r) => r.file === file)?.origin;
    expect(origin('pages/report.md')).toBe('automated');
    expect(origin('pages/mixed.md')).toBe('person');
  });

  it('picks up new, changed and removed files on sync', async () => {
    await index.sync();
    const pages = knowledgePaths(workspace).pages;
    writeFileSync(join(pages, 'garden.md'), page('Garden', ['c.md'], 'Plant tulips in October.'));
    writeFileSync(
      join(pages, 'invoices.md'),
      page('Invoices', ['b.md'], 'Invoices now go out on Mondays.'),
    );
    rmSync(join(pages, 'boat-name.md'));
    await index.sync();
    expect((await index.search('tulips')).results[0]?.file).toBe('pages/garden.md');
    expect((await index.search('Mondays')).results[0]?.file).toBe('pages/invoices.md');
    expect((await index.search('Friday')).results).toEqual([]);
    expect((await index.search('Halcyon Kestrel')).results.map((r) => r.file)).not.toContain(
      'pages/boat-name.md',
    );
    const status = await index.status();
    expect(status).toMatchObject({ built: true, documents: 2, generation: 1 });
    // The removed page's vectors went with it.
    const collection = await vectors.open('personal.1');
    expect(await collection.count()).toBe(status.chunks);
  });

  it('leaves out links, very large files and anything that looks like a credential', async () => {
    const pages = knowledgePaths(workspace).pages;
    const outside = join(workspace, '..', 'private.md');
    writeFileSync(outside, '# Private\n\nThe safe code is Zanzibar.\n');
    symlinkSync(outside, join(pages, 'linked.md'));
    writeFileSync(
      join(pages, 'huge.md'),
      `# Huge\n\nZanzibar ${'word '.repeat(MAX_FILE_SIZE / 4)}`,
    );
    writeFileSync(
      join(pages, 'tokens.md'),
      page('Tokens', [], 'The Zanzibar bot token is xoxb-1234567890-abcdefghij.'),
    );
    await index.sync();
    await index.sync();
    expect((await index.search('Zanzibar', 10)).results).toEqual([]);
    expect(embeddings.calls.flatMap((c) => c.texts).join('\n')).not.toContain('xoxb-');
    expect(logs.filter((l) => l.includes('left'))).toEqual([
      'Search in personal: left pages/huge.md out, because it is larger than 1 MB',
      'Search in personal: left pages/linked.md out, because it is a link',
      'Search in personal: left pages/tokens.md out, because it looks like it holds a credential',
    ]);
  });

  it('forgets a file once it starts to look like it holds a credential', async () => {
    await index.sync();
    const pages = knowledgePaths(workspace).pages;
    writeFileSync(
      join(pages, 'invoices.md'),
      page('Invoices', ['b.md'], 'Invoices go out Fridays. Key: sk-abcdefghijklmnopqrstuvwxyz.'),
    );
    await index.sync();
    expect((await index.search('Invoices Fridays')).results.map((r) => r.file)).toEqual([]);
    expect((await index.status()).documents).toBe(1);
  });

  it('embeds only what changed', async () => {
    await index.sync();
    const before = embeddings.calls.length;
    await index.sync();
    expect(embeddings.calls.length).toBe(before);
    writeFileSync(
      join(knowledgePaths(workspace).pages, 'garden.md'),
      page('Garden', [], 'Tulips.'),
    );
    await index.sync();
    expect(embeddings.calls.slice(before).flatMap((c) => c.texts)).toEqual(['Garden\n\nTulips.']);
  });

  it('keeps a keyword index when embedding fails, and fills in the vectors later', async () => {
    embeddings.fail('Ollama is not answering');
    await index.sync();
    expect(await index.status()).toMatchObject({ built: true, embedded: 0 });
    expect(logs.some((l) => l.includes('Ollama is not answering'))).toBe(true);
    const fallback = await index.search('Kestrel');
    expect(fallback.mode).toBe('keyword');
    expect(fallback.warning).toMatch(/keyword only/);
    expect(fallback.results[0]?.file).toBe('pages/boat-name.md');

    embeddings.recover();
    await index.sync();
    const status = await index.status();
    expect(status.embedded).toBe(status.chunks);
    expect((await index.search('boat named')).mode).toBe('hybrid');
  });

  it('logs a failing embeddings driver once, not on every sync', async () => {
    embeddings.fail('down');
    await index.sync();
    await index.sync();
    expect(logs.filter((l) => l.includes('down'))).toHaveLength(1);
  });

  it('rebuilds into a new generation and drops the old one', async () => {
    await index.sync();
    const status = await index.rebuild();
    expect(status).toMatchObject({ generation: 2, documents: 2 });
    expect(vectors.names()).toEqual(['personal.2']);
    expect(await readdir(join(indexDir, 'personal'))).toEqual(
      expect.arrayContaining(['2.sqlite', 'current.json']),
    );
    expect(existsSync(join(indexDir, 'personal', '1.sqlite'))).toBe(false);
    expect((await index.search('Kestrel')).results[0]?.file).toBe('pages/boat-name.md');
  });

  it('keeps the current index when a rebuild cannot embed', async () => {
    await index.sync();
    embeddings.fail('down');
    await expect(index.rebuild()).rejects.toThrow(/Kept the current index/);
    expect((await index.status()).generation).toBe(1);
    expect(vectors.names()).toEqual(['personal.1']);
    expect(existsSync(join(indexDir, 'personal', '2.sqlite'))).toBe(false);
    embeddings.recover();
    expect((await index.search('boat named')).mode).toBe('hybrid');
  });

  it('rebuilds itself when the embedding model changes', async () => {
    await index.sync();
    await index.close();
    embeddings = new HashEmbeddings({ model: 'hash-32', dimensions: 32 });
    index = make();
    expect((await index.status()).stale).toBe(true);
    await index.sync();
    const status = await index.status();
    expect(status).toMatchObject({
      generation: 2,
      stale: false,
      embeddings: { driver: 'hash', model: 'hash-32' },
    });
    expect(status.embedded).toBe(status.chunks);
    expect(vectors.names()).toEqual(['personal.2']);
    expect(logs.some((l) => l.includes('embedding model changed'))).toBe(true);
  });

  it('finishes a search that a rebuild overtakes, here or in another process', async () => {
    await index.sync();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const slow = new HashEmbeddings({
      synonyms: { boat: 'vessel', named: 'name', called: 'name' },
    });
    const embed = slow.embed.bind(slow);
    slow.embed = async (texts, purpose) => {
      if (purpose === 'query') await held;
      return embed(texts, purpose);
    };
    await index.close();
    index = make({ embeddings: slow });
    const reader = make({ embeddings: slow });
    const here = index.search('boat named');
    const there = reader.search('boat named');
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Both searches are waiting on their query's embedding when generation 2 replaces 1.
    await index.rebuild();
    release();
    for (const answer of await Promise.all([here, there])) {
      expect(answer.mode).toBe('hybrid');
      expect(answer.results[0]?.file).toBe('pages/boat-name.md');
    }
    // Once the search here finished, the old generation went.
    expect(existsSync(join(indexDir, 'personal', '1.sqlite'))).toBe(false);
    expect(vectors.names()).toEqual(['personal.2']);
    expect((await reader.search('Kestrel')).results[0]?.file).toBe('pages/boat-name.md');
    await reader.close();
  });

  it('searches by keyword only while an index built with another model waits for its rebuild', async () => {
    await index.sync();
    await index.close();
    embeddings = new HashEmbeddings({ model: 'hash-32', dimensions: 32 });
    index = make();
    const answer = await index.search('Kestrel');
    expect(answer.mode).toBe('keyword');
    expect(answer.warning).toBe(
      'Searched by keyword only: the index was built with hash-64 and is being rebuilt with hash-32',
    );
    expect(answer.results[0]?.file).toBe('pages/boat-name.md');
    expect(embeddings.calls).toEqual([]);
  });

  it('embeds everything again when the vector store has lost its vectors', async () => {
    await index.sync();
    const chunks = (await index.status()).chunks;
    // As after a restart with the vector files gone, or vector_store moved somewhere new.
    await index.close();
    await vectors.drop('personal.1');
    index = make();
    expect((await index.status()).embedded).toBe(0);
    await index.sync();
    expect(logs).toContain('Search in personal: the vector store lost vectors, so embedding again');
    expect(await (await vectors.open('personal.1')).count()).toBe(chunks);
    expect((await index.status()).embedded).toBe(chunks);
    expect((await index.search('boat named')).results[0]?.matched).toContain('meaning');
  });

  it('a second index on the same files sees a rebuild by the first', async () => {
    await index.sync();
    const reader = make();
    expect((await reader.search('Kestrel')).results).toHaveLength(1);
    await index.rebuild();
    expect((await reader.search('Kestrel')).results[0]?.file).toBe('pages/boat-name.md');
    expect((await reader.status()).generation).toBe(2);
    await reader.close();
  });

  it('rebuilds when its file has gone', async () => {
    await index.sync();
    await index.close();
    rmSync(join(indexDir, 'personal', '1.sqlite'));
    index = make();
    await expect(index.search('Kestrel')).rejects.toThrow(/missing/);
    await index.sync();
    expect((await index.search('Kestrel')).results).toHaveLength(1);
  });

  it('keeps vectors in SQLite beside the index with the built-in store', async () => {
    await index.close();
    const store = new SqliteVectorStore({ dir: join(indexDir, '_vectors') });
    index = new SearchIndex({
      workspace: 'personal',
      workspaceDir: workspace,
      indexDir,
      embeddings,
      vectors: store,
    });
    await index.sync();
    expect(existsSync(join(indexDir, '_vectors', 'personal.1.sqlite'))).toBe(true);
    expect((await index.search('boat named')).results[0]?.file).toBe('pages/boat-name.md');
    const current = JSON.parse(
      readFileSync(join(indexDir, 'personal', 'current.json'), 'utf8'),
    ) as {
      embeddings: unknown;
    };
    expect(current.embeddings).toEqual({ driver: 'hash', model: 'hash-64' });
  });

  it('prints results for agents to read', async () => {
    await index.sync();
    const text = formatAnswer(await index.search('Kestrel'));
    expect(text).toContain('Boat name\n');
    expect(text).toContain(
      `${join(workspace, 'knowledge', 'pages', 'boat-name.md')} (page, updated 2026-11-11)`,
    );
    expect(formatAnswer({ results: [], mode: 'keyword' })).toBe(
      'Nothing in the knowledge base matches.\n',
    );
  });
});
