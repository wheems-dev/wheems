import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { isMap, isSeq, parseDocument, YAMLMap, YAMLSeq } from 'yaml';
import type { LoadedInstall } from '../config/load.js';
import { commitFiling } from '../knowledge/filing.js';
import { looksLikeSecret } from '../knowledge/notes.js';
import { addVersion, checkSkillText, readSkill } from '../skills/library.js';
import { removeProposal, type WaitingProposal } from '../skills/proposals.js';

/**
 * What waits for the person: skills agents proposed, and changes the filer suggested to
 * `about-you.md`. `wheems review` shows each one and the person approves, edits or turns it
 * down. Nothing here runs without them.
 */

export interface AboutYouSuggestion {
  /** The suggestion's file, in `.wheems/review/about-you/`. */
  file: string;
  /** The workspace whose note it came from, read from the file name. */
  workspace: string | null;
  text: string;
}

export function aboutYouDir(stateDir: string): string {
  return join(stateDir, 'review', 'about-you');
}

/**
 * Suggested changes to `about-you.md`, oldest first. The filing queue names each
 * `<note>-<workspace>.md`; `workspaces` are the ids to recognise there.
 */
export async function listAboutYou(
  stateDir: string,
  workspaces: string[] = [],
): Promise<AboutYouSuggestion[]> {
  const dir = aboutYouDir(stateDir);
  const suggestions: AboutYouSuggestion[] = [];
  // The longest id first, so "my-work" wins over "work".
  const ids = [...workspaces].sort((a, b) => b.length - a.length);
  for (const name of (await readdir(dir).catch(() => [] as string[])).sort()) {
    if (!name.endsWith('.md')) continue;
    const file = join(dir, name);
    const text = await readFile(file, 'utf8').catch(() => null);
    if (text === null) continue;
    const workspace = ids.find((id) => name.endsWith(`-${id}.md`)) ?? null;
    suggestions.push({ file, workspace, text });
  }
  return suggestions;
}

/**
 * Approves a skill proposal: adds it to the library as the next version, pins that version
 * in the proposing workspace's `skills.yaml`, gives it to the chosen agents there and takes
 * it away from the agents left out, then commits. `text` is what the person approved,
 * edited or not.
 */
export async function approveSkill(options: {
  install: LoadedInstall;
  waiting: WaitingProposal;
  text: string;
  /** Agents in the proposing workspace that should have the skill. */
  agents: string[];
  now?: Date;
}): Promise<{ version: number; changed: string[]; committed: boolean; reason?: string }> {
  const { install, waiting } = options;
  const home = install.home;
  const { proposal } = waiting;
  const skill = checkSkillText(proposal.name, options.text);
  const day = (options.now ?? new Date()).toISOString().slice(0, 10);
  const edited = options.text.trim() !== waiting.text.trim();
  const { version, changed } = await addVersion(home, skill, {
    written_by: 'agent',
    workspace: proposal.workspace,
    agent: proposal.agent,
    approved: day,
    ...(edited && { edited: true }),
  });

  const workspace = install.workspaces.find((w) => w.id === proposal.workspace);
  if (workspace) {
    const skillsFile = join(workspace.dir, 'skills.yaml');
    await pinSkill(skillsFile, skill.name, version);
    changed.push(relative(home, skillsFile));
    for (const agent of workspace.agents) {
      const file = join(home, agent.file);
      const wanted = options.agents.includes(agent.definition.name);
      const has = agent.definition.skills.includes(skill.name);
      if (wanted === has) continue;
      await setAgentSkill(file, skill.name, wanted);
      changed.push(relative(home, file));
    }
  }
  await removeProposal(waiting);

  const versionText = version === 1 ? 'new skill' : `version ${String(version)}`;
  const message = [
    `Approved ${skill.name} (${versionText})`,
    '',
    `Proposed by ${proposal.agent} in ${proposal.workspace}${edited ? ', edited before approval' : ''}.`,
    ...(options.agents.length > 0 ? [`Given to: ${options.agents.join(', ')}.`] : []),
  ].join('\n');
  const committed = await commitFiling(home, changed, message);
  return {
    version,
    changed,
    committed: committed.ok,
    ...(!committed.ok && { reason: committed.reason }),
  };
}

