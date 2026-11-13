import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseDocument, stringify } from 'yaml';
import { runCommand } from '../util/process.js';
import { BRIEF_LIMIT, knowledgePaths, looksLikeSecret } from './notes.js';

/**
 * Filing a note: the filer agent works on a copy of the knowledge base in a folder of its
 * own, and Wheems checks every change in code before it reaches the real one. The filer can
 * change `brief.md` and pages in `pages/`, and suggest a change to `about-you.md`; nothing
 * else it writes is kept.
 */

/** The note being filed, in the filer's folder. */
export const NOTE_FILE = 'note.md';
/** Where the filer may suggest a change to the page about the person. */
export const ABOUT_YOU_SUGGESTION = 'about-you.suggested.md';

/** A page may lose at most this share of its text in one filing. */
export const MAX_PAGE_LOSS = 0.25;

const PAGE_NAME = /^[a-z0-9][a-z0-9-]{0,79}\.md$/;

export type Snapshot = Map<string, string>;

/**
 * Fills the filer's folder afresh: the note, the brief, every page, and the page about the
 * person for reference. Returns what it holds, to compare with afterwards.
 */
export async function prepareFilingFolder(
  folder: string,
  workspaceDir: string,
  noteFile: string,
  aboutYouFile: string | null,
): Promise<Snapshot> {
  const knowledge = knowledgePaths(workspaceDir);
  await rm(folder, { recursive: true, force: true });
  await mkdir(join(folder, 'pages'), { recursive: true });
  await copyFile(noteFile, join(folder, NOTE_FILE));
  if (aboutYouFile !== null && (await exists(aboutYouFile)))
    await copyFile(aboutYouFile, join(folder, 'about-you.md'));
  if (await exists(knowledge.brief)) await copyFile(knowledge.brief, join(folder, 'brief.md'));
  for (const name of await readdir(knowledge.pages).catch(() => [] as string[])) {
    if (PAGE_NAME.test(name))
      await copyFile(join(knowledge.pages, name), join(folder, 'pages', name));
  }
  return snapshot(folder);
}

/** The brief and pages in a filer's folder, by path. */
export async function snapshot(folder: string): Promise<Snapshot> {
  const files: Snapshot = new Map();
  const brief = await readFile(join(folder, 'brief.md'), 'utf8').catch(() => null);
  if (brief !== null) files.set('brief.md', brief);
  for (const name of await readdir(join(folder, 'pages')).catch(() => [] as string[])) {
    files.set(`pages/${name}`, await readFile(join(folder, 'pages', name), 'utf8'));
  }
  return files;
}

export interface FilingReview {
  /** Files to write into the knowledge folder, by path inside it, with Wheems's details added. */
  accepted: Map<string, string>;
  /** Changes not kept, and why. */
  rejected: { path: string; reason: string }[];
  /** A suggested new version of `about-you.md`, for the person to approve. */
  aboutYouSuggestion: string | null;
}

/**
 * Checks what the filer changed. A changed or new page must have a name Wheems accepts, hold
 * no credentials, and keep at least three quarters of its text; it is kept with the note
 * added to its sources. The brief must fit its limit. Deleted pages come back. Anything
 * else the filer wrote is ignored.
 */
export async function reviewFiling(
  folder: string,
  before: Snapshot,
  noteName: string,
  now = new Date(),
): Promise<FilingReview> {
  const after = await snapshot(folder);
  const accepted = new Map<string, string>();
  const rejected: { path: string; reason: string }[] = [];
  const day = now.toISOString().slice(0, 10);

  for (const [path, text] of after) {
    const old = before.get(path);
    if (old === text) continue;
    if (path === 'brief.md') {
      const body = text.trim();
      if (body.length > BRIEF_LIMIT) {
        rejected.push({ path, reason: `it is longer than ${String(BRIEF_LIMIT)} characters` });
      } else if (looksLikeSecret(body)) {
        rejected.push({ path, reason: 'it looks like it holds a credential' });
      } else {
        accepted.set(path, `${body}\n`);
      }
      continue;
    }
    const name = basename(path);
    if (!PAGE_NAME.test(name)) {
      rejected.push({ path, reason: 'page names are lowercase letters, digits and dashes' });
      continue;
    }
    const page = parsePage(text);
    if (page.body.trim() === '') {
      rejected.push({ path, reason: 'it is empty' });
      continue;
    }
    if (looksLikeSecret(text)) {
      rejected.push({ path, reason: 'it looks like it holds a credential' });
      continue;
    }
    const previous = old === undefined ? null : parsePage(old);
    if (previous && page.body.trim().length < previous.body.trim().length * (1 - MAX_PAGE_LOSS)) {
      rejected.push({
        path,
        reason: `it lost more than ${String(MAX_PAGE_LOSS * 100)}% of its text`,
      });
      continue;
    }
    // Sources only ever grow, and always include the note being filed.
    const sources = [...new Set([...(previous?.sources ?? []), ...page.sources, noteName])];
    const title = page.title ?? previous?.title ?? titleFromName(name);
    accepted.set(path, renderPage({ title, sources, updated: day, body: page.body }));
  }
  for (const path of before.keys()) {
    if (!after.has(path)) rejected.push({ path, reason: 'pages are never deleted when filing' });
  }

  const suggestion = await readFile(join(folder, ABOUT_YOU_SUGGESTION), 'utf8').catch(() => null);
  const aboutYouSuggestion =
    suggestion !== null && suggestion.trim() !== '' && !looksLikeSecret(suggestion)
      ? `${suggestion.trim()}\n`
      : null;
  return { accepted, rejected, aboutYouSuggestion };
}

