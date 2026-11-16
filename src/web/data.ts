import { readdir, readFile, stat } from 'node:fs/promises';
import { loadInstall, type LoadedInstall, type LoadedWorkspace } from '../config/load.js';
import type { DriverRegistry } from '../contracts/registry.js';
import { runDoctor, type DoctorReport } from '../doctor/doctor.js';
import { paths, type Paths } from '../home.js';
import { knowledgePaths } from '../knowledge/notes.js';
import { request, type ServiceReport } from '../service/control.js';
import { listProposals } from '../skills/proposals.js';
import { StateStore, type MessageRecord, type SessionRecord } from '../state/store.js';

/**
 * What the web app's pages show, read fresh for each page: config from the install folder, the
 * session store read-only (so it never competes with the service, and works beside an older one),
 * and the service's own status over its control socket. Nothing here writes.
 */
export interface WebContext {
  home: string;
  env: NodeJS.ProcessEnv;
  registry: DriverRegistry;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  initial: string;
  /** Where its chief chats, such as "Slack direct messages" or "#acme-chat". */
  chat: string;
}

export interface ServiceSummary {
  running: boolean;
  report: ServiceReport | null;
}

export interface ChiefSummary {
  file: string;
  engine: string;
  model: string;
  account: string;
}

/** A session in the tree: its depth under the chief (1) or under another session. */
export interface TreeItem {
  session: SessionRecord;
  depth: number;
  label: string;
  kind: string;
}

export interface WorkspacePage {
  install: InstallSummary;
  workspace: WorkspaceSummary;
  chief: ChiefSummary | null;
  /** The chief's conversations and the sessions working for it, as a tree. */
  chiefTree: TreeItem[];
  /** Sessions the person started themselves, with what they started. */
  mine: TreeItem[];
  knowledge: { pages: number; inbox: number };
  skills: { name: string; version: number }[];
  proposals: number;
  /** Why the session store couldn't be read, when it couldn't. */
  storeProblem: string | null;
}

export interface InstallSummary {
  workspaces: WorkspaceSummary[];
  service: ServiceSummary;
  problems: number;
}

export interface SessionMessage {
  who: string;
  initial: string;
  when: string;
  text: string;
}

export async function installSummary(context: WebContext): Promise<{
  install: LoadedInstall;
  summary: InstallSummary;
}> {
  const install = await loadInstall(context.home);
  const where = paths(context.home, context.env);
  return {
    install,
    summary: {
      workspaces: install.workspaces.filter((w) => w.config !== null).map(summarise),
      service: await service(where),
      problems: install.problems.filter((p) => p.level === 'error').length,
    },
  };
}

