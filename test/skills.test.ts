import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initWorkspace } from '../src/cli/commands/init.js';
import { runReview, type ReviewUi } from '../src/cli/commands/review.js';
import { defaultIo, run } from '../src/cli/program.js';
import { installYaml } from '../src/cli/templates.js';
import { crossCheck } from '../src/config/check.js';
import { loadInstall } from '../src/config/load.js';
import {
  approveAboutYou,
  approveSkill,
  declineAboutYou,
  lineDiff,
  listAboutYou,
  pinSkill,
  setAgentSkill,
} from '../src/review/review.js';
import {
  addVersion,
  checkSkillText,
  listLibrary,
  readOrigins,
  readSkill,
  skillFile,
} from '../src/skills/library.js';
import { listProposals, proposeSkill, type ProposeOptions } from '../src/skills/proposals.js';
import { HashEmbeddings } from '../src/testing/index.js';

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

const skill = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

const WEEKLY = skill(
  'weekly-report',
  'Writes the weekly report. Use when asked for a summary of the week.',
  'Read the git log for the last seven days and the brief, then list what shipped, what is blocked and what is next.',
);

describe('the skill library', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'wheems-skills-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('checks a SKILL.md, filling in a missing name and refusing a different one', () => {
    expect(checkSkillText('weekly-report', '---\ndescription: Does it.\n---\n\nSteps.\n')).toEqual({
      name: 'weekly-report',
      description: 'Does it.',
      body: 'Steps.',
    });
    expect(() => checkSkillText('weekly-report', 'Just steps.')).toThrow(/front matter/);
    expect(() => checkSkillText('weekly-report', skill('other', 'Does it.', 'Steps.'))).toThrow(
      /names "other"/,
    );
    expect(() => checkSkillText('Weekly', skill('Weekly', 'Does it.', 'Steps.'))).toThrow(
      /isn't a skill name/,
    );
    expect(() => checkSkillText('x', '---\nname: x\n---\n\nSteps.\n')).toThrow(/description/);
    expect(() => checkSkillText('x', '---\nname: x\ndescription: d\n---\n')).toThrow(
      /no instructions/,
    );
    expect(() =>
      checkSkillText('x', skill('x', 'd', 'Use the token xoxb-1234567890-abcdefghij.')),
    ).toThrow(/credential/);
  });

  it('keeps every version in a numbered folder, with who wrote each', async () => {
    const first = await addVersion(home, checkSkillText('weekly-report', WEEKLY), {
      written_by: 'agent',
      workspace: 'personal',
      agent: 'chief-of-staff',
      approved: '2026-11-13',
    });
    expect(first).toEqual({
      version: 1,
      changed: [
        'library/skills/weekly-report/1/SKILL.md',
        'library/skills/weekly-report/skill.yaml',
      ],
    });
    const second = await addVersion(
      home,
      checkSkillText('weekly-report', WEEKLY.replace('seven', 'eight')),
      { written_by: 'agent', approved: '2026-11-14' },
    );
    expect(second.version).toBe(2);
    expect((await readSkill(home, 'weekly-report'))?.text).toContain('eight');
    expect((await readSkill(home, 'weekly-report', 1))?.text).toContain('seven');
    expect(await readSkill(home, 'weekly-report', 3)).toBeNull();
    expect(Object.keys(await readOrigins(home, 'weekly-report'))).toEqual(['1', '2']);

    // A skill a person put in the library by hand.
    mkdirSync(join(home, 'library', 'skills', 'code-review', '1'), { recursive: true });
    writeFileSync(
      skillFile(home, 'code-review', 1),
      skill('code-review', 'Reviews code.', 'Read it.'),
    );
    expect(await listLibrary(home)).toEqual([
      {
        name: 'code-review',
        versions: [1],
        latest: 1,
        description: 'Reviews code.',
        writtenBy: 'person',
      },
      {
        name: 'weekly-report',
        versions: [1, 2],
        latest: 2,
        description: 'Writes the weekly report. Use when asked for a summary of the week.',
        writtenBy: 'agent',
      },
    ]);
  });
});

