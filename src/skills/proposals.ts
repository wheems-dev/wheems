import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cosine } from '../contracts/vector-store.js';
import type { EmbeddingsDriver } from '../contracts/embeddings.js';
import { contentWords } from '../knowledge/search.js';
import {
  checkSkillText,
  listLibrary,
  parseSkill,
  readSkill,
  renderSkill,
  type Skill,
} from './library.js';

/**
 * Skills agents propose. A proposal waits in the install's running state until the person
 * approves, edits or turns it down with `wheems review`; only an approved skill reaches the
 * library.
 *
 * ```
 * .wheems/review/skills/20261113-091500-weekly-report-3f9a2c/
 *   SKILL.md
 *   proposal.json
 * ```
 */

/** Two skills share at least this much of their words when one repeats the other. */
export const WORD_OVERLAP = 0.15;

export interface Similar {
  name: string;
  /** A skill in the library, or another proposal waiting for review. */
  kind: 'skill' | 'proposal';
  version?: number;
  score: number;
  /** Compared by meaning (embeddings) or by the words they share. */
  by: 'meaning' | 'words';
}

export interface Proposal {
  id: string;
  name: string;
  workspace: string;
  agent: string;
  conversation: string | null;
  /** When it was proposed, as an ISO time. */
  created: string;
  /** The library version it changes, or null for a new skill. */
  basedOn: number | null;
  similar: Similar[];
}

export interface WaitingProposal {
  proposal: Proposal;
  /** Its SKILL.md. */
  text: string;
  /** Its folder. */
  dir: string;
}

export function proposalsDir(stateDir: string): string {
  return join(stateDir, 'review', 'skills');
}

/** Every proposal waiting for review, oldest first. Folders that don't hold one are left out. */
export async function listProposals(stateDir: string): Promise<WaitingProposal[]> {
  const root = proposalsDir(stateDir);
  const waiting: WaitingProposal[] = [];
  for (const id of (await readdir(root).catch(() => [] as string[])).sort()) {
    const dir = join(root, id);
    try {
      const proposal = JSON.parse(await readFile(join(dir, 'proposal.json'), 'utf8')) as Proposal;
      const text = await readFile(join(dir, 'SKILL.md'), 'utf8');
      if (proposal.id === id) waiting.push({ proposal, text, dir });
    } catch {
      // Half written, or not a proposal.
    }
  }
  return waiting;
}

export async function removeProposal(waiting: WaitingProposal): Promise<void> {
  await rm(waiting.dir, { recursive: true, force: true });
}

export interface ProposeOptions {
  home: string;
  stateDir: string;
  workspace: string;
  agent: string;
  conversation: string | null;
  name: string;
  text: string;
  /** Compares by meaning when the driver says what a near-duplicate scores. */
  embeddings?: EmbeddingsDriver | null;
  now?: Date;
}

/**
 * Saves a proposed skill for review, after checking it: a valid SKILL.md, no credentials,
 * and not a change to a skill a person wrote. Returns the proposal and what to tell the
 * agent, including any skills it may repeat.
 */
