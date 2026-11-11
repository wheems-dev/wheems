import type { Driver, HealthCheck } from './driver.js';

/**
 * The engine contract: runs an agent in a given CLI. Version one ships Claude
 * Code, Codex and opencode (from milestone 1 onwards).
 *
 * An engine driver turns one agent definition into what its CLI expects: the
 * command that starts it with a model, its instructions file, and later its
 * skills, permissions and MCP servers. It never touches the disk or starts a
 * process itself. It returns a plan, and the framework writes the files and
 * starts the command through the runtime driver.
 */
export interface EngineDriver extends Driver<'engine'> {
  /** What this engine supports, so doctor can say what won't work. */
  readonly capabilities: EngineCapabilities;

  /** Health checks for doctor, such as whether the CLI is installed. */
  check(): Promise<HealthCheck[]>;

  /** Turns an agent definition into a launch plan. Must be deterministic and side-effect free. */
  prepare(agent: AgentDefinition, context: EngineContext): Promise<LaunchPlan>;
}

export interface EngineCapabilities {
  /** The file the engine reads instructions from, such as `CLAUDE.md` or `AGENTS.md`. */
  instructionsFile: string;
  /** Loads skills from a folder the framework controls. */
  skills: boolean;
  /** Can reach MCP servers. */
  mcp: boolean;
  /** Has hooks the framework can use to refuse risky actions early. */
  hooks: boolean;
  /** Has permission settings the framework can write. */
  permissions: boolean;
}

/** An agent as config defines it: front matter plus the Markdown body. */
export interface AgentDefinition {
  name: string;
  description: string | null;
  engine: string;
  model: string;
  /** The install account that pays for this agent. */
  account: string;
  skills: string[];
  integrations: string[];
  /** The Markdown body of the agent file. */
  instructions: string;
}

export interface EngineContext {
  workspace: { id: string; dir: string };
  /** The folder the agent's session runs in. Plan file paths are relative to it. */
  sessionDir: string;
  account: { name: string; driver: string };
}

export interface LaunchPlan {
  /** The program and its arguments. */
  command: string[];
  /** Absolute working directory for the session. */
  cwd: string;
  /** Extra environment for the session. */
  env: Record<string, string>;
  /** Files to write before starting, relative to `cwd`. Never outside it. */
  files: PlannedFile[];
}

export interface PlannedFile {
  path: string;
  content: string;
}
