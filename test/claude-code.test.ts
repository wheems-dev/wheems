import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentDefinition, EngineContext } from '../src/contracts/engine.js';
import { answersAfter } from '../src/contracts/engine.js';
import { ClaudeCodeEngine, turnAnswers } from '../src/drivers/engine/claude-code.js';
import { engineContract } from '../src/testing/index.js';
import { realHcAvailable } from './helpers/hc.js';

// The contract asks the real Claude Code whether it's signed in (claude auth status, which only
// reads), so its config folder is the real one here; every other test points it into the
// repository (test/setup/env.ts).
const testConfigDir = process.env.CLAUDE_CONFIG_DIR;
beforeAll(() => {
  const real = process.env.WHEEMS_TEST_REAL_CLAUDE_CONFIG_DIR;
  if (real === undefined || real === '') delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = real;
});
afterAll(() => {
  process.env.CLAUDE_CONFIG_DIR = testConfigDir;
});

engineContract('claude-code', {
  create: () => new ClaudeCodeEngine(),
  model: 'claude-opus-5-5',
  accountDriver: 'claude',
  // CI has no Claude Code; this Mac does.
  expectHealthy: realHcAvailable() && process.env.CI === undefined,
});

const agent: AgentDefinition = {
  name: 'chief-of-staff',
  description: null,
  engine: 'claude-code',
  model: 'claude-opus-5-5',
  account: 'claude-subscription',
  skills: [],
  integrations: [],
  permissions: 'auto',
  instructions: '# Chief of staff',
};
const context: EngineContext = {
  workspace: { id: 'personal', dir: '/home/me/wheems/workspaces/personal' },
  sessionDir: '/home/me/wheems/workspaces/personal',
  account: { name: 'claude-subscription', driver: 'claude' },
  session: {
    id: '11111111-2222-5333-8444-555555555555',
    resume: false,
    task: '-v hello',
    engineId: null,
  },
};

