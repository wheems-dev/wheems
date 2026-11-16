import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A workspace's knowledge folder. Sessions never write here directly: notes reach the inbox
 * through `wheems knowledgebase note`, and the filing job turns them into pages.
 */
export interface KnowledgePaths {
  root: string;
  /** Short, capped, loaded by every agent at launch. */
  brief: string;
  inbox: string;
  /** Filed notes, kept as the sources of the pages. */
  notes: string;
  pages: string;
  reports: string;
}

export function knowledgePaths(workspaceDir: string): KnowledgePaths {
  const root = join(workspaceDir, 'knowledge');
  return {
    root,
    brief: join(root, 'brief.md'),
    inbox: join(root, 'inbox'),
    notes: join(root, 'notes'),
    pages: join(root, 'pages'),
    reports: join(root, 'reports'),
  };
}

/** The most of the brief and of `about-you.md` an agent loads; the filing job keeps them under. */
export const BRIEF_LIMIT = 4000;
export const ABOUT_YOU_LIMIT = 4000;

/** The most a single note may hold. A note is a summary, not a transcript. */
export const NOTE_LIMIT = 32 * 1024;

/** Text that looks like a credential. Notes and pages holding any are never kept. */
const SECRET_PATTERNS = [
  /xox[abposr]-[A-Za-z0-9-]{10,}/,
  /xapp-[A-Za-z0-9-]{10,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * A credential given in words or as a header, which SECRET_PATTERNS can't recognise by its
 * shape: an Authorization header, `password=…`, `"token": "…"`, `token: Bearer …`, "my password
 * is …", and a bare bearer token.
 */
const CREDENTIAL_VALUES = [
  /(["']?\b(?:proxy-)?authori[sz]ation["']?)(\s*[:=]\s*)((?:bearer|basic|digest|token)\s+)?("[^"]*"|'[^']*'|\S+)/gi,
  /(["']?\b(?:pass(?:word|wd|phrase|code)?|pwd|pin|secret|api[ _-]?key|access[ _-]?key|token|auth)s?["']?)(\s*[:=]\s*|\s+is\s+)((?:bearer|basic|token)\s+)?("[^"]*"|'[^']*'|\S+)/gi,
  /(\bbearer)(\s+)()([A-Za-z0-9._~+/=-]{8,})/gi,
];

/**
 * Whether text seems to hold a credential of any kind: one SECRET_PATTERNS recognises, a private
 * key, or a password, key or token given in words or as an Authorization header. Wider than
 * looksLikeSecret, for text kept for its meaning, such as a session's ask, which is dropped
 * rather than redacted: telling that a credential is there is reliable, cutting it out isn't.
 */
export function holdsCredential(text: string): boolean {
  return (
    looksLikeSecret(text) ||
    CREDENTIAL_VALUES.some((pattern) => new RegExp(pattern.source, 'i').test(text))
  );
}

/** A file's text, cut to a limit, or null when it is missing or holds nothing yet. */
export async function readCapped(file: string, limit: number): Promise<string | null> {
  let text: string;
  try {
    text = (await readFile(file, 'utf8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  // A file holding only its template comment has nothing in it yet.
  if (text.replace(/<!--[\s\S]*?-->/g, '').trim() === '') return null;
  return text.length > limit
    ? `${text.slice(0, limit).trimEnd()}\n\n[Cut at ${String(limit)} characters.]`
    : text;
}

export interface NoteSource {
  workspace: string;
  agent: string;
  engine: string;
  /** The conversation it came from, when it came from one. */
  conversation?: string;
  /** `person` for work with a person, `automated` for jobs and workflows; search ranks it lower. */
  origin: 'person' | 'automated';
}

/**
 * Saves a note in a workspace's inbox, with the details Wheems knows rather than the agent:
 * which workspace, agent and conversation, and when. Never overwrites a note. Returns the
 * file's path.
 */
export async function writeNote(
  workspaceDir: string,
  source: NoteSource,
  text: string,
  now = new Date(),
): Promise<string> {
  const body = text.trim();
  if (body === '') throw new Error('The note is empty.');
  if (Buffer.byteLength(body) > NOTE_LIMIT) {
    throw new Error(
      `The note is longer than ${String(NOTE_LIMIT / 1024)} KB. A note is a short summary: what happened, why, and what's next.`,
    );
  }
  if (looksLikeSecret(body)) {
    throw new Error(
      'The note looks like it holds a password, token or key. Notes are kept in git: write it again without it.',
    );
  }
  const inbox = knowledgePaths(workspaceDir).inbox;
  await mkdir(inbox, { recursive: true });
  const header = [
    '---',
    `workspace: ${source.workspace}`,
    `agent: ${source.agent}`,
    `engine: ${source.engine}`,
    ...(source.conversation !== undefined
      ? [`conversation: ${JSON.stringify(source.conversation)}`]
      : []),
    `origin: ${source.origin}`,
    `written: ${now.toISOString()}`,
    '---',
    '',
  ].join('\n');
  const stamp = now.toISOString().slice(0, 19).replace('T', '-').replaceAll(':', '');
  const base = `${stamp}-${source.agent}-${slug(noteTitle(body))}`;
  for (let attempt = 0; ; attempt++) {
    const file = join(inbox, `${base}${attempt === 0 ? '' : `-${String(attempt + 1)}`}.md`);
    try {
      await writeFile(file, `${header}${body}\n`, { flag: 'wx' });
      return file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 50) throw error;
    }
  }
}

/** A note's title: its first heading, or else its first line. */
export function noteTitle(text: string): string {
  const lines = text.split('\n').map((l) => l.trim());
  const heading = lines.find((l) => /^#{1,6}\s/.test(l));
  return (heading ?? lines.find((l) => l !== '') ?? 'note').replace(/^#{1,6}\s+/, '');
}

function slug(text: string): string {
  const words = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return words.slice(0, 48).replace(/-+$/, '') || 'note';
}
