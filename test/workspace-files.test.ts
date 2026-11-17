import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withBuiltins } from '../src/agents/builtin.js';
import { initWorkspace } from '../src/cli/commands/init.js';
import { INSTALL_GITIGNORE, installYaml } from '../src/cli/templates.js';
import { crossCheck } from '../src/config/check.js';
import { loadInstall, validateFile } from '../src/config/load.js';
import { moveToWheemsFiles, splitGoal } from '../src/config/migrate.js';
import { instructionsFiles } from '../src/drivers/engine/instructions.js';
import { writeSkills } from '../src/service/launch.js';

describe("a workspace's files", () => {
  let home: string;
  let ws: string;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'wf-'));
    writeFileSync(join(home, 'install.yaml'), installYaml());
    ws = await initWorkspace({ home, id: 'personal' });
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const problems = async () => {
    const install = await loadInstall(home);
    return [...install.problems, ...crossCheck(install)].map((p) => `${p.level} ${p.message}`);
  };

  it('starts a workspace with WHEEMS.md for its chief, GOAL.md to fill in, and an empty team', async () => {
    expect(readFileSync(join(ws, 'WHEEMS.md'), 'utf8')).toContain('# Personal: chief of staff');
    expect(readFileSync(join(ws, 'GOAL.md'), 'utf8')).toContain('The goal for Personal');
    expect(existsSync(join(ws, 'agents', 'chief-of-staff.md'))).toBe(false);
    const install = await loadInstall(home);
    const chief = install.workspaces[0]?.agents.find((a) => a.definition.name === 'chief-of-staff');
    expect(chief?.file).toBe('workspaces/personal/WHEEMS.md');
    expect(await problems()).toEqual([]);
  });

  it('names the chief from workspace.yaml, and says what to do with an old chief file', async () => {
    writeFileSync(
      join(ws, 'WHEEMS.md'),
      readFileSync(join(ws, 'WHEEMS.md'), 'utf8').replace('---\n', '---\nname: boss\n'),
    );
    expect(await problems()).toContain(
      'error The chief of staff\'s name comes from chief_of_staff in workspace.yaml ("chief-of-staff"): leave name out of WHEEMS.md',
    );
    rmSync(join(ws, 'WHEEMS.md'));
    expect(await problems()).toContain(
      'error The chief of staff "chief-of-staff" has no WHEEMS.md',
    );

    // An old agents/ file still loads until the service moves it, and doctor says so.
    writeFileSync(
      join(ws, 'agents', 'chief-of-staff.md'),
      '---\nengine: claude-code\nmodel: m\naccount: claude-subscription\n---\n\n# Old\n',
    );
    expect(await problems()).toEqual([
      "warning The chief of staff's file is WHEEMS.md now: the service moves this one there when it starts",
    ]);
    // Beside a WHEEMS.md, it's ignored.
    writeFileSync(
      join(ws, 'WHEEMS.md'),
      '---\nengine: claude-code\nmodel: m\naccount: claude-subscription\n---\n\n# New\n',
    );
    expect(await problems()).toEqual([
      'error The chief of staff is WHEEMS.md now, so this file is ignored: move what you need into WHEEMS.md and delete it',
    ]);
    const install = await loadInstall(home);
    expect(install.workspaces[0]?.agents.map((a) => a.definition.instructions)).toEqual(['# New']);
  });

  it("moves a workspace from before WHEEMS.md over, its goal to GOAL.md, and doesn't do it twice", async () => {
    // A workspace as 0.1.9 made it.
    const chief = join(ws, 'agents', 'chief-of-staff.md');
    renameSync(join(ws, 'WHEEMS.md'), chief);
    writeFileSync(
      chief,
      `${readFileSync(chief, 'utf8')}\n## What we're working towards\n\n<!-- The goal. -->\nSell a thousand boxes by March.\n`,
    );
    rmSync(join(ws, 'GOAL.md'));
    writeFileSync(join(home, '.gitignore'), '.wheems/\nworkspaces/*/CLAUDE.md\n');

    expect(await moveToWheemsFiles(home)).toEqual([
      "Moved personal's goal to GOAL.md",
      "Moved personal's chief of staff from agents/chief-of-staff.md to WHEEMS.md",
      'Added workspaces/*/AGENTS.md, workspaces/*/.claude/, workspaces/*/.agents/ to .gitignore',
    ]);
    expect(existsSync(chief)).toBe(false);
    const wheems = readFileSync(join(ws, 'WHEEMS.md'), 'utf8');
    expect(wheems).toContain('# Personal: chief of staff');
    expect(wheems).not.toContain('working towards');
    expect(readFileSync(join(ws, 'GOAL.md'), 'utf8')).toContain('Sell a thousand boxes by March.');
    expect(readFileSync(join(home, '.gitignore'), 'utf8')).toContain('workspaces/*/.agents/\n');
    expect(await problems()).toEqual([]);

    expect(await moveToWheemsFiles(home)).toEqual([]);
  });

  it('keeps the goal in WHEEMS.md when the workspace already has a GOAL.md', async () => {
    const chief = join(ws, 'agents', 'chief-of-staff.md');
    renameSync(join(ws, 'WHEEMS.md'), chief);
    writeFileSync(
      chief,
      `${readFileSync(chief, 'utf8')}\n## What we're working towards\n\nBoxes.\n`,
    );
    writeFileSync(join(ws, 'GOAL.md'), 'Ours.\n');
    expect(await moveToWheemsFiles(home)).toEqual([
      'Kept personal\'s "What we\'re working towards" in WHEEMS.md, since it already has a GOAL.md: move what you need',
      "Moved personal's chief of staff from agents/chief-of-staff.md to WHEEMS.md",
    ]);
    expect(readFileSync(join(ws, 'WHEEMS.md'), 'utf8')).toContain('Boxes.');
    expect(readFileSync(join(ws, 'GOAL.md'), 'utf8')).toBe('Ours.\n');
  });

  it('validates WHEEMS.md on its own, named by the workspace.yaml beside it', async () => {
    expect(await validateFile(join(ws, 'WHEEMS.md'))).toEqual({ kind: 'agent', problems: [] });
    writeFileSync(
      join(ws, 'WHEEMS.md'),
      readFileSync(join(ws, 'WHEEMS.md'), 'utf8').replace('---\n', '---\nname: boss\n'),
    );
    expect((await validateFile(join(ws, 'WHEEMS.md'))).problems.map((p) => p.message)).toEqual([
      'The chief of staff\'s name comes from chief_of_staff in workspace.yaml ("chief-of-staff"): leave name out of WHEEMS.md',
    ]);
  });

  it('gives a workspace without a goal an empty GOAL.md, and never replaces one', async () => {
    rmSync(join(ws, 'GOAL.md'));
    mkdirSync(join(home, 'workspaces', 'other'));
    writeFileSync(join(home, 'workspaces', 'other', 'workspace.yaml'), 'name: Other\n');
    writeFileSync(join(home, 'workspaces', 'other', 'GOAL.md'), 'Ours.\n');
    writeFileSync(join(home, '.gitignore'), INSTALL_GITIGNORE);
    expect(await moveToWheemsFiles(home)).toEqual(['Added GOAL.md to personal, for its goal']);
    expect(readFileSync(join(home, 'workspaces', 'other', 'GOAL.md'), 'utf8')).toBe('Ours.\n');
  });
});