/** Approves a suggested `about-you.md`, as it is or as the person edited it, and commits. */
export async function approveAboutYou(options: {
  home: string;
  aboutYouFile: string;
  suggestion: AboutYouSuggestion;
  text: string;
}): Promise<{ committed: boolean; reason?: string }> {
  const text = options.text.trim();
  if (text === '') throw new Error('The page about you would be empty');
  if (looksLikeSecret(text)) throw new Error('It looks like it holds a credential');
  await writeFile(options.aboutYouFile, `${text}\n`);
  await rm(options.suggestion.file, { force: true });
  const from = options.suggestion.workspace;
  const committed = await commitFiling(
    options.home,
    [relative(options.home, options.aboutYouFile)],
    `Updated about-you.md${from !== null ? `, from a note in ${from}` : ''}`,
  );
  return { committed: committed.ok, ...(!committed.ok && { reason: committed.reason }) };
}

export async function declineAboutYou(suggestion: AboutYouSuggestion): Promise<void> {
  await rm(suggestion.file, { force: true });
}

export async function declineSkill(waiting: WaitingProposal): Promise<void> {
  await removeProposal(waiting);
}

/** The library version a proposal changes, as text, or null for a new skill. */
export async function proposalBase(home: string, waiting: WaitingProposal): Promise<string | null> {
  const { basedOn, name } = waiting.proposal;
  if (basedOn === null) return null;
  return (await readSkill(home, name, basedOn))?.text ?? null;
}

/** Pins a skill's version in a workspace's `skills.yaml`, keeping its comments. */
export async function pinSkill(file: string, name: string, version: number): Promise<void> {
  const text = await readFile(file, 'utf8').catch(
    () => '# Skills this workspace uses, each pinned to a library version.\nskills: {}\n',
  );
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new Error(`${basename(file)} isn't valid YAML`);
  let skills = doc.get('skills', true);
  if (!isMap(skills)) {
    skills = new YAMLMap();
    doc.set('skills', skills);
  }
  const map = skills as YAMLMap;
  map.flow = false;
  map.set(name, version);
  await writeFile(file, doc.toString());
}

/** Adds a skill to an agent file's `skills:` list, or takes it off, keeping everything else. */
export async function setAgentSkill(file: string, name: string, present: boolean): Promise<void> {
  const text = await readFile(file, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(text);
  if (!match) throw new Error(`${basename(file)} has no front matter`);
  const doc = parseDocument(match[1] ?? '');
  if (doc.errors.length > 0) throw new Error(`${basename(file)} has front matter that won't parse`);
  let skills = doc.get('skills', true);
  if (!isSeq(skills)) {
    const created = new YAMLSeq();
    created.flow = true;
    doc.set('skills', created);
    skills = created;
  }
  const seq = skills as YAMLSeq;
  const names = seq.toJSON().map(String);
  if (present && !names.includes(name)) seq.add(name);
  if (!present) {
    const index = names.indexOf(name);
    if (index !== -1) seq.delete(index);
  }
  const front = doc.toString().trimEnd();
  await writeFile(file, `---\n${front}\n---${match[2] ?? '\n'}${text.slice(match[0].length)}`);
}

/**
 * A line diff of `before` and `after`, for the terminal: removed lines start with `-`,
 * added lines with `+`, and unchanged lines near a change with a space. Long runs of
 * unchanged lines are cut to `…`.
 */
export function lineDiff(before: string, after: string, context = 2): string {
  const a = before.replace(/\r\n/g, '\n').trimEnd().split('\n');
  const b = after.replace(/\r\n/g, '\n').trimEnd().split('\n');
  // Longest common subsequence of the lines from i and j on, in a flat table.
  const width = b.length + 1;
  const table = new Int32Array((a.length + 1) * width);
  const lcs = (i: number, j: number) => table[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j] ? lcs(i + 1, j + 1) + 1 : Math.max(lcs(i + 1, j), lcs(i, j + 1));
    }
  }
  const lines: { mark: ' ' | '-' | '+'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const left = a[i];
    const right = b[j];
    if (left !== undefined && right !== undefined && left === right) {
      lines.push({ mark: ' ', text: left });
      i++;
      j++;
    } else if (left !== undefined && (right === undefined || lcs(i + 1, j) >= lcs(i, j + 1))) {
      // Removed lines first, then added ones.
      lines.push({ mark: '-', text: left });
      i++;
    } else {
      lines.push({ mark: '+', text: right ?? '' });
      j++;
    }
  }
  const near = lines.map((_, k) =>
    lines.slice(Math.max(0, k - context), k + context + 1).some((line) => line.mark !== ' '),
  );
  const out: string[] = [];
  let skipped = false;
  lines.forEach((line, k) => {
    if (line.mark !== ' ' || near[k]) {
      out.push(`${line.mark} ${line.text}`);
      skipped = false;
    } else if (!skipped) {
      out.push('  …');
      skipped = true;
    }
  });
  return out.join('\n');
}
