import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initWorkspace } from '../src/cli/commands/init.js';
import { installYaml } from '../src/cli/templates.js';
import { DriverRegistry } from '../src/contracts/registry.js';
import type { EngineSetup } from '../src/contracts/setup.js';
import { runDoctor, type DoctorFixes, type DoctorReport } from '../src/doctor/doctor.js';
import { offerFixes } from '../src/doctor/fix.js';
import { writeSecret } from '../src/secrets.js';
import { MemoryChannel, MemoryRuntime, StubEngine } from '../src/testing/index.js';

/** A channel driver that sees some channels by name, as Slack does, and is in all of them. */
class SeesChannels extends MemoryChannel {
  readonly listChannels: () => Promise<{ id: string; name: string }[]>;
  constructor(visible: Record<string, string>) {
    super({}, { channels: visible });
    this.listChannels = () =>
      Promise.resolve(Object.entries(visible).map(([name, id]) => ({ id, name })));
  }
  isMember() {
    return Promise.resolve(true);
  }
}

describe('wheems doctor --fix', () => {
  let home: string;
  let env: Record<string, string>;
  let calls: string[];
  let trusted: boolean;
  let answering: boolean;
  let fixes: DoctorFixes;

  const claudeSetup: EngineSetup = {
    version: () => Promise.resolve('1.0.0'),
    install: ['npm', 'install', '-g', 'claude'],
    signIn: ['claude', 'login'],
    signedIn: () => Promise.resolve(true),
    trust: ['claude'],
    trusted: () => Promise.resolve(trusted),
    markTrusted: (dir) => {
      calls.push(`mark ${dir}`);
      trusted = true;
      return Promise.resolve('marked');
    },
    trustRecord: '~/.claude.json',
    defaultModel: 'claude-opus-5-5',
    account: { name: 'claude-subscription', driver: 'claude' },
  };

  const registry = (channel = new MemoryChannel()) =>
    new DriverRegistry()
      .register('engine', 'claude-code', () => new StubEngine({ name: 'claude-code' }), {
        label: 'Claude Code',
        description: 'x',
        engine: claudeSetup,
      })
      .register('runtime', 'herdr', () => new MemoryRuntime({}))
      .register('channel', 'slack', () => channel);

  const doctor = (channel?: MemoryChannel, withFixes = true): Promise<DoctorReport> =>
    runDoctor({
      home,
      registry: registry(channel),
      env,
      quick: true,
      service: () => Promise.resolve({ installed: false, answering }),
      ...(withFixes && { fixes }),
    });

  /** Runs the fixes, answering each question from the script. */
  const fix = async (report: DoctorReport, answers: boolean[]) => {
    let out = '';
    const asked: string[] = [];
    const result = await offerFixes(report, {
      ask: (question) => {
        asked.push(question);
        return Promise.resolve(answers.shift() ?? false);
      },
      out: (text) => (out += text),
    });
    return { ...result, out, asked };
  };

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'wheems-fix-'));
    env = { WHEEMS_SECRETS: join(home, 'secrets.json') };
    writeFileSync(
      join(home, 'install.yaml'),
      installYaml().replace('allowed_users: []', 'allowed_users: [UME]'),
    );
    await initWorkspace({ home, id: 'personal' });
    await initWorkspace({ home, id: 'team', channel: 'team-chta' });
    await writeSecret(join(home, 'secrets.json'), 'slack', {
      bot_token: 'xoxb-x',
      app_token: 'xapp-x',
    });
    calls = [];
    trusted = false;
    answering = false;
    fixes = {
      startService: () => {
        calls.push('start service');
        answering = true;
        return Promise.resolve(true);
      },
      run: (command, cwd) => {
        calls.push(`run ${command.join(' ')} in ${cwd}`);
        trusted = true;
        return Promise.resolve(0);
      },
      reindex: (workspace) => {
        calls.push(`reindex ${workspace}`);
        return Promise.resolve();
      },
    };
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('says what each fix will do, asks first, and does only those it was told to', async () => {
    const channel = new SeesChannels({ 'team-chat': 'C0TEAM0001' });
    const report = await doctor(channel);
    const result = await fix(report, [true, true, false]);
    expect(result.asked).toEqual([
      // Marking the install folder trusted covers both workspaces and their sessions: asked once.
      `Mark ${home} as trusted for Claude Code in ~/.claude.json, the entry Claude Code writes when you say yes to its question, changing nothing else there. That covers every workspace and session. Do it?`,
      "Change team's chat channel in workspace.yaml from team-chta to #team-chat, a channel the app can see. Do it?",
      'Start the service, now and at every login, as wheems start does. Do it?',
    ]);
    expect(calls).toEqual([`mark ${home}`]);
    expect(result.out).toContain('Claude Code trusts the install folder now.');
    expect(result.out).toContain('team now chats in #team-chat. Restart the service to use it');
    expect(result.out).toContain('Left as it is.');
    expect(result).toMatchObject({ fixed: 2, offered: 3 });
    expect(readFileSync(join(home, 'workspaces', 'team', 'workspace.yaml'), 'utf8')).toContain(
      'channel: "team-chat"',
    );
    // Asked again, the fixed ones pass, and the service is still offered.
    const again = await fix(await doctor(channel), [true]);
    expect(again.asked).toEqual([
      'Start the service, now and at every login, as wheems start does. Do it?',
    ]);
    expect(calls.at(-1)).toBe('start service');
  });

  it('fixes nothing without a yes, and offers nothing without being asked to fix', async () => {
    const result = await fix(await doctor(), []);
    expect(result.fixed).toBe(0);
    expect(calls).toEqual([]);
    const plain = await doctor(undefined, false);
    expect(plain.sections.flatMap((s) => s.checks).some((c) => 'fix' in c)).toBe(false);
  });

  it('offers a restart when conversations.json still waits to be imported', async () => {
    trusted = true;
    answering = true;
    mkdirSync(join(home, '.wheems'), { recursive: true });
    writeFileSync(join(home, '.wheems', 'conversations.json'), '{}');
    const result = await fix(await doctor(new SeesChannels({ 'team-chta': 'C0TEAM0001' })), [true]);
    expect(result.asked).toEqual(['Restart the service, which imports it. Do it?']);
    expect(calls).toEqual(['start service']);
  });

  it('offers no channel fix when no channel the app sees is close to the name', async () => {
    const channel = new SeesChannels({ general: 'C0GENERAL1' });
    trusted = true;
    answering = true;
    const result = await fix(await doctor(channel), []);
    expect(result.offered).toBe(0);
    expect(result.out).toContain('Nothing here that doctor can fix by itself.');
  });
});
