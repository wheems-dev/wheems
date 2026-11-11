import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadInstall, type LoadedInstall } from '../src/config/load.js';
import { ConversationManager, conversationKey, uuidFor } from '../src/service/conversations.js';
import { ConversationStore } from '../src/service/store.js';
import type { FinalMessage } from '../src/contracts/engine.js';
import { MemoryChannel, MemoryRuntime, StubEngine } from '../src/testing/index.js';
import { fakeAgent, type Behaviour } from './helpers/fake-agent.js';
import { initWorkspace } from '../src/cli/commands/init.js';
import { writeFileSync } from 'node:fs';
import { installYaml } from '../src/cli/templates.js';

const ME = 'UME';

describe('conversations', () => {
  let home: string;
  let install: LoadedInstall;
  let channel: MemoryChannel;
  let runtime: MemoryRuntime;
  let manager: ConversationManager;
  let behaviour: (line: string) => Behaviour;
  let received: Map<string, string[]>;
  let logs: string[];
  let answers: Map<string, FinalMessage>;

  const make = (options: { maxLiveSessions?: number; startupSeconds?: number } = {}) => {
    const engine = new StubEngine({ command: ['fake-agent'], answers });
    manager = new ConversationManager({
      install: install.config!,
      bindings: [{ workspace: install.workspaces[0]!, connection: 'slack', channel: null }],
      channels: new Map([['slack', channel]]),
      runtime,
      engine: () => engine,
      store: new ConversationStore(join(home, '.opinr', 'conversations.json')),
      sessionEnv: { OPINR_HOME: home },
      pollMs: 5,
      startupSeconds: options.startupSeconds ?? 2,
      followUpSeconds: 0.5,
      log: (m) => logs.push(m),
      ...(options.maxLiveSessions !== undefined && { maxLiveSessions: options.maxLiveSessions }),
    });
  };

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'opinr-conv-'));
    writeFileSync(
      join(home, 'install.yaml'),
      installYaml().replace('allowed_users: []', `allowed_users: [${ME}]`),
    );
    await initWorkspace({ home, id: 'personal' });
    install = await loadInstall(home);
    channel = new MemoryChannel();
    behaviour = () => 'reply';
    received = new Map();
    answers = new Map();
    logs = [];
    runtime = new MemoryRuntime({
      'fake-agent': fakeAgent({
        behaviour: (line) => behaviour(line),
        reply: (conversation, text) => manager.reply(conversation, text),
        received,
        answers,
      }),
    });
    make();
    // The closure reads the current manager, so tests that call make() again keep working.
    await channel.start((event) => manager.handle('slack', event));
  });

  afterEach(async () => {
    await manager.stop();
    rmSync(home, { recursive: true, force: true });
  });

  /** A direct message from me; returns its id. */
  const dm = async (text: string, threadId?: string) => {
    const id = await channel.receive({
      channel: 'D1',
      text,
      userId: ME,
      direct: true,
      ...(threadId !== undefined && { threadId }),
    });
    return id;
  };
  /** Waits until every turn has ended and the manager has said what it will say. */
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 5));
    await manager.whenIdle();
  };
  const posts = () => channel.sent.map((m) => ({ thread: m.threadId, text: m.text }));

  it('starts a session per thread, hands it the message, and posts its reply in the thread', async () => {
    const first = await dm('hello');
    await settle();
    expect(posts()).toEqual([{ thread: first, text: 'echo: hello' }]);
    const sessions = await runtime.list({
      labels: { opinr: 'conversation', workspace: 'personal' },
    });
    expect(sessions).toHaveLength(1);
    const key = conversationKey('personal', 'slack', 'D1', first);
    expect(received.get(sessions[0]!.id)).toEqual(['hello']);
    // The reply carries the workspace's identity.
    expect(channel.sent[0]?.identity).toEqual({ name: 'Personal chief of staff' });
    // The seen mark is cleared once the agent has replied.
    expect([...(channel.reactions.get(`D1/${first}`) ?? [])]).toEqual([]);
    // The engine wrote its instructions file, with the built-in chat instructions.
    const claudeMd = readFileSync(join(home, 'workspaces', 'personal', 'AGENTS.md'), 'utf8');
    expect(claudeMd).toContain('opinr reply');
    expect(
      JSON.parse(readFileSync(join(home, '.opinr', 'conversations.json'), 'utf8')),
    ).toMatchObject({
      [key]: { workspace: 'personal', channel: 'D1', thread: first, sessionId: uuidFor(key) },
    });
  });

  it('carries a conversation on across replies in its thread, in the same session', async () => {
    const first = await dm('one');
    await settle();
    await dm('two', first);
    await settle();
    await dm('three', first);
    await settle();
    const sessions = await runtime.list({ labels: { opinr: 'conversation' } });
    expect(sessions).toHaveLength(1);
    expect(received.get(sessions[0]!.id)).toEqual(['one', 'two', 'three']);
    expect(posts().map((p) => p.thread)).toEqual([first, first, first]);
  });

  it('gives a new top-level message its own session', async () => {
    await dm('one');
    await dm('another topic');
    await settle();
    expect(await runtime.list({ labels: { opinr: 'conversation' } })).toHaveLength(2);
  });

  it('resumes the conversation in a new session when the old one has ended', async () => {
    const first = await dm('one');
    await settle();
    const [session] = await runtime.list({ labels: { opinr: 'conversation' } });
    await runtime.stop(session!.id);
    await dm('two', first);
    await settle();
    const [next] = await runtime.list({ labels: { opinr: 'conversation' } });
    expect(next!.id).not.toBe(session!.id);
    // The stub engine reports resume and the same conversation id.
    expect(next!.command).toEqual(['fake-agent', '--resume']);
    expect(received.get(next!.id)).toEqual(['two']);
    expect(posts().at(-1)).toEqual({ thread: first, text: 'echo: two' });
  });

  it('ignores people who are not allowed, and channels no workspace chats in', async () => {
    await channel.receive({ channel: 'D1', text: 'hi', userId: 'USTRANGER', direct: true });
    await channel.receive({ channel: 'C9', text: 'hi', userId: ME, direct: false });
    await settle();
    expect(channel.sent).toEqual([]);
    expect(await runtime.list()).toEqual([]);
    expect(logs.some((l) => l.includes('USTRANGER'))).toBe(true);
  });

  it("posts the agent's final message of each turn, read by its engine", async () => {
    behaviour = () => 'answer';
    const first = await dm('what time is it?');
    await settle();
    await dm('and tomorrow?', first);
    await settle();
    expect(posts()).toEqual([
      { thread: first, text: 'answer: what time is it?' },
      { thread: first, text: 'answer: and tomorrow?' },
    ]);
    expect(channel.sent[0]?.identity).toEqual({ name: 'Personal chief of staff' });
  });

  it('posts progress notes from opinr reply and then the final answer, without repeating a reply', async () => {
    behaviour = () => 'progress-and-answer';
    const first = await dm('do the thing');
    await settle();
    expect(posts()).toEqual([
      { thread: first, text: 'On it.' },
      { thread: first, text: 'answer: do the thing' },
    ]);
    behaviour = () => 'reply-and-answer-same';
    await dm('again', first);
    await settle();
    expect(posts().slice(2)).toEqual([{ thread: first, text: 'echo: again' }]);
  });

  it('posts the same answer to two different questions', async () => {
    behaviour = () => 'same-answer';
    const first = await dm('Is it Friday?');
    await settle();
    await dm('Is the build green?', first);
    await settle();
    expect(posts()).toEqual([
      { thread: first, text: 'Yes.' },
      { thread: first, text: 'Yes.' },
    ]);
  });

  it('answers messages sent while the agent was busy, in the turns after', async () => {
    behaviour = () => 'answer';
    await manager.stop();
    runtime = new MemoryRuntime({
      'fake-agent': fakeAgent({
        behaviour: (line) => behaviour(line),
        reply: (conversation, text) => manager.reply(conversation, text),
        answers,
        delayMs: 60,
      }),
    });
    make();
    const first = await dm('one');
    await new Promise((r) => setTimeout(r, 20));
    await dm('two', first);
    await dm('three', first);
    await settle();
    expect(posts()).toEqual([
      { thread: first, text: 'answer: one' },
      { thread: first, text: 'answer: two' },
      { thread: first, text: 'answer: three' },
    ]);
    expect([...channel.reactions.values()].every((set) => set.size === 0)).toBe(true);
  });

  it('says so when the agent finishes without replying', async () => {
    behaviour = () => 'silent';
    const first = await dm('hello');
    await settle();
    expect(posts()).toEqual([
      { thread: first, text: expect.stringMatching(/finished without replying here/) as string },
    ]);
  });

  it('says so when the agent is waiting for a person at the Mac, and when a message arrives meanwhile', async () => {
    behaviour = () => 'block';
    const first = await dm('deploy');
    await settle();
    expect(posts().at(-1)?.text).toMatch(/waiting for an answer at the Mac/);
    await dm('well?', first);
    await settle();
    expect(posts()).toHaveLength(2);
    expect(posts().at(-1)?.text).toMatch(/waiting for an answer at the Mac/);
  });

  it('says so when a new session never starts, such as at a folder trust question', async () => {
    await manager.stop();
    make({ startupSeconds: 0.2 });
    behaviour = () => 'never-start';
    await dm('hello');
    await settle();
    expect(posts().at(-1)?.text).toMatch(/hasn't started on this yet.*hc attach/);
  });

  it('says so when the session exits without replying', async () => {
    behaviour = () => 'exit';
    await dm('bye');
    await settle();
    expect(posts().at(-1)?.text).toMatch(/session ended without replying/);
  });

  it('stops the least recently used idle sessions beyond the limit', async () => {
    await manager.stop();
    make({ maxLiveSessions: 2 });
    for (const text of ['a', 'b', 'c']) {
      await dm(text);
      await settle();
    }
    const live = await runtime.list({ labels: { opinr: 'conversation' } });
    expect(live).toHaveLength(2);
    expect(live.map((s) => received.get(s.id)?.[0])).toEqual(['b', 'c']);
  });

  it('refuses replies to conversations it does not know', async () => {
    await expect(manager.reply('personal:slack:D1:nope', 'x')).rejects.toThrow(/No conversation/);
  });

  it('makes stable conversation UUIDs', () => {
    const id = uuidFor('personal:slack:D1:1.2');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidFor('personal:slack:D1:1.2')).toBe(id);
    expect(uuidFor('personal:slack:D1:1.3')).not.toBe(id);
  });
});
