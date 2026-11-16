import { describe, expect, it } from 'vitest';
import { SlackChannel } from '../src/drivers/channel/slack/slack-channel.js';
import { slackManifest } from '../src/drivers/channel/slack/setup.js';
import { noAnswer } from '../src/drivers/channel/slack/transport.js';
import { tokenProblem } from '../src/drivers/channel/slack/connect.js';
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

  it('opens direct messages with a person', async () => {
    const { fake, driver } = setup();
    expect(await driver.openDirect('UME')).toBe('DUME');
    expect(fake.calls.at(-1)).toEqual({ method: 'conversations.open', args: { users: 'UME' } });
    fake.failures.set('conversations.open', 'user_not_found');
    await expectDriverError(driver.openDirect('UNOBODY'), 'failed');
  });

  it('reports the app being added to a channel, from either event, and no one else joining', async () => {
    const { fake, driver, events, start } = setup();
    await start();
    expect(driver.capabilities.joins).toBe(true);
    await fake.emit({ type: 'member_joined_channel', channel: 'C2', user: 'U1', inviter: 'U9' });
    expect(events).toEqual([]);
    await fake.emit({ type: 'member_joined_channel', channel: 'C2', user: 'UBOT', inviter: 'U9' });
    await fake.emit({ channel: 'C3', user: 'UBOT', subtype: 'channel_join', ts: '1.6' });
    expect(events).toMatchObject([
      { type: 'joined', channel: 'C2', userId: 'U9' },
      { type: 'joined', channel: 'C3', userId: null },
    ]);
  });

  it('drops a mention of the app that starts a message', async () => {
    const { fake, events, start } = setup();
    await start();
    await fake.message({ channel: 'C1', text: '<@UBOT> Marketing' });
    await fake.message({ channel: 'C1', text: 'ask <@UBOT> about it' });
    expect(events.map((e) => (e.type === 'message' ? e.text : ''))).toEqual([
      'Marketing',
      'ask <@UBOT> about it',
    ]);
  });

  it('names a channel from its id, and remembers it', async () => {
    const { fake, driver } = setup();
    fake.channels.push({ id: 'C0MARKET01', name: 'marketing-chat' });
    expect(await driver.channelName('C0MARKET01')).toBe('marketing-chat');
    expect(await driver.channelName('C0NOWHERE1')).toBeNull();
    const lists = fake.calls.filter((c) => c.method === 'conversations.list').length;
    expect(await driver.resolveChannel('marketing-chat')).toBe('C0MARKET01');
    expect(fake.calls.filter((c) => c.method === 'conversations.list')).toHaveLength(lists);
  });

  it('passes on messages with files attached, with the files named', async () => {
    const { fake, events, start } = setup();
    await start();
    await fake.emit({
      channel: 'D1',
      channel_type: 'im',
      user: 'U1',
      subtype: 'file_share',
      text: 'what does this say?',
      ts: '2.1',
      files: [{ name: 'invoice.pdf' }, { title: 'Screenshot' }],
    });
    expect(events).toMatchObject([
      {
        type: 'message',
        text: 'what does this say?',
        files: [{ name: 'invoice.pdf' }, { name: 'Screenshot' }],
      },
    ]);
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

  it("says Slack couldn't be reached, rather than blaming the token, when this Mac is offline", async () => {
    const { fake, driver } = setup();
    fake.offline = true;
    const [check] = await driver.check();
    expect(check).toEqual(
      expect.objectContaining({
        status: 'fail',
        message: "Couldn't reach Slack (fetch failed, ENOTFOUND)",
        hint: expect.stringContaining('internet connection') as string,
      }),
    );
    // A check gives up quickly rather than retrying for half an hour.
    expect(fake.calls[0]).toEqual(expect.objectContaining({ options: { quick: true } }));
  });

  it('tells network failures and rate limits apart from what Slack itself said', () => {
    expect(
      noAnswer({ code: 'slack_webapi_request_error', original: new Error('fetch failed') })
        ?.message,
    ).toBe("Couldn't reach Slack (fetch failed)");
    expect(
      noAnswer({
        code: 'slack_webapi_request_error',
        original: Object.assign(new Error('fetch failed'), { cause: { code: 'ETIMEDOUT' } }),
      })?.message,
    ).toBe("Couldn't reach Slack (fetch failed, ETIMEDOUT)");
    expect(noAnswer({ code: 'slack_webapi_http_error', statusCode: 503 })?.message).toBe(
      "Couldn't reach Slack (HTTP 503)",
    );
    expect(noAnswer({ code: 'slack_webapi_rate_limited_error', retryAfter: 120 })).toEqual({
      message: 'Slack is limiting requests for 120 seconds',
      hint: expect.stringContaining('try again') as string,
    });
    expect(
      noAnswer({ code: 'slack_webapi_platform_error', data: { ok: false, error: 'invalid_auth' } }),
    ).toBeNull();
    expect(noAnswer(new Error('boom'))).toBeNull();
  });

  it('passes quick on to Slack for lookups made by a check', async () => {
    const { fake, driver } = setup();
    fake.channels = [{ id: 'C0AAAAAAA', name: 'alpha' }];
    await driver.resolveChannel('alpha', { quick: true });
    await driver.isMember('C0AAAAAAA', { quick: true });
    await driver.listChannels({ quick: true });
    await driver.isMember('C0AAAAAAA');
    const quick = fake.calls.map((c) => c.options?.quick === true);
    expect(quick.slice(0, -1).every(Boolean)).toBe(true);
    expect(quick.at(-1)).toBe(false);
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
    // Slack lists public channels the app isn't in; membership tells them apart.
    fake.channels.push({ id: 'C0NOTIN01', name: 'not-in', member: false });
    expect(await driver.isMember('C0CCCCCCC')).toBe(true);
    expect(await driver.isMember('C0NOTIN01')).toBe(false);
    expect(await driver.isMember('C0GONE001')).toBeNull();
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
    for (const event of [
      'message.im',
      'message.channels',
      'message.groups',
      'member_joined_channel',
    ])
      expect(manifest).toContain(`- ${event}`);
  });
});