export async function proposeSkill(
  options: ProposeOptions,
): Promise<{ proposal: Proposal; message: string }> {
  const skill = checkSkillText(options.name, options.text);
  const library = await listLibrary(options.home);
  const existing = library.find((s) => s.name === skill.name);
  if (existing?.writtenBy === 'person') {
    throw new Error(
      `${skill.name} was written by a person, so agents can't change it. Propose a skill with another name, or tell the person what you'd change.`,
    );
  }
  if (existing) {
    const current = await readSkill(options.home, skill.name, existing.latest);
    if (current !== null && sameSkill(current.text, skill)) {
      throw new Error(`Version ${String(existing.latest)} of ${skill.name} already says this.`);
    }
  }

  const waiting = await listProposals(options.stateDir);
  const earlier = waiting.filter((w) => w.proposal.name === skill.name);
  const elsewhere = earlier.find((w) => w.proposal.workspace !== options.workspace);
  if (elsewhere) {
    throw new Error(
      `A proposal for ${skill.name} from the ${elsewhere.proposal.workspace} workspace is already waiting for review. Try again once it has been reviewed.`,
    );
  }

  const others: Comparable[] = [
    ...(await Promise.all(
      library
        .filter((s) => s.name !== skill.name)
        .map(async (s) => ({
          name: s.name,
          kind: 'skill' as const,
          version: s.latest,
          text: comparableText((await readSkill(options.home, s.name, s.latest))?.text ?? ''),
        })),
    )),
    ...waiting
      .filter((w) => w.proposal.name !== skill.name)
      .map((w) => ({
        name: w.proposal.name,
        kind: 'proposal' as const,
        text: comparableText(w.text),
      })),
  ];
  const similar = await findSimilar(skillText(skill), others, options.embeddings ?? null);

  const now = options.now ?? new Date();
  // Unique even for two proposals in the same second; sorts by time.
  const id = `${stamp(now)}-${skill.name}-${randomBytes(3).toString('hex')}`;
  const proposal: Proposal = {
    id,
    name: skill.name,
    workspace: options.workspace,
    agent: options.agent,
    conversation: options.conversation,
    created: now.toISOString(),
    basedOn: existing?.latest ?? null,
    similar,
  };
  const root = proposalsDir(options.stateDir);
  const staging = join(root, `.${id}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await writeFile(join(staging, 'SKILL.md'), renderSkill(skill));
  await writeFile(join(staging, 'proposal.json'), `${JSON.stringify(proposal, null, 2)}\n`);
  await rm(join(root, id), { recursive: true, force: true });
  await rename(staging, join(root, id));
  for (const old of earlier) if (old.proposal.id !== id) await removeProposal(old);

  const what =
    existing === undefined
      ? `the new skill ${skill.name}`
      : `version ${String(existing.latest + 1)} of ${skill.name}`;
  const lines = [`Proposed ${what}. It waits for the person to review it.`];
  if (earlier.length > 0) lines.push('It replaces the earlier proposal for it.');
  if (similar.length > 0) {
    lines.push(
      '',
      'It may repeat:',
      ...similar.map(
        (s) =>
          `- ${s.name}${s.kind === 'proposal' ? ' (a proposal waiting for review)' : ` (version ${String(s.version)})`}`,
      ),
      '',
      'If one covers the same task, propose a change to it instead (read it first with `wheems skill show <name>`), so the library keeps one skill per task.',
    );
  }
  return { proposal, message: `${lines.join('\n')}\n` };
}

interface Comparable {
  name: string;
  kind: 'skill' | 'proposal';
  version?: number;
  text: string;
}

/**
 * The skills that say much the same as `text`: by meaning when the embeddings driver says
 * what a near-duplicate scores, otherwise (or when it can't be reached) by shared words.
 */
export async function findSimilar(
  text: string,
  others: Comparable[],
  embeddings: EmbeddingsDriver | null,
): Promise<Similar[]> {
  if (others.length === 0) return [];
  const found: Similar[] = [];
  let compared = false;
  if (embeddings?.nearDuplicate !== undefined) {
    try {
      const [mine, ...theirs] = await embeddings.embed(
        [text, ...others.map((o) => o.text)],
        'document',
      );
      if (mine && theirs.length === others.length) {
        others.forEach((other, i) => {
          const vector = theirs[i];
          const score = vector ? cosine(mine, vector) : 0;
          if (score >= (embeddings.nearDuplicate ?? 1))
            found.push(similar(other, score, 'meaning'));
        });
        compared = true;
      }
    } catch {
      // Compared by words instead.
    }
  }
  if (!compared) {
    const mine = contentWords(text);
    for (const other of others) {
      const score = overlap(mine, contentWords(other.text));
      if (score >= WORD_OVERLAP) found.push(similar(other, score, 'words'));
    }
  }
  return found.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function similar(other: Comparable, score: number, by: Similar['by']): Similar {
  return {
    name: other.name,
    kind: other.kind,
    ...(other.version !== undefined && { version: other.version }),
    score: Math.round(score * 1000) / 1000,
    by,
  };
}

/** The share of words two texts have in common (Jaccard). */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / (a.size + b.size - shared);
}

function skillText(skill: Skill): string {
  return `${skill.description}\n\n${skill.body}`;
}

function comparableText(text: string): string {
  try {
    return skillText(parseSkill(text));
  } catch {
    return text;
  }
}

function sameSkill(text: string, skill: Skill): boolean {
  try {
    const current = parseSkill(text);
    return current.description === skill.description && current.body === skill.body;
  } catch {
    return false;
  }
}

function stamp(now: Date): string {
  const iso = now.toISOString();
  return `${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 19).replaceAll(':', '')}`;
}
