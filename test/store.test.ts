import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConversationStore, type Conversation } from '../src/service/store.js';

const conversation = (thread: string): Conversation => ({
  workspace: 'personal',
  connection: 'slack',
  channel: 'D1',
  thread,
  sessionId: '11111111-2222-5333-8444-555555555555',
  sessionName: `personal-${thread}`,
  createdAt: '2026-11-11T10:00:00.000Z',
  lastActiveAt: '2026-11-11T10:00:00.000Z',
});

describe('conversation store', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'opinr-store-'));
    file = join(dir, '.opinr', 'conversations.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps every conversation when the first reads and writes happen at once', async () => {
    const store = new ConversationStore(file);
    await Promise.all([
      store.set('a', conversation('a')),
      store.get('x'),
      store.set('b', conversation('b')),
      store.all(),
    ]);
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')) as object).sort()).toEqual([
      'a',
      'b',
    ]);
    expect((await new ConversationStore(file).all()).map(([key]) => key).sort()).toEqual([
      'a',
      'b',
    ]);
  });

  it('reads what an earlier service saved, and refuses a damaged file', async () => {
    await new ConversationStore(file).set('a', conversation('a'));
    expect(await new ConversationStore(file).get('a')).toEqual(conversation('a'));
    writeFileSync(file, '{"a": {"workspace": 1}}');
    await expect(new ConversationStore(file).get('a')).rejects.toThrow();
  });
});
