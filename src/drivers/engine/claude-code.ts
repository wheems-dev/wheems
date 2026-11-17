import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { HealthCheck } from '../../contracts/driver.js';
import type { EngineSetup } from '../../contracts/setup.js';
import {
  answersAfter,
  type AgentDefinition,
  type EngineCapabilities,
  type EngineContext,
  type EngineDriver,
  type FinalMessage,
  type LaunchPlan,
  type PermissionLevel,
} from '../../contracts/engine.js';
import { runCommand } from '../../util/process.js';
import { claudeTrusts } from '../../util/trust.js';
import { markClaudeTrusted } from '../../util/trust-write.js';
import { extractVersion } from '../../util/version.js';
import { instructionsFiles } from './instructions.js';

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
    skillsFolder: '.claude/skills',
    mcp: true,
    hooks: true,
    permissions: true,
    resume: true,
    status: true,
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
    return answersAfter(turnAnswers(text), after);
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
    return [
      { name: 'Claude Code', status: 'pass', message: `claude ${version}` },
      await this.signInCheck(),
    ];
  }

  /** Whether Claude Code is signed in, from `claude auth status`. Never shows the account. */
  private async signInCheck(): Promise<HealthCheck> {
    const status = await runCommand(this.binary, ['auth', 'status', '--json'], {
      timeoutMs: 15_000,
    });
    let loggedIn: boolean | null = null;
    let method: string | null = null;
    try {
      const parsed = JSON.parse(status.stdout) as { loggedIn?: unknown; authMethod?: unknown };
      if (typeof parsed.loggedIn === 'boolean') loggedIn = parsed.loggedIn;
      if (typeof parsed.authMethod === 'string') method = parsed.authMethod;
    } catch {
      // An older Claude Code without `auth status`, or output it doesn't recognise.
    }
    if (loggedIn === true) {
      return {
        name: 'Claude Code sign-in',
        status: 'pass',
        message: method !== null ? `Signed in (${method})` : 'Signed in',
      };
    }
    if (loggedIn === false) {
      return {
        name: 'Claude Code sign-in',
        status: 'fail',
        message: 'Claude Code is not signed in, so agents on it cannot answer',
        hint: 'Run claude auth login, or wheems setup and choose Engines.',
      };
    }
    return {
      name: 'Claude Code sign-in',
      status: 'warn',
      message: "Couldn't tell whether Claude Code is signed in (claude auth status didn't say)",
      hint: 'Update Claude Code, or check by running claude yourself.',
    };
  }

  /**
   * Every CLAUDE.md Claude Code would load into a session in \`sessionDir\` besides the one Wheems
   * writes there: the person's own (\`~/.claude/CLAUDE.md\`), and any in a folder above the
   * session's. Absolute paths, since Claude Code's \`claudeMdExcludes\` matches those.
   */
  async othersInstructions(sessionDir: string): Promise<string[]> {
    const files = new Set<string>();
    // Both as given and as the real path, since Claude Code sees the folder through any symlink.
    for (const config of new Set([resolve(this.configDir), await canonical(this.configDir)])) {
      files.add(join(config, 'CLAUDE.md'));
    }
    for (const start of new Set([resolve(sessionDir), await canonical(sessionDir)])) {
      let dir = start;
      for (let parent = dirname(dir); parent !== dir; dir = parent, parent = dirname(dir)) {
        for (const name of FOLDER_INSTRUCTIONS) files.add(join(parent, name));
      }
    }
    return [...files];
  }

  /**
   * The person's own skills, in \`~/.claude/skills/\`, by name: written for their own work, so
   * hidden from Wheems's sessions. Never one of Wheems's, which share the names it gives them.
   */
  async ownSkills(): Promise<string[]> {
    const dir = join(this.configDir, 'skills');
    const names = new Set<string>();
    for (const entry of await readdir(dir).catch(() => [] as string[])) {
      let text: string;
      try {
        text = await readFile(join(dir, entry, 'SKILL.md'), 'utf8');
      } catch {
        continue;
      }
      const named = /^---\r?\n[\s\S]*?^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(text)?.[1];
      for (const name of [entry, named]) {
        if (name !== undefined && !name.startsWith('wheems-')) names.add(name);
      }
    }
    return [...names].sort();
  }

  async prepare(agent: AgentDefinition, context: EngineContext): Promise<LaunchPlan> {
    const { session } = context;
    // Only Wheems's instructions and skills: none of the person's own CLAUDE.md files or skills,
    // which are written for their own work (docs/instructions.md). Their plugins, MCP servers,
    // connectors and other settings stay.
    const settings = {
      claudeMdExcludes: await this.othersInstructions(context.sessionDir),
      skillOverrides: Object.fromEntries((await this.ownSkills()).map((name) => [name, 'off'])),
    };
    const command = [
      this.binary,
      '--model',
      agent.model,
      ...(session.resume ? ['--resume', session.id] : ['--session-id', session.id]),
      '--name',
      `${context.workspace.id}-${agent.name}`,
      ...PERMISSION_ARGS[agent.permissions],
      '--settings',
      JSON.stringify(settings),
      // After --, so a task that starts with a dash is still the first message.
      ...(session.task !== null ? ['--', session.task] : []),
    ];
    return {
      command,
      cwd: context.sessionDir,
      env: {
        // Transcripts are what --resume reads. A core started from inside another
        // Claude Code session would otherwise turn saving off.
        CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1',
      },
      files: instructionsFiles(agent.instructions),
    };
  }
}

