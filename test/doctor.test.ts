import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DriverRegistry } from '../src/contracts/registry.js';
import { defaultHome, runDoctor, trustedIn, type DoctorReport } from '../src/doctor/doctor.js';
import { shellPath, trustAdvice } from '../src/util/trust.js';
import { HerdrRuntime } from '../src/drivers/runtime/herdr/herdr-runtime.js';
import { formatReport } from '../src/cli/program.js';
import { fakeHc, type FakeHc } from './helpers/hc.js';
import { initWorkspace } from '../src/cli/commands/init.js';
import { installYaml } from '../src/cli/templates.js';
import { writeSecret } from '../src/secrets.js';
import { loadInstall } from '../src/config/load.js';
import { SqliteVectorStore } from '../src/drivers/vector-store/sqlite.js';
import { proposeSkill } from '../src/skills/proposals.js';
import { KnowledgeSearch } from '../src/knowledge/search.js';
import { HashEmbeddings, MemoryChannel, StubEngine } from '../src/testing/index.js';

const EXAMPLE = new URL('../examples/install/', import.meta.url).pathname;

/** Doctor never looks at the real launchd or Claude Code config in tests. */
const probes = {
  service: () => Promise.resolve({ installed: false, answering: false }),
  trust: () => Promise.resolve(true),
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
    const home = mkdtempSync(join(tmpdir(), 'wheems-home-'));
    cleanups.push(() => {
      rmSync(home, { recursive: true, force: true });
    });
    const report = await runDoctor({
      ...probes,
      home,
      registry: registryWith().registry,
      nodeVersion: '22.16.0',
      platform: 'darwin',
    });
    expect(report.ok).toBe(true);
    expect(statuses(report)).toEqual({
      System: ['pass Node.js', 'pass SQLite search', 'pass platform'],
      'Herdr core': ['pass hc installed', 'pass hc version', 'pass Herdr core', 'pass round trip'],
      Config: ['skip install'],
    });
    expect(formatReport(report, false)).toMatch(/Doctor passed\.\n$/);
  });

  it('warns on Linux that the service needs macOS for now', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wheems-home-'));
    cleanups.push(() => {
      rmSync(home, { recursive: true, force: true });
    });
    const report = await runDoctor({
      ...probes,
      home,
      registry: registryWith().registry,
      quick: true,
      nodeVersion: '22.16.0',
      platform: 'linux',
    });
    const platform = report.sections[0]?.checks.find((c) => c.name === 'platform');
    expect(platform).toMatchObject({ status: 'warn' });
    expect(platform?.message).toMatch(/launchd on macOS only/);
    expect(report.ok).toBe(true);
  });

  it('fails on Node 23, and on a Node whose SQLite has no full-text search', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wheems-home-'));
    cleanups.push(() => {
      rmSync(home, { recursive: true, force: true });
    });
    const system = async (options: Partial<Parameters<typeof runDoctor>[0]>) => {
      const report = await runDoctor({
        ...probes,
        home,
        registry: registryWith().registry,
        quick: true,
        platform: 'darwin',
        ...options,
      });
      return report.sections.find((s) => s.title === 'System')?.checks ?? [];
    };
    const node23 = await system({ nodeVersion: '23.11.0' });
    expect(node23[0]).toMatchObject({ name: 'Node.js', status: 'fail' });
    expect(node23[0]?.message).toMatch(/no Node 23 release has SQLite full-text search/);
    expect(node23[0]?.hint).toMatch(/22\.16 or later in the 22 line, or 24 or later/);

    const noFts = await system({
      nodeVersion: '24.1.0',
      fullTextSearch: () => Promise.resolve('This Node.js has SQLite without full-text search'),
    });
    expect(noFts.map((c) => `${c.status} ${c.name}`)).toEqual([
      'pass Node.js',
      'fail SQLite search',
      'pass platform',
    ]);
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
    const home = mkdtempSync(join(tmpdir(), 'wheems-home-'));
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
      System: ['fail Node.js', 'pass SQLite search', 'warn platform'],
      // install.yaml failed to parse, so the pin in it does not apply.
      'Herdr core': ['pass hc installed', 'pass hc version', 'pass Herdr core', 'pass round trip'],
      Config: ['fail install', 'fail install.yaml:2'],
    });
    expect(formatReport(report, false)).toMatch(/Doctor failed: 3 checks failed\.\n$/);
  });

  it('applies the Herdr version pinned in install.yaml', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wheems-home-'));
    cleanups.push(() => {
      rmSync(home, { recursive: true, force: true });
    });
    writeFileSync(join(home, 'install.yaml'), 'herdr: { version: 0.2.0 }\n');
    const report = await runDoctor({ home, registry: registryWith().registry, ...probes });
    expect(report.ok).toBe(false);
    expect(statuses(report)['Herdr core']).toEqual(['pass hc installed', 'fail hc version']);
  });

  it('checks engines, folder trust, chat connections and the service once there is an install', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wheems-home-'));
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
    const env = { WHEEMS_SECRETS: join(home, 'secrets.json') };
    const before = await runDoctor({
      home,
      registry,
      env,
      quick: true,
      service: () => Promise.resolve({ installed: false, answering: false }),
      trust: () => Promise.resolve(false),
    });
    expect(statuses(before).Agents).toEqual(['pass claude-code engine', 'warn personal folder']);
    expect(statuses(before).Channels).toEqual(['warn slack allowed users', 'fail slack']);
    expect(before.sections.find((x) => x.title === 'Channels')?.checks[1]?.message).toBe(
      'Not connected yet: no credentials saved for it',
    );
    expect(statuses(before).Service).toEqual(['warn service']);
    expect(before.ok).toBe(false);

    await writeSecret(env.WHEEMS_SECRETS, 'slack', { bot_token: 'xoxb-x', app_token: 'xapp-x' });
    const after = await runDoctor({
      home,
      registry,
      env,
      quick: true,
      service: () => Promise.resolve({ installed: true, answering: true }),
      trust: () => Promise.resolve(true),
    });
    expect(statuses(after).Agents).toEqual(['pass claude-code engine', 'pass personal folder']);
    expect(statuses(after).Channels).toEqual([
      'warn slack allowed users',
      'pass slack: memory channel',
    ]);
    expect(statuses(after).Service).toEqual(['pass service']);
    expect(after.ok).toBe(true);
  });

  it("warns when the app isn't in a workspace's chat channel, and fails when it can't see it", async () => {
    const home = mkdtempSync(join(tmpdir(), 'wheems-home-'));
    cleanups.push(() => {
      rmSync(home, { recursive: true, force: true });
    });
    writeFileSync(join(home, 'install.yaml'), installYaml());
    await initWorkspace({ home, id: 'personal' });
    await initWorkspace({ home, id: 'team', channel: 'team-chat' });
    await initWorkspace({ home, id: 'typo', channel: 'no-such-channel' });
    class SeesChannels extends MemoryChannel {
      resolveChannel(name: string) {
        return Promise.resolve(name === 'team-chat' ? 'C0TEAM001' : null);
      }
      // Slack lists public channels the app isn't in; this one it isn't.
      isMember() {
        return Promise.resolve(false);
      }
    }
    const { registry } = registryWith();
    registry
      .register('engine', 'claude-code', () => new StubEngine({ name: 'claude-code' }))
      .register('channel', 'slack', () => new SeesChannels());
    const env = { WHEEMS_SECRETS: join(home, 'secrets.json') };
    await writeSecret(env.WHEEMS_SECRETS, 'slack', { bot_token: 'xoxb-x', app_token: 'xapp-x' });
    const report = await runDoctor({ ...probes, home, registry, env, quick: true });
    const channels = report.sections.find((x) => x.title === 'Channels')?.checks ?? [];
    expect(channels.find((c) => c.name === 'team chat channel')).toMatchObject({
      status: 'warn',
      message: "The app isn't in team-chat, so messages there never reach the chief of staff",
      hint: 'In team-chat, type /invite and choose the app.',
    });
    expect(channels.find((c) => c.name === 'typo chat channel')).toMatchObject({ status: 'fail' });
    // The direct-messages workspace has nothing to check.
    expect(channels.some((c) => c.name.startsWith('personal'))).toBe(false);
  });

  it("checks the embeddings driver and each workspace's search index", async () => {
    const home = mkdtempSync(join(tmpdir(), 'wheems-home-'));
    cleanups.push(() => {
      rmSync(home, { recursive: true, force: true });
    });
    writeFileSync(join(home, 'install.yaml'), installYaml());
    await initWorkspace({ home, id: 'personal' });
    const { registry } = registryWith();
    const embeddings = new HashEmbeddings();
    registry
      .register('engine', 'claude-code', () => new StubEngine({ name: 'claude-code' }))
      .register('embeddings', 'hash', () => embeddings)
      .register(
        'vector-store',
        'sqlite',
        (options) => new SqliteVectorStore({ dir: String(options.dir) }),
      );
    const knowledge = async () => {
      const report = await runDoctor({ ...probes, home, registry, quick: true });
      return report.sections.find((s) => s.title === 'Knowledge')?.checks ?? [];
    };

    expect((await knowledge()).map((c) => `${c.status} ${c.name}: ${c.message}`)).toEqual([
      'skip embeddings: Search is keyword-only',
      'warn personal index: Not built yet',
    ]);

    const install = await loadInstall(home);
    const search = () =>
      new KnowledgeSearch({
        install: install.config!,
        workspaces: install.workspaces,
        registry,
        indexDir: join(home, '.wheems', 'index'),
      });
    const keyword = search();
    await keyword.syncAll();
    await keyword.close();
    expect((await knowledge()).map((c) => `${c.status} ${c.name}: ${c.message}`)).toEqual([
      'skip embeddings: Search is keyword-only',
      'pass personal index: 0 files, keyword search',
    ]);

    writeFileSync(
      join(home, 'install.yaml'),
      `${installYaml()}knowledge:\n  embeddings:\n    driver: hash\n`,
    );
    expect((await knowledge()).map((c) => `${c.status} ${c.name}`)).toEqual([
      'pass hash embeddings',
      'warn personal index',
    ]);
    expect((await knowledge())[1]?.message).toMatch(/not the model in install.yaml/);

    writeFileSync(
      join(home, 'install.yaml'),
      `${installYaml()}knowledge:\n  embeddings:\n    driver: nowhere\n`,
    );
    const broken = await knowledge();
    expect(broken[0]).toMatchObject({ name: 'embeddings', status: 'fail' });
    expect(broken[0]?.message).toMatch(/No embeddings driver named "nowhere"/);
  });

  it('says what waits for review, without failing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wheems-home-'));
    cleanups.push(() => {
      rmSync(home, { recursive: true, force: true });
    });
    writeFileSync(join(home, 'install.yaml'), installYaml());
    await initWorkspace({ home, id: 'personal' });
    const { registry } = registryWith();
    registry.register('engine', 'claude-code', () => new StubEngine({ name: 'claude-code' }));
    const review = async () => {
      const report = await runDoctor({ ...probes, home, registry, quick: true });
      return report.sections.find((s) => s.title === 'Review')?.checks[0];
    };
    expect(await review()).toMatchObject({ status: 'pass', message: 'Nothing waits for review' });
    await proposeSkill({
      home,
      stateDir: join(home, '.wheems'),
      workspace: 'personal',
      agent: 'chief-of-staff',
      conversation: null,
      name: 'weekly-report',
      text: '---\ndescription: Writes the weekly report.\n---\n\nRead the git log.\n',
    });
    mkdirSync(join(home, '.wheems', 'review', 'about-you'), { recursive: true });
    writeFileSync(join(home, '.wheems', 'review', 'about-you', 'n-personal.md'), '# About you\n');
    expect(await review()).toMatchObject({
      status: 'warn',
      message: '1 skill proposal and 1 change to about-you.md wait for review',
      hint: 'Run: wheems review',
    });
  });

  it('advises trusting the install folder once, quoting a path a shell would split', () => {
    expect(trustAdvice('Claude Code', ['claude'], '~/wheems')).toBe(
      'At the Mac, run `cd ~/wheems && claude` and answer yes. Claude Code then trusts every workspace in your install, including ones you add later.',
    );
    expect(shellPath('~/My Wheems')).toBe("~/'My Wheems'");
    expect(shellPath("/tmp/it's")).toBe("'/tmp/it'\\''s'");
  });

  it('counts a folder as trusted when Claude Code trusted it or a folder around it', () => {
    const projects = {
      '/Users/me/wheems': { hasTrustDialogAccepted: true },
      '/Users/me/other': { hasTrustDialogAccepted: false },
    };
    expect(trustedIn(projects, '/Users/me/wheems/workspaces/personal')).toBe(true);
    expect(trustedIn(projects, '/Users/me/wheems')).toBe(true);
    expect(trustedIn(projects, '/Users/me/other/x')).toBe(false);
    expect(trustedIn(projects, '/Users/me')).toBe(false);
  });

  it('uses WHEEMS_HOME, then ~/wheems', () => {
    expect(defaultHome({ WHEEMS_HOME: '/srv/wheems' })).toBe('/srv/wheems');
    expect(defaultHome({})).toMatch(/wheems$/);
  });
});
