import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initWorkspace } from '../src/cli/commands/init.js';
import { installYaml } from '../src/cli/templates.js';
import { loadInstall } from '../src/config/load.js';
import type { FinalMessage } from '../src/contracts/engine.js';
import {
  applyFiling,
  commitFiling,
  parsePage,
  prepareFilingFolder,
  reviewFiling,
} from '../src/knowledge/filing.js';
import { knowledgePaths, writeNote } from '../src/knowledge/notes.js';
import { filerSessionName, FilingQueue } from '../src/service/filing.js';
import { SESSION_NAME_PATTERN } from '../src/contracts/runtime.js';
import { TaskRunner } from '../src/service/runner.js';
import { MemoryRuntime, sleepProgram, StubEngine } from '../src/testing/index.js';
import { fakeFiler } from './helpers/fake-filer.js';

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

const page = (title: string, sources: string[], body: string) =>
  `---\ntitle: ${title}\nsources:\n${sources.map((s) => `  - ${s}\n`).join('')}---\n\n${body}\n`;

describe('checking what the filer changed', () => {
  let dir: string;
  let workspace: string;
  let folder: string;
  let note: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wheems-filing-'));
    workspace = join(dir, 'ws');
    folder = join(dir, 'filing');
    const knowledge = knowledgePaths(workspace);
    mkdirSync(knowledge.pages, { recursive: true });
    writeFileSync(knowledge.brief, 'The brief.\n');
    writeFileSync(
      join(knowledge.pages, 'boat-name.md'),
      page('Boat name', ['old-note.md'], 'The shortlist is Kestrel and Halcyon. '.repeat(4)),
    );
    note = await writeNote(
      workspace,
      { workspace: 'ws', agent: 'chief-of-staff', engine: 'stub', origin: 'person' },
      '# Picked Halcyon\n\nBecause it is calmer.',
      new Date('2026-11-11T21:00:00Z'),
    );
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const prepare = () => prepareFilingFolder(folder, workspace, note, null);
  const noteName = () => note.split('/').at(-1)!;

  it('copies the note, the brief and the pages into the filer folder', async () => {
    const before = await prepare();
    expect([...before.keys()].sort()).toEqual(['brief.md', 'pages/boat-name.md']);
    expect(readFileSync(join(folder, 'note.md'), 'utf8')).toContain('# Picked Halcyon');
  });

  it('keeps changed and new pages, adding the note to their sources and keeping the old ones', async () => {
    const before = await prepare();
    writeFileSync(
      join(folder, 'pages', 'boat-name.md'),
      page(
        'Boat name',
        [],
        `The boat is Halcyon, chosen because it is calmer. ${'More. '.repeat(20)}`,
      ),
    );
    writeFileSync(join(folder, 'pages', 'sailing.md'), 'We sail on Sundays.\n');
    writeFileSync(join(folder, 'brief.md'), 'The boat is Halcyon.\n');
    const review = await reviewFiling(folder, before, noteName(), new Date('2026-11-12T08:00:00Z'));
    expect(review.rejected).toEqual([]);
    const boat = parsePage(review.accepted.get('pages/boat-name.md')!);
    expect(boat.sources).toEqual(['old-note.md', noteName()]);
    expect(review.accepted.get('pages/boat-name.md')).toContain('updated: 2026-11-12');
    expect(parsePage(review.accepted.get('pages/sailing.md')!)).toMatchObject({
      title: 'Sailing',
      sources: [noteName()],
    });
    expect(review.accepted.get('brief.md')).toBe('The boat is Halcyon.\n');
  });

  it('refuses pages cut down, deleted, oddly named, empty or holding a credential, and an overlong brief', async () => {
    const before = await prepare();
    writeFileSync(join(folder, 'pages', 'boat-name.md'), page('Boat name', [], 'Halcyon.'));
    writeFileSync(join(folder, 'pages', 'Bad Name.md'), 'Text.\n');
    writeFileSync(join(folder, 'pages', 'empty.md'), page('Empty', [], ''));
    writeFileSync(join(folder, 'pages', 'keys.md'), 'The token is xoxb-1234567890-abcdefghij.\n');
    writeFileSync(join(folder, 'brief.md'), 'x'.repeat(5000));
    writeFileSync(join(folder, 'notes.txt'), 'Ignored.\n');
    const review = await reviewFiling(folder, before, noteName());
    expect(review.accepted.size).toBe(0);
    expect(Object.fromEntries(review.rejected.map((r) => [r.path, r.reason]))).toEqual({
      'pages/boat-name.md': 'it lost more than 25% of its text',
      'pages/Bad Name.md': 'page names are lowercase letters, digits and dashes',
      'pages/empty.md': 'it is empty',
      'pages/keys.md': 'it looks like it holds a credential',
      'brief.md': 'it is longer than 4000 characters',
    });

    rmSync(join(folder, 'pages', 'boat-name.md'));
    const deleted = await reviewFiling(folder, before, noteName());
    expect(deleted.rejected).toContainEqual({
      path: 'pages/boat-name.md',
      reason: 'pages are never deleted when filing',
    });
  });

  it('picks up a suggested change to the page about the person', async () => {
    const before = await prepare();
    writeFileSync(join(folder, 'about-you.suggested.md'), '# About me\n\nLikes boats.\n');
    const review = await reviewFiling(folder, before, noteName());
    expect(review.aboutYouSuggestion).toBe('# About me\n\nLikes boats.\n');
  });

  it('applies the changes and moves the note out of the inbox', async () => {
    const before = await prepare();
    const applied = await applyFiling(
      workspace,
      note,
      new Map([['pages/sailing.md', 'Sundays.\n']]),
      before,
      new Date('2026-11-11T21:00:00Z'),
    );
    expect(applied.ok).toBe(true);
    const changed = applied.ok ? applied.changed : [];
    const knowledge = knowledgePaths(workspace);
    expect(readFileSync(join(knowledge.pages, 'sailing.md'), 'utf8')).toBe('Sundays.\n');
    expect(readdirSync(knowledge.inbox)).toEqual([]);
    expect(existsSync(join(knowledge.notes, '2026', '11', noteName()))).toBe(true);
    expect(changed).toEqual([
      'knowledge/pages/sailing.md',
      `knowledge/inbox/${noteName()}`,
      `knowledge/notes/2026/11/${noteName()}`,
    ]);
  });

  it('applies nothing when a person changed a file while the filer worked', async () => {
    const before = await prepare();
    const knowledge = knowledgePaths(workspace);
    writeFileSync(join(knowledge.pages, 'boat-name.md'), 'Edited by hand.\n');
    writeFileSync(join(knowledge.pages, 'sailing.md'), 'Also new by hand.\n');
    const applied = await applyFiling(
      workspace,
      note,
      new Map([
        ['pages/boat-name.md', 'From the filer.\n'],
        ['pages/sailing.md', 'From the filer.\n'],
        ['brief.md', 'From the filer.\n'],
      ]),
      before,
    );
    expect(applied).toEqual({ ok: false, conflicts: ['pages/boat-name.md', 'pages/sailing.md'] });
    expect(readFileSync(join(knowledge.pages, 'boat-name.md'), 'utf8')).toBe('Edited by hand.\n');
    expect(readFileSync(knowledge.brief, 'utf8')).toBe('The brief.\n');
    expect(readdirSync(knowledge.inbox)).toEqual([noteName()]);
  });

  it('commits only the paths it is given', async () => {
    git(dir, 'init', '--quiet');
    writeFileSync(join(dir, 'unrelated.txt'), 'Not mine.\n');
    git(dir, 'add', 'unrelated.txt');
    const applied = await applyFiling(
      workspace,
      note,
      new Map([['pages/sailing.md', 'Sundays.\n']]),
      await prepare(),
    );
    const changed = applied.ok ? applied.changed : [];
    const result = await commitFiling(
      dir,
      changed.map((p) => join('ws', p)),
      'Filed a note',
    );
    expect(result).toEqual({ ok: true });
    expect(git(dir, 'log', '--format=%an: %s')).toBe('Wheems: Filed a note');
    expect(git(dir, 'show', '--name-only', '--format=')).toBe(
      ['ws/knowledge/notes/2026/11/' + noteName(), 'ws/knowledge/pages/sailing.md'].join('\n'),
    );
    // What the person had staged stays staged, uncommitted.
    expect(git(dir, 'status', '--porcelain')).toContain('A  unrelated.txt');
  });
});