/** The instruction files Claude Code reads by itself, in a folder or one of its parents. */
const FOLDER_INSTRUCTIONS = ['CLAUDE.md', 'CLAUDE.local.md', join('.claude', 'CLAUDE.md')];

/**
 * A path with its symlinks resolved, as far as it exists: a folder not made yet keeps the rest
 * of its path under its nearest real parent.
 */
async function canonical(path: string): Promise<string> {
  const rest: string[] = [];
  let at = resolve(path);
  for (;;) {
    try {
      return join(await realpath(at), ...rest);
    } catch {
      const parent = dirname(at);
      if (parent === at) return resolve(path);
      rest.unshift(basename(at));
      at = parent;
    }
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
  subtype?: string;
  uuid?: string;
  isSidechain?: boolean;
  message?: { content?: string | { type?: string; text?: string }[] };
}

/**
 * The answer to each finished turn. Claude Code ends every turn with a \`system\` entry of
 * subtype \`turn_duration\`; the answer is the last text Claude wrote in the turn. Its id is
 * the id of the turn's first prompt, which stays the same however the answer is written,
 * and prompts that reached Claude during the turn belong to it. A turn still running has
 * no answer yet.
 */
export function turnAnswers(jsonl: string): FinalMessage[] {
  const answers: FinalMessage[] = [];
  let promptId: string | null = null;
  let text: string | null = null;
  let line = 0;
  for (const raw of jsonl.split('\n')) {
    line++;
    if (raw.trim() === '') continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(raw) as TranscriptEntry;
    } catch {
      continue; // A line being written as we read.
    }
    if (entry.isSidechain === true) continue;
    const content = entry.message?.content;
    if (entry.type === 'user') {
      const isPrompt =
        typeof content === 'string' ||
        (Array.isArray(content) && content.some((block) => block.type === 'text'));
      if (isPrompt) promptId ??= entry.uuid ?? `line-${String(line)}`;
    } else if (entry.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
          text = block.text.trim();
        }
      }
    } else if (entry.type === 'system' && entry.subtype === 'turn_duration') {
      if (promptId !== null && text !== null) answers.push({ id: promptId, text });
      promptId = null;
      text = null;
    }
  }
  return answers;
}

/** How `wheems setup` installs Claude Code and signs in. */
export function claudeCodeSetup(binary = 'claude'): EngineSetup {
  return {
    version: async () => {
      const result = await runCommand(binary, ['--version'], { timeoutMs: 15_000 });
      return result.code === 0 ? (extractVersion(result.stdout) ?? result.stdout.trim()) : null;
    },
    install: ['npm', 'install', '-g', '@anthropic-ai/claude-code'],
    signIn: [binary, 'auth', 'login'],
    signedIn: async () => {
      const result = await runCommand(binary, ['auth', 'status', '--json'], { timeoutMs: 15_000 });
      if (result.code !== 0) return false;
      try {
        return (JSON.parse(result.stdout) as { loggedIn?: boolean }).loggedIn === true;
      } catch {
        return null;
      }
    },
    trust: [binary],
    trusted: (dir) => claudeTrusts(dir),
    markTrusted: (dir) => markClaudeTrusted(dir),
    trustRecord:
      process.env.CLAUDE_CONFIG_DIR !== undefined
        ? '$CLAUDE_CONFIG_DIR/.claude.json'
        : '~/.claude.json',
    defaultModel: 'claude-opus-5-5',
    account: { name: 'claude-subscription', driver: 'claude' },
  };
}
