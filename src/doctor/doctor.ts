import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LoadedInstall, LoadedWorkspace } from '../config/load.js';
import { parseDocument } from 'yaml';
import { paths, tilde } from '../home.js';
import { trustAdvice } from '../util/trust.js';
import { readSecrets } from '../secrets.js';
import { request } from '../service/control.js';
import { serviceStatus } from '../service/launchd.js';
export { trustedIn } from '../util/trust.js';
import { crossCheck } from '../config/check.js';
import { loadInstall, type Problem } from '../config/load.js';
import type { ChannelDriver } from '../contracts/channel.js';
import type { HealthCheck } from '../contracts/driver.js';
import type { DriverRegistry } from '../contracts/registry.js';
import type { RuntimeDriver } from '../contracts/runtime.js';
import { HERDR_MINIMUM_VERSION } from '../drivers/runtime/herdr/herdr-runtime.js';
import { KnowledgeSearch, type IndexStatus } from '../knowledge/search.js';
import { listAboutYou } from '../review/review.js';
import { listProposals } from '../skills/proposals.js';
import { compareVersions } from '../util/version.js';
import { NODE_SUPPORTED, nodeVersionProblem } from '../util/node-support.js';
import { fullTextSearchProblem } from '../util/sqlite.js';
import { StateStore, readConversationsFile } from '../state/store.js';
export { defaultHome } from '../home.js';

export interface DoctorOptions {
  /** The install folder. */
  home: string;
  registry: DriverRegistry;
  /** Skip starting a test session in the runtime. */
  quick?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Overrides for tests. */
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  /** Whether an engine trusts a folder: true, false, or null when it can't tell. */
  trust?: (engine: string, dir: string) => Promise<boolean | null>;
  /** Why SQLite can't do full-text search, or null when it can. */
  fullTextSearch?: () => Promise<string | null>;
  /** Whether the service is installed and answering. */
  service?: (home: string) => Promise<{ installed: boolean; answering: boolean }>;
  /** Given, doctor attaches a safe fix to each check it can fix, for `wheems doctor --fix`. */
  fixes?: DoctorFixes;
}

/** A safe fix for a failing check, run only after the person says yes (`wheems doctor --fix`). */
export interface Fix {
  /** What it will do, said before asking, such as "Start the service, as wheems start does". */
  what: string;
  /** Does it, and says what came of it. */
  run(): Promise<string>;
}

/** A check, with a fix when doctor was given `fixes` and knows a safe one. */
export interface DoctorCheck extends HealthCheck {
  fix?: Fix;
}

/** What fixes may do outside the install folder. None touches the chat app's settings or tokens. */
export interface DoctorFixes {
  /** Starts (or restarts) the service, as `wheems start` does; true once it answers. */
  startService(): Promise<boolean>;
  /** Runs a command on the person's terminal, in a folder; its exit code. */
  run(command: string[], cwd: string): Promise<number | null>;
  /** Has the running service rebuild a workspace's search index. */
  reindex(workspace: string): Promise<void>;
}

export interface DoctorSection {
  title: string;
  checks: DoctorCheck[];
}

export interface DoctorReport {
  ok: boolean;
  sections: DoctorSection[];
}

