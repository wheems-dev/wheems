import { startWeb } from '../src/web/server.js';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initWorkspace } from '../src/cli/commands/init.js';
import { defaultIo, run } from '../src/cli/program.js';
import { installYaml } from '../src/cli/templates.js';
import { DriverRegistry } from '../src/contracts/registry.js';
import { paths } from '../src/home.js';
import { writeSecret } from '../src/secrets.js';
import { request } from '../src/service/control.js';
import { runService, type RunningService } from '../src/service/service.js';
import { conversationKey, uuidFor } from '../src/service/conversations.js';
import { StateStore, sessionLabels } from '../src/state/store.js';
import { listProposals } from '../src/skills/proposals.js';
import { MemoryChannel, MemoryRuntime, StubEngine } from '../src/testing/index.js';
import { fakeAgent } from './helpers/fake-agent.js';

describe('the service', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let channel: MemoryChannel;
  let service: RunningService | undefined;
  let channelOptions: Record<string, unknown> | undefined;
  let runtime: MemoryRuntime;
  let registry: DriverRegistry;
  const startService = (log: (message: string) => void = () => undefined) =>
    runService({
      home,
      registry,
      node: '/usr/local/bin/node',
      cli: '/opt/wheems/dist/cli/main.js',
      version: '9.9.9',
      env,
      log,
      pollMs: 5,
      startupSeconds: 2,
    });

  /** Runs `wheems chat reply` (or another command) as an agent would, inside a conversation. */
  const cliReply = async (
    conversation: string,
    args: string[],
    stdin = '',
    command = 'chat reply',
  ) => {
    let out = '';
    let err = '';
    const previous = process.exitCode;
    process.exitCode = undefined;
    try {
      const code = await run([...command.split(' '), ...args], {
        ...defaultIo(),
        out: (t) => (out += t),
        err: (t) => (err += t),
        env: { ...env, WHEEMS_CONVERSATION: conversation },
        color: false,
        stdin: () => Promise.resolve(stdin),
      });
      return { code, out, err };
    } finally {
      process.exitCode = previous;
    }
  };

  beforeEach(async () => {
    // Kept short: the control socket's path must fit in about 100 bytes.
    home = mkdtempSync(join(tmpdir(), 'os-'));
    env = { ...process.env, WHEEMS_HOME: home, WHEEMS_SECRETS: join(home, 'secrets.json') };
    writeFileSync(
      join(home, 'install.yaml'),
      installYaml().replace('allowed_users: []', 'allowed_users: [UME]'),
    );
    await initWorkspace({ home, id: 'personal' });
    await writeSecret(env.WHEEMS_SECRETS!, 'slack', {
      bot_token: 'xoxb-test',
      app_token: 'xapp-test',
    });
    channel = new MemoryChannel();
    runtime = new MemoryRuntime({
      'fake-agent': fakeAgent({
        // The agent replies with the real `wheems chat reply` command, over the control socket.
        reply: async (conversation, text) => {
          const result = await cliReply(conversation, [text]);
          if (result.code !== 0) throw new Error(result.err);
        },
      }),
    });
    registry = new DriverRegistry()
      .register('runtime', 'herdr', () => runtime)
      .register('engine', 'claude-code', () => new StubEngine({ command: ['fake-agent'] }))
      .register('channel', 'slack', (options) => {
        channelOptions = options;
        return channel;
      });
    service = await startService();
  });

  afterEach(async () => {
    await service?.stop();
    service = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  it('has the first chief greet the person in direct messages, once when asked to', async () => {
    const socket = paths(home, env).socket;
    const first = await request(socket, { op: 'greet', once: true });
    expect(first).toMatchObject({ ok: true, message: 'in direct messages on slack' });
    expect(channel.sent).toMatchObject([
      { channel: 'D-UME', identity: { name: 'Personal chief of staff' } },
    ]);
    expect(channel.sent[0]?.text).toContain("I'm Personal's chief of staff, and I'm set up.");
    // Inviting the app to a channel sets up a chief there, and the hello says so.
    expect(channel.sent[0]?.text).toContain('invite me to any channel');
    expect(await request(socket, { op: 'greet', once: true })).toMatchObject({
      ok: true,
      skipped: true,
    });
    expect(channel.sent).toHaveLength(1);
    // Asked without once, it greets again.
    expect(await request(socket, { op: 'greet' })).toMatchObject({ ok: true });
    expect(channel.sent).toHaveLength(2);
  });

  it('restarts only the copy launchd runs, and says so otherwise', async () => {
    // This test's process isn't the launchd job, so the real guard refuses, and nothing restarts.
    const refused = await request(paths(home, env).socket, { op: 'restart' });
    expect(refused).toMatchObject({ ok: false });
    expect(refused.ok ? '' : refused.error).toContain("can't restart itself");
    await service?.stop();
    let asked = 0;
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
      restart: () => {
        asked += 1;
        return Promise.resolve(null);
      },
    });
    expect(await request(paths(home, env).socket, { op: 'restart' })).toMatchObject({ ok: true });
    expect(asked).toBe(1);
  });

  it('keeps a session store: imports conversations.json, writes the chief, and matches Herdr', async () => {
    await service?.stop();
    const where = paths(home, env);
    const key = conversationKey('personal', 'slack', 'D1', '1700000000.000100');
    writeFileSync(
      where.conversations,
      JSON.stringify({
        [key]: {
          workspace: 'personal',
          connection: 'slack',
          channel: 'D1',
          thread: '1700000000.000100',
          sessionId: uuidFor(key),
          sessionName: 'personal-gone',
          createdAt: '2026-11-13T10:00:00.000Z',
          lastActiveAt: '2026-11-13T10:00:00.000Z',
          lastAnswerId: 'answer-1',
        },
      }),
    );
    await runtime.start({
      name: 'stray',
      command: ['fake-agent'],
      labels: sessionLabels('not-in-the-store', 'personal'),
    });
    const logs: string[] = [];
    service = await startService((m) => logs.push(m));

    expect(existsSync(where.conversations)).toBe(false);
    expect(existsSync(`${where.conversations}.imported`)).toBe(true);
    expect(logs.join('\n')).toContain('Imported 1 conversation into the session store');
    expect(logs.join('\n')).toContain(
      "Herdr session stray has a Wheems label and isn't in the session store; leaving it alone",
    );
    const state = await StateStore.open(where.store, { readOnly: true });
    try {
      const personal = state.workspace('personal');
      expect(personal.agents()).toEqual([
        {
          id: 'personal/chief-of-staff',
          workspace: 'personal',
          project: null,
          name: 'chief-of-staff',
          role: 'chief',
          engine: 'claude-code',
        },
      ]);
      // Its Herdr session has gone, so it's stopped, and resumes when next needed.
      expect(personal.session(uuidFor(key))).toMatchObject({
        kind: 'thread',
        agent: 'personal/chief-of-staff',
        state: 'stopped',
      });
      expect(state.conversation(key)?.lastAnswerId).toBe('answer-1');
    } finally {
      state.close();
    }
    expect((await runtime.list()).map((s) => s.name)).toEqual(['stray']);
  });

  it("refuses to start while conversations.json can't be imported, then takes its threads up again once it's fixed", async () => {
    await service?.stop();
    service = undefined;
    const where = paths(home, env);
    const key = conversationKey('personal', 'slack', 'D1', '1700000000.000200');
    const conversation = {
      workspace: 'personal',
      connection: 'slack',
      channel: 'D1',
      thread: '1700000000.000200',
      sessionId: uuidFor(key),
      sessionName: 'personal-still-on',
      createdAt: '2026-11-13T10:00:00.000Z',
      lastActiveAt: '2026-11-13T10:00:00.000Z',
      lastAnswerId: 'answer-1',
    };
    // Its session is still running from before the upgrade.
    await runtime.start({
      name: 'personal-still-on',
      command: ['fake-agent'],
      labels: { wheems: 'conversation', workspace: 'personal' },
    });
    writeFileSync(where.conversations, `{"${key}": {"workspace": 1}}`);
    await expect(startService()).rejects.toThrow(/Could not import .*conversations\.json/);
    expect(existsSync(where.conversations)).toBe(true);
    // Nothing answers in the meantime, so no thread can start afresh and replace its record.
    await expect(request(where.socket, { op: 'ping' }, 500)).rejects.toThrow();

    writeFileSync(where.conversations, JSON.stringify({ [key]: conversation }));
    service = await startService();
    const reply = await cliReply(key, ['still here']);
    expect(reply).toMatchObject({ code: 0 });
    expect(channel.sent.map((m) => m.text)).toEqual(['still here']);
  });

  it('answers on its control socket, privately', async () => {
    const where = paths(home, env);
    expect(await request(where.socket, { op: 'ping' })).toEqual({ ok: true, version: '9.9.9' });
    expect(statSync(where.socket).mode & 0o777).toBe(0o600);
    expect(await request(where.socket, { op: 'nope' } as never)).toMatchObject({ ok: false });
  });

  it('says where each workspace chats, for wheems status', async () => {
    const answer = await request(paths(home, env).socket, { op: 'status' });
    expect(answer).toMatchObject({
      ok: true,
      status: {
        version: '9.9.9',
        pid: process.pid,
        home,
        connections: ['slack'],
        workspaces: [{ id: 'personal', chat: 'direct messages on slack' }],
      },
    });
    const status = await cliReply('', ['--home', home], '', 'status');
    expect(status.code).toBe(0);
    expect(status.out).toMatch(/^✓ Running: Wheems 9\.9\.9, pid \d+, up under a minute\n/);
    expect(status.out).toContain('✓ Connected to slack\n✓ personal: direct messages on slack\n');
  });

  it('serves the web app before it answers, so status never catches it starting', async () => {
    await service?.stop();
    service = undefined;
    const where = paths(home, env);
    const starting = runService({
      home,
      registry,
      node: '/usr/local/bin/node',
      cli: '/opt/wheems/dist/cli/main.js',
      version: '9.9.9',
      env,
      log: () => undefined,
      pollMs: 5,
      startupSeconds: 2,
      // A web app slow to start, as on a busy machine.
      startWeb: async (options) => {
        await new Promise((done) => setTimeout(done, 300));
        return startWeb(options);
      },
    });
    let answered: Awaited<ReturnType<typeof request>> | undefined;
    while (answered === undefined) {
      answered = await request(where.socket, { op: 'status' }, 200).catch(() => undefined);
      if (answered === undefined) await new Promise((done) => setTimeout(done, 10));
    }
    service = await starting;
    expect(answered.ok && answered.status?.web?.port).toBeGreaterThan(0);
    const status = await cliReply('', ['--home', home], '', 'status');
    expect(status.out).toMatch(/✓ Web app: http:\/\/127\.0\.0\.1:\d+\/#token=[\w-]+\n/);
  });

  it('gives the channel driver its secrets, and agents an wheems command pinned to its Node.js', () => {
    expect(channelOptions).toEqual({ bot_token: 'xoxb-test', app_token: 'xapp-test' });
    const wrapper = readFileSync(join(paths(home, env).bin, 'wheems'), 'utf8');
    expect(wrapper).toBe(
      "#!/bin/sh\nexec '/usr/local/bin/node' '/opt/wheems/dist/cli/main.js' \"$@\"\n",
    );
  });

  it('carries a chat from Slack to the agent and its reply back, across replies in the thread', async () => {
    const first = await channel.receive({
      channel: 'D1',
      text: 'hello',
      userId: 'UME',
      direct: true,
    });
    await waitFor(() => channel.sent.length === 1);
    await channel.receive({
      channel: 'D1',
      text: 'and again',
      userId: 'UME',
      direct: true,
      threadId: first,
    });
    await waitFor(() => channel.sent.length === 2);
    expect(channel.sent.map((m) => [m.threadId, m.text])).toEqual([
      [first, 'echo: hello'],
      [first, 'echo: and again'],
    ]);
  });

  it('lets wheems chat reply read a long reply from standard input', async () => {
    const first = await channel.receive({
      channel: 'D1',
      text: 'hello',
      userId: 'UME',
      direct: true,
    });
    await waitFor(() => channel.sent.length === 1);
    const result = await cliReply(`personal:slack:D1:${first}`, ['-'], '# Report\n\nAll done.\n');
    expect(result).toMatchObject({ code: 0, out: 'Sent.\n' });
    expect(channel.sent.at(-1)?.text).toBe('# Report\n\nAll done.');
  });

  it("saves a note with wheems knowledgebase note to the conversation's workspace inbox", async () => {
    const first = await channel.receive({
      channel: 'D1',
      text: 'hello',
      userId: 'UME',
      direct: true,
    });
    await waitFor(() => channel.sent.length === 1);
    const result = await cliReply(
      `personal:slack:D1:${first}`,
      ['-'],
      '# Said hello\n\nNothing more.\n',
      'knowledgebase note',
    );
    expect(result.code).toBe(0);
    const saved = /^Saved to (workspaces\/personal\/knowledge\/inbox\/.+-said-hello\.md)\.\n$/.exec(
      result.out,
    );
    expect(saved).not.toBeNull();
    expect(readFileSync(join(home, saved![1]!), 'utf8')).toContain(
      '# Said hello\n\nNothing more.\n',
    );
    // Notes are never posted to the thread.
    expect(channel.sent).toHaveLength(1);
  });

  it('lists chat threads and restarts one with wheems session restart, and refuses an unasked handover', async () => {
    const first = await channel.receive({
      channel: 'D1',
      text: 'plan the trip',
      userId: 'UME',
      direct: true,
    });
    await waitFor(() => channel.sent.length === 1);
    const key = `personal:slack:D1:${first}`;
    const listed = await request(paths(home, env).socket, {
      op: 'conversations',
      caller: { workspace: 'personal' },
    });
    expect(listed.ok && listed.conversations?.map((c) => c.ask)).toEqual(['plan the trip']);
    const session = listed.ok ? (listed.conversations?.[0]?.session ?? '') : '';

    const unasked = await cliReply(key, ['-'], '# Handover', 'session handover');
    expect(unasked.code).toBe(1);
    expect(unasked.err).toContain("Wheems hasn't asked this conversation for a handover");

    const fresh = await cliReply(
      '',
      [session, '--fresh', '--workspace', 'personal'],
      '',
      'session restart',
    );
    expect(fresh).toMatchObject({
      code: 0,
      out: "Its next message starts a new session, with only the thread's ask.\n",
    });
    // An agent can't restart threads, its own or any other.
    const byAgent = await cliReply(
      key,
      [session, '--workspace', 'personal'],
      '',
      'session restart',
    );
    expect(byAgent.code).toBe(1);
    expect(byAgent.err).toContain('Only you can restart chat threads');
    const wrong = await cliReply('', ['nope', '--workspace', 'personal'], '', 'session restart');
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain("There's no chat thread with session nope in personal.");
  });

  it('sets threads up and restarts in one request, holding them until it does', async () => {
    const first = await channel.receive({
      channel: 'D1',
      text: 'plan the trip',
      userId: 'UME',
      direct: true,
    });
    await waitFor(() => channel.sent.length === 1);
    const socket = paths(home, env).socket;
    const listed = await request(socket, {
      op: 'conversations',
      caller: { workspace: 'personal' },
    });
    const session = listed.ok ? (listed.conversations?.[0]?.session ?? '') : '';

    // This test's service isn't launchd's, so the restart is refused: the thread is let go, and
    // a message starts its new session here.
    const refused = await request(socket, {
      op: 'conversations-restart',
      caller: { workspace: 'personal' },
      choices: [{ session, choice: 'fresh' }],
      restart: true,
    });
    expect(refused).toMatchObject({ ok: true, restarting: false });
    expect(refused.ok ? refused.message : '').toContain("can't restart itself");
    await channel.receive({
      channel: 'D1',
      text: 'go on',
      userId: 'UME',
      direct: true,
      threadId: first,
    });
    await waitFor(() => channel.sent.some((m) => m.text.includes('starts afresh')));
    // Its answer, before the service stops.
    await waitFor(() =>
      channel.sent.some((m) => m.text.includes('echo:') && m.text.includes('go on')),
    );

    // A service that can restart holds every thread set to start afresh until it does.
    await service?.stop();
    let restarts = 0;
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
      restart: () => {
        restarts += 1;
        return Promise.resolve(null);
      },
    });
    const restarting = await request(socket, {
      op: 'conversations-restart',
      caller: { workspace: 'personal' },
      choices: [{ session, choice: 'fresh' }],
      restart: true,
    });
    expect(restarting).toMatchObject({ ok: true, restarting: true });
    expect(restarts).toBe(1);
    const before = channel.sent.length;
    await channel.receive({
      channel: 'D1',
      text: 'one more',
      userId: 'UME',
      direct: true,
      threadId: first,
    });
    await waitFor(() => channel.sent.length > before);
    expect(channel.sent.at(-1)?.text).toContain('restarting with new settings. Send that again');
  });

  it('takes a skill proposal from an agent, for the person to review', async () => {
    const first = await channel.receive({
      channel: 'D1',
      text: 'hello',
      userId: 'UME',
      direct: true,
    });
    await waitFor(() => channel.sent.length === 1);
    const skill =
      '---\ndescription: Writes the weekly report. Use when asked for one.\n---\n\nRead the git log for the week.\n';
    const result = await cliReply(
      `personal:slack:D1:${first}`,
      // As the built-in instructions write it.
      ['propose', 'weekly-report', '-'],
      skill,
      'skill',
    );
    expect(result).toMatchObject({
      code: 0,
      out: 'Proposed the new skill weekly-report. It waits for the person to review it.\n',
    });
    const [waiting] = await listProposals(paths(home, env).state);
    expect(waiting?.proposal).toMatchObject({
      name: 'weekly-report',
      workspace: 'personal',
      agent: 'chief-of-staff',
      conversation: `personal:slack:D1:${first}`,
    });
    expect(waiting?.text).toContain('name: weekly-report');
    const refused = await cliReply(
      `personal:slack:D1:${first}`,
      ['propose', 'Bad'],
      skill,
      'skill',
    );
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(`"Bad" isn't a skill name`);
  });

  it('builds the search index when it starts, and rebuilds it when asked', async () => {
    const kb = async (args: string[]) => {
      let out = '';
      let err = '';
      const previous = process.exitCode;
      process.exitCode = undefined;
      try {
        const code = await run(['knowledgebase', ...args], {
          ...defaultIo(),
          out: (t) => (out += t),
          err: (t) => (err += t),
          env: { ...env, WHEEMS_WORKSPACE: 'personal' },
          color: false,
        });
        return { code, out, err };
      } finally {
        process.exitCode = previous;
      }
    };
    const current = join(paths(home, env).index, 'personal', 'current.json');
    await waitFor(() => existsSync(current));
    expect(await kb(['search', 'Halcyon'])).toMatchObject({
      code: 0,
      out: 'Nothing in the knowledge base matches.\n',
    });

    const pages = join(home, 'workspaces', 'personal', 'knowledge', 'pages');
    writeFileSync(
      join(pages, 'boat-name.md'),
      '---\ntitle: Boat name\n---\n\nThe boat is Halcyon.\n',
    );
    // The service owns the index, so the command asks it to rebuild.
    expect(await kb(['reindex'])).toMatchObject({
      code: 0,
      out: 'Rebuilding in the service…\npersonal: indexed 1 file, keyword search only\n',
    });
    const found = await kb(['search', 'what', 'is', 'Halcyon']);
    expect(found.code).toBe(0);
    expect(found.out).toContain(
      `Boat name\n  ${join(pages, 'boat-name.md')} (page)\n  The boat is Halcyon.`,
    );
    expect(await kb(['search', 'x', '--workspace', 'nope'])).toMatchObject({ code: 1 });
  });

  it('refuses wheems chat reply outside a conversation, or for one it does not know', async () => {
    const outside = await run(['chat', 'reply', 'hi'], {
      ...defaultIo(),
      out: () => undefined,
      err: () => undefined,
      env,
      color: false,
    });
    expect(outside).toBe(1);
    const unknown = await cliReply('personal:slack:D1:0.0', ['hi']);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toMatch(/No conversation/);
  });
});

