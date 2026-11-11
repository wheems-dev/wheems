import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChannelDriver, InboundEvent } from '../contracts/channel.js';
import { replyThread } from '../contracts/channel.js';
import { expectDriverError, expectHealthCheck } from './runtime-contract.js';

export interface ChannelContractOptions {
  /** Builds a fresh driver for each test. */
  create: () => ChannelDriver | Promise<ChannelDriver>;
  /** A channel the driver can send to and receive from. */
  channel: string;
  /**
   * Makes the service deliver a message, as if a person wrote it, so the suite can
   * check it reaches the handler. For a real service this posts as a test user.
   */
  simulateMessage: (
    driver: ChannelDriver,
    message: { channel: string; text: string; threadId?: string },
  ) => Promise<void>;
  /** Makes the service deliver a press of a button on a message the driver sent. */
  simulateButton?: (
    driver: ChannelDriver,
    press: { channel: string; messageId: string; buttonId: string },
  ) => Promise<void>;
  /** How long to wait for an inbound event, in milliseconds. Defaults to 5000. */
  deliveryTimeoutMs?: number;
}

/**
 * The channel contract test suite. Every channel driver must pass it.
 *
 *   channelContract('my-channel', { create, channel: 'C123', simulateMessage });
 */
export function channelContract(label: string, options: ChannelContractOptions): void {
  const timeoutMs = options.deliveryTimeoutMs ?? 5000;

  describe(`channel contract: ${label}`, () => {
    let driver: ChannelDriver;
    let events: InboundEvent[];
    let waiters: (() => void)[];

    const handler = (event: InboundEvent) => {
      events.push(event);
      for (const wake of waiters.splice(0)) wake();
    };

    const nextEvent = async (match: (e: InboundEvent) => boolean): Promise<InboundEvent> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = events.find(match);
        if (found) return found;
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`No matching inbound event within ${timeoutMs} ms`);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, left);
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    };

    beforeEach(async () => {
      events = [];
      waiters = [];
      driver = await options.create();
    });

    afterEach(async () => {
      await driver.stop();
    });

    it('identifies itself as a channel driver and declares its capabilities', () => {
      expect(driver.kind).toBe('channel');
      expect(driver.name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(typeof driver.capabilities.threads).toBe('boolean');
      expect(typeof driver.capabilities.buttons).toBe('boolean');
    });

    it('reports health checks that pass', async () => {
      const checks = await driver.check();
      expect(checks.length).toBeGreaterThan(0);
      for (const check of checks) expectHealthCheck(check);
      expect(checks.filter((c) => c.status === 'fail')).toEqual([]);
    });

    it('delivers inbound messages to the handler', async () => {
      await driver.start(handler);
      const text = `contract ${Math.random().toString(36).slice(2)}`;
      await options.simulateMessage(driver, { channel: options.channel, text });
      const event = await nextEvent((e) => e.type === 'message' && e.text === text);
      expect(event).toMatchObject({ type: 'message', channel: options.channel, threadId: null });
      expect(event.messageId).toBeTruthy();
      expect(event.userId).toBeTruthy();
      expect(event.receivedAt).toBeInstanceOf(Date);
      expect(event.type === 'message' && event.direct).toBe(false);
    });

    it('refuses to start twice', async () => {
      await driver.start(handler);
      await expectDriverError(driver.start(handler), 'invalid');
    });

    it('sends a message and returns its id', async () => {
      await driver.start(handler);
      const sent = await driver.send({ channel: options.channel, text: 'contract: hello' });
      expect(sent.channel).toBe(options.channel);
      expect(sent.messageId).toBeTruthy();
      expect(sent.threadId).toBeNull();
    });

    it('replies in the thread of an inbound message, keeping the conversation together', async (ctx) => {
      if (!driver.capabilities.threads) {
        ctx.skip();
        return;
      }
      await driver.start(handler);
      const text = `thread ${Math.random().toString(36).slice(2)}`;
      await options.simulateMessage(driver, { channel: options.channel, text });
      const first = await nextEvent((e) => e.type === 'message' && e.text === text);

      const thread = replyThread(first);
      const reply = await driver.send({
        channel: options.channel,
        threadId: thread,
        text: 'contract: reply',
      });
      expect(reply.threadId).toBe(thread);

      const followUp = `${text} again`;
      await options.simulateMessage(driver, {
        channel: options.channel,
        text: followUp,
        threadId: thread,
      });
      const second = await nextEvent((e) => e.type === 'message' && e.text === followUp);
      expect(second.threadId).toBe(thread);
    });

    it('sends buttons and delivers presses, or refuses buttons it cannot send', async () => {
      await driver.start(handler);
      const message = {
        channel: options.channel,
        text: 'contract: approve?',
        buttons: [
          { id: 'yes', label: 'Yes', style: 'primary' as const },
          { id: 'no', label: 'No', style: 'danger' as const },
        ],
      };
      if (!driver.capabilities.buttons) {
        await expectDriverError(driver.send(message), 'unsupported');
        return;
      }
      const sent = await driver.send(message);
      if (!options.simulateButton)
        throw new Error('A driver with buttons needs simulateButton for the contract');
      await options.simulateButton(driver, {
        channel: options.channel,
        messageId: sent.messageId,
        buttonId: 'yes',
      });
      const press = await nextEvent((e) => e.type === 'button');
      expect(press).toMatchObject({
        type: 'button',
        channel: options.channel,
        messageId: sent.messageId,
        buttonId: 'yes',
      });
    });

    it('marks messages with reactions, or refuses reactions it cannot add', async () => {
      await driver.start(handler);
      const sent = await driver.send({ channel: options.channel, text: 'contract: react to me' });
      const ref = { channel: options.channel, messageId: sent.messageId };
      if (!driver.capabilities.reactions) {
        await expectDriverError(driver.react(ref, 'eyes', true), 'unsupported');
        return;
      }
      await driver.react(ref, 'eyes', true);
      await driver.react(ref, 'eyes', false);
    });

    it('sends a message with an identity, whether or not it can show it', async () => {
      await driver.start(handler);
      const sent = await driver.send({
        channel: options.channel,
        text: 'contract: from a named bot',
        identity: { name: 'Contract bot', icon: ':robot_face:' },
      });
      expect(sent.messageId).toBeTruthy();
      expect(typeof driver.capabilities.identities).toBe('boolean');
    });

    it('stops delivering after stop, and stop can be called twice', async () => {
      await driver.start(handler);
      await driver.stop();
      await driver.stop();
      await options
        .simulateMessage(driver, { channel: options.channel, text: 'after stop' })
        .catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(events.filter((e) => e.type === 'message' && e.text === 'after stop')).toEqual([]);
    });
  });
}