/** Runs every health check: the system, the runtime, and the install's config. */
export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const sections: DoctorSection[] = [];
  sections.push({ title: 'System', checks: await systemChecks(options) });

  const installFile = join(options.home, 'install.yaml');
  const hasInstall = await exists(installFile);
  const install = hasInstall ? await loadInstall(options.home) : null;

  const herdr = install?.config?.herdr;
  const runtime = options.registry.create('runtime', 'herdr', {
    ...(herdr?.binary !== undefined && { binary: herdr.binary }),
    ...(herdr?.version !== undefined && { minimumVersion: herdr.version }),
  });
  const runtimeChecks = await runtime.check();
  if (!options.quick && !runtimeChecks.some((c) => c.status === 'fail')) {
    runtimeChecks.push(await roundTrip(runtime));
  }
  if (herdr?.version !== undefined && compareVersions(herdr.version, HERDR_MINIMUM_VERSION) < 0) {
    runtimeChecks.push({
      name: 'pinned version',
      status: 'warn',
      message: `install.yaml pins Herdr core ${herdr.version}, below Wheems's minimum ${HERDR_MINIMUM_VERSION}, so ${HERDR_MINIMUM_VERSION} applies`,
      hint: `Set herdr.version to ${HERDR_MINIMUM_VERSION} or later.`,
    });
  }
  sections.push({ title: 'Herdr core', checks: runtimeChecks });

  const configChecks: HealthCheck[] = [];
  if (!install) {
    configChecks.push({
      name: 'install',
      status: 'skip',
      message: `No install at ${options.home} yet`,
      hint: 'wheems setup creates one. Set WHEEMS_HOME or --home to check another folder.',
    });
  } else {
    const problems = [
      ...install.problems,
      ...crossCheck(install, { engines: options.registry.names('engine') }),
    ];
    const errors = problems.filter((p) => p.level === 'error');
    configChecks.push({
      name: 'install',
      status: errors.length > 0 ? 'fail' : 'pass',
      message:
        errors.length > 0
          ? `${errors.length} ${errors.length === 1 ? 'problem' : 'problems'} in ${options.home}`
          : `${options.home}: ${install.workspaces.length} ${install.workspaces.length === 1 ? 'workspace' : 'workspaces'}`,
    });
    for (const problem of problems) configChecks.push(problemCheck(problem));
  }
  sections.push({ title: 'Config', checks: configChecks });

  if (install?.config) {
    sections.push({ title: 'Agents', checks: await agentChecks(install, options) });
    sections.push({ title: 'Channels', checks: await channelChecks(install, options) });
    sections.push({ title: 'Knowledge', checks: await knowledgeChecks(install, options) });
    sections.push({ title: 'Review', checks: [await reviewCheck(options)] });
    sections.push({
      title: 'Service',
      checks: [
        await serviceCheck(options),
        ...(await sessionStoreChecks(
          options,
          runtimeChecks.some((c) => c.status === 'fail') ? null : runtime,
        )),
      ],
    });
  }

  const ok = sections.every((s) => s.checks.every((c) => c.status !== 'fail'));
  return { ok, sections };
}

