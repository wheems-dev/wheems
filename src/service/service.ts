import { access, chmod, mkdir, writeFile } from 'node:fs/promises';
import type { Server } from 'node:net';
import { join } from 'node:path';
import { crossCheck } from '../config/check.js';
import { loadInstall, type LoadedInstall, type LoadedWorkspace } from '../config/load.js';
import { nameSchema, type InstallConfig } from '../config/schemas.js';
import type { ChannelDriver, InboundEvent } from '../contracts/channel.js';
import type { EngineDriver } from '../contracts/engine.js';
import type { SessionInfo } from '../contracts/runtime.js';
import type { DriverRegistry } from '../contracts/registry.js';
import { paths, tilde, type Paths } from '../home.js';
import { readSecrets } from '../secrets.js';
import { DEFAULT_ENGINE } from '../cli/templates.js';
import { initWorkspace } from '../cli/commands/init.js';
import { ConversationManager, type Binding } from './conversations.js';
import { Onboarding, type NewChannelWorkspace, type WaitingWorkspace } from './onboarding.js';
import { stopWorkspaceSessions } from './retire.js';
import {
  listen,
  type ControlRequest,
  type ControlResponse,
  type ServiceReport,
} from './control.js';
import { trustAdvice } from '../util/trust.js';
import { KnowledgeSearch } from '../knowledge/search.js';
import { proposeSkill } from '../skills/proposals.js';
import { FilingQueue } from './filing.js';
import { TaskRunner } from './runner.js';
import { ConversationStore } from './store.js';
import { SessionService } from './sessions.js';
import { ApprovalService } from './approvals.js';
import { ChatPoster } from './poster.js';
import { writeNote } from '../knowledge/notes.js';
import { StateStore, type MessageRecord, type StandingAgent } from '../state/store.js';
import { requireFullTextSearch } from '../util/sqlite.js';
import { settingsFiles } from '../web/data.js';
import { startWeb, type RunningWeb, type WebOptions } from '../web/server.js';
import { restartSoon } from './launchd.js';
import { moveToWheemsFiles } from '../config/migrate.js';

export interface ServiceOptions {
  home: string;
  /** Restarts the service once it has answered; returns why it can't, or null. Tests replace it. */
  restart?: () => Promise<string | null>;
  registry: DriverRegistry;
  /** The Node.js and script that run the `wheems` command, for the command agents run. */
  node: string;
  cli: string;
  version: string;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  /** Passed through to the conversation manager, for tests. */
  startupSeconds?: number;
  pollMs?: number;
  /** How often to look for quiet conversations that need a note; 0 turns it off. */
  noteSweepMs?: number;
  /** How long the filer gets for one note, in seconds. */
  filingSeconds?: number;
  /** How often to bring the search indexes up to date with hand edits; 0 turns it off. */
  indexSyncMs?: number;
  /** How often to see whether a workspace's nightly tidy is due; 0 turns it off. */
  tidyCheckMs?: number;
  /** The web app's port; null serves no web app (tests). Default: WHEEMS_WEB_PORT or 4317. */
  webPort?: number | null;
  /** Starts the web app; a test can slow it down. */
  startWeb?: (options: WebOptions) => Promise<RunningWeb>;
  /** How often to expire approvals and send the daily list of decisions; 0 turns it off. */
  approvalTickMs?: number;
}

export interface RunningService {
  stop(): Promise<void>;
}

/**
 * The always-running service: connects every chat channel that a workspace
 * binds, routes messages to agents, and answers the `wheems` command on its
 * control socket. Runs in the foreground; launchd keeps it running.
 */
