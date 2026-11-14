import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { parseDocument } from 'yaml';
import { loadInstall, type LoadedWorkspace } from '../../config/load.js';
import { defaultHome, paths, tilde, type Paths } from '../../home.js';
import { request, type ServiceReport } from '../../service/control.js';
import { stopWorkspaceSessions } from '../../service/retire.js';
import { StateStore } from '../../state/store.js';
import { shellPath } from '../../util/trust.js';
import { clackUi } from '../clack-ui.js';
import type { Io } from '../program.js';
import { initWorkspace } from './init.js';
import { serviceAnswers } from './service.js';
import { ensureInstall } from './setup.js';

const homeHelp = 'the install folder (default: $WHEEMS_HOME or ~/wheems)';

export interface CreateOptions {
  name?: string;
  channel?: string;
  engine: string;
  model?: string;
  home?: string;
}

/** The options `wheems ws create` (and the old `wheems init`) take. */
export function withCreateOptions(command: Command): Command {
  return command
    .option('--name <name>', 'its display name (default: from the id)')
    .option('--channel <channel>', "chat in this channel instead of the bot's direct messages")
    .option(
      '--engine <engine>',
      'what the chief of staff runs in: claude-code, codex or opencode',
      'claude-code',
    )
    .option('--model <model>', "the engine's model (default: the engine's usual one)")
    .option('--home <dir>', homeHelp);
}

/** Creates a workspace with its chief of staff, and the install if there is none. */
export async function createWorkspace(io: Io, id: string, options: CreateOptions): Promise<void> {
  const entry = io
    .registry()
    .catalog('engine')
    .find((e) => e.name === options.engine && e.engine);
  if (!entry?.engine) {
    const known = io
      .registry()
      .catalog('engine')
      .map((e) => e.name)
      .join(', ');
    throw new Error(`No engine "${options.engine}". Choose one of: ${known}`);
  }
  const setup = entry.engine;
  const home = resolve(options.home ?? defaultHome(io.env));
  // On a fresh machine, init makes the install too, so setup can be scripted.
  const createdInstall = await ensureInstall(paths(home, io.env));
  if (createdInstall) io.out(`Created the install at ${home} (a git folder)\n`);
  const dir = await initWorkspace({
    home,
    id,
    env: io.env,
    engine: {
      name: entry.name,
      model: options.model ?? setup.defaultModel,
      account: setup.account.name,
    },
    accountDriver: setup.account.driver,
    ...(options.name !== undefined && { name: options.name }),
    ...(options.channel !== undefined && { channel: options.channel }),
  });
  // A trusted install folder covers every workspace in it; ask only when it isn't.
  const trust = setup.trust !== null && (await setup.trusted?.(home)) !== true ? setup.trust : null;
  io.out(
    [
      `Created ${dir}, with its chief of staff on ${entry.label}`,
      '',
      ...(trust !== null
        ? [
            `${entry.label} asks once whether to trust a folder, and nobody can answer it from Slack.`,
            'Answer it now for your install folder, which covers every workspace in it: run the two lines below, say yes, then quit it.',
            '',
            `  cd ${shellPath(tilde(home, io.env))}`,
            `  ${trust.join(' ')}`,
            '',
          ]
        : []),
      options.channel !== undefined
        ? `Then invite the bot to #${options.channel.replace(/^#/, '')} and restart the service: wheems restart`
        : 'Then message the bot in Slack. If the service is already running, restart it first: wheems restart',
      '',
    ].join('\n'),
  );
}

/**
 * `wheems workspace` (`ws`): the workspaces in the install, each a chief of staff with its own
 * knowledge base. Archive keeps everything and stops serving it; remove deletes it for good.
 */
