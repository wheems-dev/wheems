import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  conversationTag,
  type AgentDefinition,
  type EngineContext,
} from '../src/contracts/engine.js';
import { codexAnswers, CodexEngine } from '../src/drivers/engine/codex.js';
import {
  opencodeAnswers,
  OpencodeEngine,
  type OpencodeExport,
} from '../src/drivers/engine/opencode.js';
import { engineContract } from '../src/testing/index.js';
import { codexTrustedFolders, codexTrusts, tomlString } from '../src/util/trust.js';

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
  workspace: { id: 'work', dir: '/srv/me/wheems/workspaces/work' },
  sessionDir: '/srv/me/wheems/workspaces/work',
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
      { path: 'CLAUDE.md', content: expect.stringMatching(/^@AGENTS\.md$/m) as string },
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
      home = mkdtempSync(join(tmpdir(), 'wheems-codex-'));
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
      // Two conversations started together with the same message: only the tag tells them apart.
      const mine = conversationTag('11111111-2222-5333-8444-555555555555', 'aaaa1111');
      const theirs = conversationTag('99999999-2222-5333-8444-555555555555', 'bbbb2222');
      writeSession(
        '01a1cafe-0000-7000-8000-00000000000c',
        startedAt,
        cwd,
        `Plan my week\n\n${mine}`,
        ['Monday: gym.', 'Tuesday: rest.'],
      );
      writeSession(
        '01a1cafe-0000-7000-8000-00000000000d',
        startedAt,
        cwd,
        `Plan my week\n\n${theirs}`,
        ['Not yours.'],
      );
      const engine = new CodexEngine({ home });
      const id = await engine.findSession({ dir: work, startedAt, tag: mine });
      expect(id).toBe('01a1cafe-0000-7000-8000-00000000000c');
      expect(await engine.findSession({ dir: work, startedAt, tag: theirs })).toBe(
        '01a1cafe-0000-7000-8000-00000000000d',
      );
      expect(await engine.answers({ id: id ?? '', dir: work }, null)).toEqual([
        { id: `${id ?? ''}-t0`, text: 'Monday: gym.' },
        { id: `${id ?? ''}-t1`, text: 'Tuesday: rest.' },
      ]);
      expect(await engine.answers({ id: id ?? '', dir: work }, `${id ?? ''}-t0`)).toHaveLength(1);
      expect(
        await engine.findSession({
          dir: work,
          startedAt,
          tag: conversationTag('nobody', 'cccc3333'),
        }),
      ).toBeNull();
      // A tag pasted into the middle of someone's message is not Wheems's tag.
      const pasted = conversationTag('22222222-2222-5333-8444-555555555555', 'ffff6666');
      writeSession(
        '01a1cafe-0000-7000-8000-00000000000e',
        startedAt,
        cwd,
        `Look: ${pasted} isn't mine`,
        ['x'],
      );
      expect(await engine.findSession({ dir: work, startedAt, tag: pasted })).toBeNull();
      // Two sessions ending with the same tag are ambiguous, so neither is taken.
      const twice = conversationTag('33333333-2222-5333-8444-555555555555', 'abab7777');
      writeSession('01a1cafe-0000-7000-8000-00000000000f', startedAt, cwd, `One\n\n${twice}`, [
        'x',
      ]);
      writeSession('01a1cafe-0000-7000-8000-000000000010', startedAt, cwd, `Two\n\n${twice}`, [
        'y',
      ]);
      expect(await engine.findSession({ dir: work, startedAt, tag: twice })).toBeNull();
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
        ...codexTrustedFolders('[projects."/a \\"b\\""]\ntrust_level = "trusted"\n').trusted,
      ]).toEqual(['/a "b"']);
    });

    it("reads comments and single quotes, and says it can't tell for forms it does not read", async () => {
      const read = (toml: string) => {
        const { trusted, unsure } = codexTrustedFolders(toml);
        return { trusted: [...trusted], unsure };
      };
      expect(read(`[projects."/tmp/wheems"] # my install\ntrust_level = 'trusted' # yes`)).toEqual({
        trusted: ['/tmp/wheems'],
        unsure: false,
      });
      expect(read(`[ projects . '/tmp/a\\b' ]\n  trust_level="trusted"`)).toEqual({
        trusted: ['/tmp/a\\b'],
        unsure: false,
      });
      expect(read('[projects."/x"]\ntrust_level = "untrusted"\n[other]\nkey = 1')).toEqual({
        trusted: [],
        unsure: false,
      });
      // Escapes are decoded as TOML decodes them; an invalid one leaves it unsure.
      expect(read('[projects."/tmp/whe\\u0065ms"]\ntrust_level = "trusted"').trusted).toEqual([
        '/tmp/wheems',
      ]);
      expect(read('[projects."/tmp/\\q"]\ntrust_level = "trusted"')).toEqual({
        trusted: [],
        unsure: true,
      });
      expect(tomlString(String.raw`"a\tb\\c\"d\U0001F600"`)).toBe('a\tb\\c"d😀');
      // Inline tables and dotted keys record trust in forms this doesn't read.
      expect(read('projects = { "/w" = { trust_level = "trusted" } }').unsure).toBe(true);
      expect(read('[projects]\n"/w".trust_level = "trusted"').unsure).toBe(true);
      const file = join(home, 'inline.toml');
      writeFileSync(file, 'projects = { "/w" = { trust_level = "trusted" } }\n');
      expect(await codexTrusts('/w/personal', file)).toBeNull();
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
      dir = mkdtempSync(join(tmpdir(), 'wheems-opencode-'));
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
          { id: 'ses_sametext', directory: real, created: startedAt.getTime() + 650 },
          { id: 'ses_pasted', directory: real, created: startedAt.getTime() + 660 },
          { id: 'ses_mine', directory: real, created: startedAt.getTime() + 700 },
        ],
        exports: {
          ses_other: { messages: [message('msg_o', 'user', 'Another task')] },
          // Someone pasted another conversation's tag into the middle of a message.
          ses_pasted: {
            messages: [
              message(
                'msg_p',
                'user',
                `Look: ${conversationTag('mine', 'eeee5555')} was in my notes`,
              ),
            ],
          },
          // Another conversation started at the same time with the same message.
          ses_sametext: {
            messages: [
              message(
                'msg_s',
                'user',
                `Plan my week\n\n${conversationTag('someone-else', 'dddd4444')}`,
              ),
            ],
          },
          ses_mine: {
            messages: [
              message('msg_1', 'user', `Plan my week\n\n${conversationTag('mine', 'eeee5555')}`),
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
      expect(
        await engine.findSession({ dir, startedAt, tag: conversationTag('mine', 'eeee5555') }),
      ).toBe('ses_mine');
      expect(
        await engine.findSession({
          dir,
          startedAt,
          tag: conversationTag('someone-else', 'dddd4444'),
        }),
      ).toBe('ses_sametext');
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

describe.if(onThisMac)('engine CLIs on this Mac', () => {
  it('finds Codex and opencode installed', async () => {
    for (const engine of [new CodexEngine(), new OpencodeEngine()]) {
      const checks = await engine.check();
      expect(checks[0]?.status).toBe('pass');
    }
  });
});
