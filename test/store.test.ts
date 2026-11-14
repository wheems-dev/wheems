import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionInfo } from '../src/contracts/runtime.js';
import { ConversationStore, type Conversation } from '../src/service/store.js';
import { MIGRATIONS, SCHEMA_VERSION } from '../src/state/schema.js';
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

    it('keeps the store and its -wal and -shm files owner-only, mending ones from before', async () => {
      const mode = (f: string) => statSync(f).mode & 0o777;
      await new ConversationStore(state).set('k', conversation('packaging', 'personal'));
      for (const f of [file, `${file}-wal`, `${file}-shm`]) expect(mode(f)).toBe(0o600);
      state.close();
      for (const f of [file, `${file}-wal`, `${file}-shm`]) {
        if (existsSync(f)) chmodSync(f, 0o644);
      }
      state = await StateStore.open(file);
      for (const f of [file, `${file}-wal`, `${file}-shm`]) {
        if (existsSync(f)) expect(mode(f)).toBe(0o600);
      }
      expect(mode(file)).toBe(0o600);
    });

    it('marks the messages of a store from before kinds as messages', async () => {
      state.close();
      const old = join(dir, 'v1.sqlite');
      const db = new DatabaseSync(old);
      db.exec(MIGRATIONS[0] ?? '');
      db.exec('PRAGMA user_version = 1');
      db.exec(
        "INSERT INTO sessions (id, workspace, kind, state, created_at, last_active_at) VALUES ('s', 'personal', 'adhoc', 'idle', 't', 't')",
      );
      db.exec(
        "INSERT INTO messages (id, workspace, sender, receiver, message_file, state, sent_at) VALUES ('m', 'personal', NULL, 's', '/m.md', 'sent', 't')",
      );
      db.close();
      state = await StateStore.open(old);
      expect(state.workspace('personal').message('m')).toMatchObject({ kind: 'message' });
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

    it('changes a session only from the state it was read in, when asked to', () => {
      const personal = state.workspace('personal');
      personal.update('id-personal-suppliers', { state: 'ended' });
      personal.update('id-personal-suppliers', { state: 'idle' }, 'working');
      expect(personal.session('id-personal-suppliers')?.state).toBe('ended');
      personal.update('id-personal-packaging', { state: 'working' }, 'idle');
      expect(personal.session('id-personal-packaging')?.state).toBe('working');
    });

    it('keeps messages in their workspace, finishes each once, and fails waiting ones at start', () => {
      const personal = state.workspace('personal');
      const message = (id: string, sentAt: string) =>
        personal.addMessage({
          id,
          sender: 'id-personal-packaging',
          receiver: 'id-personal-suppliers',
          messageFile: `/m/${id}.md`,
          sentAt,
        });
      message('m1', '2026-11-14T10:00:00.000Z');
      message('m2', '2026-11-14T11:00:00.000Z');
      personal.finishMessage('m1', 'answered', '/m/m1.answer.md', '2026-11-14T10:05:00.000Z');
      // Once finished, it stays as it was.
      personal.finishMessage('m1', 'failed', null, '2026-11-14T10:06:00.000Z');
      expect(personal.message('m1')).toMatchObject({
        state: 'answered',
        answerFile: '/m/m1.answer.md',
      });
      expect(personal.messages('id-personal-packaging').map((m) => m.id)).toEqual(['m2', 'm1']);
      expect(personal.messages('id-personal-suppliers', 1).map((m) => m.id)).toEqual(['m2']);
      expect(state.workspace('acme').message('m1')).toBeUndefined();
      expect(state.workspace('acme').messages('id-personal-packaging')).toEqual([]);
      // At start, the ones still waiting are found, and left as they are.
      expect(state.waitingMessages()).toEqual([
        expect.objectContaining({ id: 'm2', kind: 'message', state: 'sent' }),
      ]);
      // A lost one is marked failed and its sender's notice kept, together.
      const notice = personal.replaceWithNotice('m2', {
        id: 'n2',
        sender: 'id-personal-suppliers',
        receiver: 'id-personal-packaging',
        messageFile: '/m/n2.md',
        sentAt: '2026-11-14T12:00:00.000Z',
      });
      expect(notice).toMatchObject({ kind: 'handback', state: 'sent' });
      expect(personal.message('m2')?.state).toBe('failed');
      expect(state.waitingMessages().map((m) => m.id)).toEqual(['n2']);
      // If the notice can't be kept, the message isn't marked either.
      message('m3', '2026-11-14T13:00:00.000Z');
      expect(() =>
        personal.replaceWithNotice('m3', {
          id: 'n2',
          sender: 'id-personal-suppliers',
          receiver: 'id-personal-packaging',
          messageFile: '/m/n2.md',
          sentAt: '2026-11-14T13:00:00.000Z',
        }),
      ).toThrow();
      expect(personal.message('m3')?.state).toBe('sent');
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
