/**
 * Whether engines trust a folder. Each asks once ("trust this folder?") and records the
 * answer in its own config, for the folder or a folder around it (such as the git root).
 * Wheems only ever reads these records.
 */
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Claude Code: `projects[<folder>].hasTrustDialogAccepted` in ~/.claude.json. */
export async function claudeTrusts(
  dir: string,
  file = join(homedir(), '.claude.json'),
): Promise<boolean | null> {
  let projects: Record<string, { hasTrustDialogAccepted?: boolean }>;
  try {
    const config = JSON.parse(await readFile(file, 'utf8')) as {
      projects?: Record<string, { hasTrustDialogAccepted?: boolean }>;
    };
    projects = config.projects ?? {};
  } catch {
    return null;
  }
  const real = await realpath(dir).catch(() => dir);
  return trustedIn(projects, real) || trustedIn(projects, dir);
}

/** Whether a folder, or one around it, is marked trusted in a Claude Code projects record. */
export function trustedIn(
  projects: Record<string, { hasTrustDialogAccepted?: boolean }>,
  dir: string,
): boolean {
  for (let folder = dir; ; folder = dirname(folder)) {
    if (projects[folder]?.hasTrustDialogAccepted === true) return true;
    if (dirname(folder) === folder) return false;
  }
}

/**
 * Codex: `[projects."<folder>"]` with `trust_level = "trusted"` in its config.toml. Wheems reads
 * only the usual forms of that; when the file records trust in a form it doesn't read, such as
 * an inline table, the answer is null (can't tell) rather than false, because a false stops
 * conversations from starting.
 */
export async function codexTrusts(
  dir: string,
  file = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml'),
): Promise<boolean | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  const { trusted, unsure } = codexTrustedFolders(text);
  const real = await realpath(dir).catch(() => dir);
  for (const start of [real, dir]) {
    for (let folder = start; ; folder = dirname(folder)) {
      if (trusted.has(folder)) return true;
      if (dirname(folder) === folder) break;
    }
  }
  return unsure ? null : false;
}

/** A TOML basic ("…") or literal ('…') string, and an optional comment to the end of the line. */
const STRING = String.raw`("(?:[^"\\]|\\.)*"|'[^']*')`;
const COMMENT = String.raw`\s*(?:#.*)?$`;
const PROJECT_HEADER = new RegExp(String.raw`^\s*\[\s*projects\s*\.\s*${STRING}\s*\]${COMMENT}`);
const TRUST_LEVEL = new RegExp(String.raw`^\s*trust_level\s*=\s*${STRING}${COMMENT}`);

/**
 * The folders a Codex config.toml marks trusted, and whether it records trust in a form this
 * doesn't read (so a folder missing from `trusted` may still be trusted).
 */
export function codexTrustedFolders(toml: string): { trusted: Set<string>; unsure: boolean } {
  const trusted = new Set<string>();
  let unsure = false;
  let current: string | null = null;
  for (const line of toml.split('\n')) {
    const header = PROJECT_HEADER.exec(line);
    if (header) {
      current = tomlString(header[1] ?? '""');
      continue;
    }
    if (/^\s*\[/.test(line)) {
      // Any other table: `[projects]` with dotted keys under it is one this doesn't read.
      if (/^\s*\[\s*projects\s*\]/.test(line)) unsure = true;
      current = null;
      continue;
    }
    if (!line.includes('trust_level')) continue;
    const level = TRUST_LEVEL.exec(line);
    if (current === null || !level) {
      unsure = true;
      continue;
    }
    if (tomlString(level[1] ?? '""') === 'trusted') trusted.add(current);
  }
  return { trusted, unsure };
}

function tomlString(quoted: string): string {
  const body = quoted.slice(1, -1);
  return quoted.startsWith("'") ? body : body.replace(/\\(.)/g, '$1');
}

/**
 * How to trust the install folder, once, for an engine: a trusted folder covers every folder
 * in it, so this covers every workspace there is and every one added later. `command` is the
 * engine's own command (its setup's `trust`); `home` is the install folder.
 */
export function trustAdvice(label: string, command: string[], home: string): string {
  return `At the Mac, run \`cd ${shellPath(home)} && ${command.join(' ')}\` and answer yes. ${label} then trusts every workspace in your install, including ones you add later.`;
}

/** A path as it can be typed into a shell, keeping a leading ~ outside the quotes. */
export function shellPath(path: string): string {
  if (/^[\w~/.-]+$/.test(path)) return path;
  const [prefix, rest] = path.startsWith('~/') ? ['~/', path.slice(2)] : ['', path];
  return `${prefix}'${rest.replaceAll("'", `'\\''`)}'`;
}
