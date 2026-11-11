import { describe, expect, it } from 'vitest';
import type { AgentDefinition, EngineContext } from '../src/contracts/engine.js';
import { ClaudeCodeEngine } from '../src/drivers/engine/claude-code.js';
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