async function agentChecks(install: LoadedInstall, options: DoctorOptions): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  /** Trusting the install folder covers every workspace in it: one fix per engine. */
  const trustFixed = new Set<string>();
  const engines = new Set(
    install.workspaces.flatMap((w) => w.agents.map((a) => a.definition.engine)),
  );
  for (const name of [...engines].sort()) {
    if (!options.registry.has('engine', name)) continue; // Config already warns about these.
    checks.push(...(await options.registry.create('engine', name).check()));
  }
  const catalog = options.registry.catalog('engine');
  const trustOf =
    options.trust ??
    ((engine: string, dir: string) => {
      const setup = catalog.find((e) => e.name === engine)?.engine;
      return setup?.trusted ? setup.trusted(dir) : Promise.resolve(null);
    });
  const home = tilde(options.home, options.env);
  /**
   * The fix for a folder an engine doesn't trust: mark the install folder trusted, which covers
   * every workspace and session, or (for an engine Wheems can't mark) open the engine there to
   * answer its question. Offered once per engine.
   */
  const trustFix = (engine: string, dir: string): Fix | undefined => {
    const fixes = options.fixes;
    const entry = catalog.find((e) => e.name === engine);
    const setup = entry?.engine;
    const label = entry?.label ?? engine;
    if (!fixes || !setup || setup.trust === null || trustFixed.has(engine)) return undefined;
    trustFixed.add(engine);
    const after = async () =>
      (await trustOf(engine, dir)) === true
        ? `${label} trusts the install folder now.`
        : `${label} still doesn't trust it. Run wheems doctor --fix again, and say yes when it asks.`;
    if (setup.markTrusted) {
      return {
        what: `Mark ${home} as trusted for ${label}${setup.trustRecord ? ` in ${setup.trustRecord}` : ''}, the entry ${label} writes when you say yes to its question, changing nothing else there. That covers every workspace and session`,
        run: async () => {
          await setup.markTrusted?.(options.home);
          return after();
        },
      };
    }
    const command = setup.trust;
    return {
      what: `Open ${label} in ${home} so you can answer its question: say yes to trusting the folder, then press Ctrl+C twice to come back. That covers every workspace and session`,
      run: async () => {
        await fixes.run(command, options.home);
        return after();
      },
    };
  };
  const advice = (engine: string, label: string): string => {
    const command = catalog.find((e) => e.name === engine)?.engine?.trust ?? null;
    return command !== null
      ? trustAdvice(label, command, home)
      : 'Open the engine in the install folder once and say yes, or run wheems setup.';
  };
  for (const workspace of install.workspaces) {
    const chief = workspace.agents.find(
      (a) => a.definition.name === workspace.config?.chief_of_staff,
    );
    if (!chief) continue;
    const engine = chief.definition.engine;
    const label = catalog.find((e) => e.name === engine)?.label ?? engine;
    const trusted = await trustOf(engine, workspace.dir);
    if (trusted === true) {
      checks.push({
        name: `${workspace.id} folder`,
        status: 'pass',
        message: `${label} trusts the workspace folder`,
      });
    } else if (trusted === false) {
      const fix = trustFix(engine, workspace.dir);
      checks.push({
        name: `${workspace.id} folder`,
        status: 'warn',
        message: `${label} hasn't been told to trust the workspace folder, so it can't answer in chat`,
        hint: advice(engine, label),
        ...(fix && { fix }),
      });
    }
  }
  // Sessions a chief starts run in their own folders under .wheems/sessions/, on whichever
  // engine their agent uses, so each engine any agent uses must trust that folder too.
  const sessionsDir = join(paths(options.home, options.env).state, 'sessions');
  for (const engine of [...engines].sort()) {
    if (!options.registry.has('engine', engine)) continue;
    const label = catalog.find((e) => e.name === engine)?.label ?? engine;
    const trusted = await trustOf(engine, sessionsDir);
    if (trusted === true) {
      checks.push({
        name: `${label} sessions`,
        status: 'pass',
        message: `${label} trusts the folder sessions start in`,
      });
    } else if (trusted === false) {
      const fix = trustFix(engine, sessionsDir);
      checks.push({
        name: `${label} sessions`,
        status: 'warn',
        message: `${label} hasn't been told to trust ${tilde(sessionsDir, options.env)}, so sessions on it can't start`,
        hint: advice(engine, label),
        ...(fix && { fix }),
      });
    }
  }

  if (checks.length === 0)
    checks.push({ name: 'engines', status: 'skip', message: 'No agents yet' });
  return checks;
}

/**
 * Whether each chat app the workspaces use can be reached and accepts its tokens: the checks that
 * fail, empty when all pass. `wheems start` asks when the service hasn't answered in time.
 */
export async function chatProblems(
  options: Pick<DoctorOptions, 'home' | 'registry' | 'env'>,
): Promise<HealthCheck[]> {
  if (!(await exists(join(options.home, 'install.yaml')))) return [];
  const install = await loadInstall(options.home);
  // Only whether each can be reached and takes its tokens: a channel the app isn't in only warns,
  // and doesn't keep the service from answering.
  const checks = await channelChecks(install, { ...options, quick: true }, false);
  return checks.filter((check) => check.status === 'fail');
}

