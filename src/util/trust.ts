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

/** Codex: `[projects."<folder>"]` with `trust_level = "trusted"` in its config.toml. */
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
  const trusted = codexTrustedFolders(text);
  const real = await realpath(dir).catch(() => dir);
  for (const start of [real, dir]) {
    for (let folder = start; ; folder = dirname(folder)) {
      if (trusted.has(folder)) return true;
      if (dirname(folder) === folder) break;
    }
  }
  return false;
}

/** The folders a Codex config.toml marks trusted. */
export function codexTrustedFolders(toml: string): Set<string> {
  const trusted = new Set<string>();
  let current: string | null = null;
  for (const line of toml.split('\n')) {
    const header = /^\s*\[projects\."((?:[^"\\]|\\.)*)"\]\s*$/.exec(line);
    if (header) {
      current = (header[1] ?? '').replace(/\\(.)/g, '$1');
      continue;
    }
    if (/^\s*\[/.test(line)) {
      current = null;
      continue;
    }
    if (current !== null && /^\s*trust_level\s*=\s*"trusted"/.test(line)) trusted.add(current);
  }
  return trusted;
}