describe('proposing a skill', () => {
  let home: string;
  let state: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'wheems-propose-'));
    state = join(home, '.wheems');
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const propose = (name: string, text: string, extra: Partial<ProposeOptions> = {}) =>
    proposeSkill({
      home,
      stateDir: state,
      workspace: 'personal',
      agent: 'chief-of-staff',
      conversation: 'personal:slack:D1:1',
      name,
      text,
      now: new Date('2026-11-13T09:15:00Z'),
      ...extra,
    });

  it('saves a new skill for review, and tells the agent it waits', async () => {
    const { proposal, message } = await propose('weekly-report', WEEKLY);
    expect(message).toBe(
      'Proposed the new skill weekly-report. It waits for the person to review it.\n',
    );
    expect(proposal).toMatchObject({
      id: '20261113-091500-weekly-report',
      basedOn: null,
      similar: [],
      workspace: 'personal',
      agent: 'chief-of-staff',
    });
    const [waiting] = await listProposals(state);
    expect(waiting?.text).toContain('seven days');
    expect(await listLibrary(home)).toEqual([]);
  });

  it('proposes a change to a skill an agent wrote, but never to one a person wrote', async () => {
    await addVersion(home, checkSkillText('weekly-report', WEEKLY), { written_by: 'agent' });
    const { proposal, message } = await propose('weekly-report', WEEKLY.replace('seven', 'eight'));
    expect(proposal.basedOn).toBe(1);
    expect(message).toMatch(/^Proposed version 2 of weekly-report/);
    await expect(propose('weekly-report', WEEKLY)).rejects.toThrow(/already says this/);

    mkdirSync(join(home, 'library', 'skills', 'code-review', '1'), { recursive: true });
    writeFileSync(
      skillFile(home, 'code-review', 1),
      skill('code-review', 'Reviews code.', 'Read it.'),
    );
    await expect(
      propose('code-review', skill('code-review', 'Reviews code.', 'Skim it.')),
    ).rejects.toThrow(/written by a person/);
  });

  it('replaces an earlier proposal from the same workspace, and refuses one from another', async () => {
    await propose('weekly-report', WEEKLY);
    const { message } = await propose('weekly-report', WEEKLY.replace('seven', 'eight'), {
      now: new Date('2026-11-13T10:00:00Z'),
    });
    expect(message).toContain('It replaces the earlier proposal for it.');
    const waiting = await listProposals(state);
    expect(waiting.map((w) => w.proposal.id)).toEqual(['20261113-100000-weekly-report']);
    await expect(
      propose('weekly-report', WEEKLY, { workspace: 'acme', agent: 'developer' }),
    ).rejects.toThrow(/from the personal workspace is already waiting/);
  });

  it('warns about a skill that repeats another, by shared words', async () => {
    await addVersion(home, checkSkillText('weekly-report', WEEKLY), { written_by: 'agent' });
    await addVersion(
      home,
      checkSkillText(
        'dns-change',
        skill('dns-change', 'Changes a DNS record.', 'Find the zone at Cloudflare and update it.'),
      ),
      { written_by: 'agent' },
    );
    const { proposal, message } = await propose(
      'week-summary',
      skill(
        'week-summary',
        'Summarises the week.',
        'Read the git log for the last seven days, then list what shipped and what is blocked.',
      ),
    );
    expect(proposal.similar.map((s) => [s.name, s.by])).toEqual([['weekly-report', 'words']]);
    expect(message).toContain('It may repeat:\n- weekly-report (version 1)');
    expect(message).toContain('wheems skill show <name>');
  });

  it('compares by meaning when the embeddings driver says what a near-duplicate scores', async () => {
    await propose('weekly-report', WEEKLY);
    const embeddings = new HashEmbeddings({
      nearDuplicate: 0.6,
      synonyms: { fortnight: 'week', summarise: 'report' },
    });
    const { proposal } = await propose(
      'fortnight-summary',
      skill(
        'fortnight-summary',
        'Summarise the fortnight.',
        'Read the git log for the last fourteen days and the brief, then list what shipped, what is blocked and what is next.',
      ),
      { embeddings, agent: 'developer' },
    );
    expect(proposal.similar).toMatchObject([
      { name: 'weekly-report', kind: 'proposal', by: 'meaning' },
    ]);
    expect(embeddings.calls.at(-1)?.purpose).toBe('document');

    // An embeddings service that can't be reached falls back to words.
    embeddings.fail();
    const again = await propose(
      'fortnight-summary',
      skill(
        'fortnight-summary',
        'Summarise the fortnight.',
        'Read the git log for the last seven days.',
      ),
      { embeddings, now: new Date('2026-11-13T11:00:00Z') },
    );
    expect(again.proposal.similar.every((s) => s.by === 'words')).toBe(true);
  });
});

