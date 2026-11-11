import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HealthCheck } from '../../contracts/driver.js';
import type {
  AgentDefinition,
  EngineCapabilities,
  EngineContext,
  EngineDriver,
  FinalMessage,
  LaunchPlan,
  PermissionLevel,
} from '../../contracts/engine.js';
import { runCommand } from '../../util/process.js';
import { extractVersion } from '../../util/version.js';

export interface ClaudeCodeOptions {
  /** The `claude` executable. Defaults to `claude` on PATH. */
  binary?: string;
  /** Claude Code's config folder, which holds session transcripts. Defaults to ~/.claude. */
  configDir?: string;
}

const PERMISSION_ARGS: Record<PermissionLevel, string[]> = {
  ask: [],
  auto: ['--permission-mode', 'auto'],
  skip: ['--dangerously-skip-permissions'],
};

/**
 * The Claude Code engine driver. Each conversation is one Claude Code session,
 * named by the conversation's UUID, so a session that ended can be resumed.
 */
export class ClaudeCodeEngine implements EngineDriver {
  readonly kind = 'engine' as const;
  readonly name = 'claude-code';
  readonly capabilities: EngineCapabilities = {
    instructionsFile: 'CLAUDE.md',
    skills: true,
    mcp: true,
    hooks: true,
    permissions: true,
    resume: true,
  };
  private readonly binary: string;
  private readonly configDir: string;

  constructor(options: ClaudeCodeOptions = {}) {
    this.binary = options.binary ?? 'claude';
    this.configDir =
      options.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  }

  /**
   * Claude's answer to each prompt, from the session's transcript
   * (`projects/<folder>/<session id>.jsonl` in Claude Code's config folder).
   */
  async answers(
    session: { id: string; dir: string },
    after: string | null,
  ): Promise<FinalMessage[]> {
    const file = await this.transcript(session);
    if (file === null) return [];
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      return [];
    }
    const all = turnAnswers(text);
    if (after === null) return all;
    const index = all.findIndex((answer) => answer.id === after);
    return index === -1 ? all : all.slice(index + 1);
  }

  private async transcript(session: { id: string; dir: string }): Promise<string | null> {
    if (!/^[0-9a-f-]{36}$/.test(session.id)) return null;
    const projects = join(this.configDir, 'projects');
    const name = `${session.id}.jsonl`;
    // Claude Code names the folder after the real path, with every other character a dash.
    const real = await realpath(session.dir).catch(() => session.dir);
    const expected = join(projects, real.replace(/[^A-Za-z0-9]/g, '-'), name);
    if (await isFile(expected)) return expected;
    // Otherwise look for it: session ids are unique.
    const folders = await readdir(projects).catch(() => [] as string[]);
    for (const folder of folders) {
      const candidate = join(projects, folder, name);
      if (await isFile(candidate)) return candidate;
    }
    return null;
  }

  async check(): Promise<HealthCheck[]> {
    const result = await runCommand(this.binary, ['--version'], { timeoutMs: 15_000 });
    if (result.missing || result.code !== 0) {
      return [
        {
          name: 'Claude Code',
          status: 'fail',
          message: result.missing ? 'claude is not installed or not on PATH' : result.stderr.trim(),
          hint: 'Install Claude Code and sign in: https://claude.com/claude-code',
        },
      ];
    }
    const version = extractVersion(result.stdout) ?? result.stdout.trim();
    return [{ name: 'Claude Code', status: 'pass', message: `claude ${version}` }];
  }

  prepare(agent: AgentDefinition, context: EngineContext): Promise<LaunchPlan> {
    const { session } = context;
    const command = [
      this.binary,
      '--model',
      agent.model,
      ...(session.resume ? ['--resume', session.id] : ['--session-id', session.id]),
      '--name',
      `${context.workspace.id}-${agent.name}`,
      ...PERMISSION_ARGS[agent.permissions],
      // After --, so a task that starts with a dash is still the first message.
      ...(session.task !== null ? ['--', session.task] : []),
    ];
    return Promise.resolve({
      command,
      cwd: context.sessionDir,
      env: {
        // Transcripts are what --resume reads. A core started from inside another
        // Claude Code session would otherwise turn saving off.
        CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1',
      },
      files: [
        {
          path: this.capabilities.instructionsFile,
          content: `<!-- Written by Opinr from agents/${agent.name}.md; edits here are replaced. -->\n\n${agent.instructions}\n`,
        },
      ],
    });
  }
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isFile(),
    () => false,
  );
}

interface TranscriptEntry {
  type?: string;
  uuid?: string;
  isSidechain?: boolean;
  message?: { content?: string | { type?: string; text?: string }[] };
}

/**
 * The answer to each prompt the person (not a tool) sent: the last text block before the
 * next prompt, with its transcript entry's id. A prompt still being worked on has none.
 */
export function turnAnswers(jsonl: string): FinalMessage[] {
  const entries: TranscriptEntry[] = [];
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue;
    try {
      entries.push(JSON.parse(line) as TranscriptEntry);
    } catch {
      // A line being written as we read; skip it.
    }
  }
  const answers: FinalMessage[] = [];
  let current: FinalMessage | null = null;
  let line = 0;
  for (const entry of entries) {
    line++;
    if (entry.isSidechain === true) continue;
    const content = entry.message?.content;
    if (entry.type === 'user') {
      const isPrompt =
        typeof content === 'string' ||
        (Array.isArray(content) && content.some((block) => block.type === 'text'));
      if (isPrompt) {
        if (current) answers.push(current);
        current = null;
      }
    } else if (entry.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
          current = { id: entry.uuid ?? `line-${String(line)}`, text: block.text.trim() };
        }
      }
    }
  }
  if (current) answers.push(current);
  return answers;
}