async function channelChecks(
  install: LoadedInstall,
  options: DoctorOptions,
  membership = true,
): Promise<HealthCheck[]> {
  const config = install.config;
  if (!config) return [];
  const used = new Set<string>();
  for (const workspace of install.workspaces) {
    const chat = workspace.config?.channels.chat;
    if (chat) used.add(chat.connection);
  }
  if (used.size === 0)
    return [{ name: 'chat', status: 'skip', message: 'No workspace has a chat channel yet' }];
  const secrets = await readSecrets(paths(options.home, options.env).secrets);
  const checks: HealthCheck[] = [];
  for (const connection of [...used].sort()) {
    const settings = config.connections[connection];
    if (!settings) continue; // Config already reports it.
    if (!options.registry.has('channel', settings.driver)) {
      checks.push({
        name: connection,
        status: 'warn',
        message: `No channel driver "${settings.driver}" yet`,
      });
      continue;
    }
    if (settings.allowed_users.length === 0) {
      checks.push({
        name: `${connection} allowed users`,
        status: 'warn',
        message: 'Nobody is allowed to talk to agents yet, so every message is ignored',
        hint: 'Run wheems setup, or add Slack member ids to allowed_users in install.yaml.',
      });
    }
    const secret = secrets[settings.secret ?? connection];
    if (secret === undefined) {
      checks.push({
        name: connection,
        status: 'fail',
        message: 'Not connected yet: no credentials saved for it',
        hint: 'Run wheems setup to connect it.',
      });
      continue;
    }
    try {
      const driver = options.registry.create('channel', settings.driver, { ...secret });
      const health = await driver.check();
      checks.push(...health.map((c) => ({ ...c, name: `${connection}: ${c.name}` })));
      if (membership && health.every((c) => c.status !== 'fail')) {
        checks.push(...(await channelMembership(install, connection, driver, options)));
      }
    } catch (error) {
      checks.push({
        name: connection,
        status: 'fail',
        message: error instanceof Error ? error.message : String(error),
        hint: 'Run wheems setup to connect it.',
      });
    }
  }
  return checks;
}

/**
 * For each workspace that chats in a channel on this connection: can the app see the channel,
 * and is it a member? Slack lists public channels the app isn't in, and sends no messages from
 * them, so a workspace can look bound and never hear anything.
 */
async function channelMembership(
  install: LoadedInstall,
  connection: string,
  driver: ChannelDriver,
  options: DoctorOptions,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  for (const workspace of install.workspaces) {
    const chat = workspace.config?.channels.chat;
    if (!chat || chat.connection !== connection || !('channel' in chat)) continue;
    const name = `${workspace.id} chat channel`;
    const id = driver.resolveChannel
      ? await driver.resolveChannel(chat.channel, { quick: true })
      : chat.channel;
    if (id === null) {
      const fix = options.fixes ? await channelNameFix(workspace, chat.channel, driver) : undefined;
      checks.push({
        name,
        status: 'fail',
        message: `The app can't see ${chat.channel}`,
        hint: 'Invite the app to the channel: a running service picks it up at once. Or check the name in workspace.yaml.',
        ...(fix && { fix }),
      });
      continue;
    }
    const member = driver.isMember ? await driver.isMember(id, { quick: true }) : null;
    checks.push(
      member === true
        ? { name, status: 'pass', message: `The app is in ${chat.channel}` }
        : member === false
          ? {
              name,
              status: 'warn',
              message: `The app isn't in ${chat.channel}, so messages there never reach the chief of staff`,
              hint: `In ${chat.channel}, type /invite and choose the app.`,
            }
          : {
              name,
              status: 'skip',
              message: `Couldn't tell whether the app is in ${chat.channel}`,
            },
    );
  }
  return checks;
}

/**
 * When a configured channel name is a near miss for one the app can see (a typo, or a channel
 * renamed slightly), a fix that writes the right name into workspace.yaml. Only local config
 * changes: nothing in the chat app.
 */
