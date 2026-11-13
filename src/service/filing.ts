import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import {
  FILER_MODELS,
  filerAgent,
  filingTask,
  TIDY_INSTRUCTIONS,
  tidyTask,
} from '../agents/filer.js';
import type { LoadedWorkspace } from '../config/load.js';
import type { InstallConfig } from '../config/schemas.js';
import type { EngineDriver } from '../contracts/engine.js';
import {
  applyFiling,
  commitFiling,
  prepareFilingFolder,
  reviewFiling,
} from '../knowledge/filing.js';
import { knowledgePaths, looksLikeSecret, noteTitle } from '../knowledge/notes.js';
import { applyTidy, contentHash, prepareTidyFolder, reviewTidy } from '../knowledge/tidy.js';
import type { TaskRunner } from './runner.js';

export interface FilingOptions {
  /** The install folder, a git folder the filed changes are committed in. */
  home: string;
  install: InstallConfig;
  workspaces: LoadedWorkspace[];
  engine: (name: string) => EngineDriver;
  runner: TaskRunner;
  /** Running state: the filer's folders and suggestions waiting for review go here. */
  stateDir: string;
  aboutYouFile: string;
  /** Environment every agent session gets. */
  sessionEnv: Record<string, string>;
  /** How long the filer gets for one note. */
  timeoutSeconds?: number;
  /** Tries per note before it's left in the inbox until the service restarts. */
  maxAttempts?: number;
  /** Called after a note is filed into a workspace, such as to update its search index. */
  onFiled?: (workspace: string) => void;
  log?: (message: string) => void;
}

/**
 * Files each workspace's inbox, one note at a time: the filer agent works on a copy of the
 * knowledge base, Wheems checks its changes, applies those that pass, moves the note to
 * `notes/`, and commits. Each workspace has its own queue.
 */
export class FilingQueue {
  private readonly options: Required<Omit<FilingOptions, 'log' | 'onFiled'>> & {
    log: (message: string) => void;
    onFiled: (workspace: string) => void;
  };
  private readonly chains = new Map<string, Promise<void>>();
  /** Workspaces with a pass over their inbox queued and not yet started. */
  private readonly queued = new Set<string>();
  private readonly attempts = new Map<string, number>();
  /** Workspaces with a tidy queued or running. */
  private readonly tidying = new Set<string>();
  private stopped = false;

  constructor(options: FilingOptions) {
    this.options = {
      timeoutSeconds: 900,
      maxAttempts: 3,
      log: () => undefined,
      onFiled: () => undefined,
      ...options,
    };
  }

