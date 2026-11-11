import { join } from 'node:path';
import type { HealthCheck } from '../contracts/driver.js';
import type {
  AgentDefinition,
  EngineCapabilities,
  EngineContext,
  EngineDriver,
  LaunchPlan,
} from '../contracts/engine.js';

/**
 * A minimal engine driver that writes AGENTS.md and starts a given command with
 * the model in its environment. It proves the engine contract and stands in for
 * real engines (Claude Code, Codex, opencode) in tests until they are built.
 */
export class StubEngine implements EngineDriver {
  readonly kind = 'engine' as const;
  readonly name: string;
  readonly capabilities: EngineCapabilities = {
    instructionsFile: 'AGENTS.md',
    skills: false,
    mcp: false,
    hooks: false,
    permissions: false,
    resume: true,
  };
  private readonly command: string[];
  private readonly answers: Map<string, string> | undefined;

  /**
   * With `answers`, the engine reports final messages from it, by conversation id, as an
   * engine that reads its own transcripts does.
   */
  constructor(options: { name?: string; command?: string[]; answers?: Map<string, string> } = {}) {
    this.name = options.name ?? 'stub';
    this.command = options.command ?? ['sh'];
    this.answers = options.answers;
    if (this.answers) {
      const answers = this.answers;
      this.finalMessage = (session) => Promise.resolve(answers.get(session.id) ?? null);
    }
  }

  finalMessage?: (session: { id: string; dir: string }) => Promise<string | null>;

  check(): Promise<HealthCheck[]> {
    return Promise.resolve([
      { name: `${this.name} engine`, status: 'pass', message: 'Stub engine, nothing to install' },
    ]);
  }

  prepare(agent: AgentDefinition, context: EngineContext): Promise<LaunchPlan> {
    return Promise.resolve({
      command: [...this.command, ...(context.session.resume ? ['--resume'] : [])],
      cwd: join(context.sessionDir),
      env: {
        OPINR_AGENT: agent.name,
        OPINR_MODEL: agent.model,
        OPINR_WORKSPACE: context.workspace.id,
        STUB_SESSION: context.session.id,
        STUB_RESUME: context.session.resume ? '1' : '0',
        STUB_PERMISSIONS: agent.permissions,
        ...(context.session.task !== null && { STUB_TASK: context.session.task }),
      },
      files: [{ path: this.capabilities.instructionsFile, content: `${agent.instructions}\n` }],
    });
  }
}