export function registerWorkspace(program: Command, io: Io): void {
  const ws = program
    .command('workspace')
    .alias('ws')
    .description(
      'Create, list, rename, archive and remove workspaces, each with its chief of staff',
    );

  ws.command('list')
    .description('The workspaces in the install, and where each chats')
    .option('--archived', 'list the archived ones instead')
    .option('--json', 'print them as JSON')
    .option('--home <dir>', homeHelp)
    .action(async (options: { archived?: boolean; json?: boolean; home?: string }) => {
      const where = paths(home(io, options), io.env);
      if (options.archived === true) {
        const archived = await archivedWorkspaces(where);
        if (options.json === true) {
          io.out(`${JSON.stringify(archived, null, 2)}\n`);
          return;
        }
        io.out(
          archived.length === 0
            ? 'No archived workspaces.\n'
            : `${archived.map((a) => `${a.id}  archived ${a.archivedAt.slice(0, 10)}, in ${tilde(a.dir, io.env)}`).join('\n')}\n`,
        );
        return;
      }
      const install = await loadInstall(where.home);
      const report = await serviceReport(where);
      const rows = install.workspaces.map((w) => describeWorkspace(w, report));
      if (options.json === true) {
        io.out(`${JSON.stringify(rows, null, 2)}\n`);
        return;
      }
      if (rows.length === 0) {
        io.out('No workspaces yet. Create one with: wheems ws create <id>\n');
        return;
      }
      io.out(
        `${rows
          .map(
            (r) =>
              `${r.id}  ${r.name}\n  ${r.chat ?? "doesn't chat"}${r.chief !== null ? `, chief on ${r.chief.engine} (${r.chief.model})` : ''}${r.problem !== undefined ? `\n  ! ${r.problem}` : ''}`,
          )
          .join('\n')}\n`,
      );
    });

  ws.command('show')
    .description("A workspace's folder, chat, agents and knowledge base")
    .argument('<id>', "the workspace's id")
    .option('--json', 'print it as JSON')
    .option('--home <dir>', homeHelp)
    .action(async (id: string, options: { json?: boolean; home?: string }) => {
      const where = paths(home(io, options), io.env);
      const workspace = await findWorkspace(where, id);
      const row = describeWorkspace(workspace, await serviceReport(where));
      const knowledge = {
        notes: await countMarkdown(join(workspace.dir, 'knowledge', 'notes')),
        pages: await countMarkdown(join(workspace.dir, 'knowledge', 'pages')),
        inbox: await countMarkdown(join(workspace.dir, 'knowledge', 'inbox')),
      };
      const agents = workspace.agents.map((a) => ({
        name: a.definition.name,
        engine: a.definition.engine,
        model: a.definition.model,
        account: a.definition.account,
      }));
      if (options.json === true) {
        io.out(
          `${JSON.stringify({ ...row, folder: workspace.dir, agents, knowledge }, null, 2)}\n`,
        );
        return;
      }
      io.out(
        [
          `${row.id}: ${row.name}`,
          `Folder: ${tilde(workspace.dir, io.env)}`,
          `Chat: ${row.chat ?? "doesn't chat"}${row.problem !== undefined ? ` (! ${row.problem})` : ''}`,
          `Agents: ${agents.map((a) => `${a.name}${a.name === workspace.config?.chief_of_staff ? ' (chief of staff)' : ''} on ${a.engine}, ${a.model}, paid by ${a.account}`).join('; ')}`,
          `Knowledge: ${String(knowledge.pages)} pages, ${String(knowledge.notes)} notes filed, ${String(knowledge.inbox)} waiting in the inbox`,
          '',
        ].join('\n'),
      );
    });

  withCreateOptions(
    ws
      .command('create')
      .description('Create a workspace with its chief of staff (and the install, if there is none)')
      .argument('<id>', 'the workspace id, such as personal'),
  ).action(async (id: string, options: CreateOptions) => {
    await createWorkspace(io, id, options);
  });

  ws.command('rename')
    .description("Change a workspace's display name (its id and folder stay as they are)")
    .argument('<id>', "the workspace's id")
    .argument('<name>', 'the new display name')
    .option('--home <dir>', homeHelp)
    .action(async (id: string, name: string, options: { home?: string }) => {
      const where = paths(home(io, options), io.env);
      const workspace = await findWorkspace(where, id);
      const trimmed = name.trim();
      if (trimmed === '' || trimmed.includes('\n'))
        throw new Error('Give a display name, on one line');
      const file = join(workspace.dir, 'workspace.yaml');
      const doc = parseDocument(await readFile(file, 'utf8'));
      const named = doc.get('name');
      const before = typeof named === 'string' ? named : id;
      doc.set('name', trimmed);
      // The chief's name follows, when it was the one made from the old display name.
      if (doc.getIn(['identity', 'name']) === `${before} chief of staff`) {
        doc.setIn(['identity', 'name'], `${trimmed} chief of staff`);
      }
      await writeFile(file, doc.toString());
      io.out(`${id} is now called ${trimmed}. Restart the service to use it: wheems restart\n`);
    });

  ws.command('archive')
    .description('Stop serving a workspace and move it to the archive, keeping everything')
    .argument('<id>', "the workspace's id")
    .option('--yes', "don't ask first")
    .option('--home <dir>', homeHelp)
    .action(async (id: string, options: { yes?: boolean; home?: string }) => {
      const where = paths(home(io, options), io.env);
      const workspace = await findWorkspace(where, id);
      if (options.yes !== true) {
        await confirm(
          `Archive ${id}? Its chief stops answering and the workspace moves to the archive, with its knowledge base. wheems ws restore brings it back.`,
        );
      }
      const stopped = await retire(io, where, id, false);
      const dest = archiveFolder(where, id);
      await mkdir(join(where.home, 'archive'), { recursive: true });
      await rename(workspace.dir, dest);
      await writeFile(
        join(dest, ARCHIVED),
        `${JSON.stringify({ id, archivedAt: new Date().toISOString() }, null, 2)}\n`,
      );
      // The search index is rebuilt from the files when it's restored.
      await rm(join(where.index, id), { recursive: true, force: true });
      io.out(
        `Archived ${id} to ${tilde(dest, io.env)}${stopped}. Bring it back with: wheems ws restore ${id}\n`,
      );
    });

  ws.command('restore')
    .description('Bring an archived workspace back')
    .argument('<id>', "the archived workspace's id")
    .option('--home <dir>', homeHelp)
    .action(async (id: string, options: { home?: string }) => {
      const where = paths(home(io, options), io.env);
      const archived = (await archivedWorkspaces(where)).filter((a) => a.id === id).at(-1);
      if (!archived)
        throw new Error(`No archived workspace ${id}. See them with: wheems ws list --archived`);
      const dir = join(where.workspaces, id);
      if (existsSync(dir))
        throw new Error(`There's already a workspace ${id} at ${tilde(dir, io.env)}`);
      await mkdir(where.workspaces, { recursive: true });
      await rename(archived.dir, dir);
      await rm(join(dir, ARCHIVED), { force: true });
      io.out(`Restored ${id}. Restart the service for its chief to answer again: wheems restart\n`);
    });

  ws.command('remove')
    .description('Delete a workspace for good: its folder, knowledge base, sessions and records')
    .argument('<id>', "the workspace's id (an archived one, if it isn't active)")
    .option('--yes', "don't ask first")
    .option('--home <dir>', homeHelp)
    .action(async (id: string, options: { yes?: boolean; home?: string }) => {
      const where = paths(home(io, options), io.env);
      const active = join(where.workspaces, id);
      const target = existsSync(active)
        ? active
        : (await archivedWorkspaces(where)).filter((a) => a.id === id).at(-1)?.dir;
      if (target === undefined) {
        throw new Error(`No workspace ${id}, active or archived. See them with: wheems ws list`);
      }
      if (options.yes !== true) {
        await confirmTyped(
          id,
          `This deletes ${id} for good: ${tilde(target, io.env)}, with its agents and knowledge base, and its sessions, messages and search index. It can't be undone. Type ${id} to go ahead`,
        );
      }
      const stopped = await retire(io, where, id, true);
      await rm(target, { recursive: true, force: true });
      for (const dir of stateFolders(where, id)) await rm(dir, { recursive: true, force: true });
      await rm(join(where.state, 'tidy', `${id}.json`), { force: true });
      io.out(`Removed ${id}${stopped}.\n`);
    });
}

