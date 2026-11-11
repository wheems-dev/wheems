import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initWorkspace } from '../src/cli/commands/init.js';
import { setup } from '../src/cli/commands/setup.js';
import { DriverRegistry } from '../src/contracts/registry.js';
import { slackConnectFlow } from '../src/drivers/channel/slack/connect.js';
import { MemoryChannel } from '../src/testing/index.js';
import { CANCEL, scriptedUi } from './helpers/scripted-ui.js';
import { crossCheck } from '../src/config/check.js';
import { loadInstall } from '../src/config/load.js';
import { readSecrets } from '../src/secrets.js';
import { parseLaunchctlPrint, renderPlist } from '../src/service/launchd.js';

describe('opinr setup', () => {
  let root: string;
  let home: string;
  let env: NodeJS.ProcessEnv;
  let calls: string[];
  let running: boolean;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'opinr-setup-'));
    home = join(root, 'opinr');
    env = { OPINR_SECRETS: join(root, 'config', 'secrets.json') };
    calls = [];
    running = false;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const registry = () =>
    new DriverRegistry()
      .register('channel', 'slack', () => new MemoryChannel(), {
        label: 'Slack',
        description: 'chat with your agents in Slack',
        connect: slackConnectFlow({
          verifyTokens: (bot, app) =>
            bot === 'xoxb-good' && app === 'xapp-good'
              ? Promise.resolve({ team: 'Home', botUser: 'opinr' })
              : Promise.reject(new Error('Slack refused the bot token: invalid_auth')),
          memberName: (_bot, id) =>
            id === 'UFLAKY01'
              ? Promise.reject(new Error("Couldn't look up UFLAKY01 in Slack: ECONNRESET"))
              : Promise.resolve(id === 'UMEMBER1' || id === 'UMEMBER2' ? 'Me' : null),
        }),
      })
      .plan('channel', 'telegram', { label: 'Telegram', description: 'chat in Telegram' });
  const actions = {
    trustFolder: (dir: string) => {
      calls.push(`trust ${dir}`);
      return Promise.resolve();
    },
    installService: () => {
      calls.push('install service');
      running = true;
      return Promise.resolve(true);
    },
    serviceRunning: () => Promise.resolve(running),
    copy: (text: string) => {
      calls.push(`copy ${text.split('\n')[0] ?? ''}`);
      return Promise.resolve(true);
    },
    openUrl: (url: string) => {
      calls.push(`open ${url}`);
      return Promise.resolve(true);
    },
    doctor: () => {
      calls.push('doctor');
      return Promise.resolve({ ok: true, report: 'Doctor passed.' });
    },
  };

  it('walks through a channel, a workspace and the service from a menu', async () => {
    const ui = scriptedUi([
      'channels',
      'slack',
      true, // open the Slack app page
      'not-a-token', // asked again: must start with xoxb-
      'xoxb-bad',
      'xapp-bad',
      true, // try again
      'xoxb-good',
      'xapp-good',
      'nope', // asked again: not a member id
      'UNOBODY1',
      'UMEMBER1',
      'workspaces',
      'personal',
      'Personal',
      'direct',
      true, // open Claude Code to trust the folder
      'service',
      'doctor',
      'done',
    ]);
    await setup({ home, env, ui, registry: registry(), actions });
    expect(ui.remaining()).toBe(0);

    // The menu lists Telegram, but as coming later.
    const which = ui.shown.find((s) => s.message === 'Which channel?');
    expect(which?.choices?.map((c) => [c.value, c.disabled === true])).toEqual([
      ['slack', false],
      ['telegram', true],
    ]);
    expect(ui.shown.filter((s) => s.kind === 'invalid').map((s) => s.message)).toEqual([
      'The bot token starts with xoxb-',
      'A member ID starts with U or W, then letters and digits',
    ]);
    expect(await readSecrets(env.OPINR_SECRETS!)).toEqual({
      slack: { bot_token: 'xoxb-good', app_token: 'xapp-good' },
    });
    expect(statSync(env.OPINR_SECRETS!).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, '.git')).isDirectory()).toBe(true);
    expect(readFileSync(join(home, '.gitignore'), 'utf8')).toContain('.opinr/');
    expect(readFileSync(join(home, '.opinr', 'slack-app-manifest.yaml'), 'utf8')).toContain(
      'socket_mode_enabled: true',
    );

    const install = await loadInstall(home);
    expect(install.problems).toEqual([]);
    expect(install.config?.connections.slack?.allowed_users).toEqual(['UMEMBER1']);
    expect(install.workspaces.map((w) => w.id)).toEqual(['personal']);
    expect(calls).toEqual([
      'copy display_information:',
      'open https://api.slack.com/apps?new_app=1',
      `trust ${join(home, 'workspaces', 'personal')}`,
      'install service',
      'doctor',
    ]);
  });

  it('keeps working tokens and allowed users when run again, and suggests the next step', async () => {
    await setup({
      home,
      env,
      ui: scriptedUi(['channels', 'slack', false, 'xoxb-good', 'xapp-good', 'UMEMBER1', 'done']),
      registry: registry(),
      actions,
    });
    const again = scriptedUi(['channels', 'slack', true, 'done']);
    await setup({ home, env, ui: again, registry: registry(), actions });
    expect(again.shown.some((s) => s.message.includes('Connected as opinr in Home'))).toBe(true);
    expect(again.shown.some((s) => s.message === 'Allowed to talk to agents: UMEMBER1')).toBe(true);
    // With a channel connected, the menu starts on Workspaces.
    const menu = again.shown.find((s) => s.message === 'What do you want to set up?');
    expect(menu?.choices?.find((c) => c.value === 'channels')?.hint).toBe('Slack connected');
  });

  it('checks who may talk to agents when the Slack app is replaced', async () => {
    await setup({
      home,
      env,
      ui: scriptedUi(['channels', 'slack', false, 'xoxb-good', 'xapp-good', 'UMEMBER1', 'done']),
      registry: registry(),
      actions,
    });
    // UMEMBER1 is not in the other Slack workspace, so setup asks again.
    const other = new DriverRegistry().register('channel', 'slack', () => new MemoryChannel(), {
      label: 'Slack',
      description: 'x',
      connect: slackConnectFlow({
        verifyTokens: (bot) =>
          bot === 'xoxb-good'
            ? Promise.resolve({ team: 'Home', botUser: 'opinr' })
            : Promise.resolve({ team: 'Work', botUser: 'opinr' }),
        memberName: (bot, id) =>
          Promise.resolve(bot === 'xoxb-work' && id === 'UWORKER1' ? 'Me at work' : null),
      }),
    });
    const ui = scriptedUi([
      'channels',
      'slack',
      false,
      false,
      'xoxb-work',
      'xapp-work',
      'UWORKER1',
      'done',
    ]);
    await setup({ home, env, ui, registry: other, actions });
    expect(ui.remaining()).toBe(0);
    expect((await loadInstall(home)).config?.connections.slack?.allowed_users).toEqual([
      'UWORKER1',
    ]);
  });

  it('saves nothing when Slack fails to answer while rechecking allowed users', async () => {
    await setup({
      home,
      env,
      ui: scriptedUi(['channels', 'slack', false, 'xoxb-good', 'xapp-good', 'UMEMBER1', 'done']),
      registry: registry(),
      actions,
    });
    // Two people are allowed; looking up the second fails for a reason that isn't "no such member".
    const file = join(home, 'install.yaml');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace('[ UMEMBER1 ]', '[ UMEMBER1, UFLAKY01 ]'),
    );
    expect((await loadInstall(home)).config?.connections.slack?.allowed_users).toEqual([
      'UMEMBER1',
      'UFLAKY01',
    ]);
    const ui = scriptedUi(['channels', 'slack', false, false, 'xoxb-good', 'xapp-good', 'done']);
    await setup({ home, env, ui, registry: registry(), actions });
    expect(ui.shown.some((s) => s.kind === 'warn' && s.message.includes('ECONNRESET'))).toBe(true);
    expect((await loadInstall(home)).config?.connections.slack?.allowed_users).toEqual([
      'UMEMBER1',
      'UFLAKY01',
    ]);
  });

  it('keeps a new workspace when only its trust step is cancelled', async () => {
    await setup({
      home,
      env,
      ui: scriptedUi([
        'channels',
        'slack',
        false,
        'xoxb-good',
        'xapp-good',
        'UMEMBER1',
        'workspaces',
        'personal',
        'Personal',
        'direct',
        CANCEL,
        'done',
      ]),
      registry: registry(),
      actions,
    });
    expect((await loadInstall(home)).workspaces.map((w) => w.id)).toEqual(['personal']);
  });

  it('goes back to the menu when a step is cancelled, saving nothing from it', async () => {
    const ui = scriptedUi(['channels', 'slack', CANCEL, 'done']);
    await setup({ home, env, ui, registry: registry(), actions });
    expect(
      ui.shown.some((s) => s.kind === 'warn' && s.message.includes('nothing from it was saved')),
    ).toBe(true);
    expect(await readSecrets(env.OPINR_SECRETS!)).toEqual({});
  });

  it('asks for a channel before a workspace, and a channel name once the direct messages are taken', async () => {
    const first = scriptedUi(['workspaces', 'done']);
    await setup({ home, env, ui: first, registry: registry(), actions });
    expect(first.shown.some((s) => s.message.startsWith('Connect a channel first'))).toBe(true);

    await setup({
      home,
      env,
      ui: scriptedUi([
        'channels',
        'slack',
        false,
        'xoxb-good',
        'xapp-good',
        'UMEMBER1',
        'workspaces',
        'personal',
        'Personal',
        'direct',
        false,
        'workspaces',
        'acme',
        'Acme: UK',
        '#acme-chat',
        false,
        'done',
      ]),
      registry: registry(),
      actions,
    });
    const acme = (await loadInstall(home)).workspaces.find((w) => w.id === 'acme');
    expect(acme?.config).toMatchObject({
      name: 'Acme: UK',
      channels: { chat: { connection: 'slack', channel: 'acme-chat' } },
    });
  });
});

