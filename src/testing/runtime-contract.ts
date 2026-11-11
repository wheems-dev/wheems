import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DriverError, type HealthCheck } from '../contracts/driver.js';
import type { RuntimeDriver, SessionInfo } from '../contracts/runtime.js';

export interface RuntimeContractOptions {
  /** Builds the driver under test. Called once for the suite. */
  create: () => RuntimeDriver | Promise<RuntimeDriver>;
  /** Runs after the suite, for example to stop a test runtime. */
  teardown?: () => void | Promise<void>;
  /**
   * A program that reads one line and prints `got:<line>`, then exits 0.
   * Defaults to a POSIX shell one-liner.
   */
  echoCommand?: string[];
  /** A program that runs until it is stopped. Defaults to `sleep 600`. */
  longCommand?: string[];
  /** Working directory for test sessions. */
  cwd?: string;
  /** Seconds to allow a session to answer. Defaults to 15. */
  timeoutSeconds?: number;
}

/**
 * The runtime contract test suite. Every runtime driver must pass it.
 *
 *   runtimeContract('my-runtime', { create: () => new MyRuntime() });
 */
export function runtimeContract(label: string, options: RuntimeContractOptions): void {
  const echo = options.echoCommand ?? ['sh', '-c', 'read line; echo "got:$line"'];
  const long = options.longCommand ?? ['sleep', '600'];
  const timeout = options.timeoutSeconds ?? 15;
  const prefix = `ct${Math.random().toString(36).slice(2, 8)}`;
  let counter = 0;
  const nextName = () => `${prefix}-${++counter}`;

  describe(`runtime contract: ${label}`, () => {
    let driver: RuntimeDriver;
    const started: string[] = [];

    const start = async (
      command: string[],
      labels?: Record<string, string>,
    ): Promise<SessionInfo> => {
      const session = await driver.start({
        name: nextName(),
        command,
        ...(options.cwd !== undefined && { cwd: options.cwd }),
        ...(labels !== undefined && { labels }),
      });
      started.push(session.id);
      return session;
    };

    beforeAll(async () => {
      driver = await options.create();
    });

    afterAll(async () => {
      for (const id of started) {
        try {
          const session = await driver.get(id);
          if (session?.state === 'live') await driver.stop(id);
          if (session) await driver.remove(id);
        } catch {
          // Best effort: a failed test may have left it in any state.
        }
      }
      await options.teardown?.();
    });

    it('identifies itself as a runtime driver', () => {
      expect(driver.kind).toBe('runtime');
      expect(driver.name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    });

    it('reports health checks that pass', async () => {
      const checks = await driver.check();
      expect(checks.length).toBeGreaterThan(0);
      for (const check of checks) expectHealthCheck(check);
      expect(checks.filter((c) => c.status === 'fail')).toEqual([]);
    });

    it('starts a session and finds it by id, by name and in the list', async () => {
      const session = await start(long, { contract: prefix });
      expect(session.id).toBeTruthy();
      expect(session.name).toMatch(new RegExp(`^${prefix}-`));
      expect(session.state).toBe('live');
      expect(session.labels).toMatchObject({ contract: prefix });

      expect((await driver.get(session.id))?.id).toBe(session.id);
      expect((await driver.get(session.name ?? ''))?.id).toBe(session.id);
      const listed = await driver.list({ labels: { contract: prefix } });
      expect(listed.map((s) => s.id)).toContain(session.id);
      const other = await driver.list({ labels: { contract: `${prefix}-none` } });
      expect(other.map((s) => s.id)).not.toContain(session.id);
    });

    it('sends text, waits for the program and reads what it printed', async () => {
      const session = await start(echo);
      const sent = await driver.send(session.id, 'hello contract');
      expect(sent.turn).toBeGreaterThanOrEqual(0);
      expect(sent.wait).toBeNull();

      const waited = await driver.wait(session.id, { timeoutSeconds: timeout });
      expect(waited.ended).toBe(true);
      expect(waited.reason).toBe('exit');
      expect(waited.exitCode).toBe(0);

      const read = await driver.read(session.id);
      expect(read.text).toContain('got:hello contract');
      expect(typeof read.complete).toBe('boolean');

      const after = await driver.get(session.id);
      expect(after?.state).toBe('finished');
      expect(after?.exitCode).toBe(0);
    });

    it('sends text that looks like an option', async () => {
      const session = await start(echo);
      await driver.send(session.id, '--help');
      await driver.wait(session.id, { timeoutSeconds: timeout });
      expect((await driver.read(session.id)).text).toContain('got:--help');
    });

    it('checks in when a wait times out, leaving the session running', async () => {
      const session = await start(long);
      const waited = await driver.wait(session.id, { timeoutSeconds: 1 });
      expect(waited.ended).toBe(false);
      expect(waited.reason).toBe('timeout');
      expect((await driver.get(session.id))?.state).toBe('live');
    });

    it('stops a session, then removes it', async () => {
      const session = await start(long);
      const stopped = await driver.stop(session.id);
      expect(stopped.state).toBe('finished');
      await driver.remove(session.id);
      expect(await driver.get(session.id)).toBeNull();
    });

    it('returns null for an unknown session, and not_found errors for operations on one', async () => {
      const unknown = `${prefix}-missing`;
      expect(await driver.get(unknown)).toBeNull();
      await expectDriverError(driver.send(unknown, 'x'), 'not_found');
      await expectDriverError(driver.read(unknown), 'not_found');
      await expectDriverError(driver.wait(unknown, { timeoutSeconds: 1 }), 'not_found');
      await expectDriverError(driver.stop(unknown), 'not_found');
    });

    it('refuses invalid session names', async () => {
      await expectDriverError(driver.start({ name: 'Not Valid!', command: long }), 'invalid');
    });
  });
}

export function expectHealthCheck(check: HealthCheck): void {
  expect(typeof check.name).toBe('string');
  expect(check.name.length).toBeGreaterThan(0);
  expect(['pass', 'warn', 'fail', 'skip']).toContain(check.status);
  expect(typeof check.message).toBe('string');
}

export async function expectDriverError(
  promise: Promise<unknown>,
  kind: DriverError['kind'],
): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `expected a DriverError of kind ${kind}`).toBeInstanceOf(DriverError);
  expect((error as DriverError).kind).toBe(kind);
}