describe('splitting a goal out of an old chief file', () => {
  it('takes the section up to the next heading, and leaves out one with only a comment', () => {
    expect(
      splitGoal(
        "# Chief\n\nHi.\n\n## What we're working towards\n\nBoxes.\n\n## Style\n\nShort.\n",
      ),
    ).toEqual({
      chief: '# Chief\n\nHi.\n\n## Style\n\nShort.\n',
      goal: 'Boxes.',
    });
    expect(splitGoal("# Chief\n\n## What we're working towards\n\n<!-- Fill in. -->\n")).toEqual({
      chief: '# Chief\n',
      goal: null,
    });
    expect(splitGoal('# Chief\n')).toEqual({ chief: '# Chief\n', goal: null });
  });
});

describe('the instructions files', () => {
  it("writes everything to AGENTS.md, with CLAUDE.md pointing to it, and the goal after the agent's own", () => {
    const [agents, claude] = instructionsFiles('# Chief');
    expect(agents).toMatchObject({ path: 'AGENTS.md' });
    expect(agents?.content).toContain('# Chief');
    expect(claude?.path).toBe('CLAUDE.md');
    expect(claude?.content).toMatch(/^@AGENTS\.md$/m);

    const text = withBuiltins('# Chief', { aboutYou: null, brief: null, goal: 'Boxes.' });
    expect(text).toContain("# Chief\n\n## What we're working towards (from GOAL.md)\n\nBoxes.\n");
    expect(withBuiltins('# Chief')).not.toContain('working towards');
  });
});

describe("Wheems's skills in a session's folder", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sk-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const write = async (path: string, content: string) => {
    writeFileSync(path, content);
    await Promise.resolve();
  };
  const skillFile = (folder: string, name: string) => join(dir, folder, name, 'SKILL.md');

  it('writes them where the engine reads skills, and clears only its own old ones', async () => {
    // Someone's own skill, and Wheems's from an earlier start on another engine.
    mkdirSync(join(dir, '.claude', 'skills', 'my-skill'), { recursive: true });
    writeFileSync(skillFile('.claude/skills', 'my-skill'), 'mine');
    mkdirSync(join(dir, '.claude', 'skills', 'wheems-notes'), { recursive: true });
    writeFileSync(skillFile('.claude/skills', 'wheems-notes'), 'old');
    mkdirSync(join(dir, '.agents', 'skills', 'wheems-gone'), { recursive: true });
    writeFileSync(skillFile('.agents/skills', 'wheems-gone'), 'old');

    await writeSkills(dir, '.agents/skills', [{ name: 'wheems-notes', content: 'new' }], write);
    expect(readFileSync(skillFile('.agents/skills', 'wheems-notes'), 'utf8')).toBe('new');
    expect(existsSync(join(dir, '.agents', 'skills', 'wheems-gone'))).toBe(false);
    expect(existsSync(join(dir, '.claude', 'skills', 'wheems-notes'))).toBe(false);
    expect(readFileSync(skillFile('.claude/skills', 'my-skill'), 'utf8')).toBe('mine');
  });

  it("refuses a skill that isn't Wheems's, and a folder outside the session's", async () => {
    await expect(
      writeSkills(dir, '.agents/skills', [{ name: 'mine', content: '' }], write),
    ).rejects.toThrow("Not one of Wheems's skills: mine");
    await expect(writeSkills(dir, '../skills', [], write)).rejects.toThrow('outside its folder');
  });
});