describe('opinr init', () => {
  let home: string;
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'opinr-init-'));
    await setupMinimal(home);
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('creates a workspace that validates, chatting in direct messages by default', async () => {
    const dir = await initWorkspace({ home, id: 'personal' });
    expect(dir).toBe(join(home, 'workspaces', 'personal'));
    const install = await loadInstall(home);
    expect(install.problems).toEqual([]);
    expect(crossCheck(install).filter((p) => p.level === 'error')).toEqual([]);
    const workspace = install.workspaces[0]!;
    expect(workspace.config).toMatchObject({
      name: 'Personal',
      channels: { chat: { connection: 'slack', direct: true } },
    });
    expect(workspace.agents[0]?.definition).toMatchObject({
      name: 'chief-of-staff',
      engine: 'claude-code',
      permissions: 'auto',
    });
  });

  it('gives a second workspace a channel, because only one can have direct messages', async () => {
    await initWorkspace({ home, id: 'personal' });
    await expect(initWorkspace({ home, id: 'work' })).rejects.toThrow(
      /already chats in the bot's direct messages/,
    );
    await initWorkspace({ home, id: 'work', name: 'Work', channel: 'work-chat' });
    const install = await loadInstall(home);
    expect(crossCheck(install).filter((p) => p.level === 'error')).toEqual([]);
    expect(install.workspaces.find((w) => w.id === 'work')?.config?.channels.chat).toEqual({
      connection: 'slack',
      channel: 'work-chat',
    });
  });

  it('writes valid config for names and channels with YAML characters in them', async () => {
    await initWorkspace({ home, id: 'personal' });
    await initWorkspace({ home, id: 'acme', name: 'Acme: UK # ltd', channel: '#work-chat' });
    const install = await loadInstall(home);
    expect(install.problems).toEqual([]);
    const acme = install.workspaces.find((w) => w.id === 'acme');
    expect(acme?.config).toMatchObject({
      name: 'Acme: UK # ltd',
      channels: { chat: { connection: 'slack', channel: 'work-chat' } },
      identity: { name: 'Acme: UK # ltd chief of staff' },
    });
    expect(acme?.agents[0]?.definition.description).toBe(
      'The one entry point for Acme: UK # ltd, aware of everything going on in it.',
    );
  });

  it('refuses bad names, existing workspaces and a missing install', async () => {
    await expect(initWorkspace({ home, id: 'Bad Name' })).rejects.toThrow(/not a workspace name/);
    await initWorkspace({ home, id: 'personal' });
    await expect(initWorkspace({ home, id: 'personal' })).rejects.toThrow(/already exists/);
    await expect(initWorkspace({ home: join(home, 'nowhere'), id: 'x' })).rejects.toThrow(
      /Run opinr setup first/,
    );
  });

  it('flags two workspaces claiming the same direct messages', async () => {
    await initWorkspace({ home, id: 'personal' });
    await initWorkspace({ home, id: 'work', channel: 'work-chat' });
    const file = join(home, 'workspaces', 'work', 'workspace.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('channel: "work-chat"', 'direct: true'));
    const errors = crossCheck(await loadInstall(home)).filter((p) => p.level === 'error');
    expect(errors.map((e) => e.message)).toEqual([
      'Channel "chat" uses direct messages on "slack", which workspace "personal" already has',
    ]);
  });
});

