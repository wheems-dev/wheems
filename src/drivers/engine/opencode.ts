import { realpath } from 'node:fs/promises';
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
import { extractVersion } from '../../util/version.js';
import { instructionsFiles } from './instructions.js';

export interface OpencodeOptions {
  /** The `opencode` executable. Defaults to `opencode` on PATH. */
  binary?: string;
  /** Environment for opencode's own commands (session list, export), for tests. */
  env?: NodeJS.ProcessEnv;
}

const PERMISSION_ARGS: Record<PermissionLevel, string[]> = {
  ask: [],
  // opencode has one setting for this: approve whatever its config doesn't deny.
  auto: ['--auto'],
  skip: ['--auto'],
};

/**
 * The opencode engine driver: any model, through OpenRouter or a provider's own key, or
 * opencode's free models. opencode chooses its own session ids, so the driver finds the
 * session it started (`findSession`) and resumes it with `--session <id>`. Answers come
 * from `opencode export`, its own JSON record of a session.
 */
export class OpencodeEngine implements EngineDriver {
  readonly kind = 'engine' as const;
  readonly name = 'opencode';
  readonly capabilities: EngineCapabilities = {
    instructionsFile: 'AGENTS.md',
    skills: true,
    skillsFolder: '.agents/skills',
    mcp: true,
    hooks: false,
    permissions: true,
    resume: true,
    status: false,
  };
  private readonly binary: string;
  private readonly env: NodeJS.ProcessEnv | undefined;

  constructor(options: OpencodeOptions = {}) {
    this.binary = options.binary ?? 'opencode';
    this.env = options.env;
  }

  async check(): Promise<HealthCheck[]> {
    const version = await this.run(['--version']);
    if (version.missing || version.code !== 0) {
      return [
        {
          name: 'opencode',
          status: 'fail',
          message: version.missing
            ? 'opencode is not installed or not on PATH'
            : version.stderr.trim(),
          hint: 'Run wheems setup and choose Engines to install it.',
        },
      ];
    }
    return [
      {
        name: 'opencode',
        status: 'pass',
        message: `opencode ${extractVersion(version.stdout) ?? version.stdout.trim()}`,
      },
    ];
  }

  prepare(agent: AgentDefinition, context: EngineContext): Promise<LaunchPlan> {
    const { session } = context;
    const resuming = session.resume && session.engineId !== null;
    const command = [
      this.binary,
      '-m',
      agent.model,
      ...(resuming ? ['--session', session.engineId ?? ''] : []),
      ...PERMISSION_ARGS[agent.permissions],
      // opencode ignores --prompt when resuming, so the message is typed in once it starts.
      ...(session.task !== null && !resuming ? ['--prompt', session.task] : []),
    ];
    return Promise.resolve({
      command,
      cwd: context.sessionDir,
      env: {},
      ...(resuming && session.task !== null && { typeAfterStart: session.task }),
      files: instructionsFiles(agent.instructions),
    });
  }

  async findSession(session: {
    dir: string;
    startedAt: Date;
    tag: string;
  }): Promise<string | null> {
    const dir = await realpath(session.dir).catch(() => session.dir);
    const listed = await this.run(['session', 'list', '--format', 'json'], session.dir);
    if (listed.code !== 0) return null;
    let sessions: { id?: string; directory?: string; created?: number }[];
    try {
      sessions = JSON.parse(listed.stdout) as typeof sessions;
    } catch {
      return null;
    }
    const earliest = session.startedAt.getTime() - 5_000;
    const candidates = sessions
      .filter(
        (s) => typeof s.id === 'string' && s.directory === dir && (s.created ?? 0) >= earliest,
      )
      .sort((a, b) => (a.created ?? 0) - (b.created ?? 0));
    const matches: string[] = [];
    for (const candidate of candidates) {
      const exported = await this.export(candidate.id ?? '');
      if (
        exported?.messages?.some(
          (m) => m.info?.role === 'user' && partsText(m).trimEnd().endsWith(session.tag),
        )
      ) {
        matches.push(candidate.id ?? '');
      }
    }
    // Only an unambiguous match will do.
    return matches.length === 1 ? (matches[0] ?? null) : null;
  }

  async answers(
    session: { id: string; dir: string },
    after: string | null,
  ): Promise<FinalMessage[]> {
    const exported = await this.export(session.id);
    return exported ? answersAfter(opencodeAnswers(exported), after) : [];
  }

  private async export(id: string): Promise<OpencodeExport | null> {
    if (!/^ses_[A-Za-z0-9]+$/.test(id)) return null;
    const result = await this.run(['export', id]);
    if (result.code !== 0) return null;
    try {
      return JSON.parse(result.stdout) as OpencodeExport;
    } catch {
      return null;
    }
  }

  private run(args: string[], cwd?: string) {
    return runCommand(this.binary, args, {
      timeoutMs: 30_000,
      ...(this.env !== undefined && { env: this.env }),
      ...(cwd !== undefined && { cwd }),
    });
  }
}

export interface OpencodeMessage {
  info?: {
    id?: string;
    role?: string;
    parentID?: string;
    finish?: string;
    time?: { completed?: number };
  };
  parts?: { type?: string; text?: string }[];
}

export interface OpencodeExport {
  messages?: OpencodeMessage[];
}

function partsText(message: OpencodeMessage): string {
  return (message.parts ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text ?? '')
    .join('\n')
    .trim();
}

/**
 * Each finished turn's answer: the text of the last assistant message that answers a
 * prompt and finished on its own (`finish: "stop"`), not to call a tool. Its id is the
 * prompt's message id, which stays the same however the answer is written.
 */
export function opencodeAnswers(exported: OpencodeExport): FinalMessage[] {
  const messages = exported.messages ?? [];
  const answers: FinalMessage[] = [];
  for (const prompt of messages) {
    if (prompt.info?.role !== 'user' || typeof prompt.info.id !== 'string') continue;
    const replies = messages.filter(
      (m) => m.info?.role === 'assistant' && m.info.parentID === prompt.info?.id,
    );
    const last = replies.at(-1);
    if (last?.info?.finish !== 'stop' || last.info.time?.completed === undefined) continue;
    const text = partsText(last);
    if (text !== '') answers.push({ id: prompt.info.id, text });
  }
  return answers;
}

/** How `wheems setup` installs opencode and signs in. */
export function opencodeSetup(binary = 'opencode'): EngineSetup {
  return {
    version: async () => {
      const result = await runCommand(binary, ['--version'], { timeoutMs: 15_000 });
      return result.code === 0 ? (extractVersion(result.stdout) ?? result.stdout.trim()) : null;
    },
    install: ['npm', 'install', '-g', 'opencode-ai'],
    signIn: [binary, 'providers', 'login'],
    // opencode's free models need no sign-in, so there is no single answer.
    signedIn: () => Promise.resolve(null),
    trust: null,
    defaultModel: 'opencode/big-pickle',
    account: { name: 'opencode', driver: 'opencode' },
  };
}
