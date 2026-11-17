import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initWorkspace } from '../src/cli/commands/init.js';
import { setup } from '../src/cli/commands/setup.js';
import { DriverRegistry } from '../src/contracts/registry.js';
import { slackConnectFlow } from '../src/drivers/channel/slack/connect.js';
import { HashEmbeddings, MemoryChannel } from '../src/testing/index.js';
import { CANCEL, scriptedUi } from './helpers/scripted-ui.js';
import type { EngineSetup } from '../src/contracts/setup.js';
import { StubEngine } from '../src/testing/index.js';
import { crossCheck } from '../src/config/check.js';
import { loadInstall } from '../src/config/load.js';
import { readSecrets } from '../src/secrets.js';
import {
  homeInPlist,
  jobAbsent,
  parseLaunchctlPrint,
  renderPlist,
} from '../src/service/launchd.js';

describe('wheems setup', () => {
  let root: string;
  let home: string;
  let env: NodeJS.ProcessEnv;
  let calls: string[];
  let running: boolean;
  /** What the service says when asked to greet. */
  let greeting: { ok: boolean; message: string; skipped?: boolean };
  const trustedFolders = new Set<string>();
  /** Engines whose markTrusted fails. */
  const markFails = new Set<string>();
  /** The fake world: which engine CLIs exist and which are signed in. */
  let installed: Set<string>;
  let signedIn: Set<string>;
  beforeEach(() => {
    installed = new Set(['claude-code']);
    signedIn = new Set(['claude-code']);
    root = mkdtempSync(join(tmpdir(), 'wheems-setup-'));
    home = join(root, 'wheems');
    env = { WHEEMS_SECRETS: join(root, 'config', 'secrets.json') };
    calls = [];
    running = false;
    greeting = { ok: true, message: 'in direct messages on slack' };
    trustedFolders.clear();
    markFails.clear();
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
              ? Promise.resolve({ team: 'Home', botUser: 'wheems' })
              : Promise.reject(new Error('Slack refused the bot token: invalid_auth')),
          memberName: (_bot, id) =>
            id === 'UFLAKY01'
              ? Promise.reject(new Error("Couldn't look up UFLAKY01 in Slack: ECONNRESET"))
              : Promise.resolve(id === 'UMEMBER1' || id === 'UMEMBER2' ? 'Me' : null),
        }),
      })
      .plan('channel', 'telegram', { label: 'Telegram', description: 'chat in Telegram' })
      .register('engine', 'claude-code', () => new StubEngine({ name: 'claude-code' }), {
        label: 'Claude Code',
        description: 'x',
        engine: fakeEngine('claude-code', ['claude'], 'claude-opus-5-5', {
          name: 'claude-subscription',
          driver: 'claude',
        }),
      })
      .register('engine', 'codex', () => new StubEngine({ name: 'codex' }), {
        label: 'Codex',
        description: 'x',
        engine: fakeEngine('codex', ['codex', '--no-daemon'], 'gpt-6.1-sol', {
          name: 'chatgpt-subscription',
          driver: 'chatgpt',
        }),
      });
  const fakeEngine = (
    name: string,
    trust: string[],
    defaultModel: string,
    account: { name: string; driver: string },
  ): EngineSetup => ({
    version: () => Promise.resolve(installed.has(name) ? '1.0.0' : null),
    install: ['npm', 'install', '-g', `${name}-cli`],
    signIn: [name, 'login'],
    signedIn: () => Promise.resolve(signedIn.has(name)),
    trust,
    trusted: (dir) => Promise.resolve(trustedFolders.has(dir)),
    markTrusted: (dir) => {
      calls.push(`mark ${name} ${dir}`);
      if (markFails.has(name)) return Promise.reject(new Error(`${name}'s record isn't valid`));
      trustedFolders.add(dir);
      return Promise.resolve('marked');
    },
    trustRecord: `~/.${name}`,
    defaultModel,
    account,
  });
  const actions = {
    run: (command: string[], cwd?: string) => {
      calls.push(`run ${command.join(' ')}${cwd !== undefined ? ` in ${cwd}` : ''}`);
      const [program, ...args] = command;
      if (program === 'npm') installed.add(args.at(-1)?.replace(/-cli$/, '') ?? '');
      if (args[0] === 'login') signedIn.add(program ?? '');
      return Promise.resolve(0);
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
    greet: (): Promise<{ ok: boolean; message: string; skipped?: boolean }> => {
      calls.push('greet');
      return Promise.resolve(greeting);
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
      'default',
      'Default',
      'direct',
      'claude-opus-5-5', // the model
      true, // let Wheems mark the install folder trusted
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
      "That isn't the bot token: it starts with xoxb-. Under OAuth & Permissions, copy the Bot User OAuth Token (xoxb-…).",
      'A member ID starts with U or W, then letters and digits',
    ]);
    expect(await readSecrets(env.WHEEMS_SECRETS!)).toEqual({
      slack: { bot_token: 'xoxb-good', app_token: 'xapp-good' },
    });
    expect(statSync(env.WHEEMS_SECRETS!).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, '.git')).isDirectory()).toBe(true);
    expect(readFileSync(join(home, '.gitignore'), 'utf8')).toContain('.wheems/');
    expect(readFileSync(join(home, '.wheems', 'slack-app-manifest.yaml'), 'utf8')).toContain(
      'socket_mode_enabled: true',
    );

    const install = await loadInstall(home);
    expect(install.problems).toEqual([]);
    expect(install.config?.connections.slack?.allowed_users).toEqual(['UMEMBER1']);
    expect(install.workspaces.map((w) => w.id)).toEqual(['default']);
    // The first workspace is suggested as "default", with the app's direct messages.
    const suggested = (message: string) => ui.shown.find((s) => s.message === message)?.initial;
    expect(suggested('Workspace id')).toBe('default');
    expect(suggested('Its name')).toBe('Default');
    expect(suggested('Where will you chat with it?')).toBe('direct');
    // New tokens only reach a running service after a restart; setup says so, and how to add people.
    const after = ui.shown.find((x) => x.kind === 'info' && x.message.includes('reads tokens'));
    expect(after?.message).toMatch(/restart it \(Service\)/);
    expect(after?.message).toMatch(/allowed_users under connections\.slack/);
    expect(calls).toEqual([
      'copy display_information:',
      'open https://api.slack.com/apps?new_app=1',
      // Wheems marks the install folder trusted, which covers every workspace and session in it.
      `mark claude-code ${home}`,
      'install service',
      'doctor',
      // Setup ends with the chief saying hello in chat.
      'greet',
    ]);
    expect(
      ui.shown.find((x) => x.kind === 'success' && x.message.includes('said hello'))?.message,
    ).toBe('Your chief of staff said hello in direct messages on slack. Reply there to start.');
  });

  it('asks once to mark the install folder trusted for every installed engine', async () => {
    installed.add('codex');
    signedIn.add('codex');
    markFails.add('codex');
    const ui = scriptedUi([
      'channels',
      'slack',
      false,
      'xoxb-good',
      'xapp-good',
      'UMEMBER1',
      'workspaces',
      'default',
      'Default',
      'direct',
      'claude-code', // which engine runs its chief of staff
      'claude-opus-5-5',
      true, // let Wheems mark the install folder trusted
      'workspaces',
      'work',
      'Work',
      'work-chat', // direct messages are taken: its channel
      'codex',
      'gpt-6.1-sol', // asked nothing more: Claude Code trusts it, and Codex was asked already
      'done',
      false, // don't start the service
    ]);
    await setup({ home, env, ui, registry: registry(), actions });
    expect(ui.remaining()).toBe(0);
    // "default" is only suggested while there's no workspace by that name.
    expect(ui.shown.filter((s) => s.message === 'Workspace id').map((s) => s.initial)).toEqual([
      'default',
      '',
    ]);
    expect(
      ui.shown
        .filter((s) => s.kind === 'question' && s.message.includes('trust'))
        .map((s) => s.message),
    ).toEqual([
      expect.stringMatching(/^Let Wheems mark .* as trusted for Claude Code and Codex\?$/),
    ]);
    const note = ui.shown.find((s) => s.kind === 'note' && s.message.includes('nobody can answer'));
    expect(note?.message).toContain('in ~/.claude-code and ~/.codex, and changes nothing else');
    expect(calls.filter((c) => c.startsWith('mark') || c.startsWith('run'))).toEqual([
      `mark claude-code ${home}`,
      `mark codex ${home}`,
    ]);
    expect(trustedFolders.has(home)).toBe(true);
    expect(
      ui.shown.find((s) => s.kind === 'success' && s.message.includes('trusts'))?.message,
    ).toBe(`Claude Code trusts ${home} now.`);
    // Codex's record couldn't be changed: it says why, and how to do it by hand.
    expect(ui.shown.find((s) => s.kind === 'warn')?.message).toMatch(
      /^Couldn't mark it for Codex: codex's record isn't valid At the Mac, run `wheems doctor --fix`/,
    );
  });

  it("says why when the chief can't say hello, and says nothing when it has before", async () => {
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
        'default',
        'Default',
        'direct',
        'claude-opus-5-5',
        false,
        'service',
        'done',
      ]),
      registry: registry(),
      actions,
    });
    greeting = { ok: false, message: 'Slack refused the message: not_in_channel' };
    const failed = scriptedUi(['done']);
    await setup({ home, env, ui: failed, registry: registry(), actions });
    expect(failed.shown.find((x) => x.kind === 'warn')?.message).toBe(
      "Your chief of staff couldn't say hello in chat: Slack refused the message: not_in_channel. See what's wrong with: wheems doctor",
    );
    greeting = { ok: true, message: '', skipped: true };
    const quiet = scriptedUi(['done']);
    await setup({ home, env, ui: quiet, registry: registry(), actions });
    expect(quiet.shown.filter((x) => x.kind === 'warn' || x.kind === 'success')).toEqual([]);
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
    expect(again.shown.some((s) => s.message.includes('Connected as wheems in Home'))).toBe(true);
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
            ? Promise.resolve({ team: 'Home', botUser: 'wheems' })
            : Promise.resolve({ team: 'Work', botUser: 'wheems' }),
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

  it('installs an engine and signs in, then runs a workspace on it', async () => {
    const ui = scriptedUi([
      'engines',
      'codex',
      true, // install it
      true, // sign in
      'channels',
      'slack',
      false,
      'xoxb-good',
      'xapp-good',
      'UMEMBER1',
      'workspaces',
      'work',
      'Work',
      'direct',
      'codex', // which engine runs its chief of staff
      'gpt-6.1-sol',
      false, // don't mark the install folder trusted (for Claude Code and Codex)
      'done',
      true, // nothing answers in chat yet: start the service
    ]);
    await setup({ home, env, ui, registry: registry(), actions });
    expect(ui.remaining()).toBe(0);
    expect(calls.filter((c) => c.startsWith('run'))).toEqual([
      'run npm install -g codex-cli',
      'run codex login',
    ]);
    // Done, with a chat channel and no service, offers to start it rather than go quiet.
    expect(calls.slice(-2)).toEqual(['install service', 'greet']);
    const which = ui.shown.find((s) => s.message === 'Which engine?');
    expect(which?.choices?.map((c) => [c.value, c.hint])).toEqual([
      ['claude-code', '1.0.0 · signed in'],
      ['codex', 'not installed · x'],
    ]);
    const install = await loadInstall(home);
    expect(install.problems).toEqual([]);
    expect(install.config?.accounts['chatgpt-subscription']).toEqual({ driver: 'chatgpt' });
    const work = install.workspaces.find((w) => w.id === 'work');
    expect(work?.config?.accounts).toEqual(['chatgpt-subscription']);
    expect(work?.agents[0]?.definition).toMatchObject({
      engine: 'codex',
      model: 'gpt-6.1-sol',
      account: 'chatgpt-subscription',
    });
    expect(crossCheck(install, { engines: ['claude-code', 'codex'] })).toEqual([]);
  });

  it('skips the trust step when the engine already trusts the install folder', async () => {
    trustedFolders.add(home);
    const ui = scriptedUi([
      'channels',
      'slack',
      false,
      'xoxb-good',
      'xapp-good',
      'UMEMBER1',
      'workspaces',
      'default',
      'Default',
      'direct',
      'claude-opus-5-5', // no trust question follows
      'done',
      false, // don't start the service
    ]);
    await setup({ home, env, ui, registry: registry(), actions });
    expect(ui.remaining()).toBe(0);
    expect(calls.filter((c) => c.startsWith('run'))).toEqual([]);
    expect(ui.shown.some((s) => s.kind === 'info' && s.message.includes('wheems start'))).toBe(
      true,
    );
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
        'default',
        'Default',
        'direct',
        'claude-opus-5-5',
        CANCEL,
        'done',
        false, // don't start the service
      ]),
      registry: registry(),
      actions,
    });
    expect((await loadInstall(home)).workspaces.map((w) => w.id)).toEqual(['default']);
    expect(calls).not.toContain('install service');
  });

  it('goes back to the menu when a step is cancelled, saving nothing from it', async () => {
    const ui = scriptedUi(['channels', 'slack', CANCEL, 'done']);
    await setup({ home, env, ui, registry: registry(), actions });
    expect(
      ui.shown.some((s) => s.kind === 'warn' && s.message.includes('nothing from it was saved')),
    ).toBe(true);
    expect(await readSecrets(env.WHEEMS_SECRETS!)).toEqual({});
  });

  describe('the Knowledge section', () => {
    let models: string[] | null;
    const withOllama = () =>
      registry().register('embeddings', 'ollama', () => new HashEmbeddings(), {
        label: 'Ollama',
        description: 'runs an embedding model on this machine, free',
        embeddings: {
          defaultModel: 'nomic-embed-text',
          installHint: 'Install Ollama from https://ollama.com',
          models: () => Promise.resolve(models === null ? null : [...models]),
          pull: (model) => ['ollama', 'pull', model],
        },
      });
    const pullingActions = {
      ...actions,
      run: (command: string[]) => {
        calls.push(`run ${command.join(' ')}`);
        if (command[1] === 'pull' && models !== null) models.push(`${command[2] ?? ''}:latest`);
        return Promise.resolve(0);
      },
    };
    const embeddingsIn = async () => (await loadInstall(home)).config?.knowledge.embeddings;

    it('says how to get Ollama when it is not answering, and changes nothing', async () => {
      models = null;
      const ui = scriptedUi(['knowledge', 'ollama', 'done']);
      await setup({ home, env, ui, registry: withOllama(), actions: pullingActions });
      expect(ui.shown.some((s) => s.kind === 'warn' && s.message.includes('ollama.com'))).toBe(
        true,
      );
      expect(await embeddingsIn()).toBeUndefined();
    });

    it('uses the model Ollama already has, under whatever tag', async () => {
      models = ['llama3.2:latest', 'nomic-embed-text:v1.5'];
      const ui = scriptedUi(['knowledge', 'ollama', 'done']);
      await setup({ home, env, ui, registry: withOllama(), actions: pullingActions });
      expect(calls.filter((c) => c.startsWith('run'))).toEqual([]);
      expect(await embeddingsIn()).toEqual({ driver: 'ollama', model: 'nomic-embed-text:v1.5' });
      expect(crossCheck(await loadInstall(home))).toEqual([]);
    });

    it('offers to download the model, then turns search by meaning off again', async () => {
      models = [];
      await setup({
        home,
        env,
        ui: scriptedUi(['knowledge', 'ollama', true, 'done']),
        registry: withOllama(),
        actions: pullingActions,
      });
      expect(calls).toContain('run ollama pull nomic-embed-text');
      expect(await embeddingsIn()).toEqual({ driver: 'ollama', model: 'nomic-embed-text:latest' });

      const ui = scriptedUi(['knowledge', 'keyword', 'done']);
      await setup({ home, env, ui, registry: withOllama(), actions: pullingActions });
      expect(await embeddingsIn()).toBeUndefined();
      expect(readFileSync(join(home, 'install.yaml'), 'utf8')).not.toContain('ollama');
    });

    it('leaves things as they were when the download is declined', async () => {
      models = [];
      await setup({
        home,
        env,
        ui: scriptedUi(['knowledge', 'ollama', false, 'done']),
        registry: withOllama(),
        actions: pullingActions,
      });
      expect(calls.filter((c) => c.startsWith('run'))).toEqual([]);
      expect(await embeddingsIn()).toBeUndefined();
    });
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
        'default',
        'Default',
        'direct',
        'claude-opus-5-5',
        false,
        'workspaces',
        'acme',
        'Acme: UK',
        '#acme-chat',
        'claude-opus-5-5',
        false,
        'done',
        false, // don't start the service
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

describe('wheems init', () => {
  let home: string;
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'wheems-init-'));
    await setupMinimal(home);
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('creates a workspace that validates, chatting in direct messages by default', async () => {
    const dir = await initWorkspace({ home, id: 'default' });
    expect(dir).toBe(join(home, 'workspaces', 'default'));
    const install = await loadInstall(home);
    expect(install.problems).toEqual([]);
    expect(crossCheck(install).filter((p) => p.level === 'error')).toEqual([]);
    const workspace = install.workspaces[0]!;
    expect(workspace.config).toMatchObject({
      name: 'Default',
      channels: { chat: { connection: 'slack', direct: true } },
    });
    expect(workspace.agents[0]?.definition).toMatchObject({
      name: 'chief-of-staff',
      engine: 'claude-code',
      permissions: 'auto',
    });
  });

  it('gives a second workspace a channel, because only one can have direct messages', async () => {
    await initWorkspace({ home, id: 'default' });
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
    await initWorkspace({ home, id: 'default' });
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
    await initWorkspace({ home, id: 'default' });
    await expect(initWorkspace({ home, id: 'default' })).rejects.toThrow(/already exists/);
    await expect(initWorkspace({ home: join(home, 'nowhere'), id: 'x' })).rejects.toThrow(
      /Run wheems setup first/,
    );
  });

  it('flags two workspaces claiming the same direct messages', async () => {
    await initWorkspace({ home, id: 'default' });
    await initWorkspace({ home, id: 'work', channel: 'work-chat' });
    const file = join(home, 'workspaces', 'work', 'workspace.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('channel: "work-chat"', 'direct: true'));
    const errors = crossCheck(await loadInstall(home)).filter((p) => p.level === 'error');
    expect(errors.map((e) => e.message)).toEqual([
      'Channel "chat" uses direct messages on "slack", which workspace "default" already has',
    ]);
  });
});

describe('launchd', () => {
  it('counts a job as gone only when launchd says it has no such job', () => {
    const notFound =
      'Bad request.\nCould not find service "dev.wheems.service" in domain for user gui: 501\n';
    expect(jobAbsent({ code: 113, stdout: '', stderr: notFound })).toBe(true);
    expect(jobAbsent({ code: 1, stdout: notFound, stderr: '' })).toBe(true);
    // A timeout or any other failure says nothing about whether it stopped.
    expect(jobAbsent({ code: null, stdout: '', stderr: '' })).toBe(false);
    expect(jobAbsent({ code: 5, stdout: '', stderr: 'Input/output error' })).toBe(false);
  });

  it('reads back the install folder a plist was written for, so a restart keeps it', () => {
    const plist = renderPlist({
      node: '/opt/homebrew/opt/node@22/bin/node',
      cli: '/x/dist/cli/main.js',
      home: '/Users/me/Work & "Play"/wheems',
      logFile: '/Users/me/wheems/.wheems/logs/service.log',
    });
    expect(homeInPlist(plist)).toBe('/Users/me/Work & "Play"/wheems');
    expect(homeInPlist('<plist><dict></dict></plist>')).toBeNull();
  });

  it('writes a user agent that runs the service and restarts it', () => {
    const plist = renderPlist({
      node: '/opt/homebrew/opt/node@22/bin/node',
      cli: '/Users/me/Projects/wheems/dist/cli/main.js',
      home: '/Users/me/wheems & co',
      logFile: '/Users/me/wheems/.wheems/logs/service.log',
    });
    expect(plist).toContain('<string>dev.wheems.service</string>');
    // Without it, launchd throttles the job's CPU and disk, and it takes seconds to start.
    expect(plist).toContain('<key>ProcessType</key>\n  <string>Interactive</string>');
    expect(plist).toContain(
      '<string>/opt/homebrew/opt/node@22/bin/node</string>\n    <string>/Users/me/Projects/wheems/dist/cli/main.js</string>\n    <string>service</string>\n    <string>run</string>',
    );
    expect(plist).toContain('<string>/Users/me/wheems &amp; co</string>');
    expect(plist).toMatch(/<key>PATH<\/key>\s*<string>\/opt\/homebrew\/opt\/node@22\/bin:/);
    expect(plist).toContain('<key>KeepAlive</key>\n  <true/>');
  });

  it('reads launchctl print', () => {
    expect(
      parseLaunchctlPrint(
        'gui/501/dev.wheems.service = {\n\tstate = running\n\tpid = 4242\n\tlast exit code = 0\n}',
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
      // The skill that tells agents how to use hc names it in its text, but never runs it.
      if (f === join('drivers', 'runtime', 'herdr', 'agent-skill.ts')) return false;
      return /['"`]hc['"`]/.test(readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'));
    });
    expect(offenders).toEqual([]);
  });
});

async function setupMinimal(home: string): Promise<void> {
  const { installYaml } = await import('../src/cli/templates.js');
  writeFileSync(join(home, 'install.yaml'), installYaml());
}