describe('launchd', () => {
  it('writes a user agent that runs the service and restarts it', () => {
    const plist = renderPlist({
      node: '/opt/homebrew/opt/node@22/bin/node',
      cli: '/Users/me/Projects/opinr/dist/cli/main.js',
      home: '/Users/me/opinr & co',
      logFile: '/Users/me/opinr/.opinr/logs/service.log',
    });
    expect(plist).toContain('<string>dev.opinr.service</string>');
    expect(plist).toContain(
      '<string>/opt/homebrew/opt/node@22/bin/node</string>\n    <string>/Users/me/Projects/opinr/dist/cli/main.js</string>\n    <string>service</string>\n    <string>run</string>',
    );
    expect(plist).toContain('<string>/Users/me/opinr &amp; co</string>');
    expect(plist).toMatch(/<key>PATH<\/key>\s*<string>\/opt\/homebrew\/opt\/node@22\/bin:/);
    expect(plist).toContain('<key>KeepAlive</key>\n  <true/>');
  });

  it('reads launchctl print', () => {
    expect(
      parseLaunchctlPrint(
        'gui/501/dev.opinr.service = {\n\tstate = running\n\tpid = 4242\n\tlast exit code = 0\n}',
      ),
    ).toEqual({
      loaded: true,
      running: true,
      pid: 4242,
      lastExit: '0',
    });
    expect(parseLaunchctlPrint('\tstate = not running\n\tlast exit code = 1\n')).toMatchObject({
      running: false,
      pid: null,
      lastExit: '1',
    });
  });
});

describe('architecture', () => {
  it('names hc only in the Herdr adapter', async () => {
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(new URL('../src', import.meta.url), {
      recursive: true,
      encoding: 'utf8',
    }).filter((f) => f.endsWith('.ts'));
    const offenders = files.filter((f) => {
      if (f === join('drivers', 'runtime', 'herdr', 'hc.ts')) return false;
      return /['"`]hc['"`]/.test(readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'));
    });
    expect(offenders).toEqual([]);
  });
});

async function setupMinimal(home: string): Promise<void> {
  const { installYaml } = await import('../src/cli/templates.js');
  writeFileSync(join(home, 'install.yaml'), installYaml());
}