async function channelNameFix(
  workspace: LoadedWorkspace,
  configured: string,
  driver: ChannelDriver,
): Promise<Fix | undefined> {
  if (!driver.listChannels) return undefined;
  const wanted = configured.replace(/^#/, '').toLowerCase();
  const visible = await driver.listChannels({ quick: true }).catch(() => []);
  let best: { name: string; distance: number } | undefined;
  for (const channel of visible) {
    const distance = editDistance(wanted, channel.name.toLowerCase());
    if (distance <= 2 && (best === undefined || distance < best.distance)) {
      best = { name: channel.name, distance };
    }
  }
  if (!best) return undefined;
  const name = best.name;
  const file = join(workspace.dir, 'workspace.yaml');
  return {
    what: `Change ${workspace.id}'s chat channel in workspace.yaml from ${configured} to #${name}, a channel the app can see`,
    run: async () => {
      const doc = parseDocument(await readFile(file, 'utf8'));
      doc.setIn(['channels', 'chat', 'channel'], name);
      await writeFile(file, doc.toString());
      return `${workspace.id} now chats in #${name}. Restart the service to use it: wheems restart`;
    },
  };
}

/** How many single-character edits turn one string into another. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** What waits for the person in `wheems review`. Never a failure: it's for their attention. */
async function reviewCheck(options: DoctorOptions): Promise<HealthCheck> {
  const state = paths(options.home, options.env).state;
  const skills = (await listProposals(state)).length;
  const aboutYou = (await listAboutYou(state)).length;
  if (skills + aboutYou === 0) {
    return { name: 'review', status: 'pass', message: 'Nothing waits for review' };
  }
  const parts = [
    skills > 0 && `${String(skills)} ${skills === 1 ? 'skill proposal' : 'skill proposals'}`,
    aboutYou > 0 && `${String(aboutYou)} ${aboutYou === 1 ? 'change' : 'changes'} to about-you.md`,
  ].filter((part): part is string => part !== false);
  return {
    name: 'review',
    status: 'warn',
    message: `${parts.join(' and ')} ${skills + aboutYou === 1 ? 'waits' : 'wait'} for review`,
    hint: 'Run: wheems review',
  };
}

async function knowledgeChecks(
  install: LoadedInstall,
  options: DoctorOptions,
): Promise<HealthCheck[]> {
  const config = install.config;
  if (!config) return [];
  const checks: HealthCheck[] = [];
  const settings = config.knowledge.embeddings;
  let search: KnowledgeSearch;
  const indexDir = paths(options.home, options.env).index;
  try {
    search = new KnowledgeSearch({
      install: config,
      workspaces: install.workspaces,
      registry: options.registry,
      indexDir,
    });
  } catch (error) {
    checks.push({
      name: 'embeddings',
      status: 'fail',
      message: `Can't use knowledge.embeddings in install.yaml: ${error instanceof Error ? error.message : String(error)}`,
      hint: 'Fix it, or run wheems setup (Knowledge). Until then the service searches by keyword only.',
    });
    search = new KnowledgeSearch({
      install: { ...config, knowledge: {} },
      workspaces: install.workspaces,
      registry: options.registry,
      indexDir,
    });
  }
  try {
    if (search.embeddings) {
      checks.push(...(await search.embeddings.check()));
    } else if (settings === undefined) {
      checks.push({
        name: 'embeddings',
        status: 'skip',
        message: 'Search is keyword-only',
        hint: 'Run wheems setup (Knowledge) to search by meaning too, with a free local model.',
      });
    }
    for (const workspace of install.workspaces) {
      if (!workspace.config) continue;
      const status = await search
        .index(workspace.id)
        .status()
        .catch((error: unknown) => error);
      const check: DoctorCheck = indexCheck(workspace.id, status);
      const fixes = options.fixes;
      // An index not built yet is the service's to build when it starts; one it can't read,
      // or built for another model, is worth rebuilding now.
      const rebuild =
        check.status === 'warn' &&
        check.hint?.includes('wheems knowledgebase reindex') === true &&
        check.message !== 'Not built yet';
      if (fixes && rebuild) {
        const id = workspace.id;
        check.fix = {
          what: `Rebuild ${id}'s search index, as wheems knowledgebase reindex does (the service must be running)`,
          run: async () => {
            await fixes.reindex(id);
            return `${id}'s search index is rebuilt.`;
          },
        };
      }
      checks.push(check);
    }
  } finally {
    await search.close();
  }
  return checks;
}

function indexCheck(workspace: string, status: unknown): HealthCheck {
  const name = `${workspace} index`;
  if (status instanceof Error || typeof status !== 'object' || status === null) {
    return {
      name,
      status: 'warn',
      message: `Can't read it: ${status instanceof Error ? status.message : String(status)}`,
      hint: 'Run wheems knowledgebase reindex.',
    };
  }
  const index = status as IndexStatus;
  if (!index.built) {
    return {
      name,
      status: 'warn',
      message: 'Not built yet',
      hint: 'The service builds it when it starts, or run wheems knowledgebase reindex.',
    };
  }
  const files = `${String(index.documents)} ${index.documents === 1 ? 'file' : 'files'}`;
  if (index.stale) {
    return {
      name,
      status: 'warn',
      message: `${files}, built ${index.embeddings ? `with ${index.embeddings.model}` : 'for keyword search'}, not the model in install.yaml`,
      hint: 'The service rebuilds it when it next syncs, or run wheems knowledgebase reindex.',
    };
  }
  const missing = index.chunks - index.embedded;
  if (index.embeddings !== null && missing > 0) {
    return {
      name,
      status: 'warn',
      message: `${files}; ${String(missing)} of ${String(index.chunks)} passages have no vector yet, so they're found by keyword only`,
      hint: 'The service adds them once the embeddings driver answers.',
    };
  }
  return {
    name,
    status: 'pass',
    message: `${files}${index.embeddings ? `, searched by meaning with ${index.embeddings.model}` : ', keyword search'}`,
  };
}

async function serviceCheck(options: DoctorOptions): Promise<DoctorCheck> {
  const probe = options.service ?? probeService;
  const { installed, answering } = await probe(options.home);
  if (answering) return { name: 'service', status: 'pass', message: 'Running and answering' };
  const fixes = options.fixes;
  return {
    name: 'service',
    status: 'warn',
    message: installed ? 'Installed, but not answering' : 'Not running, so nothing answers in chat',
    hint: installed ? 'See why: wheems logs' : 'Start it with: wheems start',
    ...(fixes && {
      fix: {
        what: installed
          ? 'Restart the service, as wheems restart does'
          : 'Start the service, now and at every login, as wheems start does',
        run: async () =>
          (await fixes.startService())
            ? 'The service is running and answering.'
            : "The service started but hasn't answered yet. See why: wheems logs",
      },
    }),
  };
}

/** Restarting the service brings the session store up to date and imports what waits. */
function restartFix(options: DoctorOptions, why: string): { fix: Fix } | Record<string, never> {
  const fixes = options.fixes;
  if (!fixes) return {};
  return {
    fix: {
      what: `Restart the service, which ${why}`,
      run: async () =>
        (await fixes.startService())
          ? 'The service restarted and is answering.'
          : "The service restarted but hasn't answered yet. See why: wheems logs",
    },
  };
}

/**
 * The session store, read-only: whether the service has made it, whether conversations from
 * before it are still waiting to be imported, and Herdr sessions with a Wheems label that it
 * has no record of. Those are left alone; doctor only reports them.
 */
async function sessionStoreChecks(
  options: DoctorOptions,
  runtime: RuntimeDriver | null,
): Promise<HealthCheck[]> {
  const where = paths(options.home, options.env);
  const checks: HealthCheck[] = [];
  const legacy = await readConversationsFile(where.conversations);
  if (legacy.status === 'unreadable') {
    checks.push({
      name: 'conversations.json',
      status: 'fail',
      message: `${tilde(where.conversations, options.env)} can't be read, so the service won't start until it's imported: ${legacy.problem}`,
      hint: 'Fix the file, or remove it to start its threads afresh, then run wheems restart.',
    });
  } else if (legacy.status === 'read') {
    checks.push({
      name: 'conversations.json',
      status: 'warn',
      message: `${tilde(where.conversations, options.env)} hasn't been imported into the session store`,
      hint: 'The service imports it when it starts: wheems restart.',
      ...restartFix(options, 'imports it'),
    });
  }
  if (!(await exists(where.store))) {
    checks.push({
      name: 'session store',
      status: 'skip',
      message: 'Not made yet; the service makes it when it starts',
    });
    return checks;
  }
  let store: StateStore;
  try {
    store = await StateStore.open(where.store, { readOnly: true });
  } catch (error) {
    checks.push({
      name: 'session store',
      status: 'warn',
      message: error instanceof Error ? error.message : String(error),
      hint: 'wheems restart brings it up to date.',
      ...restartFix(options, 'brings it up to date'),
    });
    return checks;
  }
  try {
    checks.push({
      name: 'session store',
      status: 'pass',
      message: tilde(where.store, options.env),
    });
    if (runtime === null) return checks;
    let live;
    try {
      live = await runtime.list();
    } catch (error) {
      checks.push({
        name: 'unknown sessions',
        status: 'skip',
        message: `Couldn't list Herdr's sessions: ${error instanceof Error ? error.message : String(error)}`,
      });
      return checks;
    }
    for (const session of store.unknownSessions(live)) {
      checks.push({
        name: 'unknown session',
        status: 'warn',
        message: `Herdr session ${session.name ?? session.id} (${session.id}) has a Wheems label but isn't in the session store, so Wheems leaves it alone`,
        hint: `If nothing needs it: hc kill ${session.id}`,
      });
    }
    return checks;
  } finally {
    store.close();
  }
}

async function probeService(home: string): Promise<{ installed: boolean; answering: boolean }> {
  const status = await serviceStatus();
  const answering = await request(paths(home).socket, { op: 'ping' }, 2000).then(
    (answer) => answer.ok,
    () => false,
  );
  return { installed: status.loaded, answering };
}

async function systemChecks(options: DoctorOptions): Promise<HealthCheck[]> {
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const platform = options.platform ?? process.platform;
  const checks: HealthCheck[] = [];
  const problem = nodeVersionProblem(nodeVersion);
  checks.push(
    problem === null
      ? { name: 'Node.js', status: 'pass', message: `${nodeVersion} is supported` }
      : { name: 'Node.js', status: 'fail', message: problem, hint: `Install ${NODE_SUPPORTED}.` },
  );
  const search = await (options.fullTextSearch ?? (() => fullTextSearchProblem()))();
  checks.push(
    search === null
      ? { name: 'SQLite search', status: 'pass', message: "Node's SQLite has full-text search" }
      : {
          name: 'SQLite search',
          status: 'fail',
          message: search,
          hint: `Install ${NODE_SUPPORTED}.`,
        },
  );
  checks.push(
    platform === 'darwin'
      ? { name: 'platform', status: 'pass', message: 'macOS' }
      : platform === 'linux'
        ? {
            name: 'platform',
            status: 'warn',
            message:
              'Linux: the commands work, but the service runs under launchd on macOS only; systemd comes with the always-on milestone',
          }
        : {
            name: 'platform',
            status: 'warn',
            message: `${platform} is not supported yet; Wheems runs on macOS (and Linux, apart from the service)`,
          },
  );
  return checks;
}

/** Starts a tiny session, sends it a line, waits, reads it back and removes it. */
async function roundTrip(runtime: RuntimeDriver): Promise<HealthCheck> {
  const name = `wheems-doctor-${randomBytes(3).toString('hex')}`;
  let id: string | undefined;
  try {
    const session = await runtime.start({
      name,
      command: ['sh', '-c', 'read line; echo "wheems-doctor:$line"'],
      cwd: homedir(),
      labels: { wheems: 'doctor' },
    });
    id = session.id;
    await runtime.send(id, 'ping');
    const waited = await runtime.wait(id, { timeoutSeconds: 15 });
    const read = await runtime.read(id);
    if (!waited.ended || waited.exitCode !== 0 || !read.text.includes('wheems-doctor:ping')) {
      return {
        name: 'round trip',
        status: 'fail',
        message: `A test session did not answer as expected (wait: ${waited.reason}, exit: ${String(waited.exitCode)})`,
      };
    }
    return {
      name: 'round trip',
      status: 'pass',
      message: 'Started, sent to, waited on and read a test session',
    };
  } catch (error) {
    return {
      name: 'round trip',
      status: 'fail',
      message: `A test session failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (id !== undefined) {
      try {
        const session = await runtime.get(id);
        if (session?.state === 'live') await runtime.stop(id);
        if (session) await runtime.remove(id);
      } catch {
        // Leave it; hc ls --label wheems=doctor shows any left behind.
      }
    }
  }
}

function problemCheck(problem: Problem): HealthCheck {
  const where = problem.line !== undefined ? `${problem.file}:${problem.line}` : problem.file;
  return {
    name: where,
    status: problem.level === 'error' ? 'fail' : 'warn',
    message: problem.message,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
