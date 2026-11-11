import { describe, expect, it } from 'vitest';
import { SlackChannel } from '../src/drivers/channel/slack/slack-channel.js';
import { slackManifest } from '../src/drivers/channel/slack/setup.js';
import { channelContract, expectDriverError } from '../src/testing/index.js';
import type { InboundEvent } from '../src/contracts/channel.js';
import { FakeSlack } from './helpers/fake-slack.js';

const fakes = new WeakMap<SlackChannel, FakeSlack>();

channelContract('slack (fake Slack)', {
  create: () => {
    const fake = new FakeSlack();
    const driver = new SlackChannel(fake);
    fakes.set(driver, fake);
    return driver;
  },
  channel: 'C0GENERAL1',
  simulateMessage: async (driver, message) => {
    await fakes.get(driver as SlackChannel)!.message({
      channel: message.channel,
      text: message.text,
      ...(message.threadId !== undefined && { thread_ts: message.threadId }),
    });
  },
});

function setup() {
  const fake = new FakeSlack();
  const driver = new SlackChannel(fake);
  const events: InboundEvent[] = [];
  return { fake, driver, events, start: () => driver.start((e) => void events.push(e)) };
}

describe('slack channel', () => {
  it('ignores its own posts, other bots, edits and joins', async () => {
    const { fake, events, start } = setup();
    await start();
    await fake.emit({ channel: 'C1', user: 'UBOT', text: 'mine', ts: '1.1' });
    await fake.emit({ channel: 'C1', bot_id: 'B9', text: 'a bot', ts: '1.2' });
    await fake.emit({ channel: 'C1', user: 'U1', subtype: 'message_changed', ts: '1.3' });
    await fake.emit({ channel: 'C1', user: 'U1', subtype: 'channel_join', ts: '1.4' });
    await fake.emit({ type: 'reaction_added', channel: 'C1', user: 'U1', ts: '1.5' });
    expect(events).toEqual([]);
    await fake.message({ channel: 'C1', text: 'hello', user: 'U1' });
    expect(events).toHaveLength(1);
  });

  it('marks direct messages and threads', async () => {
    const { fake, events, start } = setup();
    await start();
    const root = await fake.message({ channel: 'D1', text: 'hi', im: true });
    await fake.message({ channel: 'D1', text: 'again', im: true, thread_ts: root });
    expect(events).toEqual([
      expect.objectContaining({
        channel: 'D1',
        messageId: root,
        threadId: null,
        direct: true,
        text: 'hi',
      }),
      expect.objectContaining({ threadId: root, direct: true, text: 'again' }),
    ]);
  });

  it('posts Markdown in a markdown block, in the thread, under the workspace identity', async () => {
    const { fake, driver, start } = setup();
    await start();
    await driver.send({
      channel: 'D1',
      threadId: '9.9',
      text: '**Done.**',
      identity: { name: 'Personal', icon: ':house:' },
    });
    await driver.send({
      channel: 'D1',
      text: 'x',
      identity: { name: 'Work', icon: 'https://example.com/i.png' },
    });
    const posts = fake.calls.filter((c) => c.method === 'chat.postMessage').map((c) => c.args);
    expect(posts[0]).toMatchObject({
      channel: 'D1',
      thread_ts: '9.9',
      text: '**Done.**',
      blocks: [{ type: 'markdown', text: '**Done.**' }],
      username: 'Personal',
      icon_emoji: ':house:',
    });
    expect(posts[1]).toMatchObject({ username: 'Work', icon_url: 'https://example.com/i.png' });
    expect(posts[1]).not.toHaveProperty('thread_ts');
  });

  it('splits long replies, preferring paragraph breaks', async () => {
    const { fake, driver, start } = setup();
    await start();
    const paragraph = `${'word '.repeat(1500).trim()}\n\n`;
    await driver.send({ channel: 'D1', text: paragraph.repeat(4) });
    const posts = fake.calls.filter((c) => c.method === 'chat.postMessage');
    expect(posts.length).toBeGreaterThan(1);
    for (const post of posts) expect((post.args.text as string).length).toBeLessThanOrEqual(11_000);
    // Each break fell between paragraphs, so rejoining them gives the original back.
    expect(posts.map((p) => p.args.text as string).join('\n\n')).toBe(paragraph.repeat(4));
  });

  it('treats adding a reaction twice, or removing one that is not there, as done', async () => {
    const { driver, start } = setup();
    await start();
    const ref = { channel: 'C1', messageId: '1.1' };
    await driver.react(ref, 'eyes', true);
    await driver.react(ref, 'eyes', true);
    await driver.react(ref, 'eyes', false);
    await driver.react(ref, 'eyes', false);
  });

  it('turns Slack errors into driver errors', async () => {
    const { fake, driver, start } = setup();
    await start();
    fake.failures.set('chat.postMessage', 'channel_not_found');
    await expectDriverError(driver.send({ channel: 'CX', text: 'x' }), 'not_found');
    fake.failures.set('chat.postMessage', 'invalid_auth');
    await expectDriverError(driver.send({ channel: 'CX', text: 'x' }), 'unavailable');
  });

  it('fails its health check when Slack refuses the token', async () => {
    const { fake, driver } = setup();
    fake.failures.set('auth.test', 'invalid_auth');
    expect(await driver.check()).toEqual([
      expect.objectContaining({
        status: 'fail',
        message: expect.stringContaining('invalid_auth') as string,
      }),
    ]);
  });

  it('finds channels by name across pages, and passes ids through', async () => {
    const { fake, driver } = setup();
    fake.channels = [
      { id: 'C0AAAAAAA', name: 'alpha' },
      { id: 'C0BBBBBBB', name: 'beta' },
      { id: 'C0CCCCCCC', name: 'personal-chat' },
    ];
    expect(await driver.resolveChannel('#personal-chat')).toBe('C0CCCCCCC');
    expect(await driver.resolveChannel('C0ZZZZZZZ')).toBe('C0ZZZZZZZ');
    expect(await driver.resolveChannel('missing')).toBeNull();
  });

  it('ships a Socket Mode manifest with the scopes the driver uses', () => {
    const manifest = slackManifest();
    expect(manifest).toContain('socket_mode_enabled: true');
    for (const scope of [
      'chat:write',
      'chat:write.customize',
      'im:history',
      'reactions:write',
      'channels:read',
    ]) {
      expect(manifest).toContain(`- ${scope}`);
    }
    for (const event of ['message.im', 'message.channels', 'message.groups'])
      expect(manifest).toContain(`- ${event}`);
  });
});
