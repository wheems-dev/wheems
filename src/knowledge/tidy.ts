import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { snapshot, type Snapshot } from './filing.js';
import { BRIEF_LIMIT, knowledgePaths, looksLikeSecret } from './notes.js';

/**
 * The nightly tidy: the filer reads the whole knowledge base and writes two reports, of pages
 * that contradict each other and of pages that look out of date, and refreshes the brief. It
 * changes no page; the reports are for the person (and the chief of staff) to act on.
 */

export const REPORTS = ['reports/contradictions.md', 'reports/stale.md'] as const;
/** The most a report may hold. */
export const REPORT_LIMIT = 32 * 1024;

const PAGE_NAME = /^[a-z0-9][a-z0-9-]{0,79}\.md$/;

/** Fills the tidy's folder: the brief, every page, and the last reports. */
export async function prepareTidyFolder(folder: string, workspaceDir: string): Promise<Snapshot> {
  const knowledge = knowledgePaths(workspaceDir);
  await rm(folder, { recursive: true, force: true });
  await mkdir(join(folder, 'pages'), { recursive: true });
  await mkdir(join(folder, 'reports'), { recursive: true });
  if (await exists(knowledge.brief)) await copyFile(knowledge.brief, join(folder, 'brief.md'));
  for (const name of await readdir(knowledge.pages).catch(() => [] as string[])) {
    if (PAGE_NAME.test(name))
      await copyFile(join(knowledge.pages, name), join(folder, 'pages', name));
  }
  for (const report of REPORTS) {
    const text = await readFile(join(knowledge.root, report), 'utf8').catch(() => null);
    if (text !== null) await writeFile(join(folder, report), text);
  }
  return tidySnapshot(folder);
}

/** The brief, pages and reports in a workspace's knowledge folder, as the tidy copies them. */
async function knowledgeSnapshot(workspaceDir: string): Promise<Snapshot> {
  const knowledge = knowledgePaths(workspaceDir);
  const files: Snapshot = new Map();
  const brief = await readFile(knowledge.brief, 'utf8').catch(() => null);
  if (brief !== null) files.set('brief.md', brief);
  for (const name of await readdir(knowledge.pages).catch(() => [] as string[])) {
    if (!PAGE_NAME.test(name)) continue;
    const text = await readFile(join(knowledge.pages, name), 'utf8').catch(() => null);
    if (text !== null) files.set(`pages/${name}`, text);
  }
  for (const report of REPORTS) {
    const text = await readFile(join(knowledge.root, report), 'utf8').catch(() => null);
    if (text !== null) files.set(report, text);
  }
  return files;
}

/** The brief, pages and reports in a tidy's folder. */
export async function tidySnapshot(folder: string): Promise<Snapshot> {
  const files = await snapshot(folder);
  for (const report of REPORTS) {
    const text = await readFile(join(folder, report), 'utf8').catch(() => null);
    if (text !== null) files.set(report, text);
  }
  return files;
}

/**
 * A fingerprint of what the tidy reads: the brief and the pages. When it hasn't changed
 * since the last tidy, there's nothing new to tidy.
 */
export function contentHash(files: Snapshot): string {
  const hash = createHash('sha256');
  for (const [path, text] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (path.startsWith('reports/')) continue;
    hash.update(`${path}\0${text}\0`);
  }
  return hash.digest('hex');
}

/**
 * Checks what the tidy wrote: the brief (under its cap) and the two reports. Changes to
 * pages, and anything else, are not kept.
 */
export async function reviewTidy(
  folder: string,
  before: Snapshot,
): Promise<{ accepted: Map<string, string>; rejected: { path: string; reason: string }[] }> {
  const after = await tidySnapshot(folder);
  const accepted = new Map<string, string>();
  const rejected: { path: string; reason: string }[] = [];
  for (const [path, text] of after) {
    if (before.get(path) === text) continue;
    const body = text.trim();
    if (path === 'brief.md') {
      if (body.length > BRIEF_LIMIT) {
        rejected.push({ path, reason: `it is longer than ${String(BRIEF_LIMIT)} characters` });
      } else if (looksLikeSecret(body)) {
        rejected.push({ path, reason: 'it looks like it holds a credential' });
      } else if (body !== '') {
        accepted.set(path, `${body}\n`);
      }
    } else if ((REPORTS as readonly string[]).includes(path)) {
      if (body.length > REPORT_LIMIT) {
        rejected.push({ path, reason: `it is longer than ${String(REPORT_LIMIT / 1024)} KB` });
      } else if (looksLikeSecret(body)) {
        rejected.push({ path, reason: 'it looks like it holds a credential' });
      } else if (body !== '') {
        accepted.set(path, `${body}\n`);
      }
    } else {
      rejected.push({ path, reason: 'the nightly tidy only writes the reports and the brief' });
    }
  }
  return { accepted, rejected };
}

/**
 * Writes the tidy's accepted files into the knowledge folder, unless anything it read or
 * writes changed since it took its copy: a person's edit, or a note filed meanwhile, is never
 * overwritten, and reports are never published about pages that have since changed.
 * Returns the paths changed, relative to the workspace folder.
 */
export async function applyTidy(
  workspaceDir: string,
  accepted: Map<string, string>,
  before: Snapshot,
): Promise<{ ok: true; changed: string[] } | { ok: false; conflicts: string[] }> {
  const knowledge = knowledgePaths(workspaceDir);
  // Everything the tidy read, and everything it writes: a page added, changed or deleted
  // meanwhile makes its reports out of date.
  const now = await knowledgeSnapshot(workspaceDir);
  const paths = new Set([...before.keys(), ...now.keys(), ...accepted.keys()]);
  const conflicts = [...paths]
    .filter((path) => (now.get(path) ?? null) !== (before.get(path) ?? null))
    .sort();
  if (conflicts.length > 0) return { ok: false, conflicts };
  const changed: string[] = [];
  for (const [path, text] of accepted) {
    const target = join(knowledge.root, path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, text);
    changed.push(join('knowledge', path));
  }
  return { ok: true, changed };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
