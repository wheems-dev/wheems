import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withBuiltins } from '../src/agents/builtin.js';
import { finishLine } from '../src/service/sessions.js';
import { BRIEF_MD } from '../src/cli/templates.js';
import { knowledgePaths, noteTitle, readCapped, writeNote } from '../src/knowledge/notes.js';

describe('notes', () => {
  let dir: string;
  const source = {
    workspace: 'personal',
    agent: 'chief-of-staff',
    engine: 'claude-code',
    conversation: 'personal:slack:D1:1.2',
    origin: 'person' as const,
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wheems-notes-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('saves a note to the inbox with what Wheems knows about where it came from', async () => {
    const file = await writeNote(
      dir,
      source,
      '# Chose Postgres for the CRM\n\nBecause it scales.',
      new Date('2026-11-11T21:05:09Z'),
    );
    expect(file).toBe(
      join(
        knowledgePaths(dir).inbox,
        '2026-11-11-210509-chief-of-staff-chose-postgres-for-the-crm.md',
      ),
    );
    expect(readFileSync(file, 'utf8')).toBe(
      [
        '---',
        'workspace: personal',
        'agent: chief-of-staff',
        'engine: claude-code',
        'conversation: "personal:slack:D1:1.2"',
        'origin: person',
        'written: 2026-11-11T21:05:09.000Z',
        '---',
        '# Chose Postgres for the CRM',
        '',
        'Because it scales.',
        '',
      ].join('\n'),
    );
  });

  it('never overwrites a note written in the same second', async () => {
    const at = new Date('2026-11-11T21:05:09Z');
    await writeNote(dir, source, '# Same', at);
    await writeNote(dir, source, '# Same', at);
    expect(readdirSync(knowledgePaths(dir).inbox).sort()).toEqual([
      '2026-11-11-210509-chief-of-staff-same-2.md',
      '2026-11-11-210509-chief-of-staff-same.md',
    ]);
  });

  it('refuses a note that looks like it holds a credential', async () => {
    await expect(writeNote(dir, source, 'The token is xoxb-1234567890-abcdefghij')).rejects.toThrow(
      'password, token or key',
    );
  });

  it('refuses empty and overlong notes', async () => {
    await expect(writeNote(dir, source, '  \n')).rejects.toThrow('empty');
    await expect(writeNote(dir, source, 'x'.repeat(40_000))).rejects.toThrow('short summary');
  });

  it('titles a note by its first heading, or else its first line', () => {
    expect(noteTitle('Some intro\n\n## The decision\n')).toBe('The decision');
    expect(noteTitle('\nJust a line\nmore')).toBe('Just a line');
  });

  it('reads a page cut to its limit, and treats a template with nothing written as empty', async () => {
    const file = join(dir, 'brief.md');
    expect(await readCapped(file, 10)).toBeNull();
    writeFileSync(file, BRIEF_MD);
    expect(await readCapped(file, 10)).toBeNull();
    writeFileSync(file, 'abcdefghijklmnop');
    expect(await readCapped(file, 10)).toBe('abcdefghij\n\n[Cut at 10 characters.]');
  });

  it("gives agents the notes instructions, and what they know when there's something to know", () => {
    const bare = withBuiltins('# Agent');
    expect(bare).toContain('wheems knowledgebase note');
    expect(bare).not.toContain('What you know');
    const known = withBuiltins('# Agent', { aboutYou: 'Prefers short answers.', brief: null });
    expect(known).toContain('### About the person\n\nPrefers short answers.');
    expect(known).not.toContain("This workspace's brief");
  });

  it('gives only a chief its role and team, with an empty team handed to ad-hoc sessions', () => {
    expect(withBuiltins('# Agent')).not.toContain('Your role');
    const alone = withBuiltins('# Chief', undefined, {
      chief: { team: [] },
      sessions: { maxOpen: 3, open: [] },
    });
    expect(alone).toContain('## Your role (built into Wheems)');
    expect(alone).toContain('No agents yet: hand work to ad-hoc sessions for now.');
    expect(alone).toContain('Start one for any work that no agent on your team fits.');
    expect(alone).not.toContain('answer simple things yourself');
    // It briefs with a finish line, checks evidence, and stops sending a job back after two tries.
    expect(alone).toContain('Brief with a finish line.');
    expect(alone).toContain('Always give `--done-when` too');
    expect(alone).toContain('Check the evidence, not the claim');
    expect(alone).toContain('Send the same job back twice at most.');
    // The role comes before the sessions it relies on.
    expect(alone.indexOf('Your role')).toBeLessThan(alone.indexOf('## Sessions'));
    const team = withBuiltins('# Chief', undefined, {
      chief: {
        team: [{ name: 'writer', description: null, engine: 'codex', model: 'gpt-6.1-sol' }],
      },
    });
    expect(team).toContain('- **writer** (codex, gpt-6.1-sol): no description yet');
  });
});

describe('answers handed back', () => {
  it('shows a finish line to check against, and says to stop sending back from the third', () => {
    expect(finishLine(null, 5)).toBe('');
    const first = finishLine('npm test passes', 1);
    expect(first).toContain("Answer 1 from this session. It's done when: npm test passes");
    expect(first).toContain('Check its evidence against that before you report.');
    expect(first).not.toContain("don't send it back again");
    expect(finishLine('npm test passes', 3)).toContain(
      "Answer 3 from this session. It's done when: npm test passes\n\nCheck its evidence against that before you report.\n\nIf the job still isn't done, don't send it back again: bring it to the person",
    );
  });
});