/** Marks an archived workspace's folder, with its id and when it was archived. */
const ARCHIVED = '.archived.json';

function home(io: Io, options: { home?: string }): string {
  return resolve(options.home ?? defaultHome(io.env));
}

/** A workspace's state outside its folder, under `.wheems/`. */
function stateFolders(where: Paths, id: string): string[] {
  return ['index', 'sessions', 'messages', 'tidy', 'quarantine'].map((dir) =>
    dir === 'index' ? join(where.index, id) : join(where.state, dir, id),
  );
}

interface WorkspaceRow {
  id: string;
  name: string;
  chat: string | null;
  chief: { name: string; engine: string; model: string } | null;
  problem?: string;
}

function describeWorkspace(workspace: LoadedWorkspace, report: ServiceReport | null): WorkspaceRow {
  const config = workspace.config;
  const chat = config?.channels.chat;
  const chief = workspace.agents.find((a) => a.definition.name === config?.chief_of_staff);
  const reported = report?.workspaces.find((w) => w.id === workspace.id);
  return {
    id: workspace.id,
    name: config?.name ?? workspace.id,
    chat:
      chat === undefined
        ? null
        : 'channel' in chat
          ? `#${chat.channel.replace(/^#/, '')} on ${chat.connection}`
          : `direct messages on ${chat.connection}`,
    chief: chief
      ? {
          name: chief.definition.name,
          engine: chief.definition.engine,
          model: chief.definition.model,
        }
      : null,
    ...(config === null && { problem: 'its config has problems: run wheems doctor' }),
    ...(reported?.problem !== undefined && { problem: reported.problem }),
  };
}

