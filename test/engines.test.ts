import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentDefinition, EngineContext } from '../src/contracts/engine.js';
import { codexAnswers, CodexEngine } from '../src/drivers/engine/codex.js';
import {
  opencodeAnswers,
  OpencodeEngine,
  type OpencodeExport,
} from '../src/drivers/engine/opencode.js';
import { engineContract } from '../src/testing/index.js';
import { codexTrustedFolders, codexTrusts } from '../src/util/trust.js';

const FAKE_OPENCODE = fileURLToPath(new URL('./helpers/fake-opencode.mjs', import.meta.url));
const onThisMac = process.env.CI === undefined;

engineContract('codex', {
  create: () => new CodexEngine(),
  model: 'gpt-6.1-sol',
  accountDriver: 'chatgpt',
  expectHealthy: false,
});

engineContract('opencode', {
  create: () => new OpencodeEngine(),
  model: 'opencode/big-pickle',
  accountDriver: 'opencode',
  expectHealthy: false,
});

const agent: AgentDefinition = {
  name: 'chief-of-staff',
  description: null,
  engine: 'codex',
  model: 'gpt-6.1-sol',
  account: 'chatgpt-subscription',
  skills: [],
  integrations: [],
  permissions: 'auto',
  instructions: '# Chief of staff',
};
const context: EngineContext = {
  workspace: { id: 'work', dir: '/home/me/opinr/workspaces/work' },
  sessionDir: '/home/me/opinr/workspaces/work',
  account: { name: 'chatgpt-subscription', driver: 'chatgpt' },
  session: {
    id: '11111111-2222-5333-8444-555555555555',
    resume: false,
    task: '-v hello',
    engineId: null,
  },
};