describe('the task runner', () => {
  let dir: string;
  let answers: Map<string, FinalMessage[]>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wheems-runner-'));
    answers = new Map();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = async (
    filer: Parameters<typeof fakeFiler>[0],
    engine: StubEngine,
    timeoutSeconds = 5,
  ) => {
    const runtime = new MemoryRuntime({ filer: fakeFiler(filer) });
    const runner = new TaskRunner({ runtime, pollMs: 5, startupSeconds: 1 });
    const result = await runner.run({
      agent: {
        name: 'filer',
        description: null,
        engine: 'stub',
        model: 'm',
        account: 'a',
        skills: [],
        integrations: [],
        permissions: 'auto',
        instructions: 'Do the task.',
      },
      engine,
      workspace: { id: 'ws', dir },
      account: { name: 'a', driver: 'stub' },
      dir,
      task: 'Write hello.txt',
      name: 'filer-ws',
      labels: { wheems: 'filer' },
      env: {},
      timeoutSeconds,
    });
    return { result, live: await runtime.list({ labels: { wheems: 'filer' } }) };
  };
  const writesHello = (cwd: string) => {
    writeFileSync(join(cwd, 'hello.txt'), 'hi');
    return 'Wrote hello.txt';
  };

  it('runs an agent on a task, returns its answer, and stops its session', async () => {
    const { result, live } = await run(
      { answers, act: writesHello },
      new StubEngine({ command: ['filer'], answers }),
    );
    expect(result).toMatchObject({ ok: true, answer: 'Wrote hello.txt' });
    expect(readFileSync(join(dir, 'hello.txt'), 'utf8')).toBe('hi');
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe('Do the task.\n');
    expect(live).toEqual([]);
  });

  it('follows engines that report no status, and that choose their own ids', async () => {
    const quiet = await run(
      { answers, act: writesHello, reportsStatus: false },
      new StubEngine({ command: ['filer'], answers, reportsStatus: false }),
    );
    expect(quiet.result).toMatchObject({ ok: true, answer: 'Wrote hello.txt' });
    const own = await run(
      { answers, act: writesHello },
      new StubEngine({ command: ['filer'], answers, ownIds: true }),
    );
    expect(own.result).toMatchObject({ ok: true, answer: 'Wrote hello.txt' });
  });

  it('never replaces a session of another job that happens to share its name', async () => {
    const runtime = new MemoryRuntime({
      filer: fakeFiler({ answers, act: writesHello }),
      other: sleepProgram,
    });
    await runtime.start({
      name: 'filer-ws',
      command: ['other'],
      cwd: dir,
      env: {},
      labels: { wheems: 'filer', workspace: 'other' },
    });
    const runner = new TaskRunner({ runtime, pollMs: 5, startupSeconds: 1 });
    const result = await runner.run({
      agent: {
        name: 'filer',
        description: null,
        engine: 'stub',
        model: 'm',
        account: 'a',
        skills: [],
        integrations: [],
        permissions: 'auto',
        instructions: 'Do the task.',
      },
      engine: new StubEngine({ command: ['filer'], answers }),
      workspace: { id: 'ws', dir },
      account: { name: 'a', driver: 'stub' },
      dir,
      task: 'Write hello.txt',
      name: 'filer-ws',
      labels: { wheems: 'filer', workspace: 'ws' },
      env: {},
      timeoutSeconds: 5,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'another session is already called filer-ws',
    });
    expect(await runtime.list({ labels: { workspace: 'other' } })).toHaveLength(1);
  });

  it('gives up when the agent runs out of time or gives no answer, and still stops it', async () => {
    const hung = await run(
      { answers, act: () => null, hang: true },
      new StubEngine({ command: ['filer'], answers }),
      0.2,
    );
    expect(hung.result).toMatchObject({ ok: false, reason: 'it ran out of time' });
    expect(hung.live).toEqual([]);
    const silent = await run(
      { answers, act: () => null },
      new StubEngine({ command: ['filer'], answers }),
    );
    expect(silent.result).toMatchObject({ ok: false, reason: 'it finished without an answer' });
  });
});

