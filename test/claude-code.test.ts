import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentDefinition, EngineContext } from '../src/contracts/engine.js';
import { ClaudeCodeEngine, finalText } from '../src/drivers/engine/claude-code.js';
import { engineContract } from '../src/testing/index.js';
import { realHcAvailable } from './helpers/hc.js';

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
  workspace: { id: 'personal', dir: '/home/me/opinr/workspaces/personal' },
  sessionDir: '/home/me/opinr/workspaces/personal',
  account: { name: 'claude-subscription', driver: 'claude' },
  session: { id: '11111111-2222-5333-8444-555555555555', resume: false, task: '-v hello' },
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
      '--',
      '-v hello',
    ]);
    expect(plan.cwd).toBe(context.sessionDir);
    expect(plan.env).toEqual({ CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1' });
    expect(plan.files).toEqual([
      { path: 'CLAUDE.md', content: expect.stringContaining('# Chief of staff') as string },
    ]);
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
      (await engine.prepare({ ...agent, permissions }, context)).command.slice(7, -2);
    expect(await flags('ask')).toEqual([]);
    expect(await flags('auto')).toEqual(['--permission-mode', 'auto']);
    expect(await flags('skip')).toEqual(['--dangerously-skip-permissions']);
  });

  it('fails its health check when claude is missing', async () => {
    const checks = await new ClaudeCodeEngine({ binary: '/nonexistent/claude' }).check();
    expect(checks).toEqual([expect.objectContaining({ status: 'fail' })]);
  });
});

describe('claude-code transcripts', () => {
  const line = (entry: object) => JSON.stringify(entry);
  const transcript = [
    line({ type: 'custom-title', customTitle: 'x' }),
    line({ type: 'user', message: { content: 'First question' } }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'First answer' }] } }),
    line({ type: 'user', message: { content: [{ type: 'text', text: 'Second question' }] } }),
    line({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } }),
    line({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 't1' },
        ],
      },
    }),
    line({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    }),
    line({
      type: 'assistant',
      isSidechain: true,
      message: { content: [{ type: 'text', text: 'A subagent talking' }] },
    }),
    line({
      uuid: 'a2',
      type: 'assistant',
      message: { content: [{ type: 'text', text: '  The second answer.  ' }] },
    }),
    '{"half a line',
  ].join('\n');

  it('takes the last text after the latest prompt, skipping tool results, thinking and subagents', () => {
    expect(finalText(transcript)).toEqual({ id: 'a2', text: 'The second answer.' });
    expect(
      finalText(`${transcript}\n${line({ type: 'user', message: { content: 'Third' } })}`),
    ).toBeNull();
    expect(finalText('')).toBeNull();
  });

  it("finds the session's transcript in Claude Code's config folder", async () => {
    const root = mkdtempSync(join(tmpdir(), 'opinr-cc-'));
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
      writeFileSync(join(folder, `${id}.jsonl`), transcript);
      const engine = new ClaudeCodeEngine({ configDir: join(root, 'claude') });
      expect(await engine.finalMessage({ id, dir })).toEqual({
        id: 'a2',
        text: 'The second answer.',
      });
      // A session elsewhere is still found by its id.
      expect((await engine.finalMessage({ id, dir: '/somewhere/else' }))?.text).toBe(
        'The second answer.',
      );
      expect(
        await engine.finalMessage({ id: '99999999-2222-5333-8444-555555555555', dir }),
      ).toBeNull();
      expect(await engine.finalMessage({ id: '../../etc/passwd', dir })).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
