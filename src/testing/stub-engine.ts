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
  };
  private readonly command: string[];

  constructor(options: { name?: string; command?: string[] } = {}) {
    this.name = options.name ?? 'stub';
    this.command = options.command ?? ['sh'];
  }

  check(): Promise<HealthCheck[]> {
    return Promise.resolve([
      { name: `${this.name} engine`, status: 'pass', message: 'Stub engine, nothing to install' },
    ]);
  }

  prepare(agent: AgentDefinition, context: EngineContext): Promise<LaunchPlan> {
    return Promise.resolve({
      command: [...this.command],
      cwd: join(context.sessionDir),
      env: {
        OPINR_AGENT: agent.name,
        OPINR_MODEL: agent.model,
        OPINR_WORKSPACE: context.workspace.id,
      },
      files: [{ path: this.capabilities.instructionsFile, content: `${agent.instructions}\n` }],
    });
  }
}
