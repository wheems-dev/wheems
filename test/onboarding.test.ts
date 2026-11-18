import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
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
    const code = await run(args, {
      ...defaultIo(),
      out: (t) => (out += t),
      err: (t) => (err += t),
      env: { ...env, ...as },
      color: false,
      stdin: () => Promise.resolve(''),
    });
    return { code, out, err };
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
          const result = await wheems(['chat', 'reply', text], {
            WHEEMS_CONVERSATION: conversation,
          });
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
    expect(existsSync(join(home, 'workspaces', 'marketing', 'WHEEMS.md'))).toBe(true);
    expect(existsSync(join(home, 'workspaces', 'marketing', 'GOAL.md'))).toBe(true);

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

  it('lets only one of two channels take a name at once', async () => {
    await start();
    await channel.join({ id: 'C0ONE00001', name: 'one' }, 'UME');
    await channel.join({ id: 'C0TWO00001', name: 'two' }, 'UME');
    const [one] = posts('C0ONE00001');
    const [two] = posts('C0TWO00001');
    await Promise.all([
      channel.receive({
        channel: 'C0ONE00001',
        threadId: one!.messageId,
        text: 'Marketing',
        userId: 'UME',
      }),
      channel.receive({
        channel: 'C0TWO00001',
        threadId: two!.messageId,
        text: 'Marketing',
        userId: 'UME',
      }),
    ]);
    const answers = [posts('C0ONE00001').at(-1)?.text, posts('C0TWO00001').at(-1)?.text];
    expect(answers.filter((t) => t?.startsWith('Done: Marketing is set up'))).toHaveLength(1);
    expect(
      answers.filter((t) => t?.includes("There's already a workspace called marketing")),
    ).toHaveLength(1);
  });

  it('never lets two inits make one workspace', async () => {
    const results = await Promise.allSettled([
      initWorkspace({ home, id: 'twice', channel: 'a' }),
      initWorkspace({ home, id: 'twice', channel: 'b' }),
    ]);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('asks again after a lookup failed while it was invited', async () => {
    await initWorkspace({ home, id: 'marketing', channel: 'marketing-chat' });
    await start();
    const channelName = channel.channelName!;
    const resolveChannel = channel.resolveChannel!;
    channel.channelName = () => Promise.reject(new Error('Slack is down'));
    channel.resolveChannel = () => Promise.reject(new Error('Slack is down'));
    await channel.join({ id: 'C0MKTCHAT1', name: 'marketing-chat' }, null);
    expect(posts('C0MKTCHAT1')).toEqual([]);
    channel.channelName = channelName;
    channel.resolveChannel = resolveChannel;
    await channel.receive({ channel: 'C0MKTCHAT1', text: 'hello again', userId: 'UME' });
    await waitFor(() => posts('C0MKTCHAT1').at(-1)?.text === 'echo: hello again');
  });

  it('never binds a workspace that was archived while it waited for its channel', async () => {
    await initWorkspace({ home, id: 'marketing', channel: 'marketing-chat' });
    await start();
    const socket = paths(home, env).socket;
    expect(
      await request(socket, { op: 'workspace-retire', id: 'marketing', forget: false }),
    ).toMatchObject({ ok: true });
    await channel.join({ id: 'C0MKTCHAT1', name: 'marketing-chat' }, null);
    expect(posts('C0MKTCHAT1')).toEqual([]);
  });

  it('binds no archived workspace, and loses no other, when it was archived during a lookup', async () => {
    await initWorkspace({ home, id: 'marketing', channel: 'marketing-chat' });
    await initWorkspace({ home, id: 'sales', channel: 'sales-chat' });
    await start();
    // The channel lookup is held open while marketing is archived.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const channelName = channel.channelName!;
    channel.channelName = async (id) => {
      await held;
      return channelName(id);
    };
    const joining = channel.join({ id: 'C0MKTCHAT1', name: 'marketing-chat' }, null);
    await new Promise((r) => setTimeout(r, 50));
    const socket = paths(home, env).socket;
    expect(
      await request(socket, { op: 'workspace-retire', id: 'marketing', forget: false }),
    ).toMatchObject({ ok: true });
    release();
    await joining;
    channel.channelName = channelName;
    expect(posts('C0MKTCHAT1')).toEqual([]);
    // Sales still waits for its channel, and is picked up when the app is invited there.
    await channel.join({ id: 'C0SALESCH1', name: 'sales-chat' }, null);
    expect(posts('C0SALESCH1').at(-1)?.text).toBe(
      "Sales's chief of staff is here. Start a thread with what you need.",
    );
  });

  it('serves a workspace made afresh under the name of one removed earlier', async () => {
    await start();
    const socket = paths(home, env).socket;
    expect(
      await request(socket, { op: 'workspace-retire', id: 'personal', forget: true }),
    ).toMatchObject({ ok: true });
    // As wheems workspace remove does, once the service has let it go.
    rmSync(join(home, 'workspaces', 'personal'), { recursive: true, force: true });
    await channel.join({ id: 'C0PERSON01', name: 'personal-chat' }, 'UME');
    const [offer] = posts('C0PERSON01');
    await channel.receive({
      channel: 'C0PERSON01',
      threadId: offer!.messageId,
      text: 'Personal',
      userId: 'UME',
    });
    expect(posts('C0PERSON01').at(-1)?.text).toContain('Done: Personal is set up');
    await channel.receive({ channel: 'C0PERSON01', text: 'hello again', userId: 'UME' });
    await waitFor(() => posts('C0PERSON01').at(-1)?.text === 'echo: hello again');
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
