import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { AgentDefinition, EngineDriver, LaunchPlan } from '../contracts/engine.js';
import type { RuntimeDriver, SessionInfo } from '../contracts/runtime.js';

/** One agent session to start in the runtime. */
export interface Launch {
  runtime: RuntimeDriver;
  engine: EngineDriver;
  /** The agent, with its instructions as the engine should get them (built-ins included). */
  agent: AgentDefinition;
  workspace: { id: string; dir: string };
  /** The folder the session runs in, where the engine writes the agent's instructions file. */
  sessionDir: string;
  account: { name: string; driver: string };
  session: {
    /** Wheems's id for the session, which names the conversation in engines that take one. */
    id: string;
    /** The runtime session's name. */
    name: string;
    resume: boolean;
    engineId: string | null;
    /** The first message, or null for none. */
    task: string | null;
  };
  env: Record<string, string>;
  labels: Record<string, string>;
  /** Waits until a just-started session reports a status, for engines that report one. */
  untilReady: (id: string) => Promise<void>;
  /** How long to let a program start before typing into it, for engines that report no status. */
  typeDelayMs: number;
  writeFile?: (path: string, content: string) => Promise<void>;
}

/**
 * Starts an agent session: has the engine plan the launch, writes the files it planned into
 * the session's folder, starts the program in the runtime, and types the first message for
 * engines that can't take it at launch.
 */
export async function launchSession(launch: Launch): Promise<SessionInfo> {
  const plan = await launch.engine.prepare(launch.agent, {
    workspace: launch.workspace,
    sessionDir: launch.sessionDir,
    account: launch.account,
    session: {
      id: launch.session.id,
      resume: launch.session.resume,
      task: launch.session.task,
      engineId: launch.session.engineId,
    },
  });
  await writePlanFiles(plan, launch.writeFile ?? writeFileMaking);
  const started = await launch.runtime.start({
    name: launch.session.name,
    command: plan.command,
    cwd: plan.cwd,
    env: { ...plan.env, ...launch.env },
    labels: launch.labels,
  });
  const text = plan.typeAfterStart;
  if (text !== undefined) {
    // The engine can't take this message at launch; type it once the program is ready.
    if (launch.engine.capabilities.status) await launch.untilReady(started.id);
    else await sleep(launch.typeDelayMs);
    await launch.runtime.send(started.id, text);
  }
  return started;
}

async function writePlanFiles(
  plan: LaunchPlan,
  write: (path: string, content: string) => Promise<void>,
): Promise<void> {
  for (const file of plan.files) {
    const target = join(plan.cwd, file.path);
    const rel = relative(plan.cwd, target);
    if (isAbsolute(file.path) || rel.startsWith('..')) {
      throw new Error(`The engine planned a file outside its folder: ${file.path}`);
    }
    await write(target, file.content);
  }
}

async function writeFileMaking(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
