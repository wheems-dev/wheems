import { appendFile, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { GENERATED_IGNORES, goalMd } from '../cli/templates.js';
import { CHIEF_FILE, DEFAULT_CHIEF, GOAL_FILE } from './load.js';

/** The heading of the goal section in a chief file from 0.1.9's template. */
const GOAL_HEADING = /^## What we're working towards[ \t]*$/m;

/**
 * Moves an install's workspaces to the files of 0.1.11 (docs/instructions.md): each chief's
 * `agents/<chief>.md` becomes `WHEEMS.md`, its "What we're working towards" section goes to
 * `GOAL.md`, a workspace without `GOAL.md` gets one to fill in, and the install's `.gitignore`
 * gets the files Wheems writes. Nothing already there is replaced. Returns what it did, to log.
 */
export async function moveToWheemsFiles(home: string): Promise<string[]> {
  const done: string[] = [];
  const workspaces = join(home, 'workspaces');
  for (const id of await list(workspaces)) {
    const dir = join(workspaces, id);
    if (!(await isDirectory(dir)) || !(await exists(join(dir, 'workspace.yaml')))) continue;
    const config = await readConfig(join(dir, 'workspace.yaml'));
    const wheems = join(dir, CHIEF_FILE);
    const goal = join(dir, GOAL_FILE);
    const old = join(dir, 'agents', `${config.chief}.md`);
    let goalText: string | null = null;
    if (!(await exists(wheems)) && (await exists(old))) {
      const split = splitGoal(await readFile(old, 'utf8'));
      goalText = split.goal;
      // Written only if it isn't there, before the old file goes, so nothing is ever lost.
      await writeFile(wheems, split.chief, { flag: 'wx' });
      await unlink(old);
      done.push(`Moved ${id}'s chief of staff from agents/${config.chief}.md to ${CHIEF_FILE}`);
    }
    if (!(await exists(goal))) {
      const template = goalMd(config.name ?? id);
      await writeFile(goal, goalText !== null ? `${template}\n${goalText}\n` : template, {
        flag: 'wx',
      });
      done.push(
        goalText !== null
          ? `Moved ${id}'s goal to ${GOAL_FILE}`
          : `Added ${GOAL_FILE} to ${id}, for its goal`,
      );
    }
  }
  const ignore = join(home, '.gitignore');
  if (await exists(ignore)) {
    const lines = new Set((await readFile(ignore, 'utf8')).split('\n').map((l) => l.trim()));
    const missing = GENERATED_IGNORES.filter((line) => !lines.has(line));
    if (missing.length > 0) {
      const text = await readFile(ignore, 'utf8');
      await appendFile(
        ignore,
        `${text.endsWith('\n') || text === '' ? '' : '\n'}# Written by Wheems at every start.\n${missing.join('\n')}\n`,
      );
      done.push(`Added ${missing.join(', ')} to .gitignore`);
    }
  }
  return done;
}

/**
 * Splits a chief file from 0.1.9's template into the chief and its goal: the text under "What
 * we're working towards", up to the next heading of its level. The goal is null when there's
 * none, or nothing in it but comments.
 */
export function splitGoal(text: string): { chief: string; goal: string | null } {
  const heading = GOAL_HEADING.exec(text);
  if (!heading) return { chief: text, goal: null };
  const start = heading.index;
  const afterHeading = start + heading[0].length;
  const next = /^#{1,2} /m.exec(text.slice(afterHeading));
  const end = next ? afterHeading + next.index : text.length;
  const body = text.slice(afterHeading, end).trim();
  const chief = `${text.slice(0, start).trimEnd()}\n${next ? `\n${text.slice(end)}` : ''}`;
  const filled = body.replace(/<!--[\s\S]*?-->/g, '').trim();
  return { chief, goal: filled === '' ? null : body };
}

async function readConfig(file: string): Promise<{ chief: string; name: string | null }> {
  try {
    const parsed = parse(await readFile(file, 'utf8')) as {
      chief_of_staff?: unknown;
      name?: unknown;
    } | null;
    return {
      chief:
        typeof parsed?.chief_of_staff === 'string' && /^[a-z0-9-]+$/.test(parsed.chief_of_staff)
          ? parsed.chief_of_staff
          : DEFAULT_CHIEF,
      name: typeof parsed?.name === 'string' ? parsed.name : null,
    };
  } catch {
    // A workspace.yaml that won't parse is doctor's to report; its chief keeps the default name.
    return { chief: DEFAULT_CHIEF, name: null };
  }
}

async function list(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => []);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );
}