describe('reviewing', () => {
  let home: string;
  let state: string;
  const ws = () => join(home, 'workspaces', 'personal');

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'wheems-review-'));
    state = join(home, '.wheems');
    writeFileSync(join(home, 'install.yaml'), installYaml());
    await initWorkspace({ home, id: 'personal' });
    writeFileSync(
      join(ws(), 'agents', 'researcher.md'),
      '---\nengine: claude-code\nmodel: claude-opus-5-5\naccount: claude-subscription\n# Finds things out.\nskills: [weekly-report]\n---\n\nYou research.\n',
    );
    writeFileSync(join(home, 'about-you.md'), '# About you\n\nLikes boats.\n');
    git(home, 'init', '--quiet');
    git(home, 'add', '.');
    git(home, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'start');
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const proposeWeekly = (text = WEEKLY) =>
    proposeSkill({
      home,
      stateDir: state,
      workspace: 'personal',
      agent: 'chief-of-staff',
      conversation: null,
      name: 'weekly-report',
      text,
    });

  it('pins a version in skills.yaml, keeping its comments', async () => {
    const file = join(ws(), 'skills.yaml');
    await pinSkill(file, 'weekly-report', 2);
    expect(readFileSync(file, 'utf8')).toBe(
      '# Skills this workspace uses, each pinned to a library version.\nskills:\n  weekly-report: 2\n',
    );
    await pinSkill(file, 'weekly-report', 3);
    expect(readFileSync(file, 'utf8')).toContain('weekly-report: 3');
  });

  it("adds a skill to an agent file's list and takes it off, keeping the rest of the file", async () => {
    const file = join(ws(), 'agents', 'chief-of-staff.md');
    const before = readFileSync(file, 'utf8');
    await setAgentSkill(file, 'weekly-report', true);
    const after = readFileSync(file, 'utf8');
    expect(after).toContain('skills: [ weekly-report ]');
    expect(after.slice(after.indexOf('\n---') + 4)).toBe(before.slice(before.indexOf('\n---') + 4));
    await setAgentSkill(file, 'weekly-report', true);
    expect(readFileSync(file, 'utf8')).toBe(after);
    await setAgentSkill(file, 'weekly-report', false);
    expect(readFileSync(file, 'utf8')).toContain('skills: []');
  });

  it('approves a proposal into the library, pins it, gives it to the chosen agents and commits', async () => {
    await proposeWeekly();
    const [waiting] = await listProposals(state);
    const result = await approveSkill({
      install: await loadInstall(home),
      waiting: waiting!,
      text: waiting!.text,
      agents: ['chief-of-staff'],
      now: new Date('2026-11-13T12:00:00Z'),
    });
    expect(result).toMatchObject({ version: 1, committed: true });
    expect(await listProposals(state)).toEqual([]);
    expect((await readOrigins(home, 'weekly-report'))[1]).toEqual({
      written_by: 'agent',
      workspace: 'personal',
      agent: 'chief-of-staff',
      approved: '2026-11-13',
    });
    const install = await loadInstall(home);
    const personal = install.workspaces[0]!;
    expect(personal.skills?.skills).toEqual({ 'weekly-report': 1 });
    const skillsOf = (name: string) =>
      personal.agents.find((a) => a.definition.name === name)?.definition.skills;
    expect(skillsOf('chief-of-staff')).toEqual(['weekly-report']);
    // Left out of the choice, so it no longer has it.
    expect(skillsOf('researcher')).toEqual([]);
    expect(crossCheck(install).filter((p) => p.level === 'error')).toEqual([]);
    expect(git(home, 'log', '-1', '--format=%s')).toBe('Approved weekly-report (new skill)');
    expect(git(home, 'status', '--porcelain')).toBe('');
  });

  it('records a proposal the person edited before approving', async () => {
    await proposeWeekly();
    const [waiting] = await listProposals(state);
    await approveSkill({
      install: await loadInstall(home),
      waiting: waiting!,
      text: waiting!.text.replace('seven', 'ten'),
      agents: [],
    });
    expect((await readOrigins(home, 'weekly-report'))[1]?.edited).toBe(true);
    expect((await readSkill(home, 'weekly-report'))?.text).toContain('ten days');
  });

  it('approves or turns down a suggested change to about-you.md', async () => {
    const dir = join(state, 'review', 'about-you');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '2026-11-13-090000-chief-of-staff-boats-personal.md'),
      '# About you\n\nLikes boats and trains.\n',
    );
    writeFileSync(
      join(dir, '2026-11-13-100000-chief-of-staff-cars-personal.md'),
      '# About you\n\nLikes cars.\n',
    );
    const [first, second] = await listAboutYou(state, ['personal', 'sonal']);
    expect(first?.workspace).toBe('personal');
    const aboutYouFile = join(home, 'about-you.md');
    await approveAboutYou({ home, aboutYouFile, suggestion: first!, text: first!.text });
    expect(readFileSync(aboutYouFile, 'utf8')).toBe('# About you\n\nLikes boats and trains.\n');
    expect(git(home, 'log', '-1', '--format=%s')).toBe(
      'Updated about-you.md, from a note in personal',
    );
    await declineAboutYou(second!);
    expect(await listAboutYou(state)).toEqual([]);
    expect(readFileSync(aboutYouFile, 'utf8')).toContain('trains');
  });

  it('shows changes as a line diff, removed lines first', () => {
    expect(lineDiff('a\nb\nc\n', 'a\nB\nc\n')).toBe('  a\n- b\n+ B\n  c');
    const long = Array.from({ length: 20 }, (_, i) => `line ${String(i)}`).join('\n');
    const diff = lineDiff(long, long.replace('line 10', 'line ten'));
    expect(diff).toBe('  …\n  line 8\n  line 9\n- line 10\n+ line ten\n  line 11\n  line 12\n  …');
  });

  describe('wheems review', () => {
    const scripted = (answers: { select: string[]; multiselect?: string[][]; edit?: string[] }) => {
      const shown: string[] = [];
      const ui: ReviewUi = {
        intro: (t) => shown.push(`intro: ${t}`),
        outro: (t) => shown.push(`outro: ${t}`),
        note: (m, t) => shown.push(`note ${t ?? ''}: ${m}`),
        info: (m) => shown.push(`info: ${m}`),
        success: (m) => shown.push(`success: ${m}`),
        warn: (m) => shown.push(`warn: ${m}`),
        select: <T extends string>() => {
          const next = answers.select.shift();
          if (next === undefined) throw new Error('no answer left');
          return Promise.resolve(next as T);
        },
        multiselect: (options) => {
          shown.push(`multiselect: ${options.initial.join(',')}`);
          return Promise.resolve(answers.multiselect?.shift() ?? options.initial);
        },
        edit: () => Promise.resolve(answers.edit?.shift() ?? ''),
      };
      return { ui, shown };
    };
    const review = async (ui: ReviewUi | null) => {
      let out = '';
      await runReview({ home, env: { WHEEMS_HOME: home }, out: (t) => (out += t), ui });
      return out;
    };

    it('says when nothing waits, and only lists what waits without a terminal', async () => {
      expect(await review(null)).toBe('Nothing waits for review.\n');
      await proposeWeekly();
      expect(await review(null)).toBe(
        'Waiting for review:\n  skill weekly-report (new), from chief-of-staff in personal\n\nRun wheems review in a terminal to go through them.\n',
      );
    });

    it('goes through each proposal: approve with the chosen agents, or turn it down', async () => {
      await proposeWeekly();
      const { ui, shown } = scripted({ select: ['approve'] });
      await review(ui);
      // The proposer and the agents that already list it are chosen to begin with.
      expect(shown).toContain('multiselect: chief-of-staff,researcher');
      expect(shown.some((s) => s.startsWith('note SKILL.md: ---\nname: weekly-report'))).toBe(true);
      expect(shown).toContain(
        'success: Added weekly-report version 1 to the library, pinned in personal, for chief-of-staff, researcher.',
      );
      expect(shown.at(-1)).toBe('outro: All reviewed.');

      await proposeSkill({
        home,
        stateDir: state,
        workspace: 'personal',
        agent: 'chief-of-staff',
        conversation: null,
        name: 'weekly-report',
        text: WEEKLY.replace('seven', 'eight'),
      });
      const second = scripted({ select: ['decline'] });
      await review(second.ui);
      // A change shows as a diff against the version it changes.
      expect(second.shown.some((s) => s.includes('- Read the git log for the last seven'))).toBe(
        true,
      );
      expect(second.shown).toContain('info: Turned down weekly-report.');
      expect(await listProposals(state)).toEqual([]);
      expect((await listLibrary(home))[0]?.latest).toBe(1);
    });

    it('lets the person edit before approving, and asks again when the edit is not a skill', async () => {
      await proposeWeekly();
      const { ui, shown } = scripted({
        select: ['edit', 'edit'],
        edit: ['not a skill', WEEKLY.replace('seven', 'ten')],
        multiselect: [[]],
      });
      await review(ui);
      expect(shown.some((s) => s.startsWith('warn: A skill starts with front matter'))).toBe(true);
      expect(shown.some((s) => s.startsWith('note Your changes:'))).toBe(true);
      expect((await readSkill(home, 'weekly-report'))?.text).toContain('ten days');
    });

    it('leaves items for later, and stops when asked', async () => {
      await proposeWeekly();
      const dir = join(state, 'review', 'about-you');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'n-personal.md'), '# About you\n\nLikes trains.\n');
      const { ui, shown } = scripted({ select: ['later', 'stop'] });
      await review(ui);
      expect(shown.some((s) => s.includes('- Likes boats.\n+ Likes trains.'))).toBe(true);
      expect(shown.at(-1)).toBe('outro: Stopped. The rest wait for next time.');
      expect(await listProposals(state)).toHaveLength(1);
      expect(await listAboutYou(state)).toHaveLength(1);
    });
  });
});

