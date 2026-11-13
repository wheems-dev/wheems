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

  /**
   * Optional: the agent's answers, one per finished turn (the last thing it wrote in the
   * turn), read from the engine's own structured record of the conversation, never the
   * screen. A turn still running has no answer. Each answer's id must stay the same once
   * the turn has finished. Returns the answers after the one with id \`after\`: all of them
   * when \`after\` is null, and only the latest when no answer has that id, so history is
   * never posted again. Use \`answersAfter\` for this. With it, the service posts each answer
   * for the agent; without it, agents answer only through \`wheems reply\`.
   */
  answers?(session: { id: string; dir: string }, after: string | null): Promise<FinalMessage[]>;

  /**
   * Optional, for engines that choose their own session ids (Codex, opencode): finds the
   * session this engine started in \`dir\` at \`startedAt\` whose first message ends with
   * \`tag\` (see \`conversationTag\`), and returns its id, or null when it can't be found yet or
   * more than one session matches. The tag is unique to each launch, so two conversations
   * never claim the same session. The
   * service keeps the id with the conversation, passes it back as \`session.engineId\` to
   * resume, and uses it as the session id for \`answers\`. Engines that take Wheems's id
   * (Claude Code) don't need it.
   */
  findSession?(session: { dir: string; startedAt: Date; tag: string }): Promise<string | null>;
}

/** An agent's answer: its final message of a turn. */
export interface FinalMessage {
  /** Identifies this message in the engine's record, so it is never posted twice. */
  id: string;
  text: string;
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
  /** Can carry on an earlier conversation by its session id. */
  resume: boolean;
  /**
   * Reports its status (working, done, blocked) to the runtime, so a turn can be followed
   * by status. Without it, the service follows a turn by its answers (\`answers\`) instead.
   */
  status: boolean;
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
  /**
   * How much the agent may do without asking. `ask`: the engine's normal prompts.
   * `auto`: the engine decides routine actions itself and asks for risky ones.
   * `skip`: never asks.
   */
  permissions: PermissionLevel;
  /** The Markdown body of the agent file. */
  instructions: string;
}

export type PermissionLevel = 'ask' | 'auto' | 'skip';

export interface EngineContext {
  workspace: { id: string; dir: string };
  /** The folder the agent's session runs in. Plan file paths are relative to it. */
  sessionDir: string;
  account: { name: string; driver: string };
  /** The conversation this launch is for. */
  session: {
    /** A UUID that names the conversation in the engine, stable across restarts. */
    id: string;
    /** True when the engine has had this conversation before and should carry it on. */
    resume: boolean;
    /** The first thing to say to the agent, or null to start it idle. */
    task: string | null;
    /**
     * The engine's own id for this conversation, for engines that choose their own ids
     * (see `findSession`), once found. Null for a new conversation.
     */
    engineId: string | null;
  };
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
  /**
   * Text to type into the program once it has started, for the cases where the engine
   * can't take the first message on its command line (opencode ignores \`--prompt\` when
   * resuming a session). The service types it once the program is ready.
   */
  typeAfterStart?: string;
}

export interface PlannedFile {
  path: string;
  content: string;
}

/** The answers after the one with id \`after\`, as \`EngineDriver.answers\` returns them. */
export function answersAfter(all: FinalMessage[], after: string | null): FinalMessage[] {
  if (after === null) return all;
  const index = all.findIndex((answer) => answer.id === after);
  return index === -1 ? all.slice(-1) : all.slice(index + 1);
}

/**
 * The tag the service adds to the end of the first message of a conversation on an engine
 * that chooses its own session ids, so \`findSession\` can tell its session from any other.
 * \`launch\` is random for each launch, so nobody can write a tag that matches another
 * conversation's session.
 */
export function conversationTag(conversationId: string, launch: string): string {
  return `<wheems conversation="${conversationId}" launch="${launch}"/>`;
}
