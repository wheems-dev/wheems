import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument, stringify } from 'yaml';
import { looksLikeSecret } from '../knowledge/notes.js';

/**
 * The install's skill library: every skill, at every version, never loaded into an agent
 * directly. A workspace pins the versions it uses in its `skills.yaml`.
 *
 * ```
 * library/skills/weekly-report/
 *   skill.yaml        who wrote each version
 *   1/SKILL.md
 *   2/SKILL.md
 * ```
 *
 * A version with no entry in `skill.yaml` was put there by a person. Agents can propose a
 * change only to a skill whose latest version an agent wrote: skills people wrote are never
 * changed by an agent.
 */

/** Skill names: lowercase letters, digits and dashes, as Agent Skills and Wheems names are. */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME = 64;
/** The most a skill's description may say: Agent Skills' own limit. */
export const MAX_DESCRIPTION = 1024;
/** The largest SKILL.md the library takes. Skills are instructions, not reference dumps. */
export const MAX_SKILL_SIZE = 64 * 1024;

export interface Skill {
  name: string;
  description: string;
  /** The Markdown after the front matter. */
  body: string;
}

export interface VersionOrigin {
  written_by: 'agent' | 'person';
  workspace?: string;
  agent?: string;
  /** When the person approved it, as YYYY-MM-DD. */
  approved?: string;
  /** True when the person edited the agent's proposal before approving it. */
  edited?: boolean;
}

export interface LibrarySkill {
  name: string;
  /** Every version, lowest first. */
  versions: number[];
  latest: number;
  description: string;
  /** Who wrote the latest version. */
  writtenBy: 'agent' | 'person';
}

export function skillsDir(home: string): string {
  return join(home, 'library', 'skills');
}

export function skillFile(home: string, name: string, version: number): string {
  return join(skillsDir(home), name, String(version), 'SKILL.md');
}

/** Why a name isn't a skill name, or null when it is one. */
export function skillNameProblem(name: string): string | null {
  if (name.length > MAX_NAME) return `a skill name is at most ${String(MAX_NAME)} characters`;
  if (!SKILL_NAME.test(name)) return 'use lowercase letters, digits and single dashes';
  return null;
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

function frontMatter(text: string): { data: Record<string, unknown>; body: string } {
  const match = FRONT_MATTER.exec(text);
  if (!match) {
    throw new Error(
      'A skill starts with front matter between --- lines, with `name` and `description`',
    );
  }
  const doc = parseDocument(match[1] ?? '');
  if (doc.errors.length > 0) {
    throw new Error(`The front matter isn't valid YAML: ${doc.errors[0]?.message ?? ''}`);
  }
  const data: unknown = doc.toJS();
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('The front matter must be `name: …` and `description: …` lines');
  }
  return { data: data as Record<string, unknown>, body: (match[2] ?? '').trim() };
}

function toSkill(data: Record<string, unknown>, body: string): Skill {
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  const description = typeof data.description === 'string' ? data.description.trim() : '';
  const problem = skillNameProblem(name);
  if (problem !== null) throw new Error(`The skill's name "${name}" won't do: ${problem}`);
  if (description === '') {
    throw new Error(
      'The front matter needs a `description`: what the skill does and when to use it',
    );
  }
  if (description.length > MAX_DESCRIPTION) {
    throw new Error(`The description is longer than ${String(MAX_DESCRIPTION)} characters`);
  }
  if (body === '') throw new Error('The skill has no instructions after its front matter');
  return { name, description, body };
}

/**
 * Reads a SKILL.md: front matter with `name` and `description`, then the instructions.
 * Throws with what's wrong, in words an agent can act on.
 */
export function parseSkill(text: string): Skill {
  const { data, body } = frontMatter(text);
  return toSkill(data, body);
}

/** A skill as its SKILL.md. */
export function renderSkill(skill: Skill): string {
  return `---\n${stringify({ name: skill.name, description: skill.description })}---\n\n${skill.body.trim()}\n`;
}

/**
 * Checks a proposed SKILL.md for the skill `name` and returns it. Front matter without a
 * name gets this one; a different name is refused. Throws with what's wrong.
 */