describe('skills in config', () => {
  it('finds pins that point at no skill or version in the library', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wheems-pins-'));
    try {
      writeFileSync(join(home, 'install.yaml'), installYaml());
      await initWorkspace({ home, id: 'personal' });
      await addVersion(home, checkSkillText('weekly-report', WEEKLY), { written_by: 'agent' });
      writeFileSync(
        join(home, 'workspaces', 'personal', 'skills.yaml'),
        'skills:\n  weekly-report: 2\n  missing: 1\n',
      );
      const problems = crossCheck(await loadInstall(home)).filter((p) => p.level === 'error');
      expect(problems.map((p) => p.message)).toEqual([
        'Skill "weekly-report" has no version 2 in the library',
        'Skill "missing" is not in the library',
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('wheems skill', () => {
  let home: string;
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'wheems-skill-cli-'));
    await addVersion(home, checkSkillText('weekly-report', WEEKLY), { written_by: 'agent' });
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const cli = async (args: string[], env: NodeJS.ProcessEnv = {}) => {
    let out = '';
    let err = '';
    const previous = process.exitCode;
    process.exitCode = undefined;
    try {
      const code = await run(args, {
        ...defaultIo(),
        out: (t) => (out += t),
        err: (t) => (err += t),
        env: { WHEEMS_HOME: home, ...env },
        color: false,
        stdin: () => Promise.resolve(WEEKLY),
      });
      return { code, out, err };
    } finally {
      process.exitCode = previous;
    }
  };

  it('lists the library and shows a skill, at its latest version or the one asked for', async () => {
    expect((await cli(['skill', 'list'])).out).toBe(
      'weekly-report (version 1)\n  Writes the weekly report. Use when asked for a summary of the week.\n',
    );
    expect((await cli(['skill', 'show', 'weekly-report'])).out).toContain('seven days');
    expect(await cli(['skill', 'show', 'weekly-report', '2'])).toMatchObject({
      code: 1,
      err: expect.stringContaining('weekly-report has no version 2') as string,
    });
    expect((await cli(['skill', 'show', 'nope'])).err).toContain('No skill nope in the library');
  });

  it('proposes only from inside a conversation', async () => {
    const result = await cli(['skill', 'propose', 'weekly-report']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('works inside a conversation started by Wheems');
    expect(existsSync(join(home, '.wheems'))).toBe(false);
  });
});
