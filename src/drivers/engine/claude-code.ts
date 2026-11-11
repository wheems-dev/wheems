import type { HealthCheck } from '../../contracts/driver.js';
import type {
  AgentDefinition,
  EngineCapabilities,
  EngineContext,
  EngineDriver,
  LaunchPlan,
  PermissionLevel,
} from '../../contracts/engine.js';
import { runCommand } from '../../util/process.js';
import { extractVersion } from '../../util/version.js';

export interface ClaudeCodeOptions {
  /** The `claude` executable. Defaults to `claude` on PATH. */
  binary?: string;
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

  constructor(options: ClaudeCodeOptions = {}) {
    this.binary = options.binary ?? 'claude';
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