describe('claude-code engine', () => {
  it('starts a named session with its model, permissions and first message', async () => {
    const plan = await new ClaudeCodeEngine().prepare(agent, context);
    expect(plan.command).toEqual([
      'claude',
      '--model',
      'claude-opus-5-5',
      '--session-id',
      context.session.id,
      '--name',
      'personal-chief-of-staff',
      '--permission-mode',
      'auto',
      '--settings',
      expect.any(String) as string,
      '--',
      '-v hello',
    ]);
    // None of the person's own CLAUDE.md files: their own, and any in a folder above.
    const settings = JSON.parse(plan.command.at(-3) ?? '') as { claudeMdExcludes: string[] };
    expect(settings.claudeMdExcludes).toContain(
      join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'CLAUDE.md'),
    );
    expect(settings.claudeMdExcludes).toEqual(
      expect.arrayContaining([
        '/home/me/wheems/workspaces/CLAUDE.md',
        '/home/me/wheems/CLAUDE.local.md',
        '/home/me/.claude/CLAUDE.md',
        '/CLAUDE.md',
      ]),
    );
    // Never the one Wheems writes in the session's folder.
    expect(settings.claudeMdExcludes).not.toContain(
      '/home/me/wheems/workspaces/personal/CLAUDE.md',
    );
    expect(
      await new ClaudeCodeEngine({ configDir: '/elsewhere/.claude' }).othersInstructions('/a'),
    ).toEqual([
      '/elsewhere/.claude/CLAUDE.md',
      '/CLAUDE.md',
      '/CLAUDE.local.md',
      '/.claude/CLAUDE.md',
    ]);
    expect(plan.cwd).toBe(context.sessionDir);
    expect(plan.env).toEqual({ CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1' });
    expect(plan.files).toEqual([
      { path: 'AGENTS.md', content: expect.stringContaining('# Chief of staff') as string },
      { path: 'CLAUDE.md', content: expect.stringMatching(/^@AGENTS\.md$/m) as string },
    ]);
  });

  it('excludes the files above a session reached through a symlink, by their real paths too', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wheems-link-')));
    try {
      mkdirSync(join(root, 'real', 'wheems'), { recursive: true });
      symlinkSync(join(root, 'real'), join(root, 'link'));
      // The session's folder needn't exist yet.
      const excluded = await new ClaudeCodeEngine({
        configDir: join(root, 'link', 'conf'),
      }).othersInstructions(join(root, 'link', 'wheems', 'sessions', 'new'));
      expect(excluded).toEqual(
        expect.arrayContaining([
          join(root, 'link', 'conf', 'CLAUDE.md'),
          join(root, 'real', 'conf', 'CLAUDE.md'),
          join(root, 'link', 'wheems', 'CLAUDE.md'),
          join(root, 'real', 'wheems', 'CLAUDE.md'),
          join(root, 'real', 'CLAUDE.md'),
        ]),
      );
      expect(excluded).not.toContain(join(root, 'real', 'wheems', 'sessions', 'new', 'CLAUDE.md'));
      expect(new Set(excluded).size).toBe(excluded.length);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("hides the person's own skills, but never Wheems's", async () => {
    const config = mkdtempSync(join(tmpdir(), 'wheems-claude-config-'));
    try {
      const skill = (folder: string, text: string) => {
        mkdirSync(join(config, 'skills', folder), { recursive: true });
        writeFileSync(join(config, 'skills', folder, 'SKILL.md'), text);
      };
      skill('wrap-up', '---\nname: wrap-up\ndescription: Notes.\n---\n');
      skill('odd-folder', '---\nname: "other-name"\ndescription: x\n---\n');
      skill('wheems-notes', '---\nname: wheems-notes\n---\n');
      mkdirSync(join(config, 'skills', 'synced', 'nested'), { recursive: true });
      const engine = new ClaudeCodeEngine({ configDir: config });
      expect(await engine.ownSkills()).toEqual(['odd-folder', 'other-name', 'wrap-up']);
      const plan = await engine.prepare(agent, context);
      const settings = JSON.parse(plan.command.at(-3) ?? '') as {
        skillOverrides: Record<string, string>;
        claudeMdExcludes: string[];
      };
      expect(settings.skillOverrides).toEqual({
        'odd-folder': 'off',
        'other-name': 'off',
        'wrap-up': 'off',
      });
      expect(settings.claudeMdExcludes[0]).toBe(join(config, 'CLAUDE.md'));
      // Without a skills folder, nothing is hidden.
      expect(await new ClaudeCodeEngine({ configDir: join(config, 'none') }).ownSkills()).toEqual(
        [],
      );
    } finally {
      rmSync(config, { recursive: true, force: true });
    }
  });

  it('resumes by session id', async () => {
    const plan = await new ClaudeCodeEngine().prepare(agent, {
      ...context,
      session: { ...context.session, resume: true, task: null },
    });
    expect(plan.command.slice(3, 5)).toEqual(['--resume', context.session.id]);
    expect(plan.command).not.toContain('--');
  });

  it('maps permission levels to Claude Code flags', async () => {
    const engine = new ClaudeCodeEngine();
    const flags = async (permissions: AgentDefinition['permissions']) =>
      (await engine.prepare({ ...agent, permissions }, context)).command.slice(7, -4);
    expect(await flags('ask')).toEqual([]);
    expect(await flags('auto')).toEqual(['--permission-mode', 'auto']);
    expect(await flags('skip')).toEqual(['--dangerously-skip-permissions']);
  });

  it('checks that Claude Code is signed in, without showing the account', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wheems-fake-claude-'));
    try {
      const fake = (auth: string) => {
        const file = join(dir, 'claude');
        writeFileSync(
          file,
          `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.0 (Claude Code)"; exit 0; fi\n${auth}\n`,
        );
        chmodSync(file, 0o755);
        return new ClaudeCodeEngine({ binary: file });
      };
      const signIn = async (auth: string) => (await fake(auth).check())[1];
      expect(
        await signIn(
          `echo '{"loggedIn":true,"authMethod":"claude.ai","email":"someone@example.com"}'`,
        ),
      ).toEqual({ name: 'Claude Code sign-in', status: 'pass', message: 'Signed in (claude.ai)' });
      expect(await signIn(`echo '{"loggedIn":false}'; exit 1`)).toMatchObject({
        status: 'fail',
        hint: expect.stringMatching(/claude auth login/) as string,
      });
      // An older Claude Code without `auth status`.
      expect(await signIn(`echo "error: unknown command 'auth'" >&2; exit 1`)).toMatchObject({
        status: 'warn',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails its health check when claude is missing', async () => {
    const checks = await new ClaudeCodeEngine({ binary: '/nonexistent/claude' }).check();
    expect(checks).toEqual([expect.objectContaining({ status: 'fail' })]);
  });
});

describe('claude-code transcripts', () => {
  const line = (entry: object) => JSON.stringify(entry);
  const prompt = (uuid: string, text: string) =>
    line({ uuid, type: 'user', message: { content: text } });
  const said = (uuid: string, ...blocks: object[]) =>
    line({ uuid, type: 'assistant', message: { content: blocks } });
  const text = (value: string) => ({ type: 'text', text: value });
  const turnEnds = line({ type: 'system', subtype: 'turn_duration', durationMs: 1000 });
  const join_ = (...lines: string[]) => lines.join('\n');

  const twoTurns = join_(
    line({ type: 'custom-title', customTitle: 'x' }),
    prompt('p1', 'First question'),
    said('a1', text('First answer')),
    turnEnds,
    prompt('p2', 'Second question'),
    said('t1', { type: 'thinking', thinking: 'hmm' }),
    said('t2', text('Let me check.'), { type: 'tool_use', id: 'tool1' }),
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool1' }] } }),
    line({ type: 'assistant', isSidechain: true, message: { content: [text('A subagent')] } }),
    said('a2', text('  The second answer.  ')),
    turnEnds,
    '{"half a line',
  );

  it("takes each finished turn's last text, named by its first prompt", () => {
    expect(turnAnswers(twoTurns)).toEqual([
      { id: 'p1', text: 'First answer' },
      { id: 'p2', text: 'The second answer.' },
    ]);
    expect(turnAnswers('')).toEqual([]);
  });

  it('gives a turn still running no answer, even when it has written text', () => {
    const running = join_(
      twoTurns,
      prompt('p3', 'Third question'),
      said('t3', text('Let me check.'), { type: 'tool_use', id: 'tool2' }),
    );
    expect(turnAnswers(running).map((a) => a.id)).toEqual(['p1', 'p2']);
    // A message that reaches Claude mid-turn joins the turn, which keeps its first prompt's id.
    const finished = join_(
      running,
      prompt('p4', 'And one more thing'),
      said('a3', text('Both done.')),
      turnEnds,
    );
    expect(turnAnswers(finished).at(-1)).toEqual({ id: 'p3', text: 'Both done.' });
  });

  it('keeps the position of an answer as the transcript grows, and never replays history', () => {
    const later = join_(
      twoTurns,
      prompt('p3', 'Third'),
      said('a3', text('Third answer')),
      turnEnds,
    );
    expect(answersAfter(turnAnswers(later), 'p2')).toEqual([{ id: 'p3', text: 'Third answer' }]);
    expect(answersAfter(turnAnswers(later), 'p3')).toEqual([]);
    expect(answersAfter(turnAnswers(later), null)).toHaveLength(3);
    // An id that is not there (a transcript replaced, say) gives only the latest answer.
    expect(answersAfter(turnAnswers(later), 'gone')).toEqual([{ id: 'p3', text: 'Third answer' }]);
  });

  it("finds the session's transcript in Claude Code's config folder", async () => {
    const root = mkdtempSync(join(tmpdir(), 'wheems-cc-'));
    try {
      const dir = join(root, 'workspaces', 'personal');
      mkdirSync(dir, { recursive: true });
      const id = '11111111-2222-5333-8444-555555555555';
      const folder = join(
        root,
        'claude',
        'projects',
        realpathSync(dir).replace(/[^A-Za-z0-9]/g, '-'),
      );
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, `${id}.jsonl`), twoTurns);
      const engine = new ClaudeCodeEngine({ configDir: join(root, 'claude') });
      expect((await engine.answers({ id, dir }, null)).map((a) => a.id)).toEqual(['p1', 'p2']);
      expect(await engine.answers({ id, dir }, 'p1')).toEqual([
        { id: 'p2', text: 'The second answer.' },
      ]);
      expect(await engine.answers({ id, dir }, 'p2')).toEqual([]);
      // A session elsewhere is still found by its id.
      expect(await engine.answers({ id, dir: '/somewhere/else' }, 'p1')).toHaveLength(1);
      expect(
        await engine.answers({ id: '99999999-2222-5333-8444-555555555555', dir }, null),
      ).toEqual([]);
      expect(await engine.answers({ id: '../../etc/passwd', dir }, null)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
