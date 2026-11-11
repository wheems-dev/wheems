import { open, readdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HealthCheck } from '../../contracts/driver.js';
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
import type { EngineSetup } from '../../contracts/setup.js';
import { runCommand } from '../../util/process.js';
import { codexTrusts } from '../../util/trust.js';
import { extractVersion } from '../../util/version.js';

export interface CodexOptions {
  /** The `codex` executable. Defaults to `codex` on PATH. */
  binary?: string;
  /** Codex's home folder, which holds its session records. Defaults to $CODEX_HOME or ~/.codex. */
  home?: string;
}

const PERMISSION_ARGS: Record<PermissionLevel, string[]> = {
  ask: [],
  // Codex reviews approval requests itself, inside its workspace-write sandbox.
  auto: ['--approve-for-me'],
  skip: ['--dangerously-bypass-approvals-and-sandbox'],
};

/**
 * The Codex engine driver. Codex chooses its own session ids, so the driver finds the
 * session it started (`findSession`) and resumes it with `codex resume <id>`. Answers
 * come from Codex's session record: each finished turn is a `task_complete` event.
 */
export class CodexEngine implements EngineDriver {
  readonly kind = 'engine' as const;
  readonly name = 'codex';
  readonly capabilities: EngineCapabilities = {
    instructionsFile: 'AGENTS.md',
    skills: true,
    mcp: true,
    hooks: true,
    permissions: true,
    resume: true,
  };
  private readonly binary: string;
  private readonly home: string;

  constructor(options: CodexOptions = {}) {
    this.binary = options.binary ?? 'codex';
    this.home = options.home ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  }

  async check(): Promise<HealthCheck[]> {
    const version = await runCommand(this.binary, ['--version'], { timeoutMs: 15_000 });
    if (version.missing || version.code !== 0) {
      return [
        {
          name: 'Codex',
          status: 'fail',
          message: version.missing
            ? 'codex is not installed or not on PATH'
            : version.stderr.trim(),
          hint: 'Run opinr setup and choose Engines to install it.',
        },
      ];
    }
    const checks: HealthCheck[] = [
      {
        name: 'Codex',
        status: 'pass',
        message: `codex ${extractVersion(version.stdout) ?? version.stdout.trim()}`,
      },
    ];
    const login = await runCommand(this.binary, ['login', 'status'], { timeoutMs: 15_000 });
    checks.push(
      login.code === 0
        ? { name: 'Codex sign-in', status: 'pass', message: (login.stdout || login.stderr).trim() }
        : {
            name: 'Codex sign-in',
            status: 'warn',
            message: 'Codex is not signed in',
            hint: 'Run codex login, or opinr setup and choose Engines.',
          },
    );
    return checks;
  }

  prepare(agent: AgentDefinition, context: EngineContext): Promise<LaunchPlan> {
    const { session } = context;
    const options = ['--no-daemon', '-m', agent.model, ...PERMISSION_ARGS[agent.permissions]];
    const resuming = session.resume && session.engineId !== null;
    // Herdr needs --no-daemon, or Codex runs its commands outside the terminal.
    const command = resuming
      ? [
          this.binary,
          'resume',
          ...options,
          '--',
          session.engineId ?? '',
          ...(session.task !== null ? [session.task] : []),
        ]
      : [this.binary, ...options, ...(session.task !== null ? ['--', session.task] : [])];
    return Promise.resolve({
      command,
      cwd: context.sessionDir,
      env: {},
      files: [
        {
          path: this.capabilities.instructionsFile,
          content: `<!-- Written by Opinr from agents/${agent.name}.md; edits here are replaced. -->\n\n${agent.instructions}\n`,
        },
      ],
    });
  }

  async findSession(session: {
    dir: string;
    startedAt: Date;
    task: string;
  }): Promise<string | null> {
    const dir = await realpath(session.dir).catch(() => session.dir);
    const earliest = session.startedAt.getTime() - 5_000;
    for (const file of await this.recentRecords(session.startedAt)) {
      const meta = await firstRecord(file);
      if (meta?.type !== 'session_meta') continue;
      const payload = meta.payload as { id?: string; cwd?: string; timestamp?: string } | undefined;
      if (payload?.cwd !== dir || typeof payload.id !== 'string') continue;
      if (Date.parse(payload.timestamp ?? '') < earliest) continue;
      if (!(await hasUserText(file, session.task.trim()))) continue;
      return payload.id;
    }
    return null;
  }

  async answers(
    session: { id: string; dir: string },
    after: string | null,
  ): Promise<FinalMessage[]> {
    const file = await this.recordFor(session.id);
    if (file === null) return [];
    const text = await readFile(file, 'utf8').catch(() => '');
    return answersAfter(codexAnswers(text), after);
  }

