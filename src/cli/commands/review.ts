import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as clack from '@clack/prompts';
import type { Command } from 'commander';
import { loadInstall } from '../../config/load.js';
import { SetupCancelled, type Choice } from '../../contracts/setup.js';
import { defaultHome, paths } from '../../home.js';
import {
  approveAboutYou,
  approveSkill,
  declineAboutYou,
  declineSkill,
  lineDiff,
  listAboutYou,
  proposalBase,
  type AboutYouSuggestion,
} from '../../review/review.js';
import { checkSkillText, skillVersions } from '../../skills/library.js';
import { listProposals, type WaitingProposal } from '../../skills/proposals.js';
import { runInteractive } from '../../util/process.js';
import type { Io } from '../program.js';

/** What `wheems review` needs from the terminal. Tests script it. */
export interface ReviewUi {
  intro(title: string): void;
  outro(message: string): void;
  note(message: string, title?: string): void;
  info(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  select<T extends string>(options: { message: string; choices: Choice<T>[] }): Promise<T>;
  multiselect(options: {
    message: string;
    choices: Choice<string>[];
    initial: string[];
  }): Promise<string[]>;
  /** Opens the text in the person's editor and resolves with what they saved. */
  edit(text: string, name: string): Promise<string>;
}

type Decision = 'approve' | 'edit' | 'decline' | 'later' | 'stop';

const DECISIONS: Choice<Decision>[] = [
  { value: 'approve', label: 'Approve' },
  { value: 'edit', label: 'Edit, then approve' },
  { value: 'decline', label: 'Turn it down', hint: 'deletes it' },
  { value: 'later', label: 'Leave it for later' },
  { value: 'stop', label: 'Stop reviewing' },
];

export function registerReview(program: Command, io: Io): void {
  program
    .command('review')
    .description('Review what waits for you: skills agents proposed, and changes to about-you.md')
    .option('--list', 'only list what is waiting')
    .option('--home <dir>', 'the install folder (default: $WHEEMS_HOME or ~/wheems)')
    .action(async (options: { list?: boolean; home?: string }) => {
      const home = resolve(options.home ?? defaultHome(io.env));
      const interactive = options.list !== true && process.stdin.isTTY && process.stdout.isTTY;
      await runReview({
        home,
        env: io.env,
        out: io.out,
        ui: interactive ? clackReviewUi(paths(home, io.env).state, io.env) : null,
      });
    });
}

/**
 * Lists what waits for review, then, with a UI, goes through each item. Without one (not a
 * terminal, or `--list`), only lists.
 */
export async function runReview(options: {
  home: string;
  env: NodeJS.ProcessEnv;
  out: (text: string) => void;
  ui: ReviewUi | null;
  now?: Date;
}): Promise<void> {
  const where = paths(options.home, options.env);
  const proposals = await listProposals(where.state);
  const workspaces = (await loadInstall(options.home)).workspaces.map((w) => w.id);
  const suggestions = await listAboutYou(where.state, workspaces);
  if (proposals.length === 0 && suggestions.length === 0) {
    options.out('Nothing waits for review.\n');
    return;
  }
  const ui = options.ui;
  if (ui === null) {
    const lines = ['Waiting for review:'];
    for (const { proposal: p } of proposals) {
      lines.push(
        `  skill ${p.name}${p.basedOn !== null ? ` (version ${String(p.basedOn + 1)})` : ' (new)'}, from ${p.agent} in ${p.workspace}`,
      );
    }
    for (const s of suggestions) {
      lines.push(
        `  about-you.md, suggested from a note${s.workspace !== null ? ` in ${s.workspace}` : ''}`,
      );
    }
    lines.push('', 'Run wheems review in a terminal to go through them.');
    options.out(`${lines.join('\n')}\n`);
    return;
  }

  ui.intro('Review');
  try {
    for (const waiting of proposals) {
      if ((await reviewProposal(options.home, waiting, ui, options.now)) === 'stop') {
        ui.outro('Stopped. The rest wait for next time.');
        return;
      }
    }
    for (const suggestion of suggestions) {
      if ((await reviewAboutYou(options.home, where.aboutYou, suggestion, ui)) === 'stop') {
        ui.outro('Stopped. The rest wait for next time.');
        return;
      }
    }
    ui.outro('All reviewed.');
  } catch (error) {
    if (error instanceof SetupCancelled) {
      ui.outro('Stopped. The rest wait for next time.');
      return;
    }
    throw error;
  }
}

async function reviewProposal(
  home: string,
  waiting: WaitingProposal,
  ui: ReviewUi,
  now?: Date,
): Promise<'done' | 'stop'> {
  const { proposal } = waiting;
  const base = await proposalBase(home, waiting);
  const kind =
    proposal.basedOn === null ? 'a new skill' : `a change to version ${String(proposal.basedOn)}`;
  ui.info(
    `Skill ${proposal.name}: ${kind}, proposed by ${proposal.agent} in ${proposal.workspace} on ${proposal.created.slice(0, 10)}.`,
  );
  const latest = (await skillVersions(home, proposal.name)).at(-1);
  if (proposal.basedOn !== null && latest !== undefined && latest > proposal.basedOn) {
    ui.warn(
      `The library has version ${String(latest)} now, newer than the version ${String(proposal.basedOn)} this changes. Approving it replaces what version ${String(latest)} says.`,
    );
  }
  ui.note(base === null ? waiting.text.trimEnd() : lineDiff(base, waiting.text), 'SKILL.md');
  if (proposal.similar.length > 0) {
    ui.warn(
      `It may repeat: ${proposal.similar
        .map((s) => `${s.name}${s.kind === 'proposal' ? ' (waiting for review)' : ''}`)
        .join(', ')}.`,
    );
  }

  let text = waiting.text;
  for (;;) {
    const decision = await ui.select({ message: `Approve ${proposal.name}?`, choices: DECISIONS });
    if (decision === 'stop') return 'stop';
    if (decision === 'later') return 'done';
    if (decision === 'decline') {
      await declineSkill(waiting);
      ui.info(`Turned down ${proposal.name}.`);
      return 'done';
    }
    if (decision === 'edit') {
      text = await ui.edit(text, `${proposal.name}.SKILL.md`);
      try {
        checkSkillText(proposal.name, text);
      } catch (error) {
        ui.warn(
          `${error instanceof Error ? error.message : String(error)}. Edit it again, or choose another way.`,
        );
        continue;
      }
      if (text.trim() !== waiting.text.trim())
        ui.note(lineDiff(waiting.text, text), 'Your changes');
    }
    break;
  }

  const install = await loadInstall(home);
  const workspace = install.workspaces.find((w) => w.id === proposal.workspace);
  let agents: string[] = [];
  if (workspace && workspace.agents.length > 0) {
    const names = workspace.agents.map((a) => a.definition.name);
    const initial = names.filter(
      (name) =>
        name === proposal.agent ||
        workspace.agents.some(
          (a) => a.definition.name === name && a.definition.skills.includes(proposal.name),
        ),
    );
    agents = await ui.multiselect({
      message: `Which agents in ${proposal.workspace} get ${proposal.name}?`,
      choices: names.map((name) => ({
        value: name,
        label: name,
        ...(name === proposal.agent && { hint: 'proposed it' }),
      })),
      initial,
    });
  } else {
    ui.warn(
      `The ${proposal.workspace} workspace isn't here any more, so the skill goes into the library only.`,
    );
  }
  const result = await approveSkill({
    install,
    waiting,
    text,
    agents,
    ...(now !== undefined && { now }),
  });
  ui.success(
    `Added ${proposal.name} version ${String(result.version)} to the library${workspace ? `, pinned in ${proposal.workspace}` : ''}${agents.length > 0 ? `, for ${agents.join(', ')}` : ''}.`,
  );
  if (!result.committed) ui.warn(`Not committed: ${result.reason ?? 'unknown reason'}`);
  return 'done';
}

async function reviewAboutYou(
  home: string,
  aboutYouFile: string,
  suggestion: AboutYouSuggestion,
  ui: ReviewUi,
): Promise<'done' | 'stop'> {
  const current = await readFile(aboutYouFile, 'utf8').catch(() => '');
  ui.info(
    `A change to about-you.md, suggested from a note${suggestion.workspace !== null ? ` in ${suggestion.workspace}` : ''}. Every agent in every workspace reads this page.`,
  );
  ui.note(lineDiff(current, suggestion.text), 'about-you.md');
  let text = suggestion.text;
  for (;;) {
    const decision = await ui.select({ message: 'Change about-you.md?', choices: DECISIONS });
    if (decision === 'stop') return 'stop';
    if (decision === 'later') return 'done';
    if (decision === 'decline') {
      await declineAboutYou(suggestion);
      ui.info('Turned it down; about-you.md is unchanged.');
      return 'done';
    }
    if (decision === 'edit') text = await ui.edit(text, 'about-you.md');
    try {
      const result = await approveAboutYou({ home, aboutYouFile, suggestion, text });
      ui.success('Updated about-you.md. Agents read it when their next session starts.');
      if (!result.committed) ui.warn(`Not committed: ${result.reason ?? 'unknown reason'}`);
      return 'done';
    } catch (error) {
      ui.warn(
        `${error instanceof Error ? error.message : String(error)}. Edit it again, or choose another way.`,
      );
    }
  }
}

function answer<T>(value: T): Exclude<T, symbol> {
  if (clack.isCancel(value)) throw new SetupCancelled();
  return value as Exclude<T, symbol>;
}

/** The review UI on this terminal. Editing opens $VISUAL or $EDITOR (vi by default). */
export function clackReviewUi(stateDir: string, env: NodeJS.ProcessEnv): ReviewUi {
  return {
    intro: (title) => {
      clack.intro(title);
    },
    outro: (message) => {
      clack.outro(message);
    },
    note: (message, title) => {
      clack.note(message, title);
    },
    info: (message) => {
      clack.log.info(message);
    },
    success: (message) => {
      clack.log.success(message);
    },
    warn: (message) => {
      clack.log.warn(message);
    },
    async select<T extends string>(options: { message: string; choices: Choice<T>[] }) {
      return answer(
        await clack.select<T>({
          message: options.message,
          options: options.choices.map((c) => ({
            value: c.value,
            label: c.label,
            ...(c.hint !== undefined && { hint: c.hint }),
          })) as Parameters<typeof clack.select<T>>[0]['options'],
        }),
      );
    },
    async multiselect(options) {
      return answer(
        await clack.multiselect<string>({
          message: options.message,
          options: options.choices.map((c) => ({
            value: c.value,
            label: c.label,
            ...(c.hint !== undefined && { hint: c.hint }),
          })),
          initialValues: options.initial,
          required: false,
        }),
      );
    },
    async edit(text, name) {
      const dir = join(stateDir, 'review', 'editing');
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, name);
      await writeFile(file, text);
      const editor = env.VISUAL || env.EDITOR || 'vi';
      // Through the shell, so an editor setting with arguments ("code --wait") works.
      const code = await runInteractive('/bin/sh', ['-c', `${editor} "$1"`, 'sh', file]);
      const edited = await readFile(file, 'utf8');
      await rm(file, { force: true });
      if (code !== 0) throw new Error(`The editor (${editor}) exited with code ${String(code)}`);
      return edited;
    },
  };
}