describe('codex engine', () => {
  it('starts Codex without its daemon, with model, permissions and first message', async () => {
    const plan = await new CodexEngine().prepare(agent, context);
    expect(plan.command).toEqual([
      'codex',
      '--no-daemon',
      '-m',
      'gpt-6.1-sol',
      '--approve-for-me',
      '--',
      '-v hello',
    ]);
    expect(plan.files).toEqual([
      { path: 'AGENTS.md', content: expect.stringContaining('# Chief of staff') as string },
    ]);
  });

  it('resumes by the id Codex chose, and starts afresh when there is none', async () => {
    const engine = new CodexEngine();
    const resumed = await engine.prepare(
      { ...agent, permissions: 'skip' },
      {
        ...context,
        session: {
          ...context.session,
          resume: true,
          engineId: '01a1cafe-0000-7000-8000-000000000001',
        },
      },
    );
    expect(resumed.command).toEqual([
      'codex',
      'resume',
      '--no-daemon',
      '-m',
      'gpt-6.1-sol',
      '--dangerously-bypass-approvals-and-sandbox',
      '--',
      '01a1cafe-0000-7000-8000-000000000001',
      '-v hello',
    ]);
    const noId = await engine.prepare(agent, {
      ...context,
      session: { ...context.session, resume: true },
    });
    expect(noId.command[1]).toBe('--no-daemon');
  });

  it("reads each finished turn's answer from task_complete events", () => {
    const record = [
      JSON.stringify({ type: 'session_meta', payload: { id: 'x', cwd: '/w' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 't1', last_agent_message: ' Done. ' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 't2', last_agent_message: null },
      }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't3' } }),
      '{"half a',
    ].join('\n');
    expect(codexAnswers(record)).toEqual([{ id: 't1', text: 'Done.' }]);
  });

  describe('with a Codex home of its own', () => {
    let home: string;
    let work: string;
    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'opinr-codex-'));
      work = join(home, 'work');
      mkdirSync(work);
    });
    afterEach(() => {
      rmSync(home, { recursive: true, force: true });
    });

    const writeSession = (
      id: string,
      startedAt: Date,
      cwd: string,
      prompt: string,
      answers: string[],
    ) => {
      const day = join(
        home,
        'sessions',
        String(startedAt.getUTCFullYear()),
        String(startedAt.getUTCMonth() + 1).padStart(2, '0'),
        String(startedAt.getUTCDate()).padStart(2, '0'),
      );
      mkdirSync(day, { recursive: true });
      const lines = [
        {
          type: 'session_meta',
          payload: {
            id,
            cwd,
            timestamp: startedAt.toISOString(),
            originator: 'codex-tui',
            base_instructions: 'x'.repeat(100_000),
          },
        },
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '# AGENTS.md instructions' }],
          },
        },
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: prompt }],
          },
        },
        ...answers.map((text, i) => ({
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: `${id}-t${String(i)}`,
            last_agent_message: text,
          },
        })),
      ];
      writeFileSync(
        join(
          day,
          `rollout-${startedAt.toISOString().slice(0, 19).replaceAll(':', '-')}-${id}.jsonl`,
        ),
        lines.map((l) => JSON.stringify(l)).join('\n'),
      );
    };

    it('finds the session it started by folder, time and first message, then reads its answers', async () => {
      const startedAt = new Date();
      const cwd = realpathSync(work);
      writeSession(
        '01a1cafe-0000-7000-8000-00000000000a',
        new Date(startedAt.getTime() - 3_600_000),
        cwd,
        'Old task',
        ['old'],
      );
      writeSession(
        '01a1cafe-0000-7000-8000-00000000000b',
        startedAt,
        '/somewhere/else',
        'Plan my week',
        ['wrong folder'],
      );
      writeSession('01a1cafe-0000-7000-8000-00000000000c', startedAt, cwd, 'Plan my week', [
        'Monday: gym.',
        'Tuesday: rest.',
      ]);
      const engine = new CodexEngine({ home });
      const id = await engine.findSession({ dir: work, startedAt, task: 'Plan my week' });
      expect(id).toBe('01a1cafe-0000-7000-8000-00000000000c');
      expect(await engine.answers({ id: id ?? '', dir: work }, null)).toEqual([
        { id: `${id ?? ''}-t0`, text: 'Monday: gym.' },
        { id: `${id ?? ''}-t1`, text: 'Tuesday: rest.' },
      ]);
      expect(await engine.answers({ id: id ?? '', dir: work }, `${id ?? ''}-t0`)).toHaveLength(1);
      expect(await engine.findSession({ dir: work, startedAt, task: 'Something else' })).toBeNull();
      expect(await engine.answers({ id: 'not-a-uuid', dir: work }, null)).toEqual([]);
    });

    it('knows which folders Codex trusts', async () => {
      writeFileSync(
        join(home, 'config.toml'),
        [
          'model = "gpt-6-astra"',
          '',
          `[projects."${realpathSync(home)}"]`,
          'trust_level = "trusted"',
          '',
          '[projects."/other"]',
          'trust_level = "untrusted"',
        ].join('\n'),
      );
      expect(await codexTrusts(work, join(home, 'config.toml'))).toBe(true);
      expect(await codexTrusts('/other/x', join(home, 'config.toml'))).toBe(false);
      expect(await codexTrusts(work, join(home, 'missing.toml'))).toBeNull();
      expect([
        ...codexTrustedFolders('[projects."/a \\"b\\""]\ntrust_level = "trusted"\n'),
      ]).toEqual(['/a "b"']);
    });
  });
});