  /** Session records from the day a session started until today, newest first. */
  private async recentRecords(since: Date): Promise<string[]> {
    const files: string[] = [];
    const day = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate()));
    // Codex files records by local date; look a day either side to be safe.
    day.setUTCDate(day.getUTCDate() - 1);
    for (
      const end = Date.now() + 86_400_000;
      day.getTime() <= end;
      day.setUTCDate(day.getUTCDate() + 1)
    ) {
      const folder = join(
        this.home,
        'sessions',
        String(day.getUTCFullYear()),
        String(day.getUTCMonth() + 1).padStart(2, '0'),
        String(day.getUTCDate()).padStart(2, '0'),
      );
      for (const name of await readdir(folder).catch(() => [] as string[])) {
        if (name.startsWith('rollout-') && name.endsWith('.jsonl')) files.push(join(folder, name));
      }
    }
    return files.sort().reverse();
  }

  private async recordFor(id: string): Promise<string | null> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return null;
    const sessions = join(this.home, 'sessions');
    // Record files end with the session id: rollout-<time>-<id>.jsonl.
    for (const year of (await readdir(sessions).catch(() => [] as string[])).sort().reverse()) {
      for (const month of (await readdir(join(sessions, year)).catch(() => [] as string[]))
        .sort()
        .reverse()) {
        for (const day of (await readdir(join(sessions, year, month)).catch(() => [] as string[]))
          .sort()
          .reverse()) {
          const folder = join(sessions, year, month, day);
          const name = (await readdir(folder).catch(() => [] as string[])).find((n) =>
            n.endsWith(`-${id}.jsonl`),
          );
          if (name !== undefined) return join(folder, name);
        }
      }
    }
    return null;
  }
}

interface CodexRecord {
  type?: string;
  payload?: Record<string, unknown>;
}

/** Each finished turn's answer: the \`last_agent_message\` of a \`task_complete\` event. */
export function codexAnswers(jsonl: string): FinalMessage[] {
  const answers: FinalMessage[] = [];
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue;
    let record: CodexRecord;
    try {
      record = JSON.parse(line) as CodexRecord;
    } catch {
      continue; // A line being written as we read.
    }
    const payload = record.payload;
    if (record.type !== 'event_msg' || payload?.type !== 'task_complete') continue;
    const id = payload.turn_id;
    const text = payload.last_agent_message;
    if (typeof id === 'string' && typeof text === 'string' && text.trim() !== '') {
      answers.push({ id, text: text.trim() });
    }
  }
  return answers;
}

/**
 * The first line of a record file, read without loading the rest. The first line holds
 * the session's metadata and can be tens of kilobytes, so read until its end (up to 4 MB).
 */
async function firstRecord(file: string): Promise<CodexRecord | null> {
  const handle = await open(file, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const chunks: Buffer[] = [];
    for (let position = 0; position < 4 * 1024 * 1024;) {
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(10);
      chunks.push(newline === -1 ? chunk : chunk.subarray(0, newline));
      if (newline !== -1) break;
      position += bytesRead;
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as CodexRecord;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/** Whether any message from the user in a record contains the text. */
async function hasUserText(file: string, wanted: string): Promise<boolean> {
  const text = await readFile(file, 'utf8').catch(() => '');
  for (const line of text.split('\n')) {
    if (!line.includes('"user"')) continue;
    try {
      const record = JSON.parse(line) as CodexRecord;
      const payload = record.payload;
      if (record.type !== 'response_item' || payload?.type !== 'message' || payload.role !== 'user')
        continue;
      const content = payload.content as { type?: string; text?: string }[] | undefined;
      if (content?.some((block) => typeof block.text === 'string' && block.text.includes(wanted)))
        return true;
    } catch {
      // Keep looking.
    }
  }
  return false;
}

/** How `opinr setup` installs Codex and signs in. */
export function codexSetup(binary = 'codex'): EngineSetup {
  return {
    version: async () => {
      const result = await runCommand(binary, ['--version'], { timeoutMs: 15_000 });
      return result.code === 0 ? (extractVersion(result.stdout) ?? result.stdout.trim()) : null;
    },
    install: ['npm', 'install', '-g', '@openai/codex'],
    signIn: [binary, 'login'],
    signedIn: async () =>
      (await runCommand(binary, ['login', 'status'], { timeoutMs: 15_000 })).code === 0,
    trust: [binary, '--no-daemon'],
    trusted: (dir) => codexTrusts(dir),
    herdrIntegration: 'codex',
    defaultModel: 'gpt-6.1-sol',
    account: { name: 'chatgpt-subscription', driver: 'chatgpt' },
  };
}
