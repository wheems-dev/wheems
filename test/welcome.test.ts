import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initWorkspace } from '../src/cli/commands/init.js';
import { defaultIo, packageVersion, run } from '../src/cli/program.js';
import { installYaml } from '../src/cli/templates.js';
import { CLOUD, renderWelcome, TAGLINE, welcomeStatus } from '../src/cli/welcome.js';
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
    expect(lines[5]).toMatch(/█ {3,}wheems 0\.0\.1$/);
    expect(lines[6]).toMatch(new RegExp(`${TAGLINE.replace('.', '\\.')}$`));
    expect(text).toContain('\n✓ The service is running\n! Something to do\n');
    expect(text).toMatch(/wheems setup · wheems doctor · wheems --help\n$/);
    expect(text).not.toContain('\x1b[');
  });

  it('colours the cloud and the marks only when asked', () => {
    const text = renderWelcome({ version: '0.0.1', status: [], color: true, hints: false });
    expect(text).toContain('\x1b[38;5;69m            ▄▄██▄▄▄\x1b[0m');
    expect(text).not.toContain('wheems setup ·');
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