export function checkSkillText(name: string, text: string): Skill {
  if (Buffer.byteLength(text) > MAX_SKILL_SIZE) {
    throw new Error(`A skill is at most ${String(MAX_SKILL_SIZE / 1024)} KB`);
  }
  const problem = skillNameProblem(name);
  if (problem !== null) throw new Error(`"${name}" isn't a skill name: ${problem}`);
  const { data, body } = frontMatter(text);
  const given = typeof data.name === 'string' ? data.name.trim() : '';
  if (given !== '' && given !== name) {
    throw new Error(`The front matter names "${given}", not "${name}"`);
  }
  const skill = toSkill({ ...data, name }, body);
  if (looksLikeSecret(text)) throw new Error('It looks like it holds a credential');
  return skill;
}

/** Every skill in the library, by name. Folders that don't hold a skill are left out. */
export async function listLibrary(home: string): Promise<LibrarySkill[]> {
  const skills: LibrarySkill[] = [];
  for (const name of (await listDir(skillsDir(home))).sort()) {
    if (skillNameProblem(name) !== null) continue;
    const versions = await skillVersions(home, name);
    const latest = versions.at(-1);
    if (latest === undefined) continue;
    const text = await readFile(skillFile(home, name, latest), 'utf8');
    let description = '';
    try {
      description = parseSkill(text).description;
    } catch {
      // A hand-written skill with odd front matter is still in the library.
    }
    const origins = await readOrigins(home, name);
    skills.push({
      name,
      versions,
      latest,
      description,
      writtenBy: origins[latest]?.written_by ?? 'person',
    });
  }
  return skills;
}

/** A skill's versions, lowest first: the numbered folders that hold a SKILL.md. */
export async function skillVersions(home: string, name: string): Promise<number[]> {
  const versions: number[] = [];
  for (const entry of await listDir(join(skillsDir(home), name))) {
    if (!/^[1-9][0-9]{0,5}$/.test(entry)) continue;
    const version = Number(entry);
    if (await isFile(skillFile(home, name, version))) versions.push(version);
  }
  return versions.sort((a, b) => a - b);
}

/** One version of a skill's SKILL.md, or the latest; null when there's no such version. */
export async function readSkill(
  home: string,
  name: string,
  version?: number,
): Promise<{ version: number; text: string } | null> {
  if (skillNameProblem(name) !== null) return null;
  const wanted = version ?? (await skillVersions(home, name)).at(-1);
  if (wanted === undefined) return null;
  const text = await readFile(skillFile(home, name, wanted), 'utf8').catch(() => null);
  return text === null ? null : { version: wanted, text };
}

/** Who wrote each version, from `skill.yaml`. */
export async function readOrigins(
  home: string,
  name: string,
): Promise<Record<number, VersionOrigin>> {
  const text = await readFile(join(skillsDir(home), name, 'skill.yaml'), 'utf8').catch(() => null);
  if (text === null) return {};
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return {};
  const data = (doc.toJS() ?? {}) as { versions?: Record<string, VersionOrigin> };
  const origins: Record<number, VersionOrigin> = {};
  for (const [key, origin] of Object.entries(data.versions ?? {})) {
    if (/^[0-9]+$/.test(key) && typeof origin === 'object') origins[Number(key)] = origin;
  }
  return origins;
}

/**
 * Adds the next version of a skill (version 1 for a new one) and records who wrote it.
 * Returns the version and the paths written, relative to the install folder.
 */
export async function addVersion(
  home: string,
  skill: Skill,
  origin: VersionOrigin,
): Promise<{ version: number; changed: string[] }> {
  const version = ((await skillVersions(home, skill.name)).at(-1) ?? 0) + 1;
  const folder = join(skillsDir(home), skill.name, String(version));
  // Written beside the version and moved in whole, so a half-written skill never shows.
  const staging = `${folder}.writing`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await writeFile(join(staging, 'SKILL.md'), renderSkill(skill));
  await rename(staging, folder);

  const origins = await readOrigins(home, skill.name);
  origins[version] = origin;
  const ordered = Object.fromEntries(
    Object.entries(origins).sort(([a], [b]) => Number(a) - Number(b)),
  );
  await writeFile(
    join(skillsDir(home), skill.name, 'skill.yaml'),
    `# Who wrote each version. A version not listed here was written by a person.\n${stringify({ versions: ordered })}`,
  );
  const base = join('library', 'skills', skill.name);
  return {
    version,
    changed: [join(base, String(version), 'SKILL.md'), join(base, 'skill.yaml')],
  };
}

async function listDir(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => [] as string[]);
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isFile(),
    () => false,
  );
}
