import { chmod, mkdir, writeFile } from 'node:fs/promises';
import type { Server } from 'node:net';
import { join } from 'node:path';
import { crossCheck } from '../config/check.js';
import { loadInstall } from '../config/load.js';
import type { ChannelDriver } from '../contracts/channel.js';
import type { EngineDriver } from '../contracts/engine.js';
import type { DriverRegistry } from '../contracts/registry.js';
import { paths } from '../home.js';
import { readSecrets } from '../secrets.js';
import { ConversationManager, type Binding } from './conversations.js';
import { listen, type ControlRequest, type ControlResponse } from './control.js';
import { ConversationStore } from './store.js';

export interface ServiceOptions {
  home: string;
  registry: DriverRegistry;
  /** The Node.js and script that run the `opinr` command, for the command agents run. */
  node: string;
  cli: string;
  version: string;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  /** Passed through to the conversation manager, for tests. */
  startupSeconds?: number;
  pollMs?: number;
}

export interface RunningService {
  stop(): Promise<void>;
}

/**
 * The always-running service: connects every chat channel that a workspace
 * binds, routes messages to agents, and answers the `opinr` command on its
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
      `The install has config problems; run opinr doctor:\n${problems.map((p) => `  ${p.file}: ${p.message}`).join('\n')}`,
    );
  }
  const config = install.config;
  const secrets = await readSecrets(where.secrets);

  // The `opinr` command agents run, pinned to this Node.js and this copy of Opinr.
  await mkdir(where.bin, { recursive: true });
  const wrapper = join(where.bin, 'opinr');
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
  const manager = new ConversationManager({
    install: config,
    bindings,
    channels,
    runtime,
    engine: (name) => {
      const engine = engines.get(name) ?? options.registry.create('engine', name);
      engines.set(name, engine);
      return engine;
    },
    store: new ConversationStore(where.conversations),
    sessionEnv: {
      OPINR_HOME: options.home,
      PATH: `${where.bin}:${env.PATH ?? '/usr/bin:/bin'}`,
    },
    log,
    ...(options.startupSeconds !== undefined && { startupSeconds: options.startupSeconds }),
    ...(options.pollMs !== undefined && { pollMs: options.pollMs }),
  });

  const server: Server = await listen(
    where.socket,
    async (request: ControlRequest): Promise<ControlResponse> => {
      switch (request.op) {
        case 'ping':
          return { ok: true, version: options.version };
        case 'reply':
          await manager.reply(request.conversation, request.text);
          return { ok: true };
      }
    },
  );

  for (const [connection, channel] of channels) {
    await channel.start((event) => manager.handle(connection, event));
    log(`Connected ${connection}`);
  }
  log(`Opinr ${options.version} is running from ${options.home}`);

  return {
    async stop() {
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
      for (const channel of channels.values()) await channel.stop().catch(() => undefined);
      await manager.stop();
    },
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
