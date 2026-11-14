import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionInfo } from '../src/contracts/runtime.js';
import { ConversationStore, type Conversation } from '../src/service/store.js';
import { SCHEMA_VERSION } from '../src/state/schema.js';
import { StateStore, sessionLabels, type StandingAgent } from '../src/state/store.js';

const conversation = (thread: string, workspace = 'personal'): Conversation => ({
  workspace,
  connection: 'slack',
  channel: 'D1',
  thread,
  sessionId: `id-${workspace}-${thread}`,
  sessionName: `${workspace}-${thread}`,
  createdAt: '2026-11-11T10:00:00.000Z',
  lastActiveAt: '2026-11-11T10:00:00.000Z',
  pending: 0,
});

const chief = (workspace: string): StandingAgent => ({
  id: `${workspace}/chief-of-staff`,
  workspace,
  project: null,
  name: 'chief-of-staff',
  role: 'chief',
  engine: 'claude-code',
});

const live = (name: string, labels: Record<string, string>): SessionInfo => ({
  id: `t-${name}`,
  name,
  state: 'live',
  status: 'idle',
  turn: 0,
  cwd: '/',
  command: null,
  exitCode: null,
  labels,
});

describe('session store', () => {
  let dir: string;
  let file: string;
  let state: StateStore;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wheems-store-'));
    file = join(dir, '.wheems', 'state.sqlite');
    state = await StateStore.open(file);
  });
  afterEach(() => {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('schema', () => {
    it('is made at the current version, in WAL mode, and reopens without migrating again', async () => {
      state.close();
      const db = new DatabaseSync(file);
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION });
      expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => r.name);
      expect(tables).toEqual(
        expect.arrayContaining(['agents', 'sessions', 'threads', 'messages', 'session_search']),
      );
      db.close();
      state = await StateStore.open(file);
      expect(state.conversations()).toEqual([]);
    });

    it('refuses a store from a newer Wheems, and doctor refuses one at another version', async () => {
      state.close();
      const db = new DatabaseSync(file);
      db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION + 1)}`);
      db.close();
      await expect(StateStore.open(file)).rejects.toThrow(/newer Wheems/);
      await expect(StateStore.open(file, { readOnly: true })).rejects.toThrow(/schema version/);
      state = await StateStore.open(join(dir, 'other.sqlite'));
    });
  });

  describe('conversations', () => {
    it('keeps every conversation when reads and writes happen at once, and after reopening', async () => {
      const store = new ConversationStore(state);
      await Promise.all([
        store.set('a', conversation('a')),
        store.get('x'),
        store.set('b', conversation('b')),
        store.all(),
      ]);
      expect((await store.all()).map(([key]) => key).sort()).toEqual(['a', 'b']);
      state.close();
      state = await StateStore.open(file);
      expect(await new ConversationStore(state).get('a')).toEqual(conversation('a'));
    });

    it('keeps every field, and leaves out the ones never set', async () => {
      const store = new ConversationStore(state);
      const full: Conversation = {
        ...conversation('a'),
        lastAnswerId: '',
        engineSessionId: 'own-1',
        startedAt: '2026-11-11T10:00:01.000Z',
        launchTag: 'tag',
        launchedAt: '2026-11-11T10:00:02.000Z',
        pending: 2,
        notedAt: '2026-11-11T09:00:00.000Z',
        noting: true,
      };
      await store.set('a', full);
      expect(await store.get('a')).toEqual(full);
      await store.set('b', conversation('b'));
      expect(Object.keys((await store.get('b'))!).sort()).toEqual(
        Object.keys(conversation('b')).sort(),
      );
    });

    it('moves the answer position and the waiting count together, never below zero', async () => {
      const store = new ConversationStore(state);
      await store.set('a', conversation('a'));
      await store.addPending('a');
      await store.addPending('a');
      const sessions = state.workspace('personal');
      expect(sessions.session('id-personal-a')?.state).toBe('working');
      await store.answered('a', 'answer-1', 1);
      expect(await store.get('a')).toMatchObject({ lastAnswerId: 'answer-1', pending: 1 });
      await store.answered('a', 'answer-3', 5);
      expect(await store.get('a')).toMatchObject({ lastAnswerId: 'answer-3', pending: 0 });
      expect(sessions.session('id-personal-a')?.state).toBe('idle');
    });

    it('changes nothing for a conversation it has no record of', async () => {
      const store = new ConversationStore(state);
      await store.answered('x', 'answer', 1);
      await store.addPending('x');
      await store.setNoting('x', true, 'answer');
      await store.touch('x', new Date());
      await store.setEngineSession('x', 'own');
      expect(await store.all()).toEqual([]);
    });

    it('sets and clears a note turn, and the time of the last note and activity', async () => {
      const store = new ConversationStore(state);
      await store.set('a', conversation('a'));
      await store.setNoting('a', true);
      await store.setNoted('a', new Date('2026-11-12T00:00:00.000Z'));
      expect(await store.get('a')).toMatchObject({
        noting: true,
        notedAt: '2026-11-12T00:00:00.000Z',
      });
      await store.setNoting('a', false, 'note-answer');
      await store.touch('a', new Date('2026-11-12T01:00:00.000Z'));
      await store.setEngineSession('a', 'own-2');
      const after = await store.get('a');
      expect(after?.noting).toBeUndefined();
      expect(after).toMatchObject({
        lastAnswerId: 'note-answer',
        lastActiveAt: '2026-11-12T01:00:00.000Z',
        engineSessionId: 'own-2',
      });
    });

    it("records a thread's session as its workspace chief's", async () => {
      state.writeAgents([chief('personal'), chief('acme')]);
      await new ConversationStore(state).set('a', conversation('a'));
      expect(state.workspace('personal').session('id-personal-a')).toMatchObject({
        kind: 'thread',
        agent: 'personal/chief-of-staff',
        herdrName: 'personal-a',
        state: 'idle',
      });
    });
  });

  describe('importing conversations.json', () => {
    let json: string;
    beforeEach(() => {
      json = join(dir, '.wheems', 'conversations.json');
    });

    it('does nothing when there is no file', async () => {
      expect(await state.importConversations(json)).toEqual({ status: 'none' });
      expect(state.conversations()).toEqual([]);
    });

    it('imports every conversation, then renames the file', async () => {
      const old = {
        a: { ...conversation('a'), pending: 1, lastAnswerId: 'x' },
        b: { ...conversation('b') },
      };
      delete (old.b as Partial<Conversation>).pending;
      writeFileSync(json, JSON.stringify(old));
      const result = await state.importConversations(json);
      expect(result).toEqual({
        status: 'imported',
        conversations: 2,
        skipped: 0,
        renamedTo: `${json}.imported`,
      });
      expect(existsSync(json)).toBe(false);
      expect(JSON.parse(readFileSync(`${json}.imported`, 'utf8'))).toEqual(old);
      expect(Object.fromEntries(state.conversations())).toEqual({
        a: old.a,
        b: { ...old.b, pending: 0 },
      });
      expect(state.workspace('personal').session('id-personal-a')?.state).toBe('working');
      // The next start finds nothing to import.
      expect(await state.importConversations(json)).toEqual({ status: 'none' });
    });

    it('never replaces a thread already in the store', async () => {
      await new ConversationStore(state).set('a', { ...conversation('a'), lastAnswerId: 'new' });
      writeFileSync(
        json,
        JSON.stringify({ a: { ...conversation('a'), lastAnswerId: 'old' }, b: conversation('b') }),
      );
      expect(await state.importConversations(json)).toMatchObject({
        conversations: 1,
        skipped: 1,
      });
      expect(state.conversation('a')?.lastAnswerId).toBe('new');
    });

    it('leaves a damaged file where it is and imports nothing from it', async () => {
      writeFileSync(json, '{"a": {"workspace": 1}}');
      expect(await state.importConversations(json)).toMatchObject({ status: 'unreadable' });
      writeFileSync(json, '{"a": ');
      expect(await state.importConversations(json)).toMatchObject({ status: 'unreadable' });
      expect(existsSync(json)).toBe(true);
      expect(state.conversations()).toEqual([]);
    });
  });

  describe('standing agents', () => {
    it('replaces the agents with those in config at each start', () => {
      state.writeAgents([chief('personal'), chief('acme')]);
      state.writeAgents([{ ...chief('acme'), engine: 'codex' }]);
      expect(state.workspace('personal').agents()).toEqual([]);
      expect(state.workspace('acme').agents()).toEqual([{ ...chief('acme'), engine: 'codex' }]);
    });
  });

  describe('matching Herdr', () => {
    it("stops sessions whose Herdr session has gone, and reports labelled sessions it doesn't know", async () => {
      const store = new ConversationStore(state);
      await store.set('a', conversation('a'));
      await store.set('b', conversation('b'));
      await store.set('c', conversation('c'));
      const match = state.matchRuntime([
        live('personal-a', sessionLabels('id-personal-a', 'personal')),
        // Started before the store, labelled the old way: known by its name.
        live('personal-b', { wheems: 'conversation', workspace: 'personal' }),
        live('personal-z', { wheems: 'conversation', workspace: 'personal' }),
        live('stray', sessionLabels('id-nobody', 'personal')),
        live('filer', { wheems: 'filer', workspace: 'personal' }),
        live('doctor', { wheems: 'doctor' }),
        live('shell', {}),
      ]);
      expect(match.stopped).toEqual(['id-personal-c']);
      expect(match.unknown.map((s) => s.name)).toEqual(['personal-z', 'stray']);
      const sessions = state.workspace('personal');
      expect(sessions.session('id-personal-c')?.state).toBe('stopped');
      expect(sessions.session('id-personal-a')?.state).toBe('idle');
      // A stopped session isn't stopped again, and starts working when resumed.
      expect(state.matchRuntime([]).stopped.sort()).toEqual(['id-personal-a', 'id-personal-b']);
      await store.set('c', { ...conversation('c'), pending: 1 });
      expect(sessions.session('id-personal-c')?.state).toBe('working');
    });
  });

  describe('workspaces', () => {
    beforeEach(async () => {
      const store = new ConversationStore(state);
      state.writeAgents([chief('personal'), chief('acme')]);
      await store.set('p', {
        ...conversation('packaging', 'personal'),
        lastActiveAt: '2026-11-12T00:00:00.000Z',
      });
      await store.set('q', conversation('suppliers', 'personal'));
      await store.set('a', conversation('packaging', 'acme'));
    });

    it("only ever sees the workspace's own sessions", () => {
      const personal = state.workspace('personal');
      expect(personal.sessions().map((s) => s.id)).toEqual([
        'id-personal-packaging',
        'id-personal-suppliers',
      ]);
      expect(personal.session('id-acme-packaging')).toBeUndefined();
      expect(
        state
          .workspace('acme')
          .sessions()
          .map((s) => s.id),
      ).toEqual(['id-acme-packaging']);
      expect(personal.sessions({ kind: 'adhoc' })).toEqual([]);
      expect(personal.sessions({ agent: 'personal/chief-of-staff', state: 'idle' })).toHaveLength(
        2,
      );
    });

    it('searches by agent within the workspace only', () => {
      expect(
        state
          .workspace('personal')
          .search('chief of staff')
          .map((s) => s.id),
      ).toEqual(['id-personal-packaging', 'id-personal-suppliers']);
      expect(
        state
          .workspace('acme')
          .search('chief')
          .map((s) => s.id),
      ).toEqual(['id-acme-packaging']);
      expect(state.workspace('acme').search('nothing-like-it')).toEqual([]);
      expect(state.workspace('acme').search('  ')).toEqual([]);
    });

    it('refuses a session id that belongs to another workspace', async () => {
      await expect(
        new ConversationStore(state).set('x', {
          ...conversation('x', 'personal'),
          sessionId: 'id-acme-packaging',
        }),
      ).rejects.toThrow(/another workspace/);
      expect(state.conversation('x')).toBeUndefined();
    });
  });

  it('opens read-only for doctor without writing', async () => {
    await new ConversationStore(state).set('a', conversation('a'));
    const reader = await StateStore.open(file, { readOnly: true });
    try {
      expect(reader.conversation('a')?.thread).toBe('a');
      expect(() => {
        reader.writeAgents([chief('personal')]);
      }).toThrow();
    } finally {
      reader.close();
    }
    mkdirSync(join(dir, 'empty'));
    await expect(
      StateStore.open(join(dir, 'empty', 'state.sqlite'), { readOnly: true }),
    ).rejects.toThrow();
  });
});
