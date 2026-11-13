import { join } from 'node:path';
import type { HealthCheck } from '../contracts/driver.js';
import {
  answersAfter,
  type FinalMessage,
  type AgentDefinition,
  type EngineCapabilities,
  type EngineContext,
  type EngineDriver,
  type LaunchPlan,
} from '../contracts/engine.js';

/**
 * A minimal engine driver that writes AGENTS.md and starts a given command with
 * the model in its environment. It proves the engine contract and stands in for
 * real engines (Claude Code, Codex, opencode) in tests until they are built.
 */
export class StubEngine implements EngineDriver {
  readonly kind = 'engine' as const;
  readonly name: string;
  capabilities: EngineCapabilities = {
    instructionsFile: 'AGENTS.md',
    skills: false,
    mcp: false,
    hooks: false,
    permissions: false,
    resume: true,
    status: true,
  };
  private readonly command: string[];
  private readonly recorded: Map<string, FinalMessage[]> | undefined;

  /**
   * With `answers`, the engine reports each conversation's answers from it, by conversation
   * id, as an engine that reads its own transcripts does.
   */
  /** For engines that choose their own ids: the ids handed out, by first task. */
  private readonly ownIds: Map<string, string> | undefined;
  private nextOwnId = 1;
  private readonly typeOnResume: boolean;

  /**
   * With `ownIds`, the engine behaves like Codex or opencode: it ignores Wheems's session id,
   * picks its own (`own-1`, `own-2`, …) and offers `findSession` to find it.
   */
  constructor(
    options: {
      name?: string;
      command?: string[];
      answers?: Map<string, FinalMessage[]>;
      ownIds?: boolean;
      /** False for an engine that reports no status, like opencode. */
      reportsStatus?: boolean;
      /** True for an engine that takes no first message when resuming, like opencode. */
      typeOnResume?: boolean;
    } = {},
  ) {
    this.typeOnResume = options.typeOnResume === true;
    if (options.reportsStatus === false)
      this.capabilities = { ...this.capabilities, status: false };
    this.name = options.name ?? 'stub';
    this.command = options.command ?? ['sh'];
    this.recorded = options.answers;
    if (options.ownIds === true) {
      const ownIds = new Map<string, string>();
      this.ownIds = ownIds;
      this.findSession = (session) => {
        for (const [task, id] of ownIds) if (task.includes(session.tag)) return Promise.resolve(id);
        return Promise.resolve(null);
      };
    }
    if (this.recorded) {
      const recorded = this.recorded;
      this.answers = (session, after) =>
        Promise.resolve(answersAfter(recorded.get(session.id) ?? [], after));
    }
  }

  answers?: (session: { id: string; dir: string }, after: string | null) => Promise<FinalMessage[]>;
  findSession?: (session: { dir: string; startedAt: Date; tag: string }) => Promise<string | null>;

  check(): Promise<HealthCheck[]> {
    return Promise.resolve([
      { name: `${this.name} engine`, status: 'pass', message: 'Stub engine, nothing to install' },
    ]);
  }

  prepare(agent: AgentDefinition, context: EngineContext): Promise<LaunchPlan> {
    let sessionId = context.session.id;
    if (this.ownIds) {
      // A fresh session gets a new id of the engine's own; a resumed one keeps its id.
      const resuming = context.session.resume && context.session.engineId !== null;
      sessionId = resuming ? (context.session.engineId ?? '') : `own-${String(this.nextOwnId++)}`;
      if (!resuming && context.session.task !== null)
        this.ownIds.set(context.session.task, sessionId);
    }
    return Promise.resolve({
      command: [...this.command, ...(context.session.resume ? ['--resume'] : [])],
      cwd: join(context.sessionDir),
      env: {
        WHEEMS_AGENT: agent.name,
        WHEEMS_MODEL: agent.model,
        WHEEMS_WORKSPACE: context.workspace.id,
        STUB_SESSION: sessionId,
        STUB_RESUME: context.session.resume ? '1' : '0',
        STUB_PERMISSIONS: agent.permissions,
        ...(context.session.task !== null &&
          !(this.typeOnResume && context.session.resume) && { STUB_TASK: context.session.task }),
      },
      ...(this.typeOnResume &&
        context.session.resume &&
        context.session.task !== null && { typeAfterStart: context.session.task }),
      files: [{ path: this.capabilities.instructionsFile, content: `${agent.instructions}\n` }],
    });
  }
}