describe('the filing queue', () => {
  let home: string;
  let answers: Map<string, FinalMessage[]>;
  let logs: string[];
  let act: (cwd: string) => string | null;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'wheems-queue-'));
    writeFileSync(join(home, 'install.yaml'), installYaml());
    await initWorkspace({ home, id: 'personal' });
    git(home, 'init', '--quiet');
    answers = new Map();
    logs = [];
    act = (cwd) => {
      const note = readFileSync(join(cwd, 'note.md'), 'utf8');
      writeFileSync(
        join(cwd, 'pages', 'boat-name.md'),
        `# Boat name\n\n${note.split('\n').at(-2) ?? ''}\n`,
      );
      writeFileSync(join(cwd, 'brief.md'), 'The boat is Halcyon.\n');
      return 'Created pages/boat-name.md and updated the brief.';
    };
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const queue = async (engines: string[] = [], filed: string[] = []) => {
    const install = await loadInstall(home);
    const runtime = new MemoryRuntime({ filer: fakeFiler({ answers, act: (cwd) => act(cwd) }) });
    return new FilingQueue({
      home,
      install: install.config!,
      workspaces: install.workspaces,
      engine: (name) => {
        engines.push(name);
        return new StubEngine({ command: ['filer'], answers });
      },
      runner: new TaskRunner({ runtime, pollMs: 5, startupSeconds: 1 }),
      stateDir: join(home, '.wheems'),
      aboutYouFile: join(home, 'about-you.md'),
      sessionEnv: {},
      log: (m) => logs.push(m),
      onFiled: (workspace) => filed.push(workspace),
    });
  };
  const addNote = (text: string) =>
    writeNote(
      join(home, 'workspaces', 'personal'),
      { workspace: 'personal', agent: 'chief-of-staff', engine: 'claude-code', origin: 'person' },
      text,
    );

  it('files a note into the knowledge base and commits it, with the note as its source', async () => {
    const note = await addNote('# Picked Halcyon\n\nThe boat is Halcyon, because it is calmer.');
    const engines: string[] = [];
    const filed: string[] = [];
    await (await queue(engines, filed)).file('personal');
    // So the search index picks up the new page.
    expect(filed).toEqual(['personal']);
    const knowledge = knowledgePaths(join(home, 'workspaces', 'personal'));
    const boat = parsePage(readFileSync(join(knowledge.pages, 'boat-name.md'), 'utf8'));
    expect(boat.sources).toEqual([note.split('/').at(-1)]);
    expect(boat.body).toContain('because it is calmer');
    expect(readFileSync(knowledge.brief, 'utf8')).toBe('The boat is Halcyon.\n');
    expect(readdirSync(knowledge.inbox)).toEqual([]);
    expect(engines).toEqual(['claude-code']);
    expect(git(home, 'log', '--format=%s')).toBe('Filed "Picked Halcyon" in personal');
    expect(git(home, 'log', '--format=%b')).toContain('Created pages/boat-name.md');
    expect(git(home, 'status', '--porcelain', 'workspaces/personal/knowledge')).toBe('');
  });

  it('never files, archives or commits a note that looks like it holds a credential', async () => {
    const inbox = knowledgePaths(join(home, 'workspaces', 'personal')).inbox;
    writeFileSync(
      join(inbox, '2026-11-11-000000-x-keys.md'),
      '# Keys\n\nghp_abcdefghijklmnopqrstuvwxyz0123456789\n',
    );
    await (await queue()).file('personal');
    expect(readdirSync(inbox)).toEqual([]);
    expect(readdirSync(join(home, '.wheems', 'quarantine', 'personal'))).toEqual([
      '2026-11-11-000000-x-keys.md',
    ]);
    expect(() => git(home, 'log')).toThrow();
  });

  it("files again from a person's edit made while the filer worked, keeping the edit", async () => {
    const real = join(knowledgePaths(join(home, 'workspaces', 'personal')).pages, 'boat-name.md');
    let runs = 0;
    act = (cwd) => {
      if (runs++ === 0) writeFileSync(real, 'Edited by hand: the mooring is booked.\n');
      const copy = join(cwd, 'pages', 'boat-name.md');
      const current = existsSync(copy) ? readFileSync(copy, 'utf8') : '';
      writeFileSync(copy, `${current}\nThe boat is Halcyon.\n`);
      return 'Updated pages/boat-name.md.';
    };
    await addNote('# Halcyon');
    await (await queue()).file('personal');
    expect(runs).toBe(2);
    expect(readFileSync(real, 'utf8')).toContain('Edited by hand: the mooring is booked.');
    expect(readFileSync(real, 'utf8')).toContain('The boat is Halcyon.');
    expect(logs.some((l) => l.includes('changed while the filer worked'))).toBe(true);
  });

  it('names filer sessions within the runtime limit, apart even for names that start alike', () => {
    const a = filerSessionName('abcdefghijklmnopqrstuvwxyz-one');
    const b = filerSessionName('abcdefghijklmnopqrstuvwxyz-two');
    expect(SESSION_NAME_PATTERN.test(a)).toBe(true);
    expect(SESSION_NAME_PATTERN.test(b)).toBe(true);
    expect(a).not.toBe(b);
  });

  it('leaves a note it could not file in the inbox, and stops trying after three tries', async () => {
    act = () => null;
    await addNote('# Something');
    const filed: string[] = [];
    const filing = await queue([], filed);
    for (let i = 0; i < 4; i++) await filing.file('personal');
    expect(filed).toEqual([]);
    expect(readdirSync(knowledgePaths(join(home, 'workspaces', 'personal')).inbox)).toHaveLength(1);
    expect(logs.filter((l) => l.startsWith("Couldn't file"))).toHaveLength(3);
  });

  it('keeps a suggested change to about-you.md for review, and files every note waiting', async () => {
    act = (cwd) => {
      writeFileSync(join(cwd, 'about-you.suggested.md'), '# About me\n\nLikes boats.\n');
      return 'Suggested a change to the page about the person.';
    };
    await addNote('# One');
    await addNote('# Two');
    await (await queue()).fileAll();
    expect(readdirSync(knowledgePaths(join(home, 'workspaces', 'personal')).inbox)).toEqual([]);
    expect(readdirSync(join(home, '.wheems', 'review', 'about-you'))).toHaveLength(2);
    expect(git(home, 'log', '--format=%s').split('\n')).toHaveLength(2);
  });
});
