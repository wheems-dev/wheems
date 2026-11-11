import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DriverRegistry } from '../src/contracts/registry.js';
import { defaultHome, runDoctor, trustedIn, type DoctorReport } from '../src/doctor/doctor.js';
import { HerdrRuntime } from '../src/drivers/runtime/herdr/herdr-runtime.js';
import { formatReport } from '../src/cli/program.js';
import { fakeHc, type FakeHc } from './helpers/hc.js';
import { initWorkspace } from '../src/cli/commands/init.js';
import { installYaml } from '../src/cli/templates.js';
import { writeSecret } from '../src/secrets.js';
import { MemoryChannel, StubEngine } from '../src/testing/index.js';

const EXAMPLE = new URL('../examples/install/', import.meta.url).pathname;

/** Doctor never looks at the real launchd or Claude Code config in tests. */
const probes = {
  service: () => Promise.resolve({ installed: false, answering: false }),
  claudeTrust: () => Promise.resolve(true),
};

describe('doctor', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  const registryWith = (
    env: Record<string, string> = {},
  ): { registry: DriverRegistry; fake: FakeHc } => {
    const fake = fakeHc(env);
    cleanups.push(fake.cleanup);
    const registry = new DriverRegistry().register(
      'runtime',
      'herdr',
      (options) =>
        new HerdrRuntime({
          binary: fake.binary,
          env: fake.env,
          ...(typeof options.minimumVersion === 'string' && {
            minimumVersion: options.minimumVersion,
          }),
        }),
    );
    return { registry, fake };
  };
  const statuses = (report: DoctorReport) =>
    Object.fromEntries(
      report.sections.map((s) => [s.title, s.checks.map((c) => `${c.status} ${c.name}`)]),
    );

  it('passes with a current hc and no install yet', async () => {
    const home = mkdtempSync(join(tmpdir(), 'opinr-home-'));
    cleanups.push(() => {
      rmSync(home, { recursive: true, force: true });
    });
    const report = await runDoctor({
      ...probes,
      home,
      registry: registryWith().registry,
      nodeVersion: '22.12.0',
      platform: 'linux',
    });
    expect(report.ok).toBe(true);
    expect(statuses(report)).toEqual({
      System: ['pass Node.js', 'pass platform'],
      'Herdr core': ['pass hc installed', 'pass hc version', 'pass Herdr core', 'pass round trip'],
      Config: ['skip install'],
    });
    expect(formatReport(report, false)).toMatch(/Doctor passed\.\n$/);
  });

  it('checks the example install and warns about engines without drivers', async () => {
    const report = await runDoctor({
      ...probes,
      home: EXAMPLE,
      registry: registryWith().registry,
      quick: true,
    });
    expect(report.ok).toBe(true);
    const config = report.sections.find((s) => s.title === 'Config')!.checks;
    expect(config[0]).toMatchObject({
      name: 'install',
      status: 'pass',
      message: expect.stringMatching(/2 workspaces$/) as string,
    });
    expect(
      config.slice(1).every((c) => c.status === 'warn' && /No engine driver/.test(c.message)),
    ).toBe(true);
    expect(statuses(report)['Herdr core']).not.toContain('pass round trip');
  });

  it('fails on an old Node.js, an old hc and config errors', async () => {
    const home = mkdtempSync(join(tmpdir(), 'opinr-home-'));
    cleanups.push(() => {
      rmSync(home, { recursive: true, force: true });
    });
    writeFileSync(join(home, 'install.yaml'), 'herdr: { version: 0.1.25 }\nmachines: { a: {} }\n');
    const report = await runDoctor({
      ...probes,
      home,
      registry: registryWith().registry,
      nodeVersion: '20.19.0',
      platform: 'win32',
    });
    expect(report.ok).toBe(false);
    expect(statuses(report)).toEqual({
      System: ['fail Node.js', 'warn platform'],
      // install.yaml failed to parse, so the pin in it does not apply.
      'Herdr core': ['pass hc installed', 'pass hc version', 'pass Herdr core', 'pass round trip'],
      Config: ['fail install', 'fail install.yaml:2'],
    });
    expect(formatReport(report, false)).toMatch(/Doctor failed: 3 checks failed\.\n$/);
  });

  it('applies the Herdr version pinned in install.yaml', async () => {
    const home = mkdtempSync(join(tmpdir(), 'opinr-home-'));
    cleanups.push(() => {
      rmSync(home, { recursive: true, force: true });
    });
    writeFileSync(join(home, 'install.yaml'), 'herdr: { version: 0.2.0 }\n');
    const report = await runDoctor({ home, registry: registryWith().registry, ...probes });
    expect(report.ok).toBe(false);
    expect(statuses(report)['Herdr core']).toEqual(['pass hc installed', 'fail hc version']);
  });

  it('checks engines, folder trust, chat connections and the service once there is an install', async () => {
    const home = mkdtempSync(join(tmpdir(), 'opinr-home-'));
    cleanups.push(() => {
      rmSync(home, { recursive: true, force: true });
    });
    writeFileSync(join(home, 'install.yaml'), installYaml());
    await initWorkspace({ home, id: 'personal' });
    const { registry } = registryWith();
    registry
      .register('engine', 'claude-code', () => new StubEngine({ name: 'claude-code' }))
      .register('channel', 'slack', (options) => {
        if (options.bot_token === undefined) throw new Error('Invalid slack options: no bot_token');
        return new MemoryChannel();
      });
    const env = { OPINR_SECRETS: join(home, 'secrets.json') };
    const before = await runDoctor({
      home,
      registry,
      env,
      quick: true,
      service: () => Promise.resolve({ installed: false, answering: false }),
      claudeTrust: () => Promise.resolve(false),
    });
    expect(statuses(before).Agents).toEqual(['pass claude-code engine', 'warn personal folder']);
    expect(statuses(before).Channels).toEqual(['warn slack allowed users', 'fail slack']);
    expect(before.sections.find((x) => x.title === 'Channels')?.checks[1]?.message).toBe(
      'Not connected yet: no credentials saved for it',
    );
    expect(statuses(before).Service).toEqual(['warn service']);
    expect(before.ok).toBe(false);

    await writeSecret(env.OPINR_SECRETS, 'slack', { bot_token: 'xoxb-x', app_token: 'xapp-x' });
    const after = await runDoctor({
      home,
      registry,
      env,
      quick: true,
      service: () => Promise.resolve({ installed: true, answering: true }),
      claudeTrust: () => Promise.resolve(true),
    });
    expect(statuses(after).Agents).toEqual(['pass claude-code engine', 'pass personal folder']);
    expect(statuses(after).Channels).toEqual([
      'warn slack allowed users',
      'pass slack: memory channel',
    ]);
    expect(statuses(after).Service).toEqual(['pass service']);
    expect(after.ok).toBe(true);
  });

  it('counts a folder as trusted when Claude Code trusted it or a folder around it', () => {
    const projects = {
      '/Users/me/opinr': { hasTrustDialogAccepted: true },
      '/Users/me/other': { hasTrustDialogAccepted: false },
    };
    expect(trustedIn(projects, '/Users/me/opinr/workspaces/personal')).toBe(true);
    expect(trustedIn(projects, '/Users/me/opinr')).toBe(true);
    expect(trustedIn(projects, '/Users/me/other/x')).toBe(false);
    expect(trustedIn(projects, '/Users/me')).toBe(false);
  });

  it('uses OPINR_HOME, then ~/opinr', () => {
    expect(defaultHome({ OPINR_HOME: '/srv/opinr' })).toBe('/srv/opinr');
    expect(defaultHome({})).toMatch(/opinr$/);
  });
});
