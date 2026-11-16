import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { workspaceHere } from '../src/cli/caller.js';
import { COMMAND_GROUPS, createProgram, defaultIo, run, type Io } from '../src/cli/program.js';
import { installYaml } from '../src/cli/templates.js';
import { DriverRegistry } from '../src/contracts/registry.js';
import type { EngineSetup } from '../src/contracts/setup.js';
import { slackManifest } from '../src/drivers/channel/slack/setup.js';
import { paths } from '../src/home.js';
import { writeSecret } from '../src/secrets.js';
import { StateStore, sessionLabels } from '../src/state/store.js';
import { MemoryChannel, MemoryRuntime, StubEngine } from '../src/testing/index.js';

describe('wheems areas', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let runtime: MemoryRuntime;

  const engine: EngineSetup = {
    version: () => Promise.resolve('2.1.0'),
    install: ['npm', 'install', '-g', 'claude'],
    signIn: ['claude', 'login'],
    signedIn: () => Promise.resolve(false),
    trust: ['claude'],
    trusted: () => Promise.resolve(true),
    defaultModel: 'claude-opus-5-5',
    account: { name: 'claude-subscription', driver: 'claude' },
  };

  const registry = () =>
    new DriverRegistry()
      .register('runtime', 'herdr', () => runtime)
      .register('engine', 'claude-code', () => new StubEngine({ name: 'claude-code' }), {
        label: 'Claude Code',
        description: 'x',
        engine,
      })
      .register('channel', 'slack', () => new MemoryChannel(), {
        label: 'Slack',
        description: 'chat in Slack',
        manifest: () => slackManifest(),
      });

  const io = (capture: { out: string; err: string }): Io => ({
    ...defaultIo(),
    out: (t) => (capture.out += t),
    err: (t) => (capture.err += t),
    env,
    color: false,
    registry,
  });

  const wheems = async (...args: string[]) => {
    const capture = { out: '', err: '' };
    const previous = process.exitCode;
    process.exitCode = undefined;
    try {
      const code = await run(args, io(capture));
      return { code, ...capture };
    } finally {
      process.exitCode = previous;
    }
  };

  let root: string;

  beforeEach(() => {
    // The install sits three folders deep in a folder of its own, so even a path that escapes
    // the install (as `workspace remove ../..` once could) stays inside this test's own folder.
    root = mkdtempSync(join(tmpdir(), 'wa-'));
    home = join(root, 'a', 'b', 'install');
    mkdirSync(home, { recursive: true });
    env = { WHEEMS_HOME: home, WHEEMS_SECRETS: join(home, 'secrets.json') };
    writeFileSync(join(home, 'install.yaml'), installYaml());
    runtime = new MemoryRuntime({
      agent: () => ({ start: () => undefined, input: () => undefined }),
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps the top level to the commands meant for it, each in a group', () => {
    const program = createProgram(io({ out: '', err: '' }));
    const visible = program
      .createHelp()
      .visibleCommands(program)
      .map((c) => c.name())
      .filter((name) => name !== 'help');
    // A new top-level command goes under an area instead, or into COMMAND_GROUPS on purpose.
    expect(visible.sort()).toEqual(Object.keys(COMMAND_GROUPS).sort());
  });

  it('lists every command by area, as php artisan list does', async () => {
    const { out } = await wheems('list');
    expect(out).toMatch(/^Start here\n/);
    expect(out).toMatch(/\n {2}setup +Set up Wheems/);
    expect(out).toMatch(/Areas: wheems <area> <action>\n {2}workspace \(ws\)\n {4}workspace list/);
    expect(out).toMatch(/ {4}workspace archive +Stop serving a workspace/);
    expect(out).toMatch(/ {4}channel manifest/);
    // Full words, with the longest action still clear of its description.
    expect(out).toMatch(/ {4}knowledgebase search +Search/);
    expect(out).toMatch(/ {4}configuration validate +Validate/);
    expect(out).not.toMatch(/^ {2}(kb|config)\b/m);
    expect(out).not.toMatch(/^ {2}(init|validate|slack) /m);
  });

  describe('workspace (ws)', () => {
    it('creates, lists, shows and renames workspaces', async () => {
      // ws is its short alias.
      expect((await wheems('ws', 'create', 'personal')).code).toBe(0);
      const created = await wheems('workspace', 'create', 'team', '--channel', 'team-chat');
      expect(created.out).toContain('Created');
      // The old name still works, and says what it's called now.
      const old = await wheems('init', 'side', '--channel', 'side-chat');
      expect(old.err).toBe('wheems init is now wheems workspace create.\n');

      const list = await wheems('workspace', 'list');
      expect(list.out).toContain(
        'personal  Personal\n  direct messages on slack, chief on claude-code (claude-opus-5-5)',
      );
      expect(list.out).toContain('team  Team\n  #team-chat on slack');
      const json = JSON.parse((await wheems('workspace', 'list', '--json')).out) as {
        id: string;
      }[];
      expect(json.map((w) => w.id)).toEqual(['personal', 'side', 'team']);

      const show = await wheems('workspace', 'show', 'team');
      expect(show.out).toContain('team: Team\n');
      expect(show.out).toContain('Agents: chief-of-staff (chief of staff) on claude-code');
      expect(show.out).toContain('Knowledge: 0 pages, 0 notes filed, 0 waiting in the inbox');
      expect((await wheems('workspace', 'show', 'nope')).err).toContain('No workspace nope');

      await wheems('workspace', 'rename', 'team', 'Team Two');
      const yaml = readFileSync(join(home, 'workspaces', 'team', 'workspace.yaml'), 'utf8');
      expect(yaml).toContain('name: "Team Two"');
      expect(yaml).toContain('name: "Team Two chief of staff"');
    });

    it('archives a workspace, stopping its sessions, and restores it', async () => {
      await wheems('workspace', 'create', 'team', '--channel', 'team-chat');
      await runtime.start({
        name: 'team-abc',
        command: ['agent'],
        cwd: home,
        env: {},
        labels: sessionLabels('s1', 'team'),
      });
      mkdirSync(join(paths(home, env).index, 'team'), { recursive: true });
      // Without a terminal, it asks for --yes rather than act unasked.
      expect((await wheems('workspace', 'archive', 'team')).err).toContain('Add --yes');
      expect(existsSync(join(home, 'workspaces', 'team'))).toBe(true);

      const archived = await wheems('workspace', 'archive', 'team', '--yes');
      expect(archived.out).toContain('Archived team to');
      expect(archived.out).toContain('1 session stopped');
      expect(existsSync(join(home, 'workspaces', 'team'))).toBe(false);
      expect(existsSync(join(home, 'archive', 'team', 'workspace.yaml'))).toBe(true);
      expect(existsSync(join(paths(home, env).index, 'team'))).toBe(false);
      expect(await runtime.list({ labels: { workspace: 'team' } })).toEqual([]);
      expect((await wheems('workspace', 'list', '--archived')).out).toMatch(
        /^team {2}archived \d{4}-/,
      );

      expect((await wheems('workspace', 'restore', 'team')).out).toContain('Restored team');
      expect(existsSync(join(home, 'workspaces', 'team', 'workspace.yaml'))).toBe(true);
      expect(existsSync(join(home, 'workspaces', 'team', '.archived.json'))).toBe(false);
      // Archived again, it doesn't overwrite the first archive.
      await wheems('workspace', 'archive', 'team', '--yes');
      expect((await wheems('workspace', 'restore', 'team')).code).toBe(0);
    });

    it('removes a workspace for good: its folder, state and records', async () => {
      await wheems('workspace', 'create', 'personal');
      await wheems('workspace', 'create', 'team', '--channel', 'team-chat');
      const where = paths(home, env);
      for (const dir of [
        join(where.index, 'team'),
        join(where.state, 'sessions', 'team'),
        join(where.state, 'messages', 'team'),
      ]) {
        mkdirSync(dir, { recursive: true });
      }
      const state = await StateStore.open(where.store);
      for (const workspace of ['team', 'personal']) {
        state.workspace(workspace).create({
          id: `s-${workspace}`,
          project: null,
          agent: `${workspace}/chief-of-staff`,
          owner: null,
          parent: null,
          title: 'Research',
          purpose: 'Research things',
          ask: null,
          herdrName: `${workspace}-s1`,
          folder: home,
          createdAt: new Date().toISOString(),
        });
      }
      state.close();

      expect((await wheems('workspace', 'remove', 'team')).err).toContain('Add --yes');
      expect((await wheems('workspace', 'remove', 'team', '--yes')).out).toBe('Removed team.\n');
      expect(existsSync(join(home, 'workspaces', 'team'))).toBe(false);
      for (const dir of ['index', 'sessions', 'messages']) {
        expect(
          existsSync(dir === 'index' ? join(where.index, 'team') : join(where.state, dir, 'team')),
        ).toBe(false);
      }
      const after = await StateStore.open(where.store, { readOnly: true });
      expect(after.workspace('team').sessions()).toEqual([]);
      expect(after.workspace('personal').sessions()).toHaveLength(1);
      after.close();
      expect((await wheems('workspace', 'remove', 'team', '--yes')).err).toContain(
        'No workspace team',
      );
    });

    it('refuses an id that is a path, and leaves everything as it is', async () => {
      await wheems('workspace', 'create', 'team', '--channel', 'team-chat');
      // Each would resolve inside this test's own folder, never above it.
      for (const id of ['../..', '..', 'team/../..', '/abs']) {
        const result = await wheems('workspace', 'remove', id, '--yes');
        expect(result.err).toContain("isn't a workspace id");
      }
      expect((await wheems('workspace', 'archive', '../team', '--yes')).err).toContain(
        "isn't a workspace id",
      );
      expect(existsSync(join(home, 'install.yaml'))).toBe(true);
      expect(existsSync(join(home, 'workspaces', 'team'))).toBe(true);
    });

    it("moves nothing when a session can't be stopped, or Herdr can't be asked", async () => {
      await wheems('workspace', 'create', 'team', '--channel', 'team-chat');
      await runtime.start({
        name: 'team-abc',
        command: ['agent'],
        cwd: home,
        env: {},
        labels: sessionLabels('s1', 'team'),
      });
      const stop = runtime.stop.bind(runtime);
      runtime.stop = () => Promise.reject(new Error('Herdr is busy'));
      expect((await wheems('workspace', 'archive', 'team', '--yes')).err).toContain(
        'Herdr is busy',
      );
      expect(existsSync(join(home, 'workspaces', 'team'))).toBe(true);
      runtime.stop = stop;
      const list = runtime.list.bind(runtime);
      runtime.list = () => Promise.reject(new Error('hc is not answering'));
      expect((await wheems('workspace', 'remove', 'team', '--yes')).err).toContain(
        'hc is not answering',
      );
      expect(existsSync(join(home, 'workspaces', 'team'))).toBe(true);
      runtime.list = list;
      expect((await wheems('workspace', 'archive', 'team', '--yes')).code).toBe(0);
    });

    it('removes an archived workspace too', async () => {
      await wheems('workspace', 'create', 'team', '--channel', 'team-chat');
      await wheems('workspace', 'archive', 'team', '--yes');
      expect((await wheems('workspace', 'remove', 'team', '--yes')).code).toBe(0);
      expect(existsSync(join(home, 'archive', 'team'))).toBe(false);
    });
  });

  describe('the agents’ commands', () => {
    it('are under their areas, and the old names still work, saying what they’re called now', async () => {
      const program = createProgram(io({ out: '', err: '' }));
      const help = program.createHelp();
      const chat = program.commands.find((c) => c.name() === 'chat');
      expect(help.visibleCommands(chat!).map((c) => c.name())).toContain('reply');
      const knowledgebase = program.commands.find((c) => c.name() === 'knowledgebase');
      expect(help.visibleCommands(knowledgebase!).map((c) => c.name())).toContain('note');
      // kb, its old name, still works for agents' prompts and skills, but isn't listed.
      expect(help.visibleCommands(program).map((c) => c.name())).not.toContain('kb');
      const session = program.commands.find((c) => c.name() === 'session');
      const actions = help.visibleCommands(session!).map((c) => c.name());
      expect(actions).toContain('create');
      expect(actions).not.toContain('new');
      // Outside a session they refuse, after saying what they're called now.
      const reply = await wheems('reply', 'hi');
      expect(reply.err).toContain('wheems reply is now wheems chat reply.\n');
      expect(reply.err).toContain('wheems reply works inside a session started by Wheems');
      expect((await wheems('note', 'x')).err).toContain(
        'wheems note is now wheems knowledgebase note.\n',
      );
      expect((await wheems('knowledgebase', 'note', 'x')).err).toContain(
        'wheems knowledgebase note works inside a session started by Wheems',
      );
      const kb = await wheems('kb', 'note', 'x');
      expect(kb.err).toContain('wheems kb is now wheems knowledgebase.\n');
      expect(kb.err).toContain('wheems kb note works inside a session started by Wheems');
      expect((await wheems('session', 'new', '--title', 't', '--purpose', 'p')).err).toContain(
        'wheems session new is now wheems session create.\n',
      );
    });
  });

  describe('the workspace from the folder you’re in', () => {
    it('is the default for --workspace, but never inside a session', async () => {
      await wheems('workspace', 'create', 'personal');
      await wheems('workspace', 'create', 'team', '--channel', 'team-chat');
      const here = (cwd: string, extra: NodeJS.ProcessEnv = {}) =>
        workspaceHere({ env: { ...env, ...extra }, cwd: () => cwd }, home);
      expect(here(join(home, 'workspaces', 'team'))).toBe('team');
      expect(here(join(home, 'workspaces', 'team', 'knowledge', 'pages'))).toBe('team');
      expect(here(join(home, 'workspaces'))).toBeUndefined();
      expect(here(home)).toBeUndefined();
      expect(here(join(home, '..'))).toBeUndefined();
      expect(here(join(home, 'workspaces', 'team'), { WHEEMS_SESSION: 's1' })).toBeUndefined();
      // knowledgebase search takes it: no --workspace needed in a workspace's folder, though there are two.
      const capture = { out: '', err: '' };
      await run(['knowledgebase', 'search', 'anything'], {
        ...io(capture),
        cwd: () => join(home, 'workspaces', 'team'),
      });
      expect(capture.err).not.toContain('Say which workspace');
      const elsewhere = await wheems('knowledgebase', 'search', 'anything');
      expect(elsewhere.err).toContain('Say which workspace');
    });
  });

  describe('channel and engine', () => {
    it('prints a driver’s manifest, and still takes wheems slack manifest', async () => {
      expect((await wheems('channel', 'manifest', 'slack')).out).toBe(slackManifest());
      const old = await wheems('slack', 'manifest');
      expect(old.out).toBe(slackManifest());
      expect(old.err).toBe('wheems slack manifest is now wheems channel manifest slack.\n');
      expect((await wheems('channel', 'manifest', 'nope')).err).toContain('No channel driver');
    });

    it('lists the connections and who chats where', async () => {
      await wheems('workspace', 'create', 'personal');
      const before = await wheems('channel', 'list');
      expect(before.out).toContain('slack (slack): not connected: wheems channel connect slack');
      await writeSecret(env.WHEEMS_SECRETS!, 'slack', { bot_token: 'x', app_token: 'y' });
      const rows = JSON.parse((await wheems('channel', 'list', '--json')).out) as unknown[];
      expect(rows).toEqual([
        {
          name: 'slack',
          driver: 'slack',
          connected: true,
          allowedUsers: 0,
          workspaces: [{ id: 'personal', where: 'direct messages' }],
        },
      ]);
    });

    it('lists the engines, with what each needs next', async () => {
      const { out } = await wheems('engine', 'list');
      expect(out).toBe(
        'claude-code  2.1.0, not signed in: wheems engine login claude-code, trusts the install\n',
      );
    });
  });
});
