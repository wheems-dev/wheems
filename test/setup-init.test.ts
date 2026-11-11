import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initWorkspace } from '../src/cli/commands/init.js';
import { setup } from '../src/cli/commands/setup.js';
import type { Prompter } from '../src/cli/prompt.js';
import { crossCheck } from '../src/config/check.js';
import { loadInstall } from '../src/config/load.js';
import { readSecrets } from '../src/secrets.js';
import { parseLaunchctlPrint, renderPlist } from '../src/service/launchd.js';

function scripted(
  answers: string[],
): Prompter & { asked: { question: string; secret: boolean }[] } {
  const asked: { question: string; secret: boolean }[] = [];
  return {
    asked,
    ask: (question, options = {}) => {
      asked.push({ question, secret: options.secret === true });
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`Unexpected question: ${question}`);
      return Promise.resolve(answer);
    },
    close: () => undefined,
  };
}

describe('opinr setup', () => {
  let root: string;
  let home: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'opinr-setup-'));
    home = join(root, 'opinr');
    env = { OPINR_SECRETS: join(root, 'config', 'secrets.json') };
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const verifyTokens = (bot: string, app: string) =>
    bot === 'xoxb-good' && app === 'xapp-good'
      ? Promise.resolve({ team: 'Home', botUser: 'opinr' })
      : Promise.reject(new Error('Slack refused the bot token: invalid_auth'));
  const memberName = (_bot: string, id: string) =>
    id === 'UME' ? Promise.resolve('Me') : Promise.reject(new Error(`Slack has no member ${id}`));

  it('creates the install, connects Slack with hidden tokens, and records who may talk', async () => {
    let out = '';
    const prompter = scripted(['xoxb-bad', 'xapp-bad', 'xoxb-good', 'xapp-good', 'UNOBODY', 'UME']);
    await setup({ home, env, prompter, out: (t) => (out += t), verifyTokens, memberName });

    expect(prompter.asked.map((q) => q.secret)).toEqual([true, true, true, true, false, false]);
    expect(out).toMatch(/Slack refused the bot token/);
    expect(out).toMatch(/Slack has no member UNOBODY/);
    expect(await readSecrets(env.OPINR_SECRETS!)).toEqual({
      slack: { bot_token: 'xoxb-good', app_token: 'xapp-good' },
    });
    expect(statSync(env.OPINR_SECRETS!).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(home, 'install.yaml'), 'utf8')).toMatch(
      /allowed_users:\n\s+- UME|allowed_users: \[ UME \]/,
    );
    expect(readFileSync(join(home, '.gitignore'), 'utf8')).toContain('.opinr/');
    expect(statSync(join(home, '.git')).isDirectory()).toBe(true);
    expect(readFileSync(join(home, '.opinr', 'slack-app-manifest.yaml'), 'utf8')).toContain(
      'socket_mode_enabled: true',
    );
    const install = await loadInstall(home);
    expect(install.problems).toEqual([]);
    expect(install.config?.connections.slack?.allowed_users).toEqual(['UME']);
  });

  it('keeps working tokens and allowed users when run again', async () => {
    await setup({
      home,
      env,
      prompter: scripted(['xoxb-good', 'xapp-good', 'UME']),
      out: () => undefined,
      verifyTokens,
      memberName,
    });
    const again = scripted(['']);
    let out = '';
    await setup({ home, env, prompter: again, out: (t) => (out += t), verifyTokens, memberName });
    expect(again.asked).toHaveLength(1);
    expect(out).toMatch(/Allowed Slack members: UME/);
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
    writeFileSync(file, readFileSync(file, 'utf8').replace('channel: work-chat', 'direct: true'));
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
