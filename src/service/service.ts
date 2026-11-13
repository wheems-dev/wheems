import { chmod, mkdir, writeFile } from 'node:fs/promises';
import type { Server } from 'node:net';
import { join } from 'node:path';
import { crossCheck } from '../config/check.js';
import { loadInstall, type LoadedWorkspace } from '../config/load.js';
import type { InstallConfig } from '../config/schemas.js';
import type { ChannelDriver } from '../contracts/channel.js';
import type { EngineDriver } from '../contracts/engine.js';
import type { DriverRegistry } from '../contracts/registry.js';
import { paths } from '../home.js';
import { readSecrets } from '../secrets.js';
import { ConversationManager, type Binding } from './conversations.js';
import { listen, type ControlRequest, type ControlResponse } from './control.js';
import { KnowledgeSearch } from '../knowledge/search.js';
import { proposeSkill } from '../skills/proposals.js';
import { FilingQueue } from './filing.js';
import { TaskRunner } from './runner.js';
import { ConversationStore } from './store.js';

export interface ServiceOptions {
  home: string;
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
  for (const workspace of install.workspaces) {
    const chat = workspace.config?.channels.chat;
    if (!chat) continue;
    const channel = channelFor(chat.connection);
    let channelId: string | null = null;
    if ('channel' in chat) {
      const resolver = (
        channel as Partial<{ resolveChannel(name: string): Promise<string | null> }>
      ).resolveChannel;
      channelId = resolver ? await resolver.call(channel, chat.channel) : chat.channel;
      if (channelId === null) {
        log(
          `Workspace ${workspace.id}: the bot cannot see channel ${chat.channel}; invite it to the channel`,
        );
        continue;
      }
    }
    bindings.push({ workspace, connection: chat.connection, channel: channelId });
    log(
      `Workspace ${workspace.id}: chat on ${chat.connection} ${channelId === null ? '(direct messages)' : channelId}`,
    );
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
  const manager = new ConversationManager({
    install: config,
    bindings,
    channels,
    runtime,
    engine: engineFor,
    store: new ConversationStore(where.conversations),
    onNote: (workspace) => void filing.file(workspace),
    aboutYouFile: where.aboutYou,
    noteSweepMs: options.noteSweepMs ?? 60_000,
    sessionEnv,
    log,
    ...(options.startupSeconds !== undefined && { startupSeconds: options.startupSeconds }),
    ...(options.pollMs !== undefined && { pollMs: options.pollMs }),
  });

  // Connect every channel first, then open the control socket: a service that answers
  // ping is one that is connected. If anything fails, undo what started, so the process
  // exits and launchd restarts it.
  const started: ChannelDriver[] = [];
  let server: Server | undefined;
  try {
    for (const [connection, channel] of channels) {
      await channel.start((event) => manager.handle(connection, event));
      started.push(channel);
      log(`Connected ${connection}`);
    }
    server = await listen(
      where.socket,
      async (request: ControlRequest): Promise<ControlResponse> => {
        switch (request.op) {
          case 'ping':
            return { ok: true, version: options.version };
          case 'reply':
            await manager.reply(request.conversation, request.text);
            return { ok: true };
          case 'note':
            return { ok: true, path: await manager.note(request.conversation, request.text) };
          case 'reindex':
            return { ok: true, index: await search.index(request.workspace).rebuild() };
          case 'propose-skill': {
            const owner = await manager.owner(request.conversation);
            const { proposal, message } = await proposeSkill({
              home: options.home,
              stateDir: where.state,
              workspace: owner.workspace,
              agent: owner.agent,
              conversation: request.conversation,
              name: request.name,
              text: request.text,
              embeddings: search.embeddings,
            });
            log(`Skill proposed by ${owner.agent} in ${owner.workspace}: ${proposal.id}`);
            return { ok: true, message };
          }
        }
      },
    );
  } catch (error) {
    for (const channel of started) await channel.stop().catch(() => undefined);
    await manager.stop();
    await search.close();
    throw error;
  }
  const listening = server;
  log(`Wheems ${options.version} is running from ${options.home}`);
  await manager.recover();
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
      await new Promise<void>((resolve) =>
        listening.close(() => {
          resolve();
        }),
      );
      clearInterval(syncTimer);
      clearInterval(tidyTimer);
      for (const channel of channels.values()) await channel.stop().catch(() => undefined);
      await manager.stop();
      filing.stop();
      await search.close();
    },
  };
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