describe('opencode engine', () => {
  it('starts opencode with model, permissions and first message, and resumes by its session id', async () => {
    const engine = new OpencodeEngine();
    const opencodeAgent = { ...agent, engine: 'opencode', model: 'openrouter/x-ai/grok-5' };
    expect((await engine.prepare(opencodeAgent, context)).command).toEqual([
      'opencode',
      '-m',
      'openrouter/x-ai/grok-5',
      '--auto',
      '--prompt',
      '-v hello',
    ]);
    const resumed = await engine.prepare(
      { ...opencodeAgent, permissions: 'ask' },
      {
        ...context,
        session: { ...context.session, resume: true, engineId: 'ses_abc123', task: null },
      },
    );
    expect(resumed.command).toEqual([
      'opencode',
      '-m',
      'openrouter/x-ai/grok-5',
      '--session',
      'ses_abc123',
    ]);
    // opencode ignores --prompt when resuming, so the message is typed in after it starts.
    const withTask = await engine.prepare(opencodeAgent, {
      ...context,
      session: { ...context.session, resume: true, engineId: 'ses_abc123', task: 'And now?' },
    });
    expect(withTask.command).not.toContain('--prompt');
    expect(withTask.typeAfterStart).toBe('And now?');
  });

  const message = (
    id: string,
    role: 'user' | 'assistant',
    text: string,
    extra: { parentID?: string; finish?: string; completed?: boolean } = {},
  ) => ({
    info: {
      id,
      role,
      ...(extra.parentID !== undefined && { parentID: extra.parentID }),
      ...(extra.finish !== undefined && { finish: extra.finish }),
      time: { created: 1, ...(extra.completed === true && { completed: 2 }) },
    },
    parts: [
      { type: 'step-start' },
      { type: 'text', text },
      { type: 'step-finish', reason: extra.finish },
    ],
  });

  it("reads each finished turn's answer, not text written alongside a tool call", () => {
    const exported: OpencodeExport = {
      messages: [
        message('msg_1', 'user', 'First'),
        message('msg_2', 'assistant', 'Let me look.', {
          parentID: 'msg_1',
          finish: 'tool-calls',
          completed: true,
        }),
        message('msg_3', 'assistant', 'Found it.', {
          parentID: 'msg_1',
          finish: 'stop',
          completed: true,
        }),
        message('msg_4', 'user', 'Second'),
        message('msg_5', 'assistant', 'Working', {
          parentID: 'msg_4',
          finish: 'tool-calls',
          completed: true,
        }),
      ],
    };
    expect(opencodeAnswers(exported)).toEqual([{ id: 'msg_1', text: 'Found it.' }]);
  });

  describe('through its CLI', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'opinr-opencode-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('finds the session it started by folder, time and first message, then reads its answers', async () => {
      const startedAt = new Date();
      const real = realpathSync(dir);
      const data = {
        sessions: [
          { id: 'ses_old', directory: real, created: startedAt.getTime() - 3_600_000 },
          { id: 'ses_elsewhere', directory: '/else', created: startedAt.getTime() + 500 },
          { id: 'ses_other', directory: real, created: startedAt.getTime() + 600 },
          { id: 'ses_mine', directory: real, created: startedAt.getTime() + 700 },
        ],
        exports: {
          ses_other: { messages: [message('msg_o', 'user', 'Another task')] },
          ses_mine: {
            messages: [
              message('msg_1', 'user', 'Plan my week'),
              message('msg_2', 'assistant', 'Monday: gym.', {
                parentID: 'msg_1',
                finish: 'stop',
                completed: true,
              }),
            ],
          },
        },
      };
      writeFileSync(join(dir, 'data.json'), JSON.stringify(data));
      const engine = new OpencodeEngine({
        binary: FAKE_OPENCODE,
        env: { ...process.env, FAKE_OPENCODE_DATA: join(dir, 'data.json') },
      });
      expect(await engine.findSession({ dir, startedAt, task: 'Plan my week' })).toBe('ses_mine');
      expect(await engine.answers({ id: 'ses_mine', dir }, null)).toEqual([
        { id: 'msg_1', text: 'Monday: gym.' },
      ]);
      expect(await engine.answers({ id: 'ses_mine', dir }, 'msg_1')).toEqual([]);
      expect(await engine.answers({ id: 'ses_missing', dir }, null)).toEqual([]);
      expect(await engine.answers({ id: '../etc', dir }, null)).toEqual([]);
      expect((await engine.check())[0]).toMatchObject({
        status: 'pass',
        message: 'opencode 1.19.5',
      });
    });
  });
});

describe.runIf(onThisMac)('engine CLIs on this Mac', () => {
  it('finds Codex and opencode installed', async () => {
    for (const engine of [new CodexEngine(), new OpencodeEngine()]) {
      const checks = await engine.check();
      expect(checks[0]?.status).toBe('pass');
    }
  });
});
