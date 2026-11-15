/**
 * Marks a folder trusted for an engine, the way its own "trust this folder?" answer does, so
 * nobody has to answer that question at the terminal. Only ever run after the person says yes
 * (`wheems setup`, `wheems doctor --fix`, `wheems engine trust`).
 *
 * Each engine's file holds much more than trust, and the engine may be writing it while it runs,
 * so every change is a careful read-modify-write:
 *
 * - it refuses to write a file it can't parse completely, and checks that the result differs from
 *   what was read by the one trust entry and nothing else;
 * - it writes a temporary file beside the real one and renames it into place, keeping the file's
 *   permissions, so the file is never half written;
 * - just before the rename it reads the file again, and if the engine changed it meanwhile it
 *   starts over from the new contents (a few times, then gives up and says so).
 */
import { randomBytes } from 'node:crypto';
import { readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseToml } from 'smol-toml';
import { claudeConfigFile, codexConfigFile, tomlString } from './trust.js';

/** What marking did: wrote the entry, or found it already there. */
export type MarkResult = 'marked' | 'already';

/**
 * Claude Code: sets `projects[<folder>].hasTrustDialogAccepted = true` in ~/.claude.json. This
 * is Claude Code's internal state, not a documented setting, so `wheems doctor` checks it rather
 * than assume it lasts.
 */
export async function markClaudeTrusted(
  dir: string,
  file = claudeConfigFile(),
  options: RewriteOptions = {},
): Promise<MarkResult> {
  // Claude Code records a folder by its real path.
  const folder = await realpath(dir).catch(() => dir);
  return rewrite(
    file,
    (text) => {
      if (text === null) {
        throw new Error(
          `${file} doesn't exist yet. Open Claude Code once (run claude), then try again.`,
        );
      }
      return claudeWithTrust(text, folder, file);
    },
    options,
  );
}

/**
 * Codex: adds `[projects."<folder>"]` with `trust_level = "trusted"` to its config.toml, or sets
 * `trust_level` in that table if it's already there, leaving every other line as it was.
 */
export async function markCodexTrusted(
  dir: string,
  file = codexConfigFile(),
  options: RewriteOptions = {},
): Promise<MarkResult> {
  const folder = await realpath(dir).catch(() => dir);
  return rewrite(file, (text) => codexWithTrust(text ?? '', folder, file), options);
}

/** ~/.claude.json with the folder marked trusted, or null when it already is. */
export function claudeWithTrust(text: string, folder: string, file: string): string | null {
  const config = parseJsonExactly(text, file);
  if (!isRecord(config)) throw new Error(`${file} isn't the JSON object Claude Code writes.`);
  const projects = config.projects ?? {};
  if (!isRecord(projects)) throw new Error(`projects in ${file} isn't an object.`);
  const entry = projects[folder];
  if (entry !== undefined && !isRecord(entry)) {
    throw new Error(`The entry for ${folder} in ${file} isn't an object.`);
  }
  if (entry?.hasTrustDialogAccepted === true) return null;
  const after = {
    ...config,
    projects: { ...projects, [folder]: { ...entry, hasTrustDialogAccepted: true } },
  };
  return JSON.stringify(after, null, indentOf(text)) + (text.endsWith('\n') ? '\n' : '');
}