async function findWorkspace(where: Paths, id: string): Promise<LoadedWorkspace> {
  const install = await loadInstall(where.home);
  const workspace = install.workspaces.find((w) => w.id === id);
  if (!workspace) {
    throw new Error(
      `No workspace ${id}. The workspaces are: ${install.workspaces.map((w) => w.id).join(', ') || 'none yet'}`,
    );
  }
  return workspace;
}

/** What the running service says about the workspaces, or null when it isn't running. */
async function serviceReport(where: Paths): Promise<ServiceReport | null> {
  if (!(await serviceAnswers(where))) return null;
  const answer = await request(where.socket, { op: 'status' }).catch(() => null);
  return answer?.ok === true ? (answer.status ?? null) : null;
}

/**
 * Stops serving a workspace before its folder moves or goes: through the running service, or,
 * when it isn't running, by stopping its sessions in Herdr and (with `forget`) forgetting its
 * records in the store directly. Returns a phrase saying what was stopped.
 */
async function retire(io: Io, where: Paths, id: string, forget: boolean): Promise<string> {
  if (await serviceAnswers(where)) {
    const answer = await request(where.socket, { op: 'workspace-retire', id, forget });
    if (!answer.ok) throw new Error(answer.error);
    return `; ${answer.message ?? 'its sessions stopped'}`;
  }
  const install = await loadInstall(where.home);
  const herdr = install.config?.herdr;
  const runtime = io.registry().create('runtime', 'herdr', {
    ...(herdr?.binary !== undefined && { binary: herdr.binary }),
    ...(herdr?.version !== undefined && { minimumVersion: herdr.version }),
  });
  const stopped = await stopWorkspaceSessions(runtime, id).catch(() => 0);
  if (forget && existsSync(where.store)) {
    const state = await StateStore.open(where.store);
    try {
      state.forgetWorkspace(id);
    } finally {
      state.close();
    }
  }
  return stopped > 0
    ? `; ${String(stopped)} ${stopped === 1 ? 'session' : 'sessions'} stopped`
    : '';
}

/** A folder in the archive for a workspace: `archive/<id>`, dated if that's taken. */
function archiveFolder(where: Paths, id: string): string {
  const base = join(where.home, 'archive', id);
  if (!existsSync(base)) return base;
  const dated = `${base}-${new Date().toISOString().slice(0, 10)}`;
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? dated : `${dated}-${String(n)}`;
    if (!existsSync(candidate)) return candidate;
  }
}

/** The archived workspaces, oldest first. */
async function archivedWorkspaces(
  where: Paths,
): Promise<{ id: string; archivedAt: string; dir: string }[]> {
  const root = join(where.home, 'archive');
  const found: { id: string; archivedAt: string; dir: string }[] = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    try {
      const marker = JSON.parse(await readFile(join(dir, ARCHIVED), 'utf8')) as {
        id?: unknown;
        archivedAt?: unknown;
      };
      if (typeof marker.id === 'string' && typeof marker.archivedAt === 'string') {
        found.push({ id: marker.id, archivedAt: marker.archivedAt, dir });
      }
    } catch {
      // Not an archived workspace.
    }
  }
  return found.sort((a, b) => a.archivedAt.localeCompare(b.archivedAt));
}

async function countMarkdown(dir: string): Promise<number> {
  const entries = await readdir(dir, { recursive: true }).catch(() => []);
  return entries.filter((e) => e.endsWith('.md')).length;
}

async function confirm(question: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'This asks first, so it needs a terminal. Add --yes to go ahead without asking.',
    );
  }
  if (
    !(await clackUi()
      .confirm(question, false)
      .catch(() => false))
  )
    throw new Error('Left as it is.');
}

async function confirmTyped(id: string, question: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'This asks first, so it needs a terminal. Add --yes to go ahead without asking.',
    );
  }
  const typed = await clackUi()
    .text({ message: question })
    .catch(() => '');
  if (typed.trim() !== id) throw new Error('Left as it is.');
}
