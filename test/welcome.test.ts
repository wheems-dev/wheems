import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initWorkspace } from '../src/cli/commands/init.js';
import { defaultIo, packageVersion, run } from '../src/cli/program.js';
import { installYaml } from '../src/cli/templates.js';
import {
  canWink,
  CLOUD,
  HIDE_CURSOR,
  renderWelcome,
  SHOW_CURSOR,
  showCloud,
  TAGLINE,
  WELCOME_WIDTH,
  welcomeStatus,
  wink,
  WINK_TIMING,
} from '../src/cli/welcome.js';
import { proposeSkill } from '../src/skills/proposals.js';

describe('the welcome screen', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'wheems-welcome-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('draws the cloud with the name and tagline beside it, then the status', () => {
    const text = renderWelcome({
      version: '0.0.1',
      status: [
        { mark: '✓', text: 'The service is running' },
        { mark: '!', text: 'Something to do' },
      ],
      color: false,
    });
    const lines = text.split('\n');
    CLOUD.forEach((row, i) => {
      expect(lines[i + 1]?.startsWith(row), `row ${String(i)}`).toBe(true);
    });
    expect(lines[5]).toMatch(/[█▀▄] {3,}wheems 0\.0\.1$/);
    expect(lines[6]).toMatch(new RegExp(`${TAGLINE.replace('.', '\\.')}$`));
    expect(text).toContain('\n✓ The service is running\n! Something to do\n');
    expect(text).toMatch(/wheems setup · wheems doctor · wheems --help\n$/);
    expect(text).not.toContain('\x1b[');
  });

  it('colours the cloud and the marks only when asked', () => {
    const text = renderWelcome({ version: '0.0.1', status: [], color: true, hints: false });
    expect(text).toContain(`\x1b[38;5;69m${CLOUD[0] ?? ''}\x1b[0m`);
    expect(text).not.toContain('wheems setup ·');
  });

  it('is an outline of one width, with a face', () => {
    const widths = new Set(CLOUD.map((row) => row.length));
    expect(Math.max(...widths)).toBe(24);
    expect(CLOUD).toHaveLength(10);
    // The eye and the smile sit inside the outline.
    expect(CLOUD[5]).toContain('  ██  ');
    expect(CLOUD[7]).toContain('▀▄▄▀');
  });

  it('leaves the cloud out when asked, keeping the name and tagline', () => {
    const text = renderWelcome({
      version: '0.0.1',
      status: [{ mark: '✓', text: 'The service is running' }],
      color: false,
      cloud: false,
    });
    expect(text).toBe(
      `\nwheems 0.0.1\n${TAGLINE}\n\n✓ The service is running\n\nwheems setup · wheems doctor · wheems --help\n`,
    );
  });

  it('draws the cloud only in a terminal wide enough for it', () => {
    expect(WELCOME_WIDTH).toBe(24 + 3 + TAGLINE.length);
    expect(showCloud(undefined)).toBe(false);
    expect(showCloud(WELCOME_WIDTH - 1)).toBe(false);
    expect(showCloud(WELCOME_WIDTH)).toBe(true);
    expect(showCloud(120)).toBe(true);
  });

  it('winks: shuts the eye, opens it, and redraws only that row', async () => {
    const written: string[] = [];
    const slept: number[] = [];
    await wink({
      version: '0.0.1',
      color: false,
      write: (t) => written.push(t),
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });
    expect(slept).toEqual([WINK_TIMING.before, WINK_TIMING.shut]);
    expect(written[0]).toBe(HIDE_CURSOR);
    expect(written.at(-1)).toBe(SHOW_CURSOR);
    // Five rows up from under the cloud is the eye's row, with the tagline beside it.
    const shut = ` ██▀  ▄▄           ▀█▄▄    ${TAGLINE}`;
    const open = ` ██▀  ██           ▀█▄▄    ${TAGLINE}`;
    expect(written[1]).toBe(`\x1b[5A\r\x1b[2K${shut}\x1b[5B\r`);
    expect(written[2]).toBe(`\x1b[5A\r\x1b[2K${open}\x1b[5B\r`);
    expect(written).toHaveLength(4);
  });

  it('gives the cursor back even if the wink fails', async () => {
    const written: string[] = [];
    await expect(
      wink({
        version: '0.0.1',
        color: false,
        write: (t) => written.push(t),
        sleep: () => Promise.reject(new Error('interrupted')),
      }),
    ).rejects.toThrow('interrupted');
    expect(written).toEqual([HIDE_CURSOR, SHOW_CURSOR]);
  });

  it('winks only for a person at a wide enough terminal', () => {
    expect(canWink(80, {})).toBe(true);
    expect(canWink(undefined, {})).toBe(false);
    expect(canWink(WELCOME_WIDTH - 1, {})).toBe(false);
    expect(canWink(80, { TERM: 'dumb' })).toBe(false);
    expect(canWink(80, { CI: 'true' })).toBe(false);
    expect(canWink(80, { WHEEMS_NO_ANIMATION: '1' })).toBe(false);
  });

  it('says to run setup when there is no install', async () => {
    expect(await welcomeStatus(join(home, 'nowhere'), { HOME: home })).toEqual([
      { mark: '!', text: 'No install at ~/nowhere yet: run wheems setup' },
    ]);
  });

  it("reports the install's workspaces, the service, search and what waits for review", async () => {
    writeFileSync(join(home, 'install.yaml'), installYaml());
    await initWorkspace({ home, id: 'personal' });
    const env = { HOME: '/elsewhere' };
    expect(await welcomeStatus(home, env, () => Promise.resolve(false))).toEqual([
      { mark: '✓', text: `1 workspace, 1 agent in ${home}` },
      { mark: '!', text: "The service isn't running: wheems service install" },
      { mark: '-', text: 'Search by keyword only (wheems setup → Knowledge for meaning)' },
    ]);

    writeFileSync(
      join(home, 'install.yaml'),
      `${installYaml()}knowledge:\n  embeddings: { driver: ollama, model: nomic-embed-text:v1.5 }\n`,
    );
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
    writeFileSync(join(home, '.wheems', 'review', 'about-you', 'n-personal.md'), '# About\n');
    const status = await welcomeStatus(home, env, () => Promise.resolve(true));
    expect(status.slice(1)).toEqual([
      { mark: '✓', text: 'The service is running' },
      { mark: '✓', text: 'Search by meaning with nomic-embed-text:v1.5' },
      { mark: '!', text: '2 things waiting for you: wheems review' },
    ]);
  });

  it('is what wheems shows with no command', async () => {
    let out = '';
    const code = await run([], {
      ...defaultIo(),
      out: (t) => (out += t),
      err: () => undefined,
      env: { WHEEMS_HOME: join(home, 'none'), HOME: home },
      color: false,
    });
    expect(code).toBe(0);
    expect(out).toContain(`wheems ${packageVersion()}`);
    expect(out).toContain('No install at ~/none yet: run wheems setup');
    // Not a terminal (no columns), so no cloud.
    expect(out).not.toContain(CLOUD[0]);
  });

  it('draws the cloud with no command in a wide terminal, and winks before the status', async () => {
    let out = '';
    await run([], {
      ...defaultIo(),
      out: (t) => (out += t),
      err: () => undefined,
      env: { WHEEMS_HOME: join(home, 'none'), HOME: home },
      color: false,
      columns: 80,
    });
    expect(out).toContain(CLOUD[0]);
    const shown = out.indexOf(SHOW_CURSOR);
    expect(out.indexOf(HIDE_CURSOR)).toBeGreaterThan(out.indexOf(CLOUD.at(-1) ?? ''));
    expect(shown).toBeLessThan(out.indexOf('No install at ~/none yet'));
  });

  it("doesn't wink for someone who has turned animation off", async () => {
    let out = '';
    await run([], {
      ...defaultIo(),
      out: (t) => (out += t),
      err: () => undefined,
      env: { WHEEMS_HOME: join(home, 'none'), HOME: home, WHEEMS_NO_ANIMATION: '1' },
      color: false,
      columns: 80,
    });
    expect(out).toContain(CLOUD[0]);
    expect(out).not.toContain('\x1b[');
  });

  it("still greets when the install can't be read, and says why", async () => {
    writeFileSync(join(home, 'install.yaml'), installYaml());
    await initWorkspace({ home, id: 'personal' });
    // An agent file nobody may read makes loading the install fail.
    const agent = join(home, 'workspaces', 'personal', 'agents', 'chief-of-staff.md');
    chmodSync(agent, 0o000);
    let out = '';
    let code: number;
    try {
      code = await run([], {
        ...defaultIo(),
        out: (t) => (out += t),
        err: () => undefined,
        env: { WHEEMS_HOME: home, HOME: home },
        color: false,
      });
    } finally {
      chmodSync(agent, 0o644);
    }
    expect(code).toBe(0);
    expect(out).toContain('Your crew, ready for work.');
    expect(out).toMatch(/! Couldn't read the install at .+Run wheems doctor\./);
  });
});
