import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadInstall, type LoadedInstall } from '../src/config/load.js';
import { ConversationManager, conversationKey, uuidFor } from '../src/service/conversations.js';
import { ConversationStore } from '../src/service/store.js';
import { StateStore } from '../src/state/store.js';
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
  let answers: Map<string, FinalMessage[]>;
  let state: StateStore;

  const make = (
    options: {
      maxLiveSessions?: number;
      startupSeconds?: number;
      noteSweepMs?: number;
      noteTurnSeconds?: number;
      trustProblem?: (engine: string, dir: string) => Promise<string | null>;
    } = {},
  ) => {
    const engine = new StubEngine({ command: ['fake-agent'], answers });
    manager = new ConversationManager({
      install: install.config!,
      bindings: [{ workspace: install.workspaces[0]!, connection: 'slack', channel: null }],
      channels: new Map([['slack', channel]]),
      runtime,
      engine: () => engine,
      store: new ConversationStore(state),
      sessionEnv: { WHEEMS_HOME: home },
      pollMs: 5,
      startupSeconds: options.startupSeconds ?? 2,
      followUpSeconds: 0.5,
      log: (m) => logs.push(m),
      ...(options.maxLiveSessions !== undefined && { maxLiveSessions: options.maxLiveSessions }),
      ...(options.noteSweepMs !== undefined && { noteSweepMs: options.noteSweepMs }),
      ...(options.noteTurnSeconds !== undefined && { noteTurnSeconds: options.noteTurnSeconds }),
      ...(options.trustProblem !== undefined && { trustProblem: options.trustProblem }),
      aboutYouFile: join(home, 'about-you.md'),
    });
  };

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'wheems-conv-'));
    state = await StateStore.open(join(home, '.wheems', 'state.sqlite'));
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
        alive: async (id) => (await runtime.get(id))?.state === 'live',
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
    state.close();
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
  /** Waits until `condition` holds, however slow the machine, failing after `ms`. */
  const until = async (condition: () => boolean, ms = 5000) => {
    const deadline = Date.now() + ms;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for a condition');
      await new Promise((r) => setTimeout(r, 2));
    }
  };

  it("says files can't reach the agent yet, and passes on any words with a note", async () => {
    const onlyFile = await channel.receive({
      channel: 'D1',
      text: '',
      userId: ME,
      direct: true,
      files: [{ name: 'invoice.pdf' }],
    });
    await settle();
    expect(posts()).toEqual([
      {
        thread: onlyFile,
        text: "_Wheems:_ I can't open files yet (invoice.pdf). Paste the text, or say in words what you need.",
      },
    ]);
    expect(await runtime.list({ labels: { workspace: 'personal' } })).toEqual([]);

    const withWords = await channel.receive({
      channel: 'D1',
      text: 'what is the total?',
      userId: ME,
      direct: true,
      files: [{ name: 'invoice.pdf' }],
    });
    await settle();
    const reply = posts().find((p) => p.thread === withWords)?.text ?? '';
    expect(reply).toContain('echo: what is the total?');
    expect(reply).toContain('The person attached a file: invoice.pdf.');
  });

  it('starts a session per thread, hands it the message, and posts its reply in the thread', async () => {
    const first = await dm('hello');
    await settle();
    expect(posts()).toEqual([{ thread: first, text: 'echo: hello' }]);
    const sessions = await runtime.list({
      labels: { workspace: 'personal' },
    });
    expect(sessions).toHaveLength(1);
    const key = conversationKey('personal', 'slack', 'D1', first);
    expect(received.get(sessions[0]!.id)).toEqual(['hello']);
    // Labelled with its session's id, so the store can be matched against Herdr.
    expect(sessions[0]!.labels).toEqual({ wheems: uuidFor(key), workspace: 'personal' });
    expect(state.workspace('personal').session(uuidFor(key))).toMatchObject({
      kind: 'thread',
      agent: null,
      herdrName: sessions[0]!.name,
    });
    // The reply carries the workspace's identity.
    expect(channel.sent[0]?.identity).toEqual({ name: 'Personal chief of staff' });
    // The seen mark is cleared once the agent has replied.
    expect([...(channel.reactions.get(`D1/${first}`) ?? [])]).toEqual([]);
    // The engine wrote its instructions file, with the built-in chat instructions.
    const claudeMd = readFileSync(join(home, 'workspaces', 'personal', 'AGENTS.md'), 'utf8');
    expect(claudeMd).toContain('wheems reply');
    expect(Object.fromEntries(state.conversations())).toMatchObject({
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
    const sessions = await runtime.list({ labels: { workspace: 'personal' } });
    expect(sessions).toHaveLength(1);
    expect(received.get(sessions[0]!.id)).toEqual(['one', 'two', 'three']);
    expect(posts().map((p) => p.thread)).toEqual([first, first, first]);
  });

  it('counts a reply that came before the turn was being followed', async () => {
    // A store that's slow to record the message, so the agent always replies before Wheems
    // starts following its turn.
    class SlowStore extends ConversationStore {
      override async addPending(key: string): Promise<void> {
        await new Promise((r) => setTimeout(r, 60));
        await super.addPending(key);
      }
    }
    await manager.stop();
    const engine = new StubEngine({ command: ['fake-agent'], answers });
    manager = new ConversationManager({
      install: install.config!,
      bindings: [{ workspace: install.workspaces[0]!, connection: 'slack', channel: null }],
      channels: new Map([['slack', channel]]),
      runtime,
      engine: () => engine,
      store: new SlowStore(state),
      sessionEnv: { WHEEMS_HOME: home },
      pollMs: 5,
      startupSeconds: 2,
      followUpSeconds: 0.5,
    });
    const first = await dm('one');
    await settle();
    await dm('two', first);
    await settle();
    expect(posts().map((p) => p.text)).toEqual(['echo: one', 'echo: two']);
  });

  it('gives a new top-level message its own session', async () => {
    await dm('one');
    await dm('another topic');
    await settle();
    expect(await runtime.list({ labels: { workspace: 'personal' } })).toHaveLength(2);
  });

  it('resumes the conversation in a new session when the old one has ended', async () => {
    const first = await dm('one');
    await settle();
    const [session] = await runtime.list({ labels: { workspace: 'personal' } });
    await runtime.stop(session!.id);
    await dm('two', first);
    await settle();
    const [next] = await runtime.list({ labels: { workspace: 'personal' } });
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

  it('posts progress notes from wheems reply and then the final answer, without repeating a reply', async () => {
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

  it('posts every answer even when turns follow each other faster than it checks', async () => {
    behaviour = () => 'answer';
    await manager.stop();
    // Each wait answers late, so by the time the manager looks, the next turn has started.
    runtime = new MemoryRuntime(
      {
        'fake-agent': fakeAgent({
          behaviour: (line) => behaviour(line),
          reply: (conversation, text) => manager.reply(conversation, text),
          answers,
          delayMs: 15,
        }),
      },
      { waitDelayMs: 25 },
    );
    make();
    const first = await dm('one');
    await dm('two', first);
    await dm('three', first);
    await settle();
    expect(posts()).toEqual([
      { thread: first, text: 'answer: one' },
      { thread: first, text: 'answer: two' },
      { thread: first, text: 'answer: three' },
    ]);
  });

  it('finds the session id of an engine that picks its own, and resumes by it', async () => {
    behaviour = () => 'answer';
    await manager.stop();
    const engine = new StubEngine({ command: ['fake-agent'], answers, ownIds: true });
    manager = new ConversationManager({
      install: install.config!,
      bindings: [{ workspace: install.workspaces[0]!, connection: 'slack', channel: null }],
      channels: new Map([['slack', channel]]),
      runtime,
      engine: () => engine,
      store: new ConversationStore(state),
      sessionEnv: { WHEEMS_HOME: home },
      pollMs: 5,
      startupSeconds: 2,
      followUpSeconds: 0.5,
    });
    const first = await dm('first question');
    await settle();
    const key = conversationKey('personal', 'slack', 'D1', first);
    const stored = Object.fromEntries(state.conversations()) as Record<
      string,
      { engineSessionId?: string }
    >;
    expect(stored[key]?.engineSessionId).toBe('own-1');
    expect(posts()).toEqual([{ thread: first, text: 'answer: first question' }]);

    // The session ends; the next message resumes the engine's own session.
    const [session] = await runtime.list({ labels: { workspace: 'personal' } });
    await runtime.stop(session!.id);
    await dm('second question', first);
    await settle();
    const [next] = await runtime.list({ labels: { workspace: 'personal' } });
    expect(next?.command).toEqual(['fake-agent', '--resume']);
    expect(posts().at(-1)).toEqual({ thread: first, text: 'answer: second question' });
  });

  it('follows an engine that reports no status by its answers', async () => {
    await manager.stop();
    const quiet = new MemoryRuntime({
      'fake-agent': fakeAgent({
        behaviour: () => 'answer',
        reply: (conversation, text) => manager.reply(conversation, text),
        answers,
        reportsStatus: false,
        delayMs: 30,
      }),
    });
    const engine = new StubEngine({
      command: ['fake-agent'],
      answers,
      ownIds: true,
      reportsStatus: false,
    });
    manager = new ConversationManager({
      install: install.config!,
      bindings: [{ workspace: install.workspaces[0]!, connection: 'slack', channel: null }],
      channels: new Map([['slack', channel]]),
      runtime: quiet,
      engine: () => engine,
      store: new ConversationStore(state),
      sessionEnv: { WHEEMS_HOME: home },
      pollMs: 5,
      answerPollMs: 5,
      startupSeconds: 2,
    });
    const first = await dm('one');
    await settle();
    expect(posts()).toEqual([{ thread: first, text: 'answer: one' }]);
    // Two messages while it works: each gets its own answer, in order.
    await dm('two', first);
    await dm('three', first);
    await settle();
    expect(posts().map((p) => p.text)).toEqual(['answer: one', 'answer: two', 'answer: three']);
    expect([...channel.reactions.values()].every((set) => set.size === 0)).toBe(true);
  });

  it('keeps two conversations with the same first message on their own engine sessions', async () => {
    behaviour = () => 'answer';
    await manager.stop();
    const engine = new StubEngine({ command: ['fake-agent'], answers, ownIds: true });
    manager = new ConversationManager({
      install: install.config!,
      bindings: [{ workspace: install.workspaces[0]!, connection: 'slack', channel: null }],
      channels: new Map([['slack', channel]]),
      runtime,
      engine: () => engine,
      store: new ConversationStore(state),
      sessionEnv: { WHEEMS_HOME: home },
      pollMs: 5,
      startupSeconds: 2,
    });
    const a = await dm('Hello');
    const b = await dm('Hello');
    await settle();
    const stored = Object.fromEntries(state.conversations()) as Record<
      string,
      { engineSessionId?: string }
    >;
    const ids = [a, b].map(
      (thread) => stored[conversationKey('personal', 'slack', 'D1', thread)]?.engineSessionId,
    );
    expect(new Set(ids).size).toBe(2);
    expect(posts().filter((p) => p.thread === a)).toHaveLength(1);
    expect(posts().filter((p) => p.thread === b)).toHaveLength(1);
  });

  it('never stops a session that is still working, even one that reports no status', async () => {
    await manager.stop();
    const quiet = new MemoryRuntime({
      'fake-agent': fakeAgent({
        behaviour: () => 'answer',
        reply: (conversation, text) => manager.reply(conversation, text),
        answers,
        reportsStatus: false,
        delayMs: 150,
      }),
    });
    const engine = new StubEngine({
      command: ['fake-agent'],
      answers,
      ownIds: true,
      reportsStatus: false,
    });
    manager = new ConversationManager({
      install: install.config!,
      bindings: [{ workspace: install.workspaces[0]!, connection: 'slack', channel: null }],
      channels: new Map([['slack', channel]]),
      runtime: quiet,
      engine: () => engine,
      store: new ConversationStore(state),
      sessionEnv: { WHEEMS_HOME: home },
      pollMs: 5,
      answerPollMs: 5,
      startupSeconds: 2,
      maxLiveSessions: 1,
    });
    await dm('first');
    await dm('second');
    await settle();
    expect(
      posts()
        .map((p) => p.text)
        .sort(),
    ).toEqual(['answer: first', 'answer: second']);
  });

  it('takes up a turn in progress after a restart, and still never stops its session', async () => {
    await manager.stop();
    const quiet = new MemoryRuntime({
      'fake-agent': fakeAgent({
        behaviour: () => 'answer',
        reply: (conversation, text) => manager.reply(conversation, text),
        answers,
        reportsStatus: false,
        delayMs: 300,
      }),
    });
    const engine = new StubEngine({
      command: ['fake-agent'],
      answers,
      ownIds: true,
      reportsStatus: false,
    });
    const make2 = () =>
      new ConversationManager({
        install: install.config!,
        bindings: [{ workspace: install.workspaces[0]!, connection: 'slack', channel: null }],
        channels: new Map([['slack', channel]]),
        runtime: quiet,
        engine: () => engine,
        store: new ConversationStore(state),
        sessionEnv: { WHEEMS_HOME: home },
        pollMs: 5,
        answerPollMs: 5,
        startupSeconds: 2,
        maxLiveSessions: 1,
      });
    manager = make2();
    const first = await dm('first');
    // The service restarts while the agent is still working on the first message.
    await new Promise((r) => setTimeout(r, 50));
    await manager.stop();
    manager = make2();
    await manager.recover();
    await dm('second');
    await settle();
    expect(
      posts()
        .map((p) => p.text)
        .sort(),
    ).toEqual(['answer: first', 'answer: second']);
    expect(posts().find((p) => p.text === 'answer: first')?.thread).toBe(first);
  });

  it('after a restart, follows until every waiting message has its answer', async () => {
    await manager.stop();
    const quiet = new MemoryRuntime({
      'fake-agent': fakeAgent({
        behaviour: () => 'answer',
        reply: (conversation, text) => manager.reply(conversation, text),
        answers,
        reportsStatus: false,
        delayMs: 150,
      }),
    });
    const engine = new StubEngine({
      command: ['fake-agent'],
      answers,
      ownIds: true,
      reportsStatus: false,
    });
    const make2 = () =>
      new ConversationManager({
        install: install.config!,
        bindings: [{ workspace: install.workspaces[0]!, connection: 'slack', channel: null }],
        channels: new Map([['slack', channel]]),
        runtime: quiet,
        engine: () => engine,
        store: new ConversationStore(state),
        sessionEnv: { WHEEMS_HOME: home },
        pollMs: 5,
        answerPollMs: 5,
        typeDelayMs: 30,
        startupSeconds: 2,
        maxLiveSessions: 1,
      });
    manager = make2();
    const first = await dm('one');
    await dm('two', first);
    // The service restarts with both messages still waiting.
    await new Promise((r) => setTimeout(r, 40));
    await manager.stop();
    manager = make2();
    await manager.recover();
    await settle();
    expect(posts().map((p) => p.text)).toEqual(['answer: one', 'answer: two']);
    const stored = Object.fromEntries(state.conversations()) as Record<
      string,
      { pending?: number }
    >;
    expect(stored[conversationKey('personal', 'slack', 'D1', first)]?.pending).toBe(0);
  });

  it('after a restart between answers, waits only for the answers still owed', async () => {
    await manager.stop();
    const quiet = new MemoryRuntime({
      'fake-agent': fakeAgent({
        behaviour: () => 'answer',
        reply: (conversation, text) => manager.reply(conversation, text),
        answers,
        reportsStatus: false,
        delayMs: 120,
      }),
    });
    const engine = new StubEngine({
      command: ['fake-agent'],
      answers,
      ownIds: true,
      reportsStatus: false,
    });
    const make2 = () =>
      new ConversationManager({
        install: install.config!,
        bindings: [{ workspace: install.workspaces[0]!, connection: 'slack', channel: null }],
        channels: new Map([['slack', channel]]),
        runtime: quiet,
        engine: () => engine,
        store: new ConversationStore(state),
        sessionEnv: { WHEEMS_HOME: home },
        pollMs: 5,
        answerPollMs: 5,
        typeDelayMs: 10,
        answerWaitSeconds: 1,
        startupSeconds: 2,
      });
    manager = make2();
    const first = await dm('one');
    await dm('two', first);
    // Wait for the first answer, then restart before the second.
    await until(() => posts().length > 0);
    expect(posts().map((p) => p.text)).toEqual(['answer: one']);
    await manager.stop();
    manager = make2();
    await manager.recover();
    await settle();
    // Only the second answer was owed: no false "no answer yet" after it.
    expect(posts().map((p) => p.text)).toEqual(['answer: one', 'answer: two']);
  });

  it('counts the wait before typing into a new session from when it was launched', async () => {
    await manager.stop();
    let launched = 0;
    const typed: number[] = [];
    class Timed extends MemoryRuntime {
      override async start(options: Parameters<MemoryRuntime['start']>[0]) {
        const info = await super.start(options);
        launched = Date.now();
        return info;
      }
      override send(id: string, text: string) {
        typed.push(Date.now());
        return super.send(id, text);
      }
    }
    const quiet = new Timed({
      'fake-agent': fakeAgent({
        behaviour: () => 'answer',
        reply: (conversation, text) => manager.reply(conversation, text),
        answers,
        reportsStatus: false,
      }),
    });
    const engine = new StubEngine({ command: ['fake-agent'], answers, reportsStatus: false });
    manager = new ConversationManager({
      install: install.config!,
      bindings: [{ workspace: install.workspaces[0]!, connection: 'slack', channel: null }],
      channels: new Map([['slack', channel]]),
      runtime: quiet,
      engine: () => engine,
      store: new ConversationStore(state),
      sessionEnv: { WHEEMS_HOME: home },
      pollMs: 5,
      answerPollMs: 5,
      typeDelayMs: 60,
      startupSeconds: 2,
      // Preparing the session is slow: its files take a while to write.
      writeFile: async (path, content) => {
        await new Promise((r) => setTimeout(r, 80));
        writeFileSync(path, content);
      },
    });
    const first = await dm('one');
    await dm('two', first);
    expect(typed).toHaveLength(1);
    expect((typed[0] ?? 0) - launched).toBeGreaterThanOrEqual(55);
    await settle();
    expect(posts().map((p) => p.text)).toEqual(['answer: one', 'answer: two']);
  });

  it('types the message into a resumed engine that takes none at launch', async () => {
    await manager.stop();
    const quiet = new MemoryRuntime({
      'fake-agent': fakeAgent({
        behaviour: () => 'answer',
        reply: (conversation, text) => manager.reply(conversation, text),
        answers,
        reportsStatus: false,
      }),
    });
    const engine = new StubEngine({
      command: ['fake-agent'],
      answers,
      ownIds: true,
      reportsStatus: false,
      typeOnResume: true,
    });
    manager = new ConversationManager({
      install: install.config!,
      bindings: [{ workspace: install.workspaces[0]!, connection: 'slack', channel: null }],
      channels: new Map([['slack', channel]]),
      runtime: quiet,
      engine: () => engine,
      store: new ConversationStore(state),
      sessionEnv: { WHEEMS_HOME: home },
      pollMs: 5,
      answerPollMs: 5,
      typeDelayMs: 20,
      startupSeconds: 2,
    });
    const first = await dm('one');
    await settle();
    const [session] = await quiet.list({ labels: { workspace: 'personal' } });
    await quiet.stop(session!.id);
    await dm('two', first);
    await settle();
    const [next] = await quiet.list({ labels: { workspace: 'personal' } });
    expect(next?.command).toEqual(['fake-agent', '--resume']);
    expect(posts().map((p) => p.text)).toEqual(['answer: one', 'answer: two']);
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

  it("says at once when the engine doesn't trust the folder, and starts nothing", async () => {
    await manager.stop();
    let trusted = false;
    const asked: string[] = [];
    make({
      trustProblem: (engine, dir) => {
        asked.push(`${engine} ${dir}`);
        return Promise.resolve(trusted ? null : 'Trust the install folder first.');
      },
    });
    const first = await dm('hello');
    await settle();
    expect(asked).toEqual([
      `${install.workspaces[0]!.agents[0]!.definition.engine} ${install.workspaces[0]!.dir}`,
    ]);
    expect(posts()).toEqual([{ thread: first, text: '_Wheems:_ Trust the install folder first.' }]);
    expect(await runtime.list({ labels: { workspace: 'personal' } })).toEqual([]);
    expect([...(channel.reactions.get(`D1/${first}`) ?? [])]).toEqual([]);

    // Once trusted at the Mac, the same thread starts as usual.
    trusted = true;
    await dm('hello again', first);
    await settle();
    expect(await runtime.list({ labels: { workspace: 'personal' } })).toHaveLength(1);
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
    const live = await runtime.list({ labels: { workspace: 'personal' } });
    expect(live).toHaveLength(2);
    expect(live.map((s) => received.get(s.id)?.[0])).toEqual(['b', 'c']);
  });

  it('refuses replies to conversations it does not know', async () => {
    await expect(manager.reply('personal:slack:D1:nope', 'x')).rejects.toThrow(/No conversation/);
  });

  describe('notes', () => {
    const isNoteRequest = (line: string) =>
      line.startsWith('Wheems: this conversation has gone quiet');
    const later = () => Date.now() + 31 * 60_000;
    const stored = () =>
      Object.fromEntries(state.conversations()) as Record<
        string,
        { notedAt?: string; noting?: boolean; lastAnswerId?: string }
      >;

    it("saves an agent's note to its workspace's inbox and counts the work so far as noted", async () => {
      const first = await dm('hello');
      await settle();
      const key = conversationKey('personal', 'slack', 'D1', first);
      const file = await manager.note(key, '# Said hello\n\nNothing else yet.');
      expect(file.startsWith(join(home, 'workspaces', 'personal', 'knowledge', 'inbox'))).toBe(
        true,
      );
      expect(readFileSync(file, 'utf8')).toContain('agent: chief-of-staff\nengine: claude-code');
      expect(stored()[key]?.notedAt).toBeDefined();
      // Noted, so a quiet spell asks for nothing.
      await manager.sweepNotes(later());
      await settle();
      const session = (await runtime.list({ labels: { workspace: 'personal' } }))[0]!;
      expect(received.get(session.id)).toEqual(['hello']);
    });

    it('refuses notes for conversations it does not know', async () => {
      await expect(manager.note('personal:slack:D1:nope', '# x')).rejects.toThrow(
        'No conversation',
      );
    });

    it('asks a quiet conversation for its note once, and never posts the answer to that turn', async () => {
      behaviour = () => 'answer';
      const first = await dm('plan the week');
      await settle();
      expect(posts()).toEqual([{ thread: first, text: 'answer: plan the week' }]);
      const key = conversationKey('personal', 'slack', 'D1', first);
      // Not quiet for long enough yet.
      await manager.sweepNotes(Date.now() + 60_000);
      const session = (await runtime.list({ labels: { workspace: 'personal' } }))[0]!;
      expect(received.get(session.id)).toEqual(['plan the week']);

      await manager.sweepNotes(later());
      await settle();
      expect(received.get(session.id)?.map((l) => isNoteRequest(l))).toEqual([false, true]);
      expect(posts()).toHaveLength(1);
      expect(stored()[key]?.noting).toBeUndefined();
      expect(stored()[key]?.lastAnswerId).toBe('answer-2');
      expect(stored()[key]?.notedAt).toBeDefined();

      // Asked once: no new work, no new request.
      await manager.sweepNotes(later());
      await settle();
      expect(received.get(session.id)).toHaveLength(2);

      // The next message's answer is posted, and only that.
      await dm('and next week?', first);
      await settle();
      expect(posts().map((p) => p.text)).toEqual([
        'answer: plan the week',
        'answer: and next week?',
      ]);
    });

    it('leaves notes alone in a workspace that turned them off', async () => {
      const file = join(home, 'workspaces', 'personal', 'workspace.yaml');
      writeFileSync(file, `${readFileSync(file, 'utf8')}\nknowledge:\n  note_after_idle: 0\n`);
      install = await loadInstall(home);
      make();
      await dm('hello');
      await settle();
      await manager.sweepNotes(later());
      await settle();
      const session = (await runtime.list({ labels: { workspace: 'personal' } }))[0]!;
      expect(received.get(session.id)).toEqual(['hello']);
    });

    it('skips a note answer left over from before a restart, before the next message', async () => {
      behaviour = () => 'answer';
      const first = await dm('one');
      await settle();
      const key = conversationKey('personal', 'slack', 'D1', first);
      // A note turn whose answer arrived after the service stopped following it.
      const session = (await runtime.list({ labels: { workspace: 'personal' } }))[0]!;
      await new ConversationStore(state).setNoting(key, true);
      make();
      await runtime.send(session.id, 'Wheems: this conversation has gone quiet (old request)');
      await new Promise((r) => setTimeout(r, 50));
      await dm('two', first);
      await settle();
      expect(posts().map((p) => p.text)).toEqual(['answer: one', 'answer: two']);
      expect(stored()[key]?.noting).toBeUndefined();
    });

    it('asks for the note before stopping an idle session to make room', async () => {
      make({ maxLiveSessions: 1, noteSweepMs: 60_000 });
      behaviour = () => 'answer';
      const first = await dm('one');
      await settle();
      const oldSession = (await runtime.list({ labels: { workspace: 'personal' } }))[0]!;
      await dm('two');
      await settle();
      expect(received.get(oldSession.id)?.map((l) => isNoteRequest(l))).toEqual([false, true]);
      const live = await runtime.list({ labels: { workspace: 'personal' } });
      expect(live.map((s) => s.id)).not.toContain(oldSession.id);
      expect(posts().map((p) => p.text)).toEqual(['answer: one', 'answer: two']);
      expect(stored()[conversationKey('personal', 'slack', 'D1', first)]?.notedAt).toBeDefined();
    });

    it("stops a session whose note turn runs late, so its answer can't stand in for the next reply", async () => {
      make({ noteTurnSeconds: 0.1 });
      behaviour = (line) => (isNoteRequest(line) ? 'slow-answer' : 'answer');
      const first = await dm('one');
      await settle();
      const oldSession = (await runtime.list({ labels: { workspace: 'personal' } }))[0]!;
      await manager.sweepNotes(later());
      expect((await runtime.get(oldSession.id))?.state).not.toBe('live');
      await dm('two', first);
      await settle();
      await new Promise((r) => setTimeout(r, 500));
      expect(posts().map((p) => p.text)).toEqual(['answer: one', 'answer: two']);
    });

    it('lets a late note turn finish before the next message goes in, and skips its answer', async () => {
      // The note turn outlived the service's wait, as after a restart.
      behaviour = (line) => (isNoteRequest(line) ? 'slow-answer' : 'answer');
      const first = await dm('one');
      await settle();
      const key = conversationKey('personal', 'slack', 'D1', first);
      const session = (await runtime.list({ labels: { workspace: 'personal' } }))[0]!;
      await new ConversationStore(state).setNoting(key, true);
      make();
      await runtime.send(session.id, 'Wheems: this conversation has gone quiet (old request)');
      await dm('two', first);
      await settle();
      expect(posts().map((p) => p.text)).toEqual(['answer: one', 'answer: two']);
      expect(stored()[key]?.noting).toBeUndefined();
    });

    it('stops the session when a note turn gave no answer, before the next message goes in', async () => {
      behaviour = (line) => (isNoteRequest(line) ? 'silent' : 'answer');
      const first = await dm('one');
      await settle();
      const key = conversationKey('personal', 'slack', 'D1', first);
      await manager.sweepNotes(later());
      await settle();
      expect(stored()[key]?.noting).toBe(true);
      await dm('two', first);
      await settle();
      expect(posts().map((p) => p.text)).toEqual(['answer: one', 'answer: two']);
      expect(stored()[key]?.noting).toBeUndefined();
    });

    it("keeps a message out of a note turn's session that can't be stopped, and says so", async () => {
      behaviour = (line) => (isNoteRequest(line) ? 'silent' : 'answer');
      const first = await dm('one');
      await settle();
      const key = conversationKey('personal', 'slack', 'D1', first);
      const session = (await runtime.list({ labels: { workspace: 'personal' } }))[0]!;
      await manager.sweepNotes(later());
      await settle();
      const stop = runtime.stop.bind(runtime);
      runtime.stop = () => Promise.reject(new Error('hc refused'));
      await dm('two', first);
      await settle();
      expect(received.get(session.id)?.filter((l) => !isNoteRequest(l))).toEqual(['one']);
      expect(posts().at(-1)?.text).toMatch(/Couldn't stop the agent's session/);
      expect(stored()[key]?.noting).toBe(true);
      // Once it can be stopped, the next message goes through.
      runtime.stop = stop;
      await dm('three', first);
      await settle();
      expect(posts().at(-1)?.text).toBe('answer: three');
      expect(stored()[key]?.noting).toBeUndefined();
    });

    it('loads the page about the person and the brief into the instructions', async () => {
      writeFileSync(join(home, 'about-you.md'), '# About me\n\nI like short answers.');
      writeFileSync(
        join(home, 'workspaces', 'personal', 'knowledge', 'brief.md'),
        'Working on the CRM this week.',
      );
      await dm('hello');
      await settle();
      const instructions = readFileSync(join(home, 'workspaces', 'personal', 'AGENTS.md'), 'utf8');
      expect(instructions).toContain('I like short answers.');
      expect(instructions).toContain('Working on the CRM this week.');
    });
  });

  it('makes stable conversation UUIDs', () => {
    const id = uuidFor('personal:slack:D1:1.2');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidFor('personal:slack:D1:1.2')).toBe(id);
    expect(uuidFor('personal:slack:D1:1.3')).not.toBe(id);
  });
});
