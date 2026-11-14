import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { END_NOTE_REQUEST } from '../src/agents/builtin.js';
import { initWorkspace } from '../src/cli/commands/init.js';
import { defaultIo, run } from '../src/cli/program.js';
import { installYaml } from '../src/cli/templates.js';
import type { FinalMessage } from '../src/contracts/engine.js';
import { DriverRegistry } from '../src/contracts/registry.js';
import { paths } from '../src/home.js';
import { writeSecret } from '../src/secrets.js';
import { conversationKey, uuidFor } from '../src/service/conversations.js';
import { runService, type RunningService } from '../src/service/service.js';
import { StateStore, type SessionRecord } from '../src/state/store.js';
import { MemoryChannel, MemoryRuntime, StubEngine } from '../src/testing/index.js';
import { fakeAgent, type Behaviour } from './helpers/fake-agent.js';

describe('wheems session', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let channel: MemoryChannel;
  let runtime: MemoryRuntime;
  let service: RunningService | undefined;
  let received: Map<string, string[]>;
  let answers: Map<string, FinalMessage[]>;
  /** What the agent does with each message: tests may change it. */
  let behave: (line: string) => Behaviour;

  /** Runs a `wheems` command, as the person or (with `as`) inside a session. */
  const wheems = async (args: string[], as: Record<string, string> = {}, stdin = '') => {
    let out = '';
    let err = '';
    const previous = process.exitCode;
    process.exitCode = undefined;
    try {
      const code = await run(args, {
        ...defaultIo(),
        out: (t) => (out += t),
        err: (t) => (err += t),
        env: { ...env, ...as },
        color: false,
        stdin: () => Promise.resolve(stdin),
      });
      return { code, out, err };
    } finally {
      process.exitCode = previous;
    }
  };

  const start = async (engine: { ownIds?: boolean; reportsStatus?: boolean } = {}) => {
    const stub = new StubEngine({ command: ['fake-agent'], answers, ...engine });
    const registry = new DriverRegistry()
      .register('runtime', 'herdr', () => runtime)
      .register('engine', 'claude-code', () => stub)
      .register('channel', 'slack', () => channel);
    service = await runService({
      home,
      registry,
      node: '/usr/local/bin/node',
      cli: '/opt/wheems/dist/cli/main.js',
      version: '9.9.9',
      env,
      log: () => undefined,
      pollMs: 5,
      startupSeconds: 2,
      noteSweepMs: 0,
    });
  };

  /** Reads the store, as doctor does. */
  const stored = async <T>(read: (state: StateStore) => T): Promise<T> => {
    const state = await StateStore.open(paths(home, env).store, { readOnly: true });
    try {
      return read(state);
    } finally {
      state.close();
    }
  };

  const newSession = async (
    title: string,
    as: Record<string, string> = {},
    extra: string[] = [],
  ): Promise<SessionRecord> => {
    const result = await wheems(
      ['session', 'new', ...extra, '--title', title, '--purpose', `research ${title}`, '--json'],
      as,
    );
    expect(result.err).toBe('');
    return JSON.parse(result.out) as SessionRecord;
  };

  /** A chief's thread session, started by a message in Slack; returns its environment. */
  const chiefThread = async (): Promise<Record<string, string>> => {
    const before = channel.sent.length;
    const thread = await channel.receive({
      channel: 'D1',
      text: 'hello',
      userId: 'UME',
      direct: true,
    });
    await waitFor(() => channel.sent.length > before);
    const key = conversationKey('personal', 'slack', 'D1', thread);
    return { WHEEMS_SESSION: uuidFor(key), WHEEMS_CONVERSATION: key };
  };

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'ss-'));
    env = { ...process.env, WHEEMS_HOME: home, WHEEMS_SECRETS: join(home, 'secrets.json') };
    delete env.WHEEMS_SESSION;
    delete env.WHEEMS_CONVERSATION;
    writeFileSync(
      join(home, 'install.yaml'),
      installYaml().replace('allowed_users: []', 'allowed_users: [UME]'),
    );
    await initWorkspace({ home, id: 'personal' });
    await writeSecret(env.WHEEMS_SECRETS!, 'slack', { bot_token: 'x', app_token: 'y' });
    channel = new MemoryChannel();
    // Chat messages are answered with wheems reply; everything else with a final answer.
    behave = (line) => (line.startsWith('hello') ? 'reply' : 'answer');
    received = new Map();
    answers = new Map();
    runtime = new MemoryRuntime({
      'fake-agent': fakeAgent({
        behaviour: (line) => behave(line),
        reply: async (conversation, text) => {
          const result = await wheems(['reply', text], { WHEEMS_CONVERSATION: conversation });
          if (result.code !== 0) throw new Error(result.err);
        },
        received,
        answers,
      }),
    });
    await start();
  });

  afterEach(async () => {
    await service?.stop();
    service = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  it('starts an ad-hoc session in a folder of its own, working on its purpose', async () => {
    const result = await wheems([
      'session',
      'new',
      '--title',
      'Packaging suppliers',
      '--purpose',
      'Find five packaging suppliers.',
    ]);
    expect(result.err).toBe('');
    const id = /^Started (\S+) \(chief-of-staff\): Packaging suppliers\n/.exec(result.out)?.[1];
    expect(id).toBeDefined();

    const session = await stored((s) => s.workspace('personal').session(id!));
    const folder = join(home, '.wheems', 'sessions', 'personal', 'adhoc', id!);
    expect(session).toMatchObject({
      kind: 'adhoc',
      agent: 'personal/chief-of-staff',
      owner: null,
      parent: null,
      title: 'Packaging suppliers',
      purpose: 'Find five packaging suppliers.',
      summary: 'Find five packaging suppliers.',
      state: 'working',
      folder,
    });
    const [live] = await runtime.list({ labels: { wheems: id! } });
    expect(live).toMatchObject({ name: session!.herdrName, cwd: folder });
    await waitFor(() => received.has(live!.id));
    expect(received.get(live!.id)).toEqual(['Find five packaging suppliers.']);
    // Its own instructions file, in its own folder; the chief's in the workspace is untouched.
    const instructions = readFileSync(join(folder, 'AGENTS.md'), 'utf8');
    expect(instructions).toContain('You\'re an ad-hoc session, "Packaging suppliers"');
    expect(instructions).toContain('> Find five packaging suppliers.');
    expect(instructions).not.toContain('Talking to the person');
    // Started by the person, one level deep: it may start one more level.
    expect(instructions).toContain('## Sessions (built into Wheems)');
    expect(existsSync(join(home, 'workspaces', 'personal', 'AGENTS.md'))).toBe(false);

    await waitFor(async () => (await wheems(['session', 'show', id!])).out.includes('Latest'));
    const show = await wheems(['session', 'show', id!]);
    expect(show.out).toContain('Latest answer:\nanswer: Find five packaging suppliers.');
    expect(show.out).toContain(`Watch it: hc attach ${live!.id}`);
  });

  it('lists and searches sessions in the workspace', async () => {
    const packaging = await newSession('packaging suppliers');
    const boats = await newSession('boat names');
    const list = await wheems(['session', 'list']);
    expect(list.out).toContain(packaging.id);
    expect(list.out).toContain(boats.id);
    const search = await wheems(['session', 'search', 'packaging']);
    expect(search.out).toContain(packaging.id);
    expect(search.out).not.toContain(boats.id);
    expect((await wheems(['session', 'search', 'nothing', 'like', 'it'])).out).toBe(
      'No session matches.\n',
    );
    const json = await wheems(['session', 'list', '--mine', '--kind', 'adhoc', '--json']);
    expect((JSON.parse(json.out) as SessionRecord[]).map((s) => s.id).sort()).toEqual(
      [packaging.id, boats.id].sort(),
    );
    expect((await wheems(['session', 'list', '--state', 'nope'])).err).toContain(
      '--state is one of',
    );
  });

  it("records a chief's sessions as the chief's, from any of its threads, and lists them at its launch", async () => {
    const chief = await chiefThread();
    const created = await newSession('packaging', chief);
    expect(created).toMatchObject({
      owner: 'personal/chief-of-staff',
      parent: chief.WHEEMS_SESSION,
    });
    // Another thread of the chief's sees it as its own.
    const other = await chiefThread();
    const mine = await wheems(['session', 'list', '--mine', '--json'], other);
    expect((JSON.parse(mine.out) as SessionRecord[]).map((s) => s.id)).toEqual([created.id]);
    // A new thread's session was told about it at launch.
    const instructions = readFileSync(join(home, 'workspaces', 'personal', 'AGENTS.md'), 'utf8');
    expect(instructions).toContain('### Your open sessions');
    expect(instructions).toMatch(
      new RegExp(`\`${created.id}\` packaging \\((working|idle)\\): research packaging`),
    );
  });

  it('limits open sessions per owner and how deep sessions may start sessions', async () => {
    const yaml = join(home, 'workspaces', 'personal', 'workspace.yaml');
    writeFileSync(
      yaml,
      `${readFileSync(yaml, 'utf8')}\nsessions:\n  max_open_per_owner: 2\n  max_depth: 2\n`,
    );
    await service?.stop();
    await start();
    const chief = await chiefThread();
    const first = await newSession('one', chief);
    await newSession('two', chief);
    const third = await wheems(
      ['session', 'new', '--title', 'three', '--purpose', 'research three'],
      chief,
    );
    expect(third.err).toContain('chief-of-staff already has 2 open sessions');

    // A session the chief started may start one more level, and no further.
    const asFirst = { WHEEMS_SESSION: first.id };
    const child = await newSession('child', asFirst);
    expect(child).toMatchObject({ owner: first.id, parent: first.id });
    const childInstructions = readFileSync(join(child.folder!, 'AGENTS.md'), 'utf8');
    expect(childInstructions).not.toContain('## Sessions (built into Wheems)');
    const grandchild = await wheems(
      ['session', 'new', '--title', 'grandchild', '--purpose', 'research'],
      { WHEEMS_SESSION: child.id },
    );
    expect(grandchild.err).toContain('2 levels deep');
  });

  it('admits one session at a time, so two at once cannot both pass a limit', async () => {
    const yaml = join(home, 'workspaces', 'personal', 'workspace.yaml');
    writeFileSync(yaml, `${readFileSync(yaml, 'utf8')}\nsessions:\n  max_open_per_owner: 1\n`);
    await service?.stop();
    await start();
    const results = await Promise.all(
      ['one', 'two'].map((title) =>
        wheems(['session', 'new', '--title', title, '--purpose', `research ${title}`]),
      ),
    );
    expect(results.filter((r) => r.code === 0)).toHaveLength(1);
    expect(results.map((r) => r.err).join('')).toContain('already has 1 open sessions');
  });

  it("counts the filer's sessions against its account's limit", async () => {
    writeFileSync(
      join(home, 'install.yaml'),
      readFileSync(join(home, 'install.yaml'), 'utf8').replace(
        'driver: claude\n',
        'driver: claude\n    max_sessions: 1\n',
      ),
    );
    await service?.stop();
    await start();
    await runtime.start({
      name: 'personal-filer',
      command: ['fake-agent'],
      labels: { wheems: 'filer', workspace: 'personal' },
    });
    const refused = await wheems(['session', 'new', '--title', 'one', '--purpose', 'research']);
    expect(refused.err).toContain('already runs 1 sessions');
  });

  it('shows a session idle once its turn is done, and stopped once its Herdr session has gone', async () => {
    const session = await newSession('packaging');
    await waitFor(async () =>
      (await wheems(['session', 'list', '--state', 'idle'])).out.includes(session.id),
    );
    const [live] = await runtime.list({ labels: { wheems: session.id } });
    await runtime.stop(live!.id);
    await runtime.remove(live!.id);
    expect((await wheems(['session', 'list', '--state', 'stopped'])).out).toContain(session.id);
  });

  it("doesn't mark a session ended while its agent may still be running", async () => {
    const session = await newSession('packaging');
    await waitFor(() => (answers.get(session.id) ?? []).length > 0);
    const stop = runtime.stop.bind(runtime);
    runtime.stop = () => Promise.reject(new Error('Herdr is busy'));
    const failed = await wheems(['session', 'end', session.id]);
    expect(failed.err).toContain("Couldn't stop session");
    expect(await stored((s) => s.workspace('personal').session(session.id)?.state)).not.toBe(
      'ended',
    );
    runtime.stop = stop;
    expect((await wheems(['session', 'end', session.id])).code).toBe(0);
  });

  it('limits sessions per account, across workspaces', async () => {
    writeFileSync(
      join(home, 'install.yaml'),
      readFileSync(join(home, 'install.yaml'), 'utf8').replace(
        'driver: claude\n',
        'driver: claude\n    max_sessions: 2\n',
      ),
    );
    await service?.stop();
    await start();
    await chiefThread();
    await newSession('one');
    const refused = await wheems(['session', 'new', '--title', 'two', '--purpose', 'research']);
    expect(refused.err).toContain('already runs 2 sessions');
  });

  it('ends a session after asking for its note, and keeps it as a record', async () => {
    const chief = await chiefThread();
    const session = await newSession('packaging', chief);
    const [live] = await runtime.list({ labels: { wheems: session.id } });
    await waitFor(() => (answers.get(session.id) ?? []).length > 0);

    const stranger = await newSession('other');
    const refused = await wheems(['session', 'end', session.id], {
      WHEEMS_SESSION: stranger.id,
    });
    expect(refused.err).toContain('Only its owner or the person can end');

    const ended = await wheems(['session', 'end', session.id], chief);
    expect(ended.out).toBe(`Ended ${session.id}. It wrote its note and has ended.\n`);
    expect(received.get(live!.id)).toEqual(['research packaging', END_NOTE_REQUEST]);
    expect(await runtime.list({ labels: { wheems: session.id } })).toEqual([]);
    expect(await stored((s) => s.workspace('personal').session(session.id)?.state)).toBe('ended');
    expect((await wheems(['session', 'list'])).out).not.toContain(session.id);
    expect((await wheems(['session', 'list', '--all'])).out).toContain(session.id);
    expect((await wheems(['session', 'search', 'packaging'])).out).toContain(session.id);
    expect((await wheems(['session', 'end', session.id], chief)).err).toContain('already ended');
    expect(
      (
        await wheems(['session', 'new', '--title', 'x', '--purpose', 'y'], {
          WHEEMS_SESSION: session.id,
        })
      ).err,
    ).toContain('has ended');
  });

  it("takes a session's notes, whose title becomes its summary, and has no thread to reply in yet", async () => {
    const session = await newSession('packaging');
    const as = { WHEEMS_SESSION: session.id };
    const note = await wheems(['note', '-'], as, '# Shortlisted three suppliers\n\nDetails.');
    expect(note.err).toBe('');
    const inbox = join(home, 'workspaces', 'personal', 'knowledge', 'inbox');
    const [file] = readdirSync(inbox);
    expect(readFileSync(join(inbox, file!), 'utf8')).toContain(`conversation: "${session.id}"`);
    expect(await stored((s) => s.workspace('personal').session(session.id)?.summary)).toBe(
      'Shortlisted three suppliers',
    );
    expect((await wheems(['session', 'search', 'shortlisted'])).out).toContain(session.id);
    const reply = await wheems(['reply', 'hi'], as);
    expect(reply.err).toContain('Answer your owner instead');
  });

  it('finds the answers of an engine that chooses its own ids and reports no status', async () => {
    await service?.stop();
    runtime = new MemoryRuntime({
      'fake-agent': fakeAgent({
        behaviour: (line) => (line.startsWith('research') ? 'slow-answer' : 'answer'),
        slowMs: 300,
        reply: () => Promise.resolve(),
        reportsStatus: false,
        received,
        answers,
      }),
    });
    await start({ ownIds: true, reportsStatus: false });
    const session = await newSession('packaging');
    // No status, and no answer yet: still working.
    expect((await wheems(['session', 'list', '--state', 'working'])).out).toContain(session.id);
    await waitFor(async () =>
      (await wheems(['session', 'list', '--state', 'idle'])).out.includes(session.id),
    );
    await waitFor(async () =>
      (await wheems(['session', 'show', session.id])).out.includes(
        'Latest answer:\nanswer: research packaging',
      ),
    );
    expect(await stored((s) => s.workspace('personal').session(session.id)?.engineSessionId)).toBe(
      'own-1',
    );
    // Its answer to a message is the one after the answers it had.
    const sent = await wheems(['session', 'send', session.id, 'And prices.', '--wait']);
    expect(sent.out).toBe('answer: Wheems: message from the person:\n\nAnd prices.\n');
    const ended = await wheems(['session', 'end', session.id]);
    expect(ended.out).toContain('It wrote its note and has ended.');
  });

  it('refuses secrets in titles and purposes', async () => {
    const result = await wheems([
      'session',
      'new',
      '--title',
      'keys',
      '--purpose',
      'use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ',
    ]);
    expect(result.err).toContain('looks like it holds a password');
  });

  it("keeps each workspace's sessions to itself", async () => {
    await service?.stop();
    await initWorkspace({ home, id: 'acme', channel: 'acme-chat' });
    await start();
    const personal = await newSession('packaging', {}, ['--workspace', 'personal']);
    const acme = await newSession('packaging', {}, ['--workspace', 'acme']);
    const asAcme = { WHEEMS_SESSION: acme.id };
    expect((await wheems(['session', 'search', 'packaging'], asAcme)).out).not.toContain(
      personal.id,
    );
    expect((await wheems(['session', 'show', personal.id], asAcme)).err).toContain(
      `No session ${personal.id} in acme`,
    );
    expect((await wheems(['session', 'list', '--workspace', 'personal'], asAcme)).err).toContain(
      'can only act in its own workspace',
    );
    expect((await wheems(['session', 'list'])).err).toContain('Say which workspace');
  });
  describe('send', () => {
    /** Waits until a session has answered its purpose and is idle. */
    const settled = async (id: string) => {
      await waitFor(
        async () => (await stored((s) => s.workspace('personal').session(id)?.state)) === 'idle',
      );
    };

    it('waits for the answer, and keeps the message and its answer', async () => {
      const session = await newSession('packaging');
      await settled(session.id);
      const sent = await wheems(['session', 'send', session.id, 'Add delivery times.', '--wait']);
      expect(sent.err).toBe('');
      expect(sent.out).toBe('answer: Wheems: message from the person:\n\nAdd delivery times.\n');

      const messages = await stored((s) => s.workspace('personal').messages(session.id));
      expect(messages[0]).toMatchObject({ sender: null, receiver: session.id, state: 'answered' });
      expect(readFileSync(messages[0]!.messageFile, 'utf8')).toBe('Add delivery times.\n');
      expect(readFileSync(messages[0]!.answerFile!, 'utf8')).toContain('Add delivery times.');
      // Its purpose is its first message.
      expect(messages[1]).toMatchObject({ sender: null, state: 'answered' });

      const show = await wheems(['session', 'show', session.id]);
      expect(show.out).toContain('Recent messages:');
      expect(show.out).toContain('from the person');
      expect(show.out).toContain('answered: Add delivery times.');
    });

    it("hands answers back to a chief's conversation, which answers on its channel", async () => {
      const chief = await chiefThread();
      const before = channel.sent.length;
      const created = await newSession('packaging', chief);
      // The purpose's answer comes back to the thread that started it, as a message from Wheems.
      const told = `Wheems: answer from session ${created.id} ("packaging"):`;
      const heard = () => [...received.values()].flat().filter((l) => l.startsWith(told));
      await waitFor(() => heard().length === 1);
      await waitFor(() => channel.sent.length > before);

      const sent = await wheems(['session', 'send', created.id, 'And prices.'], chief);
      expect(sent.out).toContain('Its answer will come to you in this conversation');
      await waitFor(() => heard().length === 2);
      expect(heard()[1]).toContain('Wheems: message from chief-of-staff:');
    });

    it('resumes a stopped session first', async () => {
      const session = await newSession('packaging');
      await settled(session.id);
      const herdr = await runtime.get(session.herdrName!);
      await runtime.stop(herdr!.id);
      await runtime.remove(herdr!.id);
      expect((await wheems(['session', 'list', '--json'])).out).toContain('"state": "stopped"');

      const sent = await wheems(['session', 'send', session.id, 'Carry on.', '--wait']);
      expect(sent.err).toBe('');
      expect(sent.out).toContain('Carry on.');
      expect((await runtime.get(session.herdrName!))?.state).toBe('live');
      expect((await wheems(['session', 'show', session.id, '--json'])).out).toContain(
        '"state": "idle"',
      );
    });

    it('lets a session send only to its owner and the sessions it owns', async () => {
      const one = await newSession('one');
      const two = await newSession('two');
      await settled(one.id);
      const asOne = { WHEEMS_SESSION: one.id };
      const sideways = await wheems(['session', 'send', two.id, 'hi'], asOne);
      expect(sideways.err).toContain('only send to its owner and to the sessions it owns');
      // The person started it, so there's no owner to send to.
      expect((await wheems(['session', 'send', 'owner', 'hi'], asOne)).err).toContain(
        'no owner to send to',
      );
      const child = await newSession('child', asOne);
      await settled(child.id);
      expect((await wheems(['session', 'send', child.id, 'go', '--wait'], asOne)).err).toBe('');
      expect(
        (await wheems(['session', 'send', 'owner', 'done', '--wait'], { WHEEMS_SESSION: child.id }))
          .err,
      ).toBe('');
      expect((await wheems(['session', 'send', one.id, 'hi'], asOne)).err).toContain(
        "can't send to itself",
      );
    });

    it("tells a chief's thread what its session sends to its owner, never with a wait", async () => {
      const chief = await chiefThread();
      const created = await newSession('packaging', chief);
      await settled(created.id);
      const asIt = { WHEEMS_SESSION: created.id };
      expect(
        (await wheems(['session', 'send', 'owner', 'Found one.', '--wait'], asIt)).err,
      ).toContain("can't wait");
      const sent = await wheems(['session', 'send', 'owner', 'Found one.'], asIt);
      expect(sent.err).toBe('');
      await waitFor(() =>
        [...received.values()]
          .flat()
          .some((l) => l.startsWith(`Wheems: message from session ${created.id}`)),
      );
      // The person's own chats aren't for sending to.
      expect((await wheems(['session', 'send', chief.WHEEMS_SESSION!, 'hi'])).err).toContain(
        'a conversation with the person',
      );
    });

    it('refuses a wait that would make two sessions wait on each other', async () => {
      const parent = await newSession('parent');
      await settled(parent.id);
      const asParent = { WHEEMS_SESSION: parent.id };
      const child = await newSession('child', asParent);
      await settled(child.id);
      behave = (line) => (line.includes('slowly') ? 'slow-answer' : 'answer');
      const waiting = wheems(['session', 'send', child.id, 'Work slowly.', '--wait'], asParent);
      await waitFor(async () =>
        (await stored((s) => s.workspace('personal').messages(child.id))).some(
          (m) => m.state === 'sent',
        ),
      );
      const back = await wheems(['session', 'send', 'owner', 'Quick question', '--wait'], {
        WHEEMS_SESSION: child.id,
      });
      expect(back.err).toContain('is waiting on you');
      expect((await waiting).out).toContain('Work slowly.');
      // Once the wait is over, it may.
      const after = await wheems(['session', 'send', 'owner', 'Thanks', '--wait'], {
        WHEEMS_SESSION: child.id,
      });
      expect(after.err).toBe('');
    });

    it('lets only one of two crossing waits through', async () => {
      const parent = await newSession('parent');
      await settled(parent.id);
      const asParent = { WHEEMS_SESSION: parent.id };
      const child = await newSession('child', asParent);
      await settled(child.id);
      behave = (line) => (line.includes('slowly') ? 'slow-answer' : 'answer');
      const results = await Promise.all([
        wheems(['session', 'send', child.id, 'Work slowly.', '--wait'], asParent),
        wheems(['session', 'send', 'owner', 'Work slowly too.', '--wait'], {
          WHEEMS_SESSION: child.id,
        }),
      ]);
      expect(results.filter((r) => r.err.includes('is waiting on you'))).toHaveLength(1);
      expect(results.filter((r) => r.err === '')).toHaveLength(1);
    });

    it('stops a session whose turn is cut short, so a late answer is never the next one', async () => {
      const session = await newSession('packaging');
      await settled(session.id);
      behave = (line) => (line.includes('permission') ? 'block' : 'answer');
      const blocked = await wheems(['session', 'send', session.id, 'Needs permission.', '--wait']);
      expect(blocked.err).toContain(
        'it was waiting for an answer at the Mac, so Wheems stopped it',
      );
      expect(await stored((s) => s.workspace('personal').session(session.id)?.state)).toBe(
        'stopped',
      );
      // The next message resumes it, and gets its own answer.
      const next = await wheems(['session', 'send', session.id, 'Carry on.', '--wait']);
      expect(next.out).toBe('answer: Wheems: message from the person:\n\nCarry on.\n');
    });

    it('keeps an answer it could not hand back, as a failed message', async () => {
      const parent = await newSession('parent');
      await settled(parent.id);
      const asParent = { WHEEMS_SESSION: parent.id };
      // The parent can't take the answer in: it stops to ask for permission.
      behave = (line) => (line.startsWith('Wheems: answer from') ? 'block' : 'answer');
      const child = await newSession('child', asParent);
      await waitFor(async () =>
        (await stored((s) => s.workspace('personal').messages(parent.id))).some(
          (m) => m.sender === child.id && m.state === 'failed',
        ),
      );
      const show = await wheems(['session', 'show', parent.id]);
      expect(show.out).toContain(`from ${child.id}`);
      expect(show.out).toContain('failed: Wheems: answer from session');
    });

    it('refuses messages to an ended session', async () => {
      const session = await newSession('packaging');
      await settled(session.id);
      expect((await wheems(['session', 'end', session.id])).err).toBe('');
      expect((await wheems(['session', 'send', session.id, 'hi'])).err).toContain('has ended');
    });
  });
});

async function waitFor(check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}
