import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Hc, HcError } from '../src/drivers/runtime/herdr/hc.js';
import { HERDR_MINIMUM_VERSION, HerdrRuntime } from '../src/drivers/runtime/herdr/herdr-runtime.js';
import { expectDriverError, runtimeContract } from '../src/testing/index.js';
import { fakeHc, isolatedHcEnv, realHcAvailable, type FakeHc } from './helpers/hc.js';

// The Herdr driver against a fake hc: runs everywhere, including CI.
{
  let fake: FakeHc | undefined;
  runtimeContract('herdr (fake hc)', {
    create: () => {
      fake = fakeHc();
      return new HerdrRuntime({ binary: fake.binary, env: fake.env });
    },
    teardown: () => fake?.cleanup(),
  });
}

// The Herdr driver against the real hc, in a core of its own. Skipped where hc is not installed.
{
  const live = realHcAvailable();
  const isolated = live ? isolatedHcEnv() : undefined;
  describe.runIf(live)('herdr (real hc)', () => {
    runtimeContract('herdr (real hc)', {
      create: () => new HerdrRuntime({ env: isolated!.env }),
      teardown: async () => {
        await new Hc({ env: isolated!.env }).serverStop();
        rmSync(isolated!.dir, { recursive: true, force: true });
      },
    });
  });
}

describe('hc adapter', () => {
  const fakes: FakeHc[] = [];
  const make = (env: Record<string, string> = {}) => {
    const fake = fakeHc(env);
    fakes.push(fake);
    return fake;
  };
  afterEach(() => {
    for (const fake of fakes.splice(0)) fake.cleanup();
  });

  it('reads the version from hc --version', async () => {
    const fake = make({ FAKE_HC_VERSION: '0.3.1' });
    expect(await new Hc({ binary: fake.binary, env: fake.env }).version()).toBe('0.3.1');
  });

  it('always asks for JSON and passes positional arguments after --', async () => {
    const fake = make();
    const log = join(fake.dir, 'log.jsonl');
    const hc = new Hc({ binary: fake.binary, env: { ...fake.env, FAKE_HC_LOG: log } });
    const t = await hc.run(['sh', '-c', 'sleep 9'], {
      name: 'x',
      cwd: '/tmp',
      labels: { a: 'b' },
      machine: 'box',
    });
    await hc.send(t.address, '--not-an-option', { ifStatus: 'idle' });
    await hc.read(t.address, { lines: 5 });
    await hc.wait(t.address, { timeoutSeconds: 1, output: 'ready' });
    const calls = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    expect(calls).toEqual([
      [
        'run',
        '--json',
        '--bg',
        '--no-parent',
        '--no-notify',
        '--name',
        'x',
        '--cwd',
        '/tmp',
        '--on',
        'box',
        '--label',
        'a=b',
        '--',
        'sh',
        '-c',
        'sleep 9',
      ],
      ['send', '--json', '--if', 'idle', '--', t.address, '--not-an-option'],
      ['read', '--json', '--lines', '5', '--', t.address],
      ['wait', '--json', '--timeout', '1', '--output', 'ready', '--', t.address],
    ]);
  });

  it('gives a waiting send the same explicit timeout as hc, 180 seconds by default', async () => {
    const fake = make();
    const log = join(fake.dir, 'log.jsonl');
    const hc = new Hc({ binary: fake.binary, env: { ...fake.env, FAKE_HC_LOG: log } });
    const t = await hc.run(['sh', '-c', 'sleep 9']);
    await hc.send(t.address, 'one', { wait: true });
    await hc.send(t.address, 'two', { wait: true, timeoutSeconds: 600 });
    const calls = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
      .filter((args) => args[0] === 'send');
    expect(calls).toEqual([
      ['send', '--json', '--wait', '--timeout', '180', '--', t.address, 'one'],
      ['send', '--json', '--wait', '--timeout', '600', '--', t.address, 'two'],
    ]);
  });

  it("turns hc's JSON errors into HcError with kind, message, hint and exit code", async () => {
    const fake = make();
    const error = await new Hc({ binary: fake.binary, env: fake.env })
      .get('nope')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HcError);
    expect(error).toMatchObject({
      kind: 'not_found',
      message: 'no terminal "nope"',
      hint: 'see `hc ls --all`',
      exitCode: 3,
    });
  });

  it('reports a missing hc', async () => {
    const error = await new Hc({ binary: '/nonexistent/hc' }).version().catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'missing' });
  });

  it('refuses output that is not JSON', async () => {
    const fake = make({ FAKE_HC_BAD_OUTPUT: '1' });
    const error = await new Hc({ binary: fake.binary, env: fake.env })
      .list()
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'bad_output' });
  });
});