export interface Page {
  title: string | null;
  sources: string[];
  body: string;
}

/** A page's front matter (title, sources) and body. Front matter that won't parse is body. */
export function parsePage(text: string): Page {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'));
  if (!match) return { title: null, sources: [], body: text };
  const doc = parseDocument(match[1] ?? '');
  if (doc.errors.length > 0) return { title: null, sources: [], body: text };
  const data = (doc.toJS() ?? {}) as { title?: unknown; sources?: unknown };
  return {
    title: typeof data.title === 'string' && data.title.trim() !== '' ? data.title.trim() : null,
    sources: Array.isArray(data.sources)
      ? data.sources.filter((s): s is string => typeof s === 'string')
      : [],
    body: match[2] ?? '',
  };
}

export function renderPage(page: {
  title: string;
  sources: string[];
  updated: string;
  body: string;
}): string {
  const front = stringify({ title: page.title, sources: page.sources, updated: page.updated });
  return `---\n${front}---\n\n${page.body.trim()}\n`;
}

/**
 * Writes the accepted changes into the knowledge folder and moves the note from the inbox
 * to `notes/<year>/<month>/`. Nothing is written if any file it would change has changed
 * since the filer took its copy (`before`): a person's edit is never overwritten, and the
 * note is filed again from the new version. Returns the paths changed, relative to the
 * workspace folder, or the files that changed meanwhile.
 */
export async function applyFiling(
  workspaceDir: string,
  noteFile: string,
  accepted: Map<string, string>,
  before: Snapshot,
  now = new Date(),
): Promise<{ ok: true; changed: string[] } | { ok: false; conflicts: string[] }> {
  const knowledge = knowledgePaths(workspaceDir);
  const conflicts: string[] = [];
  for (const path of accepted.keys()) {
    const current = await readFile(join(knowledge.root, path), 'utf8').catch(() => null);
    if (current !== (before.get(path) ?? null)) conflicts.push(path);
  }
  if (conflicts.length > 0) return { ok: false, conflicts };
  const changed: string[] = [];
  for (const [path, text] of accepted) {
    const target = join(knowledge.root, path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, text);
    changed.push(join('knowledge', path));
  }
  const month = join(String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'));
  await mkdir(join(knowledge.notes, month), { recursive: true });
  const filed = join(knowledge.notes, month, basename(noteFile));
  await rename(noteFile, filed);
  changed.push(join('knowledge', 'inbox', basename(noteFile)));
  changed.push(join('knowledge', 'notes', month, basename(noteFile)));
  return { ok: true, changed };
}

/**
 * Commits the filed changes in the install's git folder, and only those, so nothing else
 * the person has changed is swept in. Does nothing outside a git folder.
 */
export async function commitFiling(
  home: string,
  paths: string[],
  message: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const inside = await runCommand('git', ['-C', home, 'rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0) return { ok: false, reason: 'the install is not a git folder' };
  // A path that is gone and was never committed (a note filed straight from the inbox) has
  // nothing for git to record.
  const listed = await runCommand('git', ['-C', home, 'ls-files', '--cached', '--', ...paths]);
  const tracked = new Set(listed.stdout.split('\n').filter((line) => line !== ''));
  const present: string[] = [];
  for (const path of paths) {
    if (tracked.has(path) || (await exists(join(home, path)))) present.push(path);
  }
  if (present.length === 0) return { ok: true };
  const add = await runCommand('git', ['-C', home, 'add', '--all', '--', ...present]);
  if (add.code !== 0) return { ok: false, reason: add.stderr.trim() };
  const staged = await runCommand('git', [
    '-C',
    home,
    'diff',
    '--cached',
    '--name-only',
    '--no-renames',
    '--',
    ...present,
  ]);
  if (staged.code !== 0) return { ok: false, reason: staged.stderr.trim() };
  const changed = staged.stdout.split('\n').filter((line) => line !== '');
  if (changed.length === 0) return { ok: true };
  const commit = await runCommand('git', [
    '-C',
    home,
    '-c',
    'user.name=Wheems',
    '-c',
    'user.email=wheems@localhost',
    'commit',
    '--quiet',
    '-m',
    message,
    '--only',
    '--',
    ...changed,
  ]);
  if (commit.code !== 0) return { ok: false, reason: (commit.stderr || commit.stdout).trim() };
  return { ok: true };
}

function titleFromName(name: string): string {
  const words = name.replace(/\.md$/, '').replaceAll('-', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