export async function workspacePage(
  context: WebContext,
  id: string,
  options: { includeEnded?: boolean } = {},
): Promise<WorkspacePage | null> {
  const { install, summary } = await installSummary(context);
  const workspace = install.workspaces.find((w) => w.id === id && w.config !== null);
  if (!workspace) return null;
  const where = paths(context.home, context.env);
  let sessions: SessionRecord[] = [];
  let storeProblem: string | null = null;
  const store = await openStore(where).catch((error: unknown) => {
    storeProblem = describe(error);
    return null;
  });
  if (store) {
    try {
      sessions = store.workspace(id).sessions();
    } finally {
      store.close();
    }
  }
  const shown = visible(sessions, options.includeEnded === true);
  const ids = new Set(shown.map((s) => s.id));
  // A session whose parent isn't here (gone from the store) is shown as a root of its own.
  const orphan = (s: SessionRecord) => s.parent !== null && !ids.has(s.parent);
  const knowledge = knowledgePaths(workspace.dir);
  return {
    install: summary,
    workspace: summarise(workspace),
    chief: chiefOf(workspace),
    chiefTree: tree(shown, (s) => s.kind === 'thread' || (orphan(s) && s.owner !== null)),
    mine: tree(
      shown,
      (s) => s.kind !== 'thread' && s.owner === null && (s.parent === null || orphan(s)),
    ),
    knowledge: {
      pages: await countMarkdown(knowledge.pages),
      inbox: await countMarkdown(knowledge.inbox),
    },
    skills: Object.entries(workspace.skills?.skills ?? {})
      .map(([name, version]) => ({ name, version }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    proposals: (await listProposals(where.state)).filter((p) => p.proposal.workspace === id).length,
    storeProblem,
  };
}

/** A session's latest messages and answers, newest last, read from their files. */
export async function sessionMessages(
  context: WebContext,
  workspace: string,
  session: SessionRecord,
): Promise<SessionMessage[]> {
  const where = paths(context.home, context.env);
  const store = await openStore(where).catch(() => null);
  if (!store) return [];
  let records: MessageRecord[];
  try {
    records = store.workspace(workspace).messages(session.id, 5);
  } finally {
    store.close();
  }
  const out: SessionMessage[] = [];
  for (const record of [...records].sort((a, b) => a.sentAt.localeCompare(b.sentAt))) {
    const sender =
      record.sender === null ? 'You' : record.sender === session.owner ? 'Its owner' : 'A session';
    const text = await readCappedText(record.messageFile);
    if (text !== null)
      out.push({ who: sender, initial: sender.charAt(0), when: record.sentAt, text });
    if (record.answerFile !== null && record.answeredAt !== null) {
      const answer = await readCappedText(record.answerFile);
      if (answer !== null) {
        out.push({ who: 'This session', initial: 'S', when: record.answeredAt, text: answer });
      }
    }
  }
  return out;
}

export function doctorReport(context: WebContext): Promise<DoctorReport> {
  return runDoctor({
    home: context.home,
    registry: context.registry,
    env: context.env,
    quick: true,
  });
}

function summarise(workspace: LoadedWorkspace): WorkspaceSummary {
  const name = workspace.config?.name ?? workspace.id;
  const chat = workspace.config?.channels.chat;
  return {
    id: workspace.id,
    name,
    initial: name.charAt(0).toUpperCase(),
    chat:
      chat === undefined
        ? 'no chat channel'
        : 'channel' in chat
          ? `#${chat.channel.replace(/^#/, '')}`
          : `${capitalise(chat.connection)} direct messages`,
  };
}

function chiefOf(workspace: LoadedWorkspace): ChiefSummary | null {
  const name = workspace.config?.chief_of_staff ?? 'chief-of-staff';
  const agent = workspace.agents.find((a) => a.definition.name === name);
  if (!agent) return null;
  return {
    file: `agents/${name}.md`,
    engine: agent.definition.engine,
    model: agent.definition.model,
    account: agent.definition.account,
  };
}

/**
 * The sessions to show: every one that isn't ended (or every one, with `includeEnded`), and the
 * ended sessions above them, so a session still running under an ended one is never hidden.
 */
function visible(sessions: SessionRecord[], includeEnded: boolean): SessionRecord[] {
  if (includeEnded) return sessions;
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const keep = new Set<string>();
  for (const s of sessions) {
    if (s.state === 'ended') continue;
    let at: SessionRecord | undefined = s;
    while (at !== undefined && !keep.has(at.id)) {
      keep.add(at.id);
      at = at.parent !== null ? byId.get(at.parent) : undefined;
    }
  }
  return sessions.filter((s) => keep.has(s.id));
}

/** The sessions that are roots by `isRoot`, each followed by the sessions it started, depth first. */
function tree(sessions: SessionRecord[], isRoot: (s: SessionRecord) => boolean): TreeItem[] {
  const children = new Map<string, SessionRecord[]>();
  for (const s of sessions) {
    if (s.parent === null) continue;
    const list = children.get(s.parent) ?? [];
    list.push(s);
    children.set(s.parent, list);
  }
  const out: TreeItem[] = [];
  const seen = new Set<string>();
  const walk = (s: SessionRecord, depth: number) => {
    if (seen.has(s.id)) return;
    seen.add(s.id);
    out.push({ session: s, depth, label: labelOf(s), kind: kindOf(s) });
    for (const child of children.get(s.id) ?? []) walk(child, depth + 1);
  };
  for (const s of sessions.filter(isRoot)) walk(s, 1);
  return out;
}

function labelOf(s: SessionRecord): string {
  if (s.title !== null && s.title !== '') return s.title;
  if (s.ask !== null && s.ask !== '') return oneLine(s.ask, 80);
  return s.kind === 'thread' ? 'A conversation in chat' : 'A session';
}

function kindOf(s: SessionRecord): string {
  if (s.kind === 'thread') return 'Conversation with you';
  if (s.owner === null) return 'Started by you';
  // A chief's sessions are owned by its agent id (workspace/name); a session's by its own id.
  return s.owner.includes('/') ? 'Started by the chief' : 'Started by another session';
}

async function service(where: Paths): Promise<ServiceSummary> {
  try {
    const answer = await request(where.socket, { op: 'status' }, 1500);
    return { running: answer.ok, report: answer.ok ? (answer.status ?? null) : null };
  } catch {
    return { running: false, report: null };
  }
}

async function openStore(where: Paths): Promise<StateStore | null> {
  if (!(await exists(where.store))) return null;
  return StateStore.open(where.store, { readOnly: true, olderSchema: true });
}

async function countMarkdown(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

/** The most of one message or answer shown on a page. */
const MESSAGE_LIMIT = 4000;

async function readCappedText(file: string): Promise<string | null> {
  try {
    const text = (await readFile(file, 'utf8')).trim();
    return text.length > MESSAGE_LIMIT ? `${text.slice(0, MESSAGE_LIMIT)}…` : text;
  } catch {
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

function oneLine(text: string, limit: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
