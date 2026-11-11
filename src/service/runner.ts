import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import {
  conversationTag,
  type AgentDefinition,
  type EngineDriver,
  type LaunchPlan,
} from '../contracts/engine.js';
import type { RuntimeDriver } from '../contracts/runtime.js';

export interface TaskRun {
  /** The agent to run, with its full instructions. */
  agent: AgentDefinition;
  engine: EngineDriver;
  workspace: { id: string; dir: string };
  account: { name: string; driver: string };
  /** The folder the agent works in. Its instructions file is written here. */
  dir: string;
  task: string;
  /** The session's name in the runtime, and its labels. */
  name: string;
  labels: Record<string, string>;
  /** Environment the session gets on top of the plan's. */
  env: Record<string, string>;
  timeoutSeconds: number;
}

export type TaskResult =
  | { ok: true; answer: string; sessionId: string }
  | { ok: false; reason: string; sessionId: string | null };

export interface TaskRunnerOptions {
  runtime: RuntimeDriver;
  /** Seconds a session gets to start working on its task. */
  startupSeconds?: number;
  pollMs?: number;
  log?: (message: string) => void;
}

/**
 * Runs one agent on one task outside any chat: starts its session, waits for the turn to
 * finish, reads the agent's answer from the engine's own record, and stops the session.
 * The filing job uses it, and workflows will.
 */
export class TaskRunner {
  private readonly runtime: RuntimeDriver;
  private readonly startupSeconds: number;
  private readonly pollMs: number;
  private readonly log: (message: string) => void;

  constructor(options: TaskRunnerOptions) {
    this.runtime = options.runtime;
    this.startupSeconds = options.startupSeconds ?? 120;
    this.pollMs = options.pollMs ?? 1000;
    this.log = options.log ?? (() => undefined);
  }

  async run(run: TaskRun): Promise<TaskResult> {
    const { engine } = run;
    if (!engine.answers) {
      return { ok: false, reason: `${engine.name} can't report answers`, sessionId: null };
    }
    const id = randomUUID();
    // An engine that picks its own ids finds this session by a tag at the end of the task.
    const tag = engine.findSession ? conversationTag(id, randomBytes(8).toString('hex')) : null;
    const startedAt = new Date();
    const plan = await engine.prepare(run.agent, {
      workspace: run.workspace,
      sessionDir: run.dir,
      account: run.account,
      session: {
        id,
        resume: false,
        task: tag === null ? run.task : `${run.task}\n\n${tag}`,
        engineId: null,
      },
    });
    await writePlanFiles(plan);
    const existing = await this.runtime.get(run.name);
    if (existing) {
      if (existing.state === 'live') await this.runtime.stop(existing.id).catch(() => undefined);
      await this.runtime.remove(existing.id).catch(() => undefined);
    }
    const session = await this.runtime.start({
      name: run.name,
      command: plan.command,
      cwd: plan.cwd,
      env: { ...plan.env, ...run.env },
      labels: run.labels,
    });
    this.log(`Started ${session.id} (${run.name}) for a task`);
    let engineId: string | null = tag === null ? id : null;
    const answerNow = async (): Promise<string | null> => {
      engineId ??=
        (await engine.findSession?.({ dir: run.dir, startedAt, tag: tag ?? '' })) ?? null;
      if (engineId === null || !engine.answers) return null;
      return (await engine.answers({ id: engineId, dir: run.dir }, null)).at(-1)?.text ?? null;
    };
    try {
      const deadline = Date.now() + run.timeoutSeconds * 1000;
      if (engine.capabilities.status) {
        const failed = await this.untilTurnEnds(session.id, deadline);
        if (failed !== null) return { ok: false, reason: failed, sessionId: session.id };
        // The engine may still be writing its record as the turn ends.
        for (let attempt = 0; attempt < 10; attempt++) {
          if (attempt > 0) await sleep(Math.max(50, this.pollMs));
          const answer = await answerNow();
          if (answer !== null) return { ok: true, answer, sessionId: session.id };
        }
        return { ok: false, reason: 'it finished without an answer', sessionId: session.id };
      }
      // No status to follow: the turn has ended once its answer is there.
      while (Date.now() < deadline) {
        const answer = await answerNow();
        if (answer !== null) return { ok: true, answer, sessionId: session.id };
        const current = await this.runtime.get(session.id);
        if (current?.state !== 'live') {
          return { ok: false, reason: 'it ended without an answer', sessionId: session.id };
        }
        await sleep(this.pollMs);
      }
      return { ok: false, reason: 'it ran out of time', sessionId: session.id };
    } finally {
      await this.runtime.stop(session.id).catch(() => undefined);
      await this.runtime.remove(session.id).catch(() => undefined);
    }
  }

  /** Waits for a new session's first turn to end. Returns null when it did, or why it didn't. */
  private async untilTurnEnds(id: string, deadline: number): Promise<string | null> {
    const startBy = Date.now() + this.startupSeconds * 1000;
    while (Date.now() < deadline) {
      const session = await this.runtime.get(id);
      if (!session) return 'its session disappeared';
      if (session.state === 'finished') return null;
      if (session.status === 'blocked') return 'it is waiting for a person at the Mac';
      if (session.status === 'error') return 'it hit an error';
      if (session.turn > 0 && session.status !== 'working') return null;
      if (session.status !== 'working' && Date.now() > startBy)
        return "it didn't start on the task";
      if (session.status === 'working') {
        await this.runtime.wait(id, {
          timeoutSeconds: Math.max(1, Math.min(60, Math.ceil((deadline - Date.now()) / 1000))),
        });
      } else {
        await sleep(this.pollMs);
      }
    }
    return 'it ran out of time';
  }
}

async function writePlanFiles(plan: LaunchPlan): Promise<void> {
  for (const file of plan.files) {
    const target = join(plan.cwd, file.path);
    const rel = relative(plan.cwd, target);
    if (isAbsolute(file.path) || rel.startsWith('..')) {
      throw new Error(`The engine planned a file outside its folder: ${file.path}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
