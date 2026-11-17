import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { END_NOTE_REQUEST } from '../src/agents/builtin.js';
import { initWorkspace } from '../src/cli/commands/init.js';
import { defaultIo, run } from '../src/cli/program.js';
import { installYaml } from '../src/cli/templates.js';
import type { FinalMessage } from '../src/contracts/engine.js';
import type { EngineSetup } from '../src/contracts/setup.js';
import { DriverRegistry } from '../src/contracts/registry.js';
import { paths, tilde } from '../src/home.js';
import { writeSecret } from '../src/secrets.js';
import { conversationKey, uuidFor } from '../src/service/conversations.js';
import { request } from '../src/service/control.js';
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

  const start = async (
    engine: { ownIds?: boolean; reportsStatus?: boolean } = {},
    /** Given, the engine asks to trust folders, and trusts those this says. */
    trusts?: (dir: string) => boolean,
  ) => {
    const { ownIds, reportsStatus } = engine;
    const stub = new StubEngine({
      command: ['fake-agent'],
      answers,
      ...(ownIds !== undefined && { ownIds }),
      ...(reportsStatus !== undefined && { reportsStatus }),
    });
    const setup: EngineSetup | undefined = trusts && {
      version: () => Promise.resolve('1.0.0'),
      install: ['npm', 'install', '-g', 'claude'],
      signIn: null,
      signedIn: () => Promise.resolve(null),
      trust: ['claude'],
      trusted: (dir) => Promise.resolve(trusts(dir)),
      defaultModel: 'claude-opus-5-5',
      account: { name: 'claude-subscription', driver: 'claude' },
    };
    const registry = new DriverRegistry()
      .register('runtime', 'herdr', () => runtime)
      .register('engine', 'claude-code', () => stub, {
        label: 'Claude Code',
        description: 'x',
        ...(setup && { engine: setup }),
      })
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
      ['session', 'create', ...extra, '--title', title, '--purpose', `research ${title}`, '--json'],
      as,
    );
    expect(result.err).toBe('');
    return JSON.parse(result.out) as SessionRecord;
  };

  /** A chief's thread session, started by a message in Slack; returns its environment. */
  const chiefThread = async (text = 'hello'): Promise<Record<string, string>> => {
    const before = channel.sent.length;
    const thread = await channel.receive({
      channel: 'D1',
      text,
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
          const result = await wheems(['chat', 'reply', text], {
            WHEEMS_CONVERSATION: conversation,
          });
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
      'create',
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
    // Without a named agent it runs on the chief's engine as a member of the team, not as the
    // chief, whose file is written for managing.
    expect(instructions).toContain("You're a member of Personal's team");
    expect(instructions).not.toContain('chief of staff for Personal');
    expect(instructions).not.toContain('Your role (built into Wheems)');
    // Started by the person, one level deep: it may start one more level.
    expect(instructions).toContain('## Sessions (built into Wheems)');
    expect(existsSync(join(home, 'workspaces', 'personal', 'AGENTS.md'))).toBe(false);

    await waitFor(async () => (await wheems(['session', 'show', id!])).out.includes('Latest'));
    const show = await wheems(['session', 'show', id!]);
    expect(show.out).toContain('Latest answer:\nanswer: Find five packaging suppliers.');
    expect(show.out).toContain(`Watch it: hc attach ${live!.id}`);
  });

  it('tells the chief its role and its team, and a team agent keeps its own role', async () => {
    await service?.stop();
    const agents = join(home, 'workspaces', 'personal', 'agents');
    const chiefFile = readFileSync(join(agents, 'chief-of-staff.md'), 'utf8');
    const front = chiefFile.slice(0, chiefFile.indexOf('\n---\n', 4) + 5);
    writeFileSync(
      join(agents, 'developer.md'),
      front.replace(
        /^description: .*$/m,
        'description: Builds and fixes the website. Use for any code.',
      ) + '\n# Developer\n\nYou build and fix the website.\n',
    );
    await start();
    await chiefThread();
    const chief = readFileSync(join(home, 'workspaces', 'personal', 'AGENTS.md'), 'utf8');
    expect(chief).toContain('## Your role (built into Wheems)');
    expect(chief).toContain('**You read and answer; your team makes and changes things.**');
    expect(chief).toMatch(
      /## Your team \(built into Wheems\)[\s\S]*- \*\*developer\*\* \(claude-code, [^)]+\): Builds and fixes the website\. Use for any code\./,
    );
    expect(chief).not.toContain('answer simple things yourself');
    expect(chief).toContain('without one, it runs a general member of the team');

    const job = await newSession('checkout fix', {}, ['developer']);
    const own = readFileSync(join(job.folder!, 'AGENTS.md'), 'utf8');
    expect(own).toContain('You build and fix the website.');
    expect(own).not.toContain('Your role (built into Wheems)');
    expect(own).not.toContain('Your team (built into Wheems)');
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

  it("keeps the person's ask on the chief's thread, and passes it to every session started for it", async () => {
    const ask = 'Can you find me cheaper boat insurance?';
    const chief = await chiefThread(ask);
    expect((await stored((s) => s.workspace('personal').session(chief.WHEEMS_SESSION!)))?.ask).toBe(
      ask,
    );
    const quotes = await newSession('insurers', chief);
    expect(quotes.ask).toBe(ask);
    const wording = await newSession('policy wording', { WHEEMS_SESSION: quotes.id });
    expect(wording.ask).toBe(ask);
    // Each session started for it keeps the ask in view.
    const folder = join(home, '.wheems', 'sessions', 'personal', 'adhoc', wording.id);
    expect(readFileSync(join(folder, 'AGENTS.md'), 'utf8')).toContain(
      `It all started with the person asking:\n\n> ${ask}\n\nKeep your work to what that needs`,
    );
    expect((await wheems(['session', 'show', quotes.id])).out).toContain(`Asked:\n${ask}\n`);
    // A session the person starts has its purpose as its ask, so nothing is said twice.
    const mine = await newSession('marinas');
    expect(mine.ask).toBe('research marinas');
    expect((await wheems(['session', 'show', mine.id])).out).not.toContain('Asked:');
    const own = join(home, '.wheems', 'sessions', 'personal', 'adhoc', mine.id, 'AGENTS.md');
    expect(readFileSync(own, 'utf8')).not.toContain('It all started with');
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
      ['session', 'create', '--title', 'three', '--purpose', 'research three'],
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
      ['session', 'create', '--title', 'grandchild', '--purpose', 'research'],
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
        wheems(['session', 'create', '--title', title, '--purpose', `research ${title}`]),
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
    const refused = await wheems(['session', 'create', '--title', 'one', '--purpose', 'research']);
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
    const refused = await wheems(['session', 'create', '--title', 'two', '--purpose', 'research']);
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
        await wheems(['session', 'create', '--title', 'x', '--purpose', 'y'], {
          WHEEMS_SESSION: session.id,
        })
      ).err,
    ).toContain('has ended');
  });

  it("takes a session's notes, whose title becomes its summary, and has no thread to reply in yet", async () => {
    const session = await newSession('packaging');
    const as = { WHEEMS_SESSION: session.id };
    const note = await wheems(
      ['knowledgebase', 'note', '-'],
      as,
      '# Shortlisted three suppliers\n\nDetails.',
    );
    expect(note.err).toBe('');
    const inbox = join(home, 'workspaces', 'personal', 'knowledge', 'inbox');
    const [file] = readdirSync(inbox);
    expect(readFileSync(join(inbox, file!), 'utf8')).toContain(`conversation: "${session.id}"`);
    expect(await stored((s) => s.workspace('personal').session(session.id)?.summary)).toBe(
      'Shortlisted three suppliers',
    );
    expect((await wheems(['session', 'search', 'shortlisted'])).out).toContain(session.id);
    const reply = await wheems(['chat', 'reply', 'hi'], as);
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
      'create',
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
  it('starts nothing for a workspace while it is retired, even what was already queued', async () => {
    // A session's start waits in Herdr while the workspace is retired.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const start = runtime.start.bind(runtime);
    runtime.start = async (options) => {
      await held;
      return start(options);
    };
    const creating = wheems(['session', 'create', '--title', 'late', '--purpose', 'research late']);
    await new Promise((r) => setTimeout(r, 50));
    const retiring = request(paths(home, env).socket, {
      op: 'workspace-retire',
      id: 'personal',
      forget: true,
    });
    await new Promise((r) => setTimeout(r, 50));
    release();
    expect(await retiring).toMatchObject({ ok: true });
    expect((await creating).err).toContain('no longer served');
    expect(
      (await runtime.list({ labels: { workspace: 'personal' } })).filter((x) => x.state === 'live'),
    ).toEqual([]);
    expect(await stored((s) => s.workspace('personal').sessions({ kind: 'adhoc' }))).toEqual([]);
  });

  it("refuses to start a session in a folder its engine doesn't trust, starting nothing", async () => {
    await service?.stop();
    // The engine trusts the workspace (the chief answers) but not where sessions start.
    await start({}, (dir) => !dir.includes(join('.wheems', 'sessions')));
    const result = await wheems(['session', 'create', '--title', 'late', '--purpose', 'research']);
    expect(result.code).toBe(1);
    const adhoc = join(home, '.wheems', 'sessions', 'personal', 'adhoc');
    const at = tilde(home, env);
    expect(result.err).toBe(
      `Error: Claude Code doesn't trust the folder this session starts in (${tilde(adhoc, env)}), so it would wait at a "trust this folder?" question that nobody can see. Nothing was started. At the Mac, run \`wheems doctor --fix\` and say yes to marking ${at} trusted, or run \`cd ${at} && claude\` and answer yes. Claude Code then trusts every workspace and session in your install, including ones added later. Then try again.\n`,
    );
    expect(await runtime.list({ labels: { workspace: 'personal' } })).toEqual([]);
    expect(await stored((s) => s.workspace('personal').sessions({ kind: 'adhoc' }))).toEqual([]);
    expect(readdirSync(adhoc)).toEqual([]);
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

    it('refuses to resume a session in a folder its engine no longer trusts', async () => {
      let trusted = true;
      await service?.stop();
      await start({}, () => trusted);
      const session = await newSession('packaging');
      await settled(session.id);
      const herdr = await runtime.get(session.herdrName!);
      await runtime.stop(herdr!.id);
      await runtime.remove(herdr!.id);
      trusted = false;

      const sent = await wheems(['session', 'send', session.id, 'Carry on.']);
      expect(sent.code).toBe(1);
      expect(sent.err).toContain("Claude Code doesn't trust the folder this session starts in");
      expect(sent.err).toContain('Nothing was started.');
      // Refused before it was taken: no message kept, nothing started.
      expect(await stored((s) => s.workspace('personal').messages(session.id))).toHaveLength(1);
      expect(await runtime.get(session.herdrName!)).toBeNull();

      // Once it's trusted, the same send resumes it.
      trusted = true;
      const again = await wheems(['session', 'send', session.id, 'Carry on.', '--wait']);
      expect(again.err).toBe('');
      expect(again.out).toContain('Carry on.');
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

    it("holds the next message while a turn it couldn't stop is unfinished", async () => {
      const session = await newSession('packaging');
      await settled(session.id);
      behave = (line) => (line.includes('permission') ? 'block' : 'answer');
      const stop = runtime.stop.bind(runtime);
      runtime.stop = () => Promise.reject(new Error("Herdr didn't answer"));
      const blocked = await wheems(['session', 'send', session.id, 'Needs permission.', '--wait']);
      expect(blocked.err).toContain("couldn't be stopped");
      // Until it can be stopped, the next message waits rather than joining that turn, even
      // while Herdr can't say how the session is.
      const latest = async () =>
        (await stored((s) => s.workspace('personal').messages(session.id)))[0]?.state;
      const get = runtime.get.bind(runtime);
      runtime.get = () => Promise.reject(new Error("Herdr didn't answer"));
      const next = wheems(['session', 'send', session.id, 'Carry on.', '--wait']);
      await new Promise((r) => setTimeout(r, 300));
      expect(await latest()).toBe('sent');
      runtime.get = get;
      await new Promise((r) => setTimeout(r, 100));
      expect(await latest()).toBe('sent');
      runtime.stop = stop;
      expect((await next).out).toBe('answer: Wheems: message from the person:\n\nCarry on.\n');
    });

    it('stops or holds a turn it lost track of, so its late answer is never the next one', async () => {
      const session = await newSession('packaging');
      await settled(session.id);
      behave = (line) => (line.includes('slowly') ? 'slow-answer' : 'answer');
      const get = runtime.get.bind(runtime);
      const stop = runtime.stop.bind(runtime);
      const first = wheems(['session', 'send', session.id, 'Work slowly.', '--wait']);
      await waitFor(async () =>
        (await stored((s) => s.workspace('personal').messages(session.id))).some(
          (m) => m.state === 'sent',
        ),
      );
      // Herdr stops answering while the turn is followed, and the session can't be stopped.
      runtime.get = () => Promise.reject(new Error("Herdr didn't answer"));
      runtime.stop = () => Promise.reject(new Error("Herdr didn't answer"));
      expect((await first).err).toContain("Herdr didn't answer");
      const next = wheems(['session', 'send', session.id, 'Carry on.', '--wait']);
      await new Promise((r) => setTimeout(r, 100));
      runtime.get = get;
      runtime.stop = stop;
      // The slow turn's late answer belongs to the first message, not this one.
      expect((await next).out).toBe('answer: Wheems: message from the person:\n\nCarry on.\n');
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

    describe('after a restart', () => {
      const restart = async () => {
        await service?.stop();
        await start();
      };
      const heard = (start: string) =>
        [...received.values()].flat().filter((line) => line.startsWith(start));

      it('tells an ad-hoc sender its message was lost', async () => {
        const parent = await newSession('parent');
        await settled(parent.id);
        const asParent = { WHEEMS_SESSION: parent.id };
        const child = await newSession('child', asParent);
        await settled(child.id);
        behave = (line) => (line.includes('slowly') ? 'slow-answer' : 'answer');
        expect((await wheems(['session', 'send', child.id, 'Work slowly.'], asParent)).err).toBe(
          '',
        );
        await waitFor(async () =>
          (await stored((s) => s.workspace('personal').messages(child.id))).some(
            (m) => m.state === 'sent',
          ),
        );
        await restart();
        const lost = `Wheems: your message to session ${child.id} ("child") was lost when Wheems restarted. Send it again if you still need it.`;
        await waitFor(() => heard(lost).length === 1);
        const messages = await stored((s) => s.workspace('personal').messages(parent.id, 10));
        expect(messages.find((m) => m.receiver === child.id)?.state).toBe('failed');
        expect(messages.find((m) => m.receiver === parent.id)).toMatchObject({
          kind: 'handback',
          sender: child.id,
        });
      });

      it('tells a chief in its conversation, like any answer', async () => {
        const chief = await chiefThread();
        behave = (line) =>
          line.startsWith('hello') ? 'reply' : line.includes('slowly') ? 'slow-answer' : 'answer';
        const before = channel.sent.length;
        // Its purpose is its first message, and is lost while it works on it.
        const created = await newSession('slowly', chief);
        await restart();
        await waitFor(
          () =>
            heard(`Wheems: your message to session ${created.id} ("slowly") was lost`).length === 1,
        );
        // The chief answered in its thread.
        await waitFor(() => channel.sent.length > before);
      });

      it('delivers again an answer that was being handed back', async () => {
        const parent = await newSession('parent');
        await settled(parent.id);
        const child = await newSession('child', { WHEEMS_SESSION: parent.id });
        await settled(child.id);
        await service?.stop();
        service = undefined;
        const file = join(home, '.wheems', 'messages', 'personal', 'handed-back.md');
        writeFileSync(file, `Wheems: answer from session ${child.id} ("child"):\n\nFound three.\n`);
        const state = await StateStore.open(paths(home, env).store);
        state.workspace('personal').addMessage({
          id: 'handed-back',
          kind: 'handback',
          sender: child.id,
          receiver: parent.id,
          messageFile: file,
          sentAt: new Date().toISOString(),
        });
        state.close();
        await start();
        await waitFor(
          () =>
            heard(`Wheems: answer from session ${child.id} ("child"):\n\nFound three.`).length ===
            1,
        );
      });

      it('keeps notices through another restart, and delivers them side by side', async () => {
        const a = await newSession('a');
        const c = await newSession('c');
        await settled(a.id);
        await settled(c.id);
        const b = await newSession('b', { WHEEMS_SESSION: a.id });
        const d = await newSession('d', { WHEEMS_SESSION: c.id });
        await settled(b.id);
        await settled(d.id);
        // The work is slow, and so is taking in the news that it was lost.
        behave = (line) =>
          line.includes('slowly') || line.startsWith('Wheems: your message')
            ? 'slow-answer'
            : 'answer';
        await wheems(['session', 'send', b.id, 'Work slowly.'], { WHEEMS_SESSION: a.id });
        await wheems(['session', 'send', d.id, 'Work slowly.'], { WHEEMS_SESSION: c.id });
        await waitFor(async () =>
          (await stored((s) => s.workspace('personal').messages(d.id))).some(
            (m) => m.state === 'sent',
          ),
        );
        const toA = `Wheems: your message to session ${b.id} ("b") was lost`;
        const toC = `Wheems: your message to session ${d.id} ("d") was lost`;
        await restart();
        // Both arrive while the other is still being taken in.
        await waitFor(() => heard(toA).length === 1 && heard(toC).length === 1);
        await restart();
        // Neither had been taken in when the service stopped again, so both come again.
        await waitFor(() => heard(toA).length === 2 && heard(toC).length === 2);
      });

      it("tells the person's messages to no one, and only marks them", async () => {
        const session = await newSession('packaging');
        await settled(session.id);
        behave = (line) => (line.includes('slowly') ? 'slow-answer' : 'answer');
        await wheems(['session', 'send', session.id, 'Work slowly.']);
        await restart();
        const messages = await stored((s) => s.workspace('personal').messages(session.id));
        expect(messages[0]).toMatchObject({ sender: null, state: 'failed' });
        await new Promise((r) => setTimeout(r, 100));
        expect(heard('Wheems: your message')).toEqual([]);
      });
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
