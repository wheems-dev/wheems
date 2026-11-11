import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initWorkspace } from '../src/cli/commands/init.js';
import { installYaml } from '../src/cli/templates.js';
import { loadInstall } from '../src/config/load.js';
import { ClaudeCodeEngine } from '../src/drivers/engine/claude-code.js';
import { ConversationManager } from '../src/service/conversations.js';
import { ConversationStore } from '../src/service/store.js';
import { MemoryChannel, MemoryRuntime, type ProgramFactory } from '../src/testing/index.js';

/**
 * A stand-in for Claude Code that writes its transcript the way Claude Code does, so the
 * real Claude Code driver reads it: a prompt, text alongside a tool call while it works,
 * messages that arrive mid-turn, then the answer and the turn_duration marker.
 */
function transcriptAgent(
  configDir: string,
  script: (prompt: string) => 'slow' | 'quick',
): ProgramFactory {
  return ({ args, cwd }) => {
    const id = args[args.indexOf('--session-id') + 1] ?? args[args.indexOf('--resume') + 1] ?? '';
    const folder = join(configDir, 'projects', realpathSync(cwd).replace(/[^A-Za-z0-9]/g, '-'));
    mkdirSync(folder, { recursive: true });
    const file = join(folder, `${id}.jsonl`);
    let n = 0;
    const write = (entry: object) => {
      appendFileSync(file, `${JSON.stringify(entry)}\n`);
    };
    let busy = false;
    const turn = (
      prompt: string,
      io: Parameters<NonNullable<ReturnType<ProgramFactory>['start']>>[0],
    ) => {
      write({ uuid: `p${String(++n)}`, type: 'user', message: { content: prompt } });
      if (busy) return; // Claude Code takes a message that arrives mid-turn into the turn.
      busy = true;
      io.status('working');
      write({
        uuid: `t${String(n)}`,
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Let me check.' },
            { type: 'tool_use', id: 'x' },
          ],
        },
      });
      const finish = () => {
        const answer = script(prompt) === 'slow' ? 'Both done.' : `Answer to: ${prompt}`;
        write({
          uuid: `a${String(n)}`,
          type: 'assistant',
          message: { content: [{ type: 'text', text: answer }] },
        });
        write({ type: 'system', subtype: 'turn_duration', durationMs: 10 });
        busy = false;
        io.status('done');
      };
      setTimeout(finish, script(prompt) === 'slow' ? 120 : 10);
    };
    const task = args.indexOf('--');
    return {
      start(io) {
        writeFileSync(file, '', { flag: 'a' });
        io.status('idle');
        if (task !== -1 && args[task + 1] !== undefined) turn(args[task + 1]!, io);
      },
      input: turn,
    };
  };
}

describe('conversations with the Claude Code driver reading a transcript', () => {
  let home: string;
  let manager: ConversationManager;
  let channel: MemoryChannel;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'opinr-ta-'));
    writeFileSync(
      join(home, 'install.yaml'),
      installYaml().replace('allowed_users: []', 'allowed_users: [UME]'),
    );
    await initWorkspace({ home, id: 'personal' });
    const install = await loadInstall(home);
    const configDir = join(home, 'claude');
    const engine = new ClaudeCodeEngine({ binary: 'claude', configDir });
    const runtime = new MemoryRuntime(
      { claude: transcriptAgent(configDir, (prompt) => (prompt === 'one' ? 'slow' : 'quick')) },
      { waitDelayMs: 15 },
    );
    channel = new MemoryChannel();
    manager = new ConversationManager({
      install: install.config!,
      bindings: [{ workspace: install.workspaces[0]!, connection: 'slack', channel: null }],
      channels: new Map([['slack', channel]]),
      runtime,
      engine: () => engine,
      store: new ConversationStore(join(home, '.opinr', 'conversations.json')),
      sessionEnv: {},
      pollMs: 5,
      startupSeconds: 2,
      followUpSeconds: 0.3,
    });
    await channel.start((event) => manager.handle('slack', event));
  });

  afterEach(async () => {
    await manager.stop();
    rmSync(home, { recursive: true, force: true });
  });

  it('posts only finished answers, once each, when a message arrives mid-turn', async () => {
    const first = await channel.receive({
      channel: 'D1',
      text: 'one',
      userId: 'UME',
      direct: true,
    });
    await new Promise((r) => setTimeout(r, 40));
    await channel.receive({
      channel: 'D1',
      text: 'two',
      userId: 'UME',
      direct: true,
      threadId: first,
    });
    await new Promise((r) => setTimeout(r, 5));
    await manager.whenIdle();
    await channel.receive({
      channel: 'D1',
      text: 'three',
      userId: 'UME',
      direct: true,
      threadId: first,
    });
    await new Promise((r) => setTimeout(r, 5));
    await manager.whenIdle();
    expect(channel.sent.map((m) => m.text)).toEqual(['Both done.', 'Answer to: three']);
  });
});
