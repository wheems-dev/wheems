import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';
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
  /** Wheems's own skills for the session, written where its engine finds skills. */
  skills?: { name: string; content: string }[];
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
  await writeSkills(
    plan.cwd,
    launch.engine.capabilities.skillsFolder,
    launch.skills ?? [],
    launch.writeFile ?? writeFileMaking,
  );
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

/** Every folder an engine may read skills from, so Wheems's old ones can be cleared from each. */
const SKILL_FOLDERS = ['.claude/skills', '.agents/skills'];
/** Wheems's own skills' names; no other skill in a folder is ever touched. */
const OWN_SKILL = /^wheems-[a-z0-9-]+$/;

/**
 * Writes Wheems's skills into the folder the engine reads them from, and removes Wheems's own
 * skills that it no longer gives, from that folder and any other an engine reads (as after a
 * change of engine). Skills that aren't Wheems's are left alone.
 */
export async function writeSkills(
  cwd: string,
  folder: string,
  skills: { name: string; content: string }[],
  write: (path: string, content: string) => Promise<void>,
): Promise<void> {
  if (isAbsolute(folder) || normalize(folder).startsWith('..')) {
    throw new Error(`The engine's skills folder is outside its folder: ${folder}`);
  }
  for (const s of skills) {
    if (!OWN_SKILL.test(s.name)) throw new Error(`Not one of Wheems's skills: ${s.name}`);
  }
  const keep = new Set(skills.map((s) => s.name));
  for (const each of new Set([...SKILL_FOLDERS, folder])) {
    const dir = join(cwd, each);
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!OWN_SKILL.test(name) || (each === folder && keep.has(name))) continue;
      await rm(join(dir, name), { recursive: true, force: true });
    }
  }
  for (const s of skills) {
    const dir = join(cwd, folder, s.name);
    await mkdir(dir, { recursive: true });
    await write(join(dir, 'SKILL.md'), s.content);
  }
}

async function writeFileMaking(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