describe('herdr runtime', () => {
  const fakes: FakeHc[] = [];
  afterEach(() => {
    for (const fake of fakes.splice(0)) fake.cleanup();
  });
  const runtime = (env: Record<string, string> = {}, minimumVersion?: string) => {
    const fake = fakeHc(env);
    fakes.push(fake);
    return new HerdrRuntime({
      binary: fake.binary,
      env: fake.env,
      ...(minimumVersion !== undefined && { minimumVersion }),
    });
  };

  it(`pins a minimum of ${HERDR_MINIMUM_VERSION}, raised but never lowered by install.yaml`, () => {
    expect(runtime().minimumVersion).toBe(HERDR_MINIMUM_VERSION);
    expect(runtime({}, '0.1.2').minimumVersion).toBe(HERDR_MINIMUM_VERSION);
    expect(runtime({}, '9.0.0').minimumVersion).toBe('9.0.0');
  });

  it('refuses to run against an hc older than the minimum', async () => {
    const old = runtime({ FAKE_HC_VERSION: '0.1.19' });
    await expectDriverError(old.list(), 'version');
    await expectDriverError(old.start({ name: 'x', command: ['sleep', '1'] }), 'version');
    const checks = await old.check();
    expect(checks.find((c) => c.name === 'hc version')).toMatchObject({ status: 'fail' });
  });

  it('fails its health check when hc is missing', async () => {
    const checks = await new HerdrRuntime({ binary: '/nonexistent/hc' }).check();
    expect(checks).toEqual([expect.objectContaining({ name: 'hc installed', status: 'fail' })]);
    await expectDriverError(new HerdrRuntime({ binary: '/nonexistent/hc' }).list(), 'unavailable');
  });

  it('passes its health check on a current hc', async () => {
    const checks = await runtime().check();
    expect(checks.map((c) => [c.name, c.status])).toEqual([
      ['hc installed', 'pass'],
      ['hc version', 'pass'],
      ['Herdr core', 'pass'],
    ]);
  });

  it("reads an agent's status whether hc reports the word or the whole record", async () => {
    const herdr = runtime();
    const session = await herdr.start({ name: 'agent', command: ['fake-agent'], env: { A: 'b' } });
    expect((await herdr.get(session.id))?.status).toBe('idle');
    const sent = await herdr.send(session.id, 'hi');
    expect(sent).toMatchObject({ turn: 0, status: 'idle' });
    expect(await herdr.wait(session.id, { timeoutSeconds: 1 })).toMatchObject({
      ended: true,
      reason: 'status',
      status: 'done',
      turn: 1,
    });
    expect((await herdr.get(session.id))?.status).toBe('done');
    expect((await herdr.list()).find((s) => s.id === session.id)?.status).toBe('done');
    // hc run has no env option, so the driver puts env(1) in front.
    expect((await herdr.get(session.id))?.command).toEqual(['/usr/bin/env', 'A=b', 'fake-agent']);
  });

  it('refuses environment variable names that env(1) would misread', async () => {
    await expectDriverError(
      runtime().start({ name: 'x', command: ['sleep', '1'], env: { 'BAD=NAME': 'v' } }),
      'invalid',
    );
  });

  it('refuses a session without a command', async () => {
    await expectDriverError(runtime().start({ name: 'x', command: [] }), 'invalid');
  });
});