describe('the service when a channel cannot connect', () => {
  it('stops what it started and does not answer on its socket', async () => {
    const home = mkdtempSync(join(tmpdir(), 'os-'));
    const env = { ...process.env, WHEEMS_HOME: home, WHEEMS_SECRETS: join(home, 'secrets.json') };
    try {
      writeFileSync(join(home, 'install.yaml'), installYaml());
      await initWorkspace({ home, id: 'personal' });
      const channel = new MemoryChannel();
      let stopped = 0;
      channel.start = () => Promise.reject(new Error('Slack refused the app-level token'));
      const stop = channel.stop.bind(channel);
      channel.stop = () => {
        stopped++;
        return stop();
      };
      const registry = new DriverRegistry()
        .register('runtime', 'herdr', () => new MemoryRuntime())
        .register('engine', 'claude-code', () => new StubEngine())
        .register('channel', 'slack', () => channel);
      await expect(
        runService({
          home,
          registry,
          node: 'node',
          cli: 'x.js',
          version: '0',
          env,
          log: () => undefined,
        }),
      ).rejects.toThrow(/app-level token/);
      await expect(request(paths(home, env).socket, { op: 'ping' }, 1000)).rejects.toThrow(
        /not running/,
      );
      expect(stopped).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('the service without a valid install', () => {
  it('refuses to start, saying what is wrong', async () => {
    const home = mkdtempSync(join(tmpdir(), 'os-'));
    writeFileSync(join(home, 'install.yaml'), 'machines: { a: {} }\n');
    await expect(
      runService({
        home,
        registry: new DriverRegistry(),
        node: 'node',
        cli: 'x.js',
        version: '0',
        log: () => undefined,
      }),
    ).rejects.toThrow(/config problems/);
    rmSync(home, { recursive: true, force: true });
  });
});

async function waitFor(condition: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}