  /** Files whatever is in a workspace's inbox, after any pass already running. */
  file(workspace: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.queued.has(workspace)) return this.chains.get(workspace) ?? Promise.resolve();
    this.queued.add(workspace);
    const next = (this.chains.get(workspace) ?? Promise.resolve())
      .then(() => {
        this.queued.delete(workspace);
        return this.pass(workspace);
      })
      .catch((error: unknown) => {
        this.options.log(`Filing in ${workspace}: ${describe(error)}`);
      });
    this.chains.set(workspace, next);
    return next;
  }

  /** Files every workspace's inbox, as after a restart. */
  async fileAll(): Promise<void> {
    await Promise.all(this.options.workspaces.map((w) => this.file(w.id)));
  }

  async whenIdle(): Promise<void> {
    await Promise.allSettled([...this.chains.values()]);
  }

  /**
   * Stops taking new notes. A filing in progress isn't waited for: its note stays in the
   * inbox until it's filed, and the next start files it again from the beginning.
   */
  stop(): void {
    this.stopped = true;
  }

  /**
   * Runs the nightly tidy in every workspace whose `knowledge.tidy_at` has passed today (local
   * time) and that hasn't had one today. The service calls this every minute; a service that
   * was stopped overnight tidies when it starts.
   */
  async tidyIfDue(now = new Date()): Promise<void> {
    const today = localDay(now);
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    await Promise.all(
      this.options.workspaces.map(async (workspace) => {
        const at = workspace.config?.knowledge.tidy_at;
        if (at === undefined || at === false || time < at || this.tidying.has(workspace.id)) return;
        if ((await this.readTidyState(workspace.id))?.ran === today) return;
        await this.tidy(workspace.id, now);
      }),
    );
  }

  /** Runs the nightly tidy in a workspace now, after any filing already queued there. */
  tidy(workspace: string, now = new Date()): Promise<TidyResult> {
    if (this.stopped) return Promise.resolve('skipped');
    this.tidying.add(workspace);
    const next = (this.chains.get(workspace) ?? Promise.resolve()).then(() =>
      this.tidyOne(workspace, now),
    );
    const settled = next
      .catch((error: unknown): TidyResult => {
        this.options.log(`Tidying ${workspace}: ${describe(error)}`);
        return 'failed';
      })
      .finally(() => this.tidying.delete(workspace));
    this.chains.set(
      workspace,
      settled.then(() => undefined),
    );
    return settled;
  }

  private async tidyOne(id: string, now: Date): Promise<TidyResult> {
    const workspace = this.options.workspaces.find((w) => w.id === id);
    if (!workspace?.config || this.stopped) return 'skipped';
    const day = localDay(now);
    const last = await this.readTidyState(id);
    const folder = join(this.options.stateDir, 'tidy', id);
    const before = await prepareTidyFolder(folder, workspace.dir);
    const hash = contentHash(before);
    // Recorded before the run, so a tidy that fails isn't retried every minute.
    await this.writeTidyState(id, { ran: day, hash: last?.hash ?? null });
    if (![...before.keys()].some((path) => path.startsWith('pages/'))) {
      this.options.log(`Tidying ${id}: no pages yet, so nothing to tidy`);
      return 'skipped';
    }
    if (last?.hash === hash) {
      this.options.log(`Tidying ${id}: nothing has changed since the last tidy`);
      return 'skipped';
    }

    const filer = this.filer(workspace);
    this.options.log(`Tidying ${id}`);
    const result = await this.options.runner.run({
      agent: filerAgent(filer.engineName, filer.model, filer.accountName, TIDY_INSTRUCTIONS),
      engine: filer.engine,
      workspace: { id: workspace.id, dir: workspace.dir },
      account: filer.account,
      dir: folder,
      task: tidyTask(day),
      name: filerSessionName(workspace.id),
      labels: { wheems: 'filer', workspace: workspace.id },
      env: { ...this.options.sessionEnv, WHEEMS_WORKSPACE: workspace.id },
      timeoutSeconds: this.options.timeoutSeconds,
    });
    if (!result.ok) throw new Error(`the filer didn't finish: ${result.reason}`);

    const review = await reviewTidy(folder, before);
    for (const { path, reason } of review.rejected) {
      this.options.log(`Tidying ${id}: not keeping ${path}, because ${reason}`);
    }
    const applied = await applyTidy(workspace.dir, review.accepted, before);
    if (!applied.ok) {
      throw new Error(
        `${applied.conflicts.join(', ')} changed while the filer worked, so nothing was applied; it runs again tomorrow`,
      );
    }
    const after = new Map(before);
    for (const [path, text] of review.accepted) after.set(path, text);
    await this.writeTidyState(id, { ran: day, hash: contentHash(after) });

    const answer = result.answer.trim();
    const message = [
      `Tidied the knowledge base in ${id}`,
      '',
      answer,
      ...(review.rejected.length > 0
        ? ['', 'Not kept:', ...review.rejected.map((r) => `- ${r.path}: ${r.reason}`)]
        : []),
    ].join('\n');
    const prefix = relative(this.options.home, workspace.dir);
    const committed = await commitFiling(
      this.options.home,
      applied.changed.map((path) => join(prefix, path)),
      looksLikeSecret(message) ? `Tidied the knowledge base in ${id}` : message,
    );
    if (!committed.ok)
      this.options.log(`Tidying ${id}: not committed, because ${committed.reason}`);
    this.options.log(`Tidied ${id}: ${answer}`);
    return 'tidied';
  }

  private async readTidyState(id: string): Promise<TidyState | null> {
    try {
      return JSON.parse(
        await readFile(join(this.options.stateDir, 'tidy', `${id}.json`), 'utf8'),
      ) as TidyState;
    } catch {
      return null;
    }
  }

  private async writeTidyState(id: string, state: TidyState): Promise<void> {
    const dir = join(this.options.stateDir, 'tidy');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${id}.json`), `${JSON.stringify(state)}\n`);
  }

  /** The filer's engine, model and account in a workspace, from its settings. */
  private filer(workspace: LoadedWorkspace) {
    const config = workspace.config;
    if (!config) throw new Error('the workspace has no workspace.yaml');
    const chief = workspace.agents.find((a) => a.definition.name === config.chief_of_staff);
    if (!chief) throw new Error('the workspace has no chief of staff agent file');
    const settings = config.knowledge.filer;
    const engineName = settings?.engine ?? chief.definition.engine;
    const model =
      settings?.model ??
      FILER_MODELS[engineName] ??
      (engineName === chief.definition.engine ? chief.definition.model : undefined);
    if (model === undefined) {
      throw new Error(`set knowledge.filer.model in workspace.yaml for the ${engineName} engine`);
    }
    const accountName = settings?.account ?? chief.definition.account;
    const account = this.options.install.accounts[accountName];
    return {
      engineName,
      model,
      accountName,
      account: { name: accountName, driver: account?.driver ?? 'unknown' },
      engine: this.options.engine(engineName),
    };
  }

  private async pass(id: string): Promise<void> {
    const workspace = this.options.workspaces.find((w) => w.id === id);
    if (!workspace?.config) return;
    const inbox = knowledgePaths(workspace.dir).inbox;
    const notes = (await readdir(inbox).catch(() => [] as string[]))
      .filter((name) => name.endsWith('.md'))
      .sort();
    for (const name of notes) {
      if (this.stopped) return;
      const file = join(inbox, name);
      if ((this.attempts.get(file) ?? 0) >= this.options.maxAttempts) continue;
      try {
        // A file changed by a person while the filer worked: file again from the new version.
        for (let tries = 0; (await this.fileOne(workspace, file)) === 'conflict'; tries++) {
          if (tries >= 2) throw new Error('the knowledge base kept changing while filing');
        }
        this.attempts.delete(file);
      } catch (error) {
        const tries = (this.attempts.get(file) ?? 0) + 1;
        this.attempts.set(file, tries);
        this.options.log(
          `Couldn't file ${name} in ${id} (try ${String(tries)} of ${String(this.options.maxAttempts)}): ${describe(error)}`,
        );
      }
    }
  }

  private async fileOne(
    workspace: LoadedWorkspace,
    noteFile: string,
  ): Promise<'filed' | 'conflict' | 'quarantined'> {
    if (!workspace.config) return 'filed';
    const noteText = await readFile(noteFile, 'utf8');
    if (looksLikeSecret(noteText)) {
      // Never filed, archived or committed: moved where git never looks, for the person.
      const dir = join(this.options.stateDir, 'quarantine', workspace.id);
      await mkdir(dir, { recursive: true });
      await rename(noteFile, join(dir, basename(noteFile)));
      this.options.log(
        `Filing ${basename(noteFile)}: it looks like it holds a credential, so it was moved to ${dir} and not filed`,
      );
      return 'quarantined';
    }
    const filer = this.filer(workspace);
    const noteName = basename(noteFile);
    const folder = join(this.options.stateDir, 'filing', workspace.id);

    this.options.log(`Filing ${noteName} in ${workspace.id}`);
    const before = await prepareFilingFolder(
      folder,
      workspace.dir,
      noteFile,
      this.options.aboutYouFile,
    );
    const result = await this.options.runner.run({
      agent: filerAgent(filer.engineName, filer.model, filer.accountName),
      engine: filer.engine,
      workspace: { id: workspace.id, dir: workspace.dir },
      account: filer.account,
      dir: folder,
      task: filingTask(noteName),
      name: filerSessionName(workspace.id),
      labels: { wheems: 'filer', workspace: workspace.id },
      env: { ...this.options.sessionEnv, WHEEMS_WORKSPACE: workspace.id },
      timeoutSeconds: this.options.timeoutSeconds,
    });
    if (!result.ok) throw new Error(`the filer didn't finish: ${result.reason}`);

    const review = await reviewFiling(folder, before, noteName);
    for (const { path, reason } of review.rejected) {
      this.options.log(`Filing ${noteName}: not keeping ${path}, because ${reason}`);
    }
    const title = noteTitle(noteText);
    const applied = await applyFiling(workspace.dir, noteFile, review.accepted, before);
    if (!applied.ok) {
      this.options.log(
        `Filing ${noteName}: ${applied.conflicts.join(', ')} changed while the filer worked, so nothing was applied`,
      );
      return 'conflict';
    }
    const changed = applied.changed;
    this.options.onFiled(workspace.id);
    if (review.aboutYouSuggestion !== null) {
      const dir = join(this.options.stateDir, 'review', 'about-you');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, `${noteName.replace(/\.md$/, '')}-${workspace.id}.md`),
        review.aboutYouSuggestion,
      );
      this.options.log(`Filing ${noteName}: a change to about-you.md waits for review`);
    }
    const prefix = relative(this.options.home, workspace.dir);
    const lines = [
      `Filed "${title}" in ${workspace.id}`,
      '',
      result.answer.trim(),
      ...(review.rejected.length > 0
        ? ['', 'Not kept:', ...review.rejected.map((r) => `- ${r.path}: ${r.reason}`)]
        : []),
      '',
      `Note: ${changed.at(-1) ?? noteName}`,
    ];
    const message = lines.join('\n');
    const committed = await commitFiling(
      this.options.home,
      changed.map((path) => join(prefix, path)),
      // The filer's own words never carry a credential into git history.
      looksLikeSecret(message)
        ? `Filed a note in ${workspace.id}\n\nNote: ${changed.at(-1) ?? noteName}`
        : message,
    );
    if (!committed.ok)
      this.options.log(`Filing ${noteName}: not committed, because ${committed.reason}`);
    this.options.log(`Filed ${noteName} in ${workspace.id}: ${result.answer.trim()}`);
    return 'filed';
  }
}

export type TidyResult = 'tidied' | 'skipped' | 'failed';

interface TidyState {
  /** The local day of the last tidy, as YYYY-MM-DD. */
  ran: string;
  /** What the brief and pages held after it, to skip a night when nothing changed. */
  hash: string | null;
}

/** A local date as YYYY-MM-DD. */
function localDay(date: Date): string {
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * The filer's session name: within the runtime's 32 characters, and unique to the workspace
 * even when two workspace names start the same way.
 */
export function filerSessionName(workspace: string): string {
  const hash = createHash('sha1').update(workspace).digest('hex').slice(0, 8);
  return `filer-${workspace.slice(0, 16)}-${hash}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