/** Codex's config.toml with the folder marked trusted, or null when it already is. */
export function codexWithTrust(text: string, folder: string, file: string): string | null {
  const before = parseTomlOrSay(text, file);
  const projects = before.projects;
  if (projects !== undefined && !isRecord(projects)) {
    throw new Error(`projects in ${file} isn't a table.`);
  }
  const entry = projects?.[folder];
  if (entry !== undefined && !isRecord(entry)) {
    throw new Error(`The entry for ${folder} in ${file} isn't a table.`);
  }
  if (entry?.trust_level === 'trusted') return null;

  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(newline);
  const header = lines.findIndex((line) => {
    const match = PROJECT_HEADER.exec(line);
    return match !== null && tomlString(match[1] ?? '""') === folder;
  });
  let after: string;
  if (header !== -1) {
    // The table is there: set trust_level in it, or add it under the header.
    let end = lines.findIndex((line, i) => i > header && /^\s*\[/.test(line));
    if (end === -1) end = lines.length;
    const level = lines.findIndex((line, i) => i > header && i < end && TRUST_KEY.test(line));
    if (level !== -1) lines[level] = 'trust_level = "trusted"';
    else lines.splice(header + 1, 0, 'trust_level = "trusted"');
    after = lines.join(newline);
  } else if (entry === undefined) {
    const body = text === '' || text.endsWith(newline) ? text : text + newline;
    const gap = body === '' ? '' : newline;
    after = `${body}${gap}[projects.${tomlKey(folder)}]${newline}trust_level = "trusted"${newline}`;
  } else {
    throw new Error(
      `${file} records ${folder} in a form Wheems doesn't edit, so it left the file alone.`,
    );
  }

  // The one entry, and nothing else, may differ.
  const expected = plain(before) as Record<string, unknown>;
  const table = (expected.projects ??= {}) as Record<string, unknown>;
  table[folder] = { ...(table[folder] as object | undefined), trust_level: 'trusted' };
  let parsed: unknown;
  try {
    parsed = parseToml(after);
  } catch {
    parsed = undefined;
  }
  if (!isDeepStrictEqual(plain(parsed), expected)) {
    throw new Error(
      `Wheems couldn't add the trust entry to ${file} without changing anything else, so it left the file alone.`,
    );
  }
  return after;
}

export interface RewriteOptions {
  /** How many times to start over when the engine changes the file meanwhile. Default: 5. */
  attempts?: number;
  /** How long to wait before starting over. Default: 250 ms. */
  pauseMs?: number;
  /** Runs between the check and the write; tests use it to change the file at that moment. */
  beforeCheck?: () => Promise<void>;
}

/**
 * Reads a file, changes it with `change` (null: nothing to change), and puts the result in
 * place by renaming a temporary file, only if the file still holds what was read.
 */
async function rewrite(
  file: string,
  change: (text: string | null) => string | null,
  options: RewriteOptions,
): Promise<MarkResult> {
  const attempts = options.attempts ?? 5;
  // Write through a symlink to the file it points to, rather than replace the link.
  const target = await realpath(file).catch(() => file);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const before = await readOrNull(target);
    const after = change(before);
    if (after === null) return 'already';
    const mode = before === null ? 0o600 : (await stat(target)).mode & 0o777;
    const temp = join(
      dirname(target),
      `.${basename(target)}.wheems-${randomBytes(6).toString('hex')}`,
    );
    await writeFile(temp, after, { mode, flag: 'wx' });
    try {
      await options.beforeCheck?.();
      if ((await readOrNull(target)) === before) {
        await rename(temp, target);
        return 'marked';
      }
    } finally {
      await rm(temp, { force: true });
    }
    await new Promise((done) => setTimeout(done, options.pauseMs ?? 250));
  }
  throw new Error(
    `${file} kept changing while Wheems tried to update it. Close the engine and try again.`,
  );
}

async function readOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Parses JSON, refusing any number that writing it back would change (one too big to hold
 * exactly, or written in another form), so a rewrite can't alter a value it didn't mean to.
 */
function parseJsonExactly(text: string, file: string): unknown {
  const found: { inexact?: string } = {};
  const reviver = (_key: string, item: unknown, context?: { source?: string }): unknown => {
    if (typeof item === 'number' && context?.source !== undefined) {
      if (JSON.stringify(item) !== context.source) found.inexact ??= context.source;
    }
    return item;
  };
  let value: unknown;
  try {
    value = JSON.parse(text, reviver);
  } catch {
    throw new Error(`${file} isn't valid JSON, so Wheems left it alone.`);
  }
  if (found.inexact !== undefined) {
    throw new Error(
      `${file} holds a number (${found.inexact}) that Wheems can't write back exactly, so it left the file alone.`,
    );
  }
  return value;
}

function parseTomlOrSay(text: string, file: string): Record<string, unknown> {
  try {
    return parseToml(text);
  } catch {
    throw new Error(`${file} isn't valid TOML, so Wheems left it alone.`);
  }
}

/** The indent a JSON file uses: two spaces when it can't tell, none when it's on one line. */
function indentOf(text: string): string | number {
  if (!text.trimEnd().includes('\n')) return 0;
  const match = /^\{\r?\n([ \t]+)"/.exec(text.trimStart());
  return match?.[1] ?? 2;
}

/**
 * A parsed TOML value as plain data, for comparing: its tables have no prototype, and its dates
 * are compared as written.
 */
function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain);
  if (value instanceof Date) return `date ${String(value)}`;
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A TOML basic string for a key. */
function tomlKey(key: string): string {
  let escaped = '';
  for (const ch of key) {
    const code = ch.charCodeAt(0);
    if (ch === '\\' || ch === '"') escaped += `\\${ch}`;
    else if (code < 0x20 || code === 0x7f) escaped += `\\u${code.toString(16).padStart(4, '0')}`;
    else escaped += ch;
  }
  return `"${escaped}"`;
}

const PROJECT_HEADER = /^\s*\[\s*projects\s*\.\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*\]\s*(?:#.*)?$/;
const TRUST_KEY = /^\s*trust_level\s*=/;
