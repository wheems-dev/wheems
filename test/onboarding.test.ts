import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { workspaceName } from '../src/service/onboarding.js';
import { runService, type RunningService } from '../src/service/service.js';
import { MemoryChannel, MemoryRuntime, StubEngine } from '../src/testing/index.js';
import { fakeAgent } from './helpers/fake-agent.js';

describe('setting Wheems up by inviting it to a channel', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let channel: MemoryChannel;
  let runtime: MemoryRuntime;
  let service: RunningService | undefined;

  const wheems = async (args: string[], as: Record<string, string> = {}) => {
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
        stdin: () => Promise.resolve(''),
      });
      return { code, out, err };
    } finally {
      process.exitCode = previous;
    }
  };

  const start = async () => {
    const registry = new DriverRegistry()
      .register('runtime', 'herdr', () => runtime)
      .register('engine', 'claude-code', () => new StubEngine({ command: ['fake-agent'] }))
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

  /** What was posted in a channel, oldest first. */
  const posts = (channelId: string) => channel.sent.filter((m) => m.channel === channelId);

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'ob-'));
    env = { ...process.env, WHEEMS_HOME: home, WHEEMS_SECRETS: join(home, 'secrets.json') };
    delete env.WHEEMS_SESSION;
    delete env.WHEEMS_CONVERSATION;
    writeFileSync(
      join(home, 'install.yaml'),
      installYaml().replace('allowed_users: []', 'allowed_users: [UME]'),
    );
    await initWorkspace({ home, id: 'personal' });
    await writeSecret(env.WHEEMS_SECRETS!, 'slack', { bot_token: 'x', app_token: 'y' });
    channel = new MemoryChannel({}, { channels: {} });
    runtime = new MemoryRuntime({
      'fake-agent': fakeAgent({
        reply: async (conversation, text) => {
          const result = await wheems(['reply', text], { WHEEMS_CONVERSATION: conversation });
          if (result.code !== 0) throw new Error(result.err);
        },
      }),
    });
  });

  afterEach(async () => {
    await service?.stop();
    service = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  it('offers a chief when invited, makes one from the name given, and answers at once', async () => {
    await start();
    await channel.join({ id: 'C0MARKET01', name: 'marketing' }, 'UME');
    const [offer] = posts('C0MARKET01');
    expect(offer?.text).toContain("I'm not set up in this channel yet. Reply in this thread");
    expect(offer?.threadId).toBeUndefined();

    await channel.receive({
      channel: 'C0MARKET01',
      threadId: offer!.messageId,
      text: 'Marketing',
      userId: 'UME',
    });
    const done = posts('C0MARKET01').at(-1);
    expect(done).toMatchObject({ threadId: offer!.messageId });
    expect(done?.text).toContain('Done: Marketing is set up, in `workspaces/marketing`');
    expect(done?.identity?.name).toBe('Marketing chief of staff');
    const yaml = readFileSync(join(home, 'workspaces', 'marketing', 'workspace.yaml'), 'utf8');
    expect(yaml).toContain('chat: { connection: slack, channel: "marketing" }');
    expect(existsSync(join(home, 'workspaces', 'marketing', 'agents', 'chief-of-staff.md'))).toBe(
      true,
    );

    // No restart: its chief answers in the channel straight away.
    const before = posts('C0MARKET01').length;
    await channel.receive({ channel: 'C0MARKET01', text: 'hello there', userId: 'UME' });
    await waitFor(() => posts('C0MARKET01').length > before);
    expect(posts('C0MARKET01').at(-1)?.text).toBe('echo: hello there');
    const status = await request(paths(home, env).socket, { op: 'status' });
    expect(status.ok && status.status?.workspaces.map((w) => w.id)).toContain('marketing');
  });

  it('offers once per channel, on the first message when it saw no invitation', async () => {
    await start();
    const first = await channel.receive({
      channel: 'C0SALES001',
      text: 'anyone here?',
      userId: 'UME',
    });
    expect(posts('C0SALES001')).toMatchObject([{ threadId: first }]);
    // Chatter elsewhere in the channel isn't a name, and gets no second offer.
    await channel.receive({
      channel: 'C0SALES001',
      text: 'meeting moved to three, everyone',
      userId: 'UME',
    });
    expect(posts('C0SALES001')).toHaveLength(1);
    // In the offer's thread, it says what it needs.
    await channel.receive({
      channel: 'C0SALES001',
      threadId: first,
      text: 'something that is far too long to be a name',
      userId: 'UME',
    });
    expect(posts('C0SALES001').at(-1)?.text).toContain("That doesn't look like a name");
    await channel.receive({
      channel: 'C0SALES001',
      threadId: first,
      text: 'Personal',
      userId: 'UME',
    });
    expect(posts('C0SALES001').at(-1)?.text).toContain(
      "There's already a workspace called personal",
    );
    // A short name on its own in the channel counts too.
    await channel.receive({ channel: 'C0SALES001', text: 'Sales', userId: 'UME' });
    expect(posts('C0SALES001').at(-1)?.text).toContain('Done: Sales is set up');
  });

  it('ignores anyone not in allowed_users', async () => {
    await start();
    await channel.join({ id: 'C0OTHER001', name: 'other' }, 'USTRANGER');
    await channel.join({ id: 'C0OTHER002', name: 'unknown' }, null);
    await channel.receive({ channel: 'C0OTHER001', text: 'Marketing', userId: 'USTRANGER' });
    expect(channel.sent).toEqual([]);
    expect(existsSync(join(home, 'workspaces', 'marketing'))).toBe(false);
  });

  it("picks up a workspace whose channel it couldn't see once it's invited there", async () => {
    await initWorkspace({ home, id: 'marketing', channel: 'marketing-chat' });
    await start();
    const before = await request(paths(home, env).socket, { op: 'status' });
    expect(
      before.ok && before.status?.workspaces.find((w) => w.id === 'marketing')?.problem,
    ).toContain("the app can't see #marketing-chat");

    // Whoever invites it: the channel is already this workspace's.
    await channel.join({ id: 'C0MKTCHAT1', name: 'marketing-chat' }, null);
    expect(posts('C0MKTCHAT1').at(-1)?.text).toBe(
      "Marketing's chief of staff is here. Start a thread with what you need.",
    );
    await channel.receive({ channel: 'C0MKTCHAT1', text: 'hello again', userId: 'UME' });
    await waitFor(() => posts('C0MKTCHAT1').at(-1)?.text === 'echo: hello again');
    const after = await request(paths(home, env).socket, { op: 'status' });
    expect(after.ok && after.status?.workspaces.find((w) => w.id === 'marketing')).toEqual({
      id: 'marketing',
      chat: 'C0MKTCHAT1 on slack',
    });
  });
});

describe('a workspace name from what someone typed', () => {
  it('takes short names, and makes ids of them', () => {
    expect(workspaceName('Marketing')).toEqual({ name: 'Marketing', id: 'marketing' });
    expect(workspaceName(' "Acme UK". ')).toEqual({ name: 'Acme UK', id: 'acme-uk' });
    expect(workspaceName('R&D')).toEqual({ name: 'R&D', id: 'r-and-d' });
    expect(workspaceName('Café Nord')).toEqual({ name: 'Café Nord', id: 'cafe-nord' });
  });

  it('refuses what is not a name', () => {
    for (const text of [
      '',
      'anyone here?',
      'meeting moved to three, everyone',
      'one two three four five',
      'line\nbreak',
      '<@U123> hi',
    ]) {
      expect(workspaceName(text)).toBeNull();
    }
  });
});

async function waitFor(check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}