describe('checking a pasted Slack token', () => {
  // Shaped like real tokens, but made up, and put together here so that nothing in this file
  // looks like a token to secret scanners.
  const bot = ['xoxb', '1111111111', '2222222222222', 'abcdefghijklmnopqrstuvwx'].join('-');
  const app = ['xapp', '1', 'A0123456789', '1234567890123', 'f'.repeat(64)].join('-');

  it('accepts the right token, with spaces around it', () => {
    expect(tokenProblem('bot', bot)).toBeUndefined();
    expect(tokenProblem('bot', `  ${bot}\n`)).toBeUndefined();
    expect(tokenProblem('app', app)).toBeUndefined();
  });

  it('says when the other token was pasted, and where the right one is', () => {
    expect(tokenProblem('bot', app)).toBe(
      "That starts with xapp-, so it's the app-level token. Under OAuth & Permissions, copy the Bot User OAuth Token (xoxb-…).",
    );
    expect(tokenProblem('app', bot)).toBe(
      "That starts with xoxb-, so it's the bot token. Under Basic Information → App-Level Tokens, copy the token (xapp-…).",
    );
  });

  it('names other Slack tokens by their prefix', () => {
    expect(tokenProblem('bot', 'xoxp-123-456-789-abc')).toBe(
      "That starts with xoxp-, so it's a user token, not the bot token. Under OAuth & Permissions, copy the Bot User OAuth Token (xoxb-…).",
    );
  });

  it('spots two pastes run together, or something in front of the token', () => {
    expect(tokenProblem('bot', bot + bot)).toBe(
      'That looks like more than one paste. Clear the field with Backspace, then paste it once.',
    );
    expect(tokenProblem('bot', `oops${bot}`)).toBe(
      "There's something before the xoxb- at the start. Clear the field with Backspace, then paste it once.",
    );
    expect(tokenProblem('bot', `${bot.slice(0, 20)} ${bot.slice(20)}`)).toBe(
      "There's a space or line break in it. Clear the field with Backspace, then paste it once.",
    );
  });

  it('asks for the token when nothing was pasted', () => {
    expect(tokenProblem('app', '  ')).toBe(
      'Paste the app-level token. Under Basic Information → App-Level Tokens, copy the token (xapp-…).',
    );
  });

  it('never repeats any of what was pasted beyond a standard prefix', () => {
    const pasted = ['secret-client-value-123', app, bot + bot, `oops${bot}`, 'xoxp-999-888'];
    for (const value of pasted) {
      for (const kind of ['bot', 'app'] as const) {
        const said = tokenProblem(kind, value) ?? '';
        expect(said).not.toContain('1111111111');
        expect(said).not.toContain('A0123456789');
        expect(said).not.toContain('secret');
        expect(said).not.toContain('999');
        expect(said).not.toContain('oops');
      }
    }
  });
});