export async function runService(options: ServiceOptions): Promise<RunningService> {
  const env = options.env ?? process.env;
  const log =
    options.log ??
    ((message: string) => {
      console.log(`${new Date().toISOString()} ${message}`);
    });
  const where = paths(options.home, env);
  log(`Starting Wheems ${options.version} from ${options.home}`);

  // Workspaces from before WHEEMS.md move over before they're loaded (docs/instructions.md).
  for (const moved of await moveToWheemsFiles(options.home)) log(moved);
  const install = await loadInstall(options.home);
  const problems = [...install.problems, ...crossCheck(install)].filter((p) => p.level === 'error');
  if (!install.config || problems.length > 0) {
    throw new Error(
      `The install has config problems; run wheems doctor:\n${problems.map((p) => `  ${p.file}: ${p.message}`).join('\n')}`,
    );
  }
  const config = install.config;
  const secrets = await readSecrets(where.secrets);

  // The `wheems` command agents run, pinned to this Node.js and this copy of Wheems.
  await mkdir(where.bin, { recursive: true });
  const wrapper = join(where.bin, 'wheems');
  await writeFile(
    wrapper,
    `#!/bin/sh\nexec ${shellQuote(options.node)} ${shellQuote(options.cli)} "$@"\n`,
  );
  await chmod(wrapper, 0o755);

  const runtime = options.registry.create('runtime', 'herdr', {
    ...(config.herdr?.binary !== undefined && { binary: config.herdr.binary }),
    ...(config.herdr?.version !== undefined && { minimumVersion: config.herdr.version }),
  });
  const runtimeFailures = (await runtime.check()).filter((c) => c.status === 'fail');
  if (runtimeFailures.length > 0) {
    throw new Error(`Herdr core is not ready: ${runtimeFailures.map((c) => c.message).join('; ')}`);
  }

  const { state, lost } = await openStore(where, install.workspaces, await runtime.list(), log);

  const channels = new Map<string, ChannelDriver>();
  const channelFor = (connection: string): ChannelDriver => {
    const existing = channels.get(connection);
    if (existing) return existing;
    const settings = config.connections[connection];
    if (!settings) throw new Error(`No connection "${connection}" in install.yaml`);
    const driver = options.registry.create('channel', settings.driver, {
      ...secrets[settings.secret ?? connection],
    });
    channels.set(connection, driver);
    return driver;
  };

  const bindings: Binding[] = [];
  const workspaceReport: ServiceReport['workspaces'] = [];
  /** Workspaces whose channel the app can't see yet: bound once it's invited there. */
  const waiting: WaitingWorkspace[] = [];
  for (const workspace of install.workspaces) {
    const chat = workspace.config?.channels.chat;
    if (!chat) {
      workspaceReport.push({ id: workspace.id, chat: null });
      continue;
    }
    const channel = channelFor(chat.connection);
    let channelId: string | null = null;
    const place =
      'channel' in chat
        ? `#${chat.channel.replace(/^#/, '')} on ${chat.connection}`
        : `direct messages on ${chat.connection}`;
    if ('channel' in chat) {
      channelId = channel.resolveChannel
        ? await channel.resolveChannel(chat.channel)
        : chat.channel;
      if (channelId === null) {
        const problem = `the app can't see ${place}. Invite the app to the channel, and the chief of staff answers there at once; or check the name in workspace.yaml.`;
        log(`Workspace ${workspace.id}: ${problem}`);
        workspaceReport.push({ id: workspace.id, chat: place, problem });
        waiting.push({ workspace, connection: chat.connection, channel: chat.channel });
        continue;
      }
      // Slack lists public channels the app isn't in, and sends no messages from them.
      if ((await channel.isMember?.(channelId)) === false) {
        const problem = `the app isn't in ${place}, so messages there won't reach the chief of staff. In that channel, /invite the app.`;
        log(`Workspace ${workspace.id}: ${problem}`);
        workspaceReport.push({ id: workspace.id, chat: place, problem });
        bindings.push({ workspace, connection: chat.connection, channel: channelId });
        continue;
      }
    }
    bindings.push({ workspace, connection: chat.connection, channel: channelId });
    workspaceReport.push({ id: workspace.id, chat: place });
    log(
      `Workspace ${workspace.id}: chat on ${chat.connection} ${channelId === null ? '(direct messages)' : channelId}`,
    );
  }

  // The connections a workspace's approvals and updates channels use are connected too, so a
  // post there doesn't find its connection not running.
  for (const workspace of install.workspaces) {
    for (const [name, named] of Object.entries(workspace.config?.channels ?? {})) {
      if (name === 'chat' || !config.connections[named.connection]) continue;
      channelFor(named.connection);
    }
  }

  const engines = new Map<string, EngineDriver>();
  const engineFor = (name: string): EngineDriver => {
    const engine = engines.get(name) ?? options.registry.create('engine', name);
    engines.set(name, engine);
    return engine;
  };
  const sessionEnv = {
    WHEEMS_HOME: options.home,
    PATH: `${where.bin}:${env.PATH ?? '/usr/bin:/bin'}`,
  };
  const search = knowledgeSearch(config, install.workspaces, options.registry, where.index, log);
  const filing = new FilingQueue({
    home: options.home,
    install: config,
    workspaces: install.workspaces,
    engine: engineFor,
    runner: new TaskRunner({
      runtime,
      log,
      ...(options.pollMs !== undefined && { pollMs: options.pollMs }),
    }),
    stateDir: where.state,
    aboutYouFile: where.aboutYou,
    sessionEnv,
    log,
    onFiled: (workspace) => {
      search
        .index(workspace)
        .sync()
        .catch((error: unknown) => {
          log(`Search in ${workspace}: ${error instanceof Error ? error.message : String(error)}`);
        });
    },
    ...(options.filingSeconds !== undefined && { timeoutSeconds: options.filingSeconds }),
  });
  /** The engine's label and trust command when it plainly doesn't trust a folder; else null. */
  const untrusted = async (
    engine: string,
    dir: string,
  ): Promise<{ label: string; trust: string[] } | null> => {
    const entry = options.registry.catalog('engine').find((e) => e.name === engine);
    const setup = entry?.engine;
    if (!entry || !setup?.trusted || setup.trust === null) return null;
    // Only a plain no counts: an engine that can't tell is given the benefit of the doubt.
    if ((await setup.trusted(dir)) !== false) return null;
    return { label: entry.label, trust: setup.trust };
  };
  const sessions: SessionService = new SessionService({
    install: config,
    workspaces: install.workspaces,
    state,
    runtime,
    engine: engineFor,
    stateDir: where.state,
    sessionEnv,
    trustProblem: async (engine, dir) => {
      const found = await untrusted(engine, dir);
      if (!found) return null;
      return `${found.label} doesn't trust the folder this session starts in (${tilde(dir, env)}), so it would wait at a "trust this folder?" question that nobody can see. Nothing was started. ${trustAdvice(found.label, found.trust, tilde(options.home, env))} Then try again.`;
    },
    aboutYouFile: where.aboutYou,
    // A thread session hears from sessions through its conversation, like any message.
    tell: (sessionId: string, text: string): Promise<void> => {
      const key = state.threadKeyOf(sessionId);
      if (key === undefined) return Promise.reject(new Error(`No conversation for ${sessionId}`));
      return manager.tell(key, text);
    },
    // Ending a session takes back the approvals it was waiting on.
    onEnded: (session) => void approvals.withdrawFor(session),
    log,
    ...(options.startupSeconds !== undefined && { startupSeconds: options.startupSeconds }),
    ...(options.pollMs !== undefined && { pollMs: options.pollMs }),
  });
  /**
   * Which conversation or ad-hoc session a reply, note or skill proposal comes from. A thread
   * session may say either, so it's taken to its conversation.
   */
  const speaker = (request: {
    conversation?: string | undefined;
    session?: string | undefined;
  }): { conversation: string } | { session: string } => {
    if (request.conversation !== undefined) return { conversation: request.conversation };
    if (request.session === undefined) throw new Error('Say which conversation or session');
    const key = state.threadKeyOf(request.session);
    if (key !== undefined) return { conversation: key };
    if (!state.callingSession(request.session)) throw new Error(`No session ${request.session}`);
    return { session: request.session };
  };
  /**
   * The workspace of a request only the person may make, such as restarting chat threads: an
   * agent's session, which could otherwise reach threads it doesn't own, is refused.
   */
  const personsWorkspace = (ref: {
    session?: string | undefined;
    conversation?: string | undefined;
    workspace?: string | undefined;
  }): string => {
    const caller = sessions.caller(ref);
    if (caller.session !== null) {
      throw new Error(
        'Only you can restart chat threads, from a terminal or the web app, not an agent.',
      );
    }
    return caller.workspace.id;
  };
  /** When each engine last said it was signed in: asked again after ten minutes. */
  const signedInAt = new Map<string, number>();
  const manager: ConversationManager = new ConversationManager({
    install: config,
    bindings,
    channels,
    runtime,
    engine: engineFor,
    store: new ConversationStore(state),
    sessionsSection: (workspace, owner) => sessions.sessionsSection(workspace, owner),
    onNote: (workspace) => void filing.file(workspace),
    trustProblem: async (engine, dir) => {
      const found = await untrusted(engine, dir);
      if (!found) return null;
      return `${found.label} hasn't been told to trust this workspace's folder, so it can't start. ${trustAdvice(found.label, found.trust, tilde(options.home, env))} Then send your message again.`;
    },
    signInProblem: async (engine) => {
      const entry = options.registry.catalog('engine').find((e) => e.name === engine);
      const setup = entry?.engine;
      if (!entry || !setup || setup.signIn === null) return null;
      const known = signedInAt.get(engine);
      if (known !== undefined && Date.now() - known < 10 * 60_000) return null;
      // Only a plain no counts: an engine that can't tell is given the benefit of the doubt.
      if ((await setup.signedIn()) !== false) {
        signedInAt.set(engine, Date.now());
        return null;
      }
      signedInAt.delete(engine);
      return `${entry.label} isn't signed in, so I can't answer. At the Mac, run \`${setup.signIn.join(' ')}\` and sign in (or wheems setup, then Engines), then send your message again.`;
    },
    savedChiefEngine: async (id) => {
      const workspace = (await loadInstall(options.home)).workspaces.find((w) => w.id === id);
      const chief = workspace?.config?.chief_of_staff;
      const agent = workspace?.agents.find((a) => a.definition.name === chief);
      if (!agent) throw new Error(`the chief of staff's agent file for ${id} can't be read`);
      return agent.definition.engine;
    },
    aboutYouFile: where.aboutYou,
    noteSweepMs: options.noteSweepMs ?? 60_000,
    sessionEnv,
    log,
    ...(options.startupSeconds !== undefined && { startupSeconds: options.startupSeconds }),
    ...(options.pollMs !== undefined && { pollMs: options.pollMs }),
  });

  const poster = new ChatPoster({ install: config, bindings, channels, state, log });
  const approvals: ApprovalService = new ApprovalService({
    install: config,
    workspaces: install.workspaces,
    state,
    sessions,
    poster,
    log,
    ...(options.approvalTickMs !== undefined && { tickMs: options.approvalTickMs }),
  });

  // Inviting the app to a channel is the whole setup: see onboarding.ts.
  const onboarding = new Onboarding({
    install: config,
    channels,
    bindings,
    workspaces: install.workspaces,
    waiting,
    create: async (request) => {
      const workspace = await createChannelWorkspace(options.home, env, config, install, request);
      // A workspace removed earlier under this name stays retired no more.
      manager.unretire(workspace.id);
      sessions.unretire(workspace.id);
      filing.unretire(workspace.id);
      state.writeAgents(standingAgents(install.workspaces));
      return workspace;
    },
    bound: (binding) => {
      const place = `${binding.channel ?? 'direct messages'} on ${binding.connection}`;
      const report = workspaceReport.find((w) => w.id === binding.workspace.id);
      if (report) {
        report.chat = place;
        delete report.problem;
      } else {
        workspaceReport.push({ id: binding.workspace.id, chat: place });
      }
    },
    deliver: (connection, event) => manager.handle(connection, event),
    log,
  });

  /**
   * Every event from a channel. A press of an approval's button, or a reply that answers one in
   * words, is the person deciding, wherever it was posted, even in a channel no conversation is
   * bound to; everything else goes on through onboarding to the conversation it belongs to.
   */
  const inbound = async (connection: string, event: InboundEvent): Promise<void> => {
    try {
      if (event.type === 'button' && (await approvals.press(connection, event))) return;
      if (event.type === 'message' && (await approvals.replyInWords(connection, event))) return;
    } catch (error) {
      log(`Approvals: ${error instanceof Error ? error.message : String(error)}`);
      if (event.type === 'button') return;
    }
    await onboarding.handle(connection, event);
  };

  // Connect every channel first, then open the control socket: a service that answers
  // ping is one that is connected. If anything fails, undo what started, so the process
  // exits and launchd restarts it.
  const started: ChannelDriver[] = [];
  const startedAt = new Date().toISOString();
  let server: Server | undefined;
  /** The web app, once it's served; reported by `status`. */
  let web: RunningWeb | null = null;
  try {
    for (const [connection, channel] of channels) {
      await channel.start((event) => inbound(connection, event));
      started.push(channel);
      log(`Connected ${connection}`);
    }
    // The web app, before the control socket: once the service answers, the
    // web app has started or failed, so status never reports one that is still starting.
    // Wheems runs without it if its port is taken.
    if (options.webPort !== null) {
      web = await (options.startWeb ?? startWeb)({
        home: options.home,
        env,
        registry: options.registry,
        ...(options.webPort !== undefined && { port: options.webPort }),
        log,
      }).catch((error: unknown) => {
        log(
          `The web app isn't served: ${error instanceof Error ? error.message : String(error)}. Wheems runs without it.`,
        );
        return null;
      });
      if (web) log(`Serving the web app at ${web.url} (open it with wheems web open)`);
    }
    server = await listen(
      where.socket,
      async (request: ControlRequest): Promise<ControlResponse> => {
        switch (request.op) {
          case 'ping':
            return { ok: true, version: options.version };
          case 'status':
            return {
              ok: true,
              status: {
                version: options.version,
                pid: process.pid,
                startedAt,
                home: options.home,
                connections: [...channels.keys()],
                workspaces: workspaceReport,
                web: web ? { port: web.port } : null,
              },
            };
          case 'reply': {
            const from = speaker(request);
            if ('session' in from) {
              throw new Error(
                'An ad-hoc session never talks to the person directly, so wheems chat reply is not for you. Answer your owner instead: your last message of each turn is your answer, and Wheems passes it on.',
              );
            }
            await manager.reply(from.conversation, request.text);
            return { ok: true };
          }
          case 'handover': {
            const from = speaker(request);
            if (!('conversation' in from)) {
              throw new Error('Only a chat thread hands over; this session has no thread.');
            }
            await manager.handover(from.conversation, request.text);
            return { ok: true, message: 'Saved. Now answer "done".' };
          }
          case 'conversations': {
            const workspace = personsWorkspace(request.caller);
            return { ok: true, conversations: await manager.openConversations(workspace) };
          }
          case 'conversations-restart': {
            const workspace = personsWorkspace(request.caller);
            if (request.restart !== true && request.choices.length === 0) {
              throw new Error('Say which conversations, and how each restarts.');
            }
            const lookUp = (session: string) => {
              const key = state.threadKeyOf(session);
              const thread = key === undefined ? undefined : state.conversation(key);
              return key !== undefined && thread?.workspace === workspace ? key : undefined;
            };
            const apply = () =>
              Promise.all(
                request.choices.map(({ session, choice }) => {
                  const key = lookUp(session);
                  return key === undefined
                    ? Promise.resolve({
                        key: session,
                        done: false,
                        text: `There's no chat thread with session ${session} in ${workspace}.`,
                      })
                    : manager.restart(key, choice);
                }),
              );
            if (request.restart !== true) return { ok: true, restarted: await apply() };
            // With a restart to follow: the old service starts no session in the workspace until
            // it, and every conversation must be covered, by a choice or by being set up already,
            // so none runs on after the restart with its old session and the new settings.
            if (!(await manager.hold(workspace))) {
              return {
                ok: true,
                restarted: [],
                restarting: false,
                stale: true,
                message:
                  'Something in the workspace was still starting, so nothing was done. Try again in a minute.',
              };
            }
            // The settings the choices were made for, as the files say now.
            const settingsNow = async () => {
              const loaded = (await loadInstall(options.home)).workspaces.find(
                (w) => w.id === workspace,
              );
              return loaded ? (await settingsFiles(options.home, loaded)).seen : null;
            };
            const changedSettings = {
              ok: true as const,
              restarted: [],
              restarting: false,
              stale: true,
              message:
                "The chief's settings changed after these choices were made, so the service wasn't restarted. Look at the choices again, then apply.",
            };
            if (request.settings !== undefined && (await settingsNow()) !== request.settings) {
              manager.release(workspace);
              return changedSettings;
            }
            const chosen = new Set(request.choices.map((c) => c.session));
            const uncovered = (await manager.openConversations(workspace)).filter(
              (c) => !c.startsAfresh && !chosen.has(c.session),
            );
            if (uncovered.length > 0) {
              manager.release(workspace);
              return {
                ok: true,
                restarted: [],
                restarting: false,
                stale: true,
                message: `The conversations changed since the page listed them (${String(uncovered.length)} not chosen for), so nothing was done. Look again, then apply.`,
              };
            }
            const restarted = await apply();
            if (restarted.some((outcome) => !outcome.done)) {
              manager.release(workspace);
              return { ok: true, restarted, restarting: false };
            }
            // Saved again while the choices were applied, here or by hand: they may not fit.
            if (request.settings !== undefined && (await settingsNow()) !== request.settings) {
              manager.release(workspace);
              return { ...changedSettings, restarted };
            }
            const why = await (options.restart ?? restartSoon)();
            if (why !== null) {
              manager.release(workspace);
              return { ok: true, restarted, restarting: false, message: why };
            }
            log(`Restarting, as asked from the web app, with ${workspace}'s conversations set up`);
            // The workspace stays held: this service stops in a moment.
            return { ok: true, restarted, restarting: true };
          }
          case 'note': {
            const from = speaker(request);
            if ('conversation' in from) {
              return { ok: true, path: await manager.note(from.conversation, request.text) };
            }
            const { workspace, agent } = sessions.agentOf(from.session);
            const path = await writeNote(
              workspace.dir,
              {
                workspace: workspace.id,
                agent: agent.definition.name,
                engine: agent.definition.engine,
                conversation: from.session,
                origin: 'person',
              },
              request.text,
            );
            sessions.noted(from.session, request.text);
            log(`Note from session ${from.session}: ${path}`);
            void filing.file(workspace.id);
            return { ok: true, path };
          }
          case 'reindex':
            return { ok: true, index: await search.index(request.workspace).rebuild() };
          case 'propose-skill': {
            const from = speaker(request);
            const owner =
              'conversation' in from
                ? await manager.owner(from.conversation)
                : (({ workspace, agent }) => ({
                    workspace: workspace.id,
                    agent: agent.definition.name,
                  }))(sessions.agentOf(from.session));
            const { proposal, message } = await proposeSkill({
              home: options.home,
              stateDir: where.state,
              workspace: owner.workspace,
              agent: owner.agent,
              conversation: 'conversation' in from ? from.conversation : from.session,
              name: request.name,
              text: request.text,
              embeddings: search.embeddings,
            });
            log(`Skill proposed by ${owner.agent} in ${owner.workspace}: ${proposal.id}`);
            return { ok: true, message };
          }
          case 'session-new': {
            const session = await sessions.create(sessions.caller(request.caller), {
              title: request.title,
              purpose: request.purpose,
              ...(request.doneWhen !== undefined && { doneWhen: request.doneWhen }),
              ...(request.agent !== undefined && { agent: request.agent }),
              ...(request.project !== undefined && { project: request.project }),
            });
            return { ok: true, session };
          }
          case 'session-list': {
            const { op: _op, caller, ...filter } = request;
            return { ok: true, sessions: await sessions.list(sessions.caller(caller), filter) };
          }
          case 'session-search':
            return {
              ok: true,
              sessions: await sessions.search(sessions.caller(request.caller), request.words),
            };
          case 'session-show':
            return {
              ok: true,
              details: await sessions.show(sessions.caller(request.caller), request.id),
            };
          case 'session-send': {
            const sent = await sessions.send(sessions.caller(request.caller), {
              id: request.id,
              text: request.text,
              ...(request.wait !== undefined && { wait: request.wait }),
              ...(request.wait_seconds !== undefined && { waitSeconds: request.wait_seconds }),
            });
            return {
              ok: true,
              sent: sent.message,
              ...(sent.answer !== null && { answer: sent.answer }),
              message: sent.next,
            };
          }
          case 'workspace-retire': {
            const id = request.id;
            if (!nameSchema.safeParse(id).success) throw new Error(`"${id}" isn't a workspace id`);
            // First nothing new starts: unbound, unloaded, and refused by every queue.
            for (let i = bindings.length - 1; i >= 0; i--) {
              if (bindings[i]?.workspace.id === id) bindings.splice(i, 1);
            }
            const loaded = install.workspaces.findIndex((w) => w.id === id);
            if (loaded >= 0) install.workspaces.splice(loaded, 1);
            const reported = workspaceReport.findIndex((w) => w.id === id);
            if (reported >= 0) workspaceReport.splice(reported, 1);
            // Nor is it bound later, when the app is invited to the channel it was waiting for.
            const waits = waiting.findIndex((w) => w.workspace.id === id);
            if (waits >= 0) waiting.splice(waits, 1);
            const draining = Promise.all([
              manager.retire(id),
              sessions.retire(id),
              filing.retire(id),
            ]);
            // Then its sessions stop, which ends whatever queued work was waiting on them,
            // and anything that started meanwhile is stopped too.
            let stopped = await stopWorkspaceSessions(runtime, id);
            await draining;
            stopped += await stopWorkspaceSessions(runtime, id);
            if (request.forget) state.forgetWorkspace(id);
            log(
              `Stopped serving workspace ${id}: ${String(stopped)} ${stopped === 1 ? 'session' : 'sessions'} stopped${request.forget ? ', its records forgotten' : ''}`,
            );
            return {
              ok: true,
              message: `${String(stopped)} ${stopped === 1 ? 'session' : 'sessions'} stopped`,
            };
          }
          case 'restart': {
            const why = await (options.restart ?? restartSoon)();
            if (why !== null) throw new Error(why);
            log('Restarting, as asked from the web app');
            return { ok: true, message: 'Restarting' };
          }
          case 'greet': {
            const marker = join(where.state, 'greeted.json');
            if (request.once === true && (await exists(marker))) {
              return { ok: true, skipped: true, message: 'It has greeted you before.' };
            }
            const greeted = await greet(config, bindings, channels);
            await mkdir(where.state, { recursive: true });
            await writeFile(
              marker,
              `${JSON.stringify({ workspace: greeted.workspace, at: new Date().toISOString() })}\n`,
            );
            return { ok: true, message: greeted.place };
          }
          case 'approval-request': {
            const asked = await approvals.request(sessions.caller(request.caller), {
              question: request.question,
              ...(request.details !== undefined && { details: request.details }),
              ...(request.choices !== undefined && { choices: request.choices }),
              ...(request.expires_seconds !== undefined && {
                expiresSeconds: request.expires_seconds,
              }),
              ...(request.wait !== undefined && { wait: request.wait }),
              ...(request.wait_seconds !== undefined && { waitSeconds: request.wait_seconds }),
            });
            return {
              ok: true,
              approval: asked.settled ?? asked.approval,
              message: asked.next,
            };
          }
          case 'approval-answer':
            return {
              ok: true,
              approval: await approvals.answer(
                sessions.caller(request.caller),
                request.id,
                request.choice,
                {
                  ...(request.reason !== undefined && { reason: request.reason }),
                  ...(request.via !== undefined && { via: request.via }),
                },
              ),
            };
          case 'approval-escalate':
            return {
              ok: true,
              approval: await approvals.escalate(
                sessions.caller(request.caller),
                request.id,
                request.note,
              ),
            };
          case 'approval-withdraw':
            return {
              ok: true,
              approval: await approvals.withdraw(sessions.caller(request.caller), request.id),
            };
          case 'approval-list':
            return {
              ok: true,
              approvals: approvals.list(sessions.caller(request.caller), {
                ...(request.all !== undefined && { all: request.all }),
              }),
            };
          case 'approval-show':
            return {
              ok: true,
              approval: approvals.show(sessions.caller(request.caller), request.id),
            };
          case 'chat-post': {
            const caller = sessions.caller(request.caller);
            if (caller.session !== null && caller.session.kind !== 'thread') {
              throw new Error(
                'Only your chief of staff posts to a channel. Your results go back to your owner, who decides what the person hears.',
              );
            }
            const posted = await poster.toChannel(caller.workspace, request.channel, {
              text: request.text,
            });
            log(`Posted to ${request.channel} in ${caller.workspace.id} (${posted.channel})`);
            return { ok: true, message: `Posted to ${request.channel}.` };
          }
          case 'session-end': {
            const ended = await sessions.end(sessions.caller(request.caller), request.id);
            return {
              ok: true,
              session: ended.session,
              message: ended.noted
                ? 'It wrote its note and has ended.'
                : "It has ended. It gave no note in time, or wasn't running.",
            };
          }
        }
      },
    );
  } catch (error) {
    await web?.close().catch(() => undefined);
    for (const channel of started) await channel.stop().catch(() => undefined);
    await sessions.stop();
    await manager.stop();
    await search.close();
    state.close();
    throw error;
  }
  const listening = server;
  log(`Wheems ${options.version} is running from ${options.home}`);
  await manager.recover();
  // Senders of messages lost in the restart hear so, now the chats are connected.
  void sessions.recoverLost(lost);
  // Approvals that ran out while the service was away expire, and answers not yet delivered are.
  void approvals.start();
  manager.startNotes();
  // Files edited, and notes that landed, while the service was away.
  void search.syncAll();
  void filing.fileAll();
  const indexSyncMs = options.indexSyncMs ?? 10 * 60_000;
  const syncTimer =
    indexSyncMs > 0
      ? setInterval(() => {
          void search.syncAll();
        }, indexSyncMs)
      : undefined;
  syncTimer?.unref();
  // After the notes left from before, so the tidy sees them filed.
  const tidyCheckMs = options.tidyCheckMs ?? 60_000;
  const tidyDue = () => {
    void filing.tidyIfDue().catch((error: unknown) => {
      log(`Nightly tidy: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  if (tidyCheckMs > 0) tidyDue();
  const tidyTimer = tidyCheckMs > 0 ? setInterval(tidyDue, tidyCheckMs) : undefined;
  tidyTimer?.unref();

  return {
    async stop() {
      await web?.close();
      await new Promise<void>((resolve) =>
        listening.close(() => {
          resolve();
        }),
      );
      clearInterval(syncTimer);
      clearInterval(tidyTimer);
      approvals.stop();
      for (const channel of channels.values()) await channel.stop().catch(() => undefined);
      await sessions.stop();
      await manager.stop();
      filing.stop();
      await search.close();
      state.close();
    },
  };
}

/**
 * Opens the session store and brings it up to date: its schema, the standing agents from
 * config, the conversations a Wheems from before it kept in `conversations.json`, and which
 * sessions are still running in Herdr.
 */
async function openStore(
  where: Paths,
  workspaces: LoadedWorkspace[],
  live: SessionInfo[],
  log: (message: string) => void,
): Promise<{ state: StateStore; lost: MessageRecord[] }> {
  await requireFullTextSearch();
  const state = await StateStore.open(where.store);
  let lost: MessageRecord[];
  try {
    state.writeAgents(standingAgents(workspaces));
    const imported = await state.importConversations(where.conversations);
    if (imported.status === 'imported') {
      log(
        `Imported ${String(imported.conversations)} ${imported.conversations === 1 ? 'conversation' : 'conversations'} into the session store${imported.skipped > 0 ? ` (${String(imported.skipped)} already there)` : ''}; the old file is ${imported.renamedTo}`,
      );
    } else if (imported.status === 'unreadable') {
      // Its threads' sessions may still be running, and a thread started afresh would replace
      // its record for good, so nothing starts until the file is fixed or removed.
      throw new Error(
        `Could not import ${where.conversations} into the session store: ${imported.problem}\nFix the file, or remove it to start its threads afresh, then run wheems restart.`,
      );
    }
    // Read before the control socket opens, so no message sent from now on is among them.
    lost = state.waitingMessages();
    if (lost.length > 0) {
      log(
        `${String(lost.length)} ${lost.length === 1 ? 'message was' : 'messages were'} still waiting for an answer when the service last stopped; their senders will be told`,
      );
    }
    const match = state.matchRuntime(live);
    if (match.stopped.length > 0) {
      log(
        `${String(match.stopped.length)} ${match.stopped.length === 1 ? 'session has' : 'sessions have'} stopped since the service last ran; each resumes when it's next needed`,
      );
    }
    for (const session of match.unknown) {
      log(
        `Herdr session ${session.name ?? session.id} has a Wheems label and isn't in the session store; leaving it alone`,
      );
    }
  } catch (error) {
    state.close();
    throw error;
  }
  return { state, lost };
}

/**
 * Whether inviting the app to a channel sets up a chief there, so the greeting can say so. It
 * does, through channel onboarding (onboarding.ts).
 */
export const INVITES_SET_UP_CHIEFS: boolean = true;

/**
 * The first chief greets the person in chat, through the channel driver: the chief in direct
 * messages if there is one, else the first that chats in a channel. Says where, or throws why it
 * couldn't.
 */

async function greet(
  config: InstallConfig,
  bindings: Binding[],
  channels: Map<string, ChannelDriver>,
): Promise<{ workspace: string; place: string }> {
  const binding = bindings.find((b) => b.channel === null) ?? bindings[0];
  if (!binding) throw new Error('No workspace chats anywhere yet: run wheems setup (Workspaces).');
  const driver = channels.get(binding.connection);
  if (!driver) throw new Error(`${binding.connection} isn't connected`);
  let channel = binding.channel;
  if (channel === null) {
    const person = config.connections[binding.connection]?.allowed_users[0];
    if (person === undefined) {
      throw new Error(
        `no one is in ${binding.connection}'s allowed_users yet: run wheems setup (Channels).`,
      );
    }
    if (!driver.openDirect) {
      throw new Error(`${binding.connection} can't start direct messages.`);
    }
    channel = await driver.openDirect(person);
  }
  const workspace = binding.workspace;
  const name = workspace.config?.name ?? workspace.id;
  const identity = workspace.config?.identity;
  const invite = INVITES_SET_UP_CHIEFS
    ? "\n\nTo add another chief of staff, for a team, a client or a project, invite me to any channel. I'll ask for a name there and set one up."
    : '';
  await driver.send({
    channel,
    text: `Hi! I'm ${name}'s chief of staff, and I'm set up. Message me here whenever you need something: each message starts a conversation, and replies in its thread carry it on.${invite}`,
    ...(identity && driver.capabilities.identities && { identity }),
  });
  return {
    workspace: workspace.id,
    place:
      binding.channel === null
        ? `in direct messages on ${binding.connection}`
        : `in ${binding.channel} on ${binding.connection}`,
  };
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/**
 * Creates a workspace and its chief of staff for a channel, as `wheems init <id> --channel`
 * does, and loads it into the running service's workspaces. Its chief runs on the same engine,
 * model and account as the first workspace's, which the install already has.
 */
async function createChannelWorkspace(
  home: string,
  env: NodeJS.ProcessEnv,
  config: InstallConfig,
  install: LoadedInstall,
  request: NewChannelWorkspace,
): Promise<LoadedWorkspace> {
  const model = install.workspaces
    .map((w) => w.agents.find((a) => a.definition.name === w.config?.chief_of_staff))
    .find((agent) => agent !== undefined)?.definition;
  const engine = model
    ? { name: model.engine, model: model.model, account: model.account }
    : DEFAULT_ENGINE;
  if (!(engine.account in config.accounts)) {
    throw new Error(
      `the install has no ${engine.account} account yet. Set up a first workspace with wheems setup.`,
    );
  }
  await initWorkspace({
    home,
    id: request.id,
    name: request.name,
    channel: request.channelName ?? request.channelId,
    connection: request.connection,
    engine,
    env,
  });
  const loaded = (await loadInstall(home)).workspaces.find((w) => w.id === request.id);
  if (!loaded?.config) {
    throw new Error(`workspace ${request.id} was made but has config problems: run wheems doctor`);
  }
  install.workspaces.push(loaded);
  return loaded;
}

/** Each workspace's chief of staff, as the store records standing agents. */
export function standingAgents(workspaces: LoadedWorkspace[]): StandingAgent[] {
  return workspaces.flatMap((workspace) => {
    const chief = workspace.config?.chief_of_staff;
    const agent = workspace.agents.find((a) => a.definition.name === chief);
    if (chief === undefined || !agent) return [];
    return [
      {
        id: `${workspace.id}/${chief}`,
        workspace: workspace.id,
        project: null,
        name: chief,
        role: 'chief' as const,
        engine: agent.definition.engine,
      },
    ];
  });
}

/**
 * The install's search indexes. If the embeddings driver can't be made from install.yaml,
 * search runs on keywords alone rather than stopping the service; doctor says why.
 */
function knowledgeSearch(
  config: InstallConfig,
  workspaces: LoadedWorkspace[],
  registry: DriverRegistry,
  indexDir: string,
  log: (message: string) => void,
): KnowledgeSearch {
  try {
    return new KnowledgeSearch({ install: config, workspaces, registry, indexDir, log });
  } catch (error) {
    log(
      `Search is keyword-only: ${error instanceof Error ? error.message : String(error)}. Run wheems doctor.`,
    );
    return new KnowledgeSearch({
      install: { ...config, knowledge: {} },
      workspaces,
      registry,
      indexDir,
      log,
    });
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
