import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { loadInstall, type LoadedInstall, type LoadedWorkspace } from '../config/load.js';
import type { DriverRegistry } from '../contracts/registry.js';
import { runDoctor, type DoctorReport } from '../doctor/doctor.js';
import { paths, type Paths } from '../home.js';
import { knowledgePaths } from '../knowledge/notes.js';
import { request, type ServiceReport } from '../service/control.js';
import { listAboutYou } from '../review/review.js';
import { readSecrets } from '../secrets.js';
import { listProposals } from '../skills/proposals.js';
import {
  StateStore,
  type ChatTurn,
  type MessageRecord,
  type SessionRecord,
} from '../state/store.js';

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
  /** Skill proposals from it waiting for review. */
  waiting: number;
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
  /** Unique among a session's messages, for the page to tell them apart. */
  key: string;
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
  const proposals = await listProposals(where.state);
  const waiting = (id: string) => proposals.filter((p) => p.proposal.workspace === id).length;
  return {
    install,
    summary: {
      workspaces: install.workspaces
        .filter((w) => w.config !== null)
        .map((w) => summarise(w, waiting(w.id))),
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
    workspace: summarise(workspace, summary.workspaces.find((w) => w.id === id)?.waiting ?? 0),
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

/** How many of a session's latest messages and chat turns are shown. */
const LATEST_MESSAGES = 12;

/**
 * A session's latest messages, newest last: what was said in its chat thread, and messages
 * sent to it through Wheems with their answers, read from their files.
 */
export async function sessionMessages(
  context: WebContext,
  workspace: string,
  session: SessionRecord,
): Promise<SessionMessage[]> {
  const where = paths(context.home, context.env);
  const store = await openStore(where).catch(() => null);
  if (!store) return [];
  let records: MessageRecord[];
  let turns: ChatTurn[];
  try {
    const sessions = store.workspace(workspace);
    records = sessions.messages(session.id, LATEST_MESSAGES);
    turns = sessions.chat(session.id, LATEST_MESSAGES);
  } finally {
    store.close();
  }
  const out: SessionMessage[] = turns.map((turn) => {
    const who =
      turn.author === 'person' ? 'You' : turn.author === 'agent' ? 'This session' : 'Wheems';
    return { key: turn.id, who, initial: who.charAt(0), when: turn.at, text: capped(turn.text) };
  });
  for (const record of records) {
    const sender =
      record.sender === null ? 'You' : record.sender === session.owner ? 'Its owner' : 'A session';
    const text = await readCappedText(record.messageFile);
    if (text !== null) {
      out.push({
        key: record.id,
        who: sender,
        initial: sender.charAt(0),
        when: record.sentAt,
        text,
      });
    }
    if (record.answerFile !== null && record.answeredAt !== null) {
      const answer = await readCappedText(record.answerFile);
      if (answer !== null) {
        out.push({
          key: `${record.id}-answer`,
          who: 'This session',
          initial: 'S',
          when: record.answeredAt,
          text: answer,
        });
      }
    }
  }
  return out.sort((a, b) => a.when.localeCompare(b.when)).slice(-LATEST_MESSAGES);
}

/** One session's record, or null when the store doesn't have it. */
export async function findSession(
  context: WebContext,
  workspace: string,
  id: string,
): Promise<SessionRecord | null> {
  const store = await openStore(paths(context.home, context.env)).catch(() => null);
  if (!store) return null;
  try {
    return store.workspace(workspace).session(id) ?? null;
  } finally {
    store.close();
  }
}

export function doctorReport(context: WebContext): Promise<DoctorReport> {
  return runDoctor({
    home: context.home,
    registry: context.registry,
    env: context.env,
    quick: true,
  });
}

function summarise(workspace: LoadedWorkspace, waiting: number): WorkspaceSummary {
  const name = workspace.config?.name ?? workspace.id;
  const chat = workspace.config?.channels.chat;
  return {
    id: workspace.id,
    name,
    initial: name.charAt(0).toUpperCase(),
    waiting,
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

function capped(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MESSAGE_LIMIT ? `${trimmed.slice(0, MESSAGE_LIMIT)}…` : trimmed;
}

async function readCappedText(file: string): Promise<string | null> {
  try {
    return capped(await readFile(file, 'utf8'));
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

// Review, settings, connections and about you ----------------------------------

/** The most of a proposal's SKILL.md, or of about-you.md, shown on a page. */
const TEXT_LIMIT = 8000;

export interface ProposalView {
  id: string;
  name: string;
  agent: string;
  created: string;
  /** The library version it changes, or null for a new skill. */
  basedOn: number | null;
  similar: string[];
  text: string;
  /** A fingerprint of the text shown, so approving applies only to that version. */
  seen: string;
  /** The workspace's agents, and whether each would get it: whoever proposed it, and any that has it. */
  agents: { name: string; checked: boolean }[];
}

export interface ReviewView {
  install: InstallSummary;
  workspace: WorkspaceSummary;
  proposals: ProposalView[];
}

/** The skill proposals waiting from one workspace, oldest first. */
export async function reviewData(context: WebContext, id: string): Promise<ReviewView | null> {
  const { install, summary } = await installSummary(context);
  const agents = install.workspaces.find((w) => w.id === id)?.agents ?? [];
  const workspace = summary.workspaces.find((w) => w.id === id);
  if (!workspace) return null;
  const where = paths(context.home, context.env);
  const proposals = (await listProposals(where.state))
    .filter((p) => p.proposal.workspace === id)
    .map((p) => ({
      id: p.proposal.id,
      name: p.proposal.name,
      agent: p.proposal.agent,
      created: p.proposal.created,
      basedOn: p.proposal.basedOn,
      similar: p.proposal.similar.map(
        (s) =>
          `${s.kind === 'skill' ? 'skill' : 'proposal'} ${s.name}${s.version !== undefined ? ` v${String(s.version)}` : ''}`,
      ),
      text: p.text,
      seen: fingerprint(p.text),
      agents: agents.map((a) => ({
        name: a.definition.name,
        checked:
          a.definition.name === p.proposal.agent || a.definition.skills.includes(p.proposal.name),
      })),
    }));
  return { install: summary, workspace, proposals };
}

export interface SettingsView {
  install: InstallSummary;
  workspace: WorkspaceSummary;
  folder: string;
  description: string | null;
  chief: (ChiefSummary & { permissions: string }) | null;
  postsAs: string | null;
  channels: { name: string; place: string }[];
  accounts: string[];
  integrations: { name: string; access: string }[];
  sessions: { maxOpenPerOwner: number; maxDepth: number };
  knowledge: { noteAfterIdle: number; tidyAt: string };
  skillBudget: number;
  skills: { name: string; version: number }[];
  agents: { name: string; engine: string; model: string }[];
}

/** A workspace's settings, as `workspace.yaml`, its agents and `skills.yaml` say. */
export async function settingsData(context: WebContext, id: string): Promise<SettingsView | null> {
  const { install, summary } = await installSummary(context);
  const workspace = install.workspaces.find((w) => w.id === id);
  const config = workspace?.config;
  const listed = summary.workspaces.find((w) => w.id === id);
  if (!workspace || !config || !listed) return null;
  const chief = chiefOf(workspace);
  const chiefAgent = workspace.agents.find((a) => a.definition.name === config.chief_of_staff);
  return {
    install: summary,
    workspace: listed,
    folder: workspace.dir,
    description: config.description ?? null,
    chief:
      chief && chiefAgent ? { ...chief, permissions: chiefAgent.definition.permissions } : null,
    postsAs: config.identity?.name ?? null,
    channels: Object.entries(config.channels).map(([name, binding]) => ({
      name,
      place:
        'channel' in binding
          ? `#${binding.channel.replace(/^#/, '')} on ${binding.connection}`
          : `direct messages on ${binding.connection}`,
    })),
    accounts: config.accounts,
    integrations: Object.entries(config.integrations).map(([name, grant]) => ({
      name,
      access: grant.access === 'full' ? 'full' : 'read-only',
    })),
    sessions: {
      maxOpenPerOwner: config.sessions.max_open_per_owner,
      maxDepth: config.sessions.max_depth,
    },
    knowledge: {
      noteAfterIdle: config.knowledge.note_after_idle,
      tidyAt: config.knowledge.tidy_at === false ? 'off' : config.knowledge.tidy_at,
    },
    skillBudget: config.skill_budget,
    skills: Object.entries(workspace.skills?.skills ?? {})
      .map(([name, version]) => ({ name, version }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    agents: workspace.agents
      .map((a) => ({
        name: a.definition.name,
        engine: a.definition.engine,
        model: a.definition.model,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export interface ConnectionView {
  name: string;
  driver: string;
  kind: 'chat' | 'integration';
  /** Whether its credentials are saved. Their values are never read into a page. */
  connected: boolean;
  allowedUsers: number;
  usedBy: string[];
}

export interface AccountView {
  name: string;
  driver: string;
  needsSecret: boolean;
  /** Whether its key is saved, for an account that needs one. */
  hasSecret: boolean;
  maxSessions: number | null;
  usedBy: string[];
}

export interface ConnectionsView {
  install: InstallSummary;
  connections: ConnectionView[];
  accounts: AccountView[];
}

/** The install's connections and accounts, and which workspaces use each. */
export async function connectionsData(context: WebContext): Promise<ConnectionsView> {
  const { install, summary } = await installSummary(context);
  const where = paths(context.home, context.env);
  // Only which names have credentials; the values stay in the secrets file.
  const saved = new Set(Object.keys(await readSecrets(where.secrets).catch(() => ({}))));
  const chatDrivers = new Set(context.registry.catalog('channel').map((e) => e.name));
  const workspaces = install.workspaces.filter((w) => w.config !== null);
  const nameOf = (id: string) => summary.workspaces.find((w) => w.id === id)?.name ?? id;
  const connections = Object.entries(install.config?.connections ?? {}).map(([name, c]) => {
    const usedBy = workspaces
      .filter(
        (w) =>
          Object.values(w.config?.channels ?? {}).some((b) => b.connection === name) ||
          Object.keys(w.config?.integrations ?? {}).includes(name),
      )
      .map((w) => nameOf(w.id));
    return {
      name,
      driver: c.driver,
      kind: chatDrivers.has(c.driver) ? ('chat' as const) : ('integration' as const),
      connected: saved.has(c.secret ?? name),
      allowedUsers: c.allowed_users.length,
      usedBy,
    };
  });
  const accounts = Object.entries(install.config?.accounts ?? {}).map(([name, a]) => ({
    name,
    driver: a.driver,
    needsSecret: a.secret !== undefined,
    hasSecret: a.secret !== undefined && saved.has(a.secret),
    maxSessions: a.max_sessions ?? null,
    usedBy: workspaces.filter((w) => w.config?.accounts.includes(name)).map((w) => nameOf(w.id)),
  }));
  return { install: summary, connections, accounts };
}

export interface AboutYouView {
  install: InstallSummary;
  /** about-you.md as it is, or null when it's empty or missing. */
  current: string | null;
  /** Each suggestion's file name, which the page's buttons name it by. */
  suggestions: { name: string; workspace: string | null; text: string; seen: string }[];
}

/** `about-you.md`, read by every agent in every workspace, and the changes waiting for it. */
export async function aboutYouData(context: WebContext): Promise<AboutYouView> {
  const { summary } = await installSummary(context);
  const where = paths(context.home, context.env);
  const current = await readCappedText(where.aboutYou);
  const suggestions = await listAboutYou(
    where.state,
    summary.workspaces.map((w) => w.id),
  );
  return {
    install: summary,
    current:
      current === null || current.replace(/<!--[\s\S]*?-->/g, '').trim() === ''
        ? null
        : cap(current, TEXT_LIMIT),
    suggestions: suggestions.map((s) => ({
      name: basename(s.file),
      workspace:
        s.workspace === null
          ? null
          : (summary.workspaces.find((w) => w.id === s.workspace)?.name ?? s.workspace),
      text: s.text,
      seen: fingerprint(s.text),
    })),
  };
}

/** A short fingerprint of text, so an action applies only to the version the person saw. */
export function fingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

function cap(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
