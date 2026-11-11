import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

  /** Runs `opinr reply` as an agent would, inside a conversation. */
  const cliReply = async (conversation: string, args: string[], stdin = '') => {
    let out = '';
    let err = '';
    const previous = process.exitCode;
    process.exitCode = undefined;
    try {
      const code = await run(['reply', ...args], {
        ...defaultIo(),
        out: (t) => (out += t),
        err: (t) => (err += t),
        env: { ...env, OPINR_CONVERSATION: conversation },
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
    env = { ...process.env, OPINR_HOME: home, OPINR_SECRETS: join(home, 'secrets.json') };
    writeFileSync(
      join(home, 'install.yaml'),
      installYaml().replace('allowed_users: []', 'allowed_users: [UME]'),
    );
    await initWorkspace({ home, id: 'personal' });
    await writeSecret(env.OPINR_SECRETS!, 'slack', {
      bot_token: 'xoxb-test',
      app_token: 'xapp-test',
    });
    channel = new MemoryChannel();
    const runtime = new MemoryRuntime({
      'fake-agent': fakeAgent({
        // The agent replies with the real `opinr reply` command, over the control socket.
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
      cli: '/opt/opinr/dist/cli/main.js',
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

  it('gives the channel driver its secrets, and agents an opinr command pinned to its Node.js', () => {
    expect(channelOptions).toEqual({ bot_token: 'xoxb-test', app_token: 'xapp-test' });
    const wrapper = readFileSync(join(paths(home, env).bin, 'opinr'), 'utf8');
    expect(wrapper).toBe(
      "#!/bin/sh\nexec '/usr/local/bin/node' '/opt/opinr/dist/cli/main.js' \"$@\"\n",
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

  it('lets opinr reply read a long reply from standard input', async () => {
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

  it('refuses opinr reply outside a conversation, or for one it does not know', async () => {
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
    const env = { ...process.env, OPINR_HOME: home, OPINR_SECRETS: join(home, 'secrets.json') };
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
