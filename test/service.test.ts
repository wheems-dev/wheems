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
import { MemoryChannel, MemoryRuntime, StubEngine } from '../src/testing/index.js';
import { fakeAgent } from './helpers/fake-agent.js';

describe('the service', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let channel: MemoryChannel;
  let service: RunningService | undefined;
  let channelOptions: Record<string, unknown> | undefined;

  /** Runs `wheems reply` (or another command) as an agent would, inside a conversation. */
  const cliReply = async (conversation: string, args: string[], stdin = '', command = 'reply') => {
    let out = '';
    let err = '';
    const previous = process.exitCode;
    process.exitCode = undefined;
    try {
      const code = await run([command, ...args], {
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
    const runtime = new MemoryRuntime({
      'fake-agent': fakeAgent({
        // The agent replies with the real `wheems reply` command, over the control socket.
        reply: async (conversation, text) => {
          const result = await cliReply(conversation, [text]);
          if (result.code !== 0) throw new Error(result.err);
        },
      }),
    });
    const registry = new DriverRegistry()
      .register('runtime', 'herdr', () => runtime)
      .register('engine', 'claude-code', () => new StubEngine({ command: ['fake-agent'] }))
      .register('channel', 'slack', (options) => {
        channelOptions = options;
        return channel;
      });
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
    });
  });

  afterEach(async () => {
    await service?.stop();
    service = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  it('answers on its control socket, privately', async () => {
    const where = paths(home, env);
    expect(await request(where.socket, { op: 'ping' })).toEqual({ ok: true, version: '9.9.9' });
    expect(statSync(where.socket).mode & 0o777).toBe(0o600);
    expect(await request(where.socket, { op: 'nope' } as never)).toMatchObject({ ok: false });
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

  it('lets wheems reply read a long reply from standard input', async () => {
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

  it("saves a note with wheems note to the conversation's workspace inbox", async () => {
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
      'note',
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

  it('builds the search index when it starts, and rebuilds it when asked', async () => {
    const kb = async (args: string[]) => {
      let out = '';
      let err = '';
      const previous = process.exitCode;
      process.exitCode = undefined;
      try {
        const code = await run(['kb', ...args], {
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

  it('refuses wheems reply outside a conversation, or for one it does not know', async () => {
    const outside = await run(['reply', 'hi'], {
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
