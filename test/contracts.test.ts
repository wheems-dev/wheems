import { describe, expect, it } from 'bun:test';
import { DriverError, isDriverError } from '../src/contracts/driver.js';
import { DriverRegistry } from '../src/contracts/registry.js';
import { replyThread } from '../src/contracts/channel.js';
import { createDriverRegistry } from '../src/drivers/index.js';
import { HerdrRuntime } from '../src/drivers/runtime/herdr/herdr-runtime.js';
import {
  channelContract,
  engineContract,
  MemoryChannel,
  MemoryRuntime,
  runtimeContract,
  StubEngine,
} from '../src/testing/index.js';

// The contract suites run against the in-memory reference drivers, which proves
// the suites themselves and the drivers later code will be tested with.
runtimeContract('memory', {
  create: () => new MemoryRuntime(),
  echoCommand: ['echo-line'],
  envCommand: ['echo-env'],
  longCommand: ['sleep', '600'],
});

engineContract('stub', {
  create: () => new StubEngine(),
  model: 'test-model-1',
  accountDriver: 'test',
});

channelContract('memory', {
  create: () => new MemoryChannel(),
  channel: 'general',
  simulateMessage: async (driver, message) => {
    await (driver as MemoryChannel).receive(message);
  },
  simulateButton: async (driver, press) => {
    await (driver as MemoryChannel).press(press);
  },
});

channelContract('memory without threads or buttons', {
  create: () =>
    new MemoryChannel({ threads: false, buttons: false, reactions: false, identities: false }),
  channel: 'general',
  simulateMessage: async (driver, message) => {
    await (driver as MemoryChannel).receive(message);
  },
});

describe('driver registry', () => {
  it('creates registered drivers by kind and name', () => {
    const registry = new DriverRegistry().register('engine', 'stub', () => new StubEngine());
    expect(registry.has('engine', 'stub')).toBe(true);
    expect(registry.has('runtime', 'stub')).toBe(false);
    expect(registry.names('engine')).toEqual(['stub']);
    expect(registry.create('engine', 'stub').name).toBe('stub');
  });

  it('refuses duplicates and names unknown drivers', () => {
    const registry = new DriverRegistry().register('engine', 'stub', () => new StubEngine());
    expect(() => registry.register('engine', 'stub', () => new StubEngine())).toThrow(DriverError);
    try {
      registry.create('engine', 'missing');
      expect.unreachable();
    } catch (error) {
      expect(isDriverError(error, 'not_found')).toBe(true);
      expect((error as DriverError).hint).toBe('Known engine drivers: stub');
    }
  });

  it('ships the Herdr runtime as a built-in driver', () => {
    const registry = createDriverRegistry();
    expect(registry.names('runtime')).toEqual(['herdr']);
    expect(registry.create('runtime', 'herdr', { minimumVersion: '0.2.0' })).toBeInstanceOf(
      HerdrRuntime,
    );
    expect(() => registry.create('runtime', 'herdr', { nope: true })).toThrow(
      /Invalid herdr options/,
    );
  });
});

describe('channel helpers', () => {
  it('replies in the thread a message started, or the thread it is in', () => {
    const base = {
      type: 'message' as const,
      channel: 'c',
      userId: 'u',
      text: 't',
      direct: false,
      receivedAt: new Date(),
    };
    expect(replyThread({ ...base, messageId: '1', threadId: null })).toBe('1');
    expect(replyThread({ ...base, messageId: '2', threadId: '1' })).toBe('1');
  });
});

describe('the memory runtime', () => {
  it('holds text sent before a program starts, as a terminal does, and hands it over after', async () => {
    const events: string[] = [];
    const runtime = new MemoryRuntime({
      recorder: () => ({
        start: () => events.push('start'),
        input: (line) => events.push(`input: ${line}`),
      }),
    });
    const session = await runtime.start({ name: 'early', command: ['recorder'] });
    // Sent before the program has started.
    await runtime.send(session.id, 'typed ahead');
    expect(events).toEqual([]);
    await new Promise((r) => setTimeout(r, 5));
    expect(events).toEqual(['start', 'input: typed ahead']);
    await runtime.send(session.id, 'later');
    expect(events.at(-1)).toBe('input: later');
  });

  it('drops text typed ahead once the program has exited', async () => {
    const got: string[] = [];
    const runtime = new MemoryRuntime({
      once: () => ({
        input: (line, io) => {
          got.push(line);
          io.exit(0);
        },
      }),
    });
    const session = await runtime.start({ name: 'once', command: ['once'] });
    await runtime.send(session.id, 'one');
    await runtime.send(session.id, 'two');
    await new Promise((r) => setTimeout(r, 5));
    expect(got).toEqual(['one']);
    expect((await runtime.get(session.id))?.state).toBe('finished');
  });
});
