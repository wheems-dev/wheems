import { resolve } from 'node:path';
import type { Command } from 'commander';
import { loadInstall } from '../../config/load.js';
import { defaultHome, paths } from '../../home.js';
import { readSecrets } from '../../secrets.js';
import { SetupCancelled } from '../../contracts/setup.js';
import { clackUi } from '../clack-ui.js';
import type { Io } from '../program.js';
import { setupActions } from '../setup-actions.js';
import { connectChannel, ensureInstall } from './setup.js';

const homeHelp = 'the install folder (default: $WHEEMS_HOME or ~/wheems)';

/**
 * `wheems channel`: the chat apps the install connects to, such as Slack. Channel-agnostic:
 * each driver brings its own connect flow and, where it has one, its app manifest.
 */
export function registerChannel(program: Command, io: Io): void {
  const channel = program
    .command('channel')
    .description('Connect chat apps such as Slack, and see where each workspace chats');

  channel
    .command('list')
    .description('The chat connections, whether each is connected, and who chats where')
    .option('--json', 'print them as JSON')
    .option('--home <dir>', homeHelp)
    .action(async (options: { json?: boolean; home?: string }) => {
      const home = resolve(options.home ?? defaultHome(io.env));
      const install = await loadInstall(home);
      const secrets = await readSecrets(paths(home, io.env).secrets);
      const rows = Object.entries(install.config?.connections ?? {}).map(([name, settings]) => ({
        name,
        driver: settings.driver,
        connected: secrets[settings.secret ?? name] !== undefined,
        allowedUsers: settings.allowed_users.length,
        workspaces: install.workspaces.flatMap((w) => {
          const chat = w.config?.channels.chat;
          if (chat?.connection !== name) return [];
          return [
            {
              id: w.id,
              where: 'channel' in chat ? `#${chat.channel.replace(/^#/, '')}` : 'direct messages',
            },
          ];
        }),
      }));
      if (options.json === true) {
        io.out(`${JSON.stringify(rows, null, 2)}\n`);
        return;
      }
      if (rows.length === 0) {
        io.out('No chat connections yet. Connect one with: wheems channel connect slack\n');
        return;
      }
      io.out(
        `${rows
          .map(
            (r) =>
              `${r.name} (${r.driver}): ${r.connected ? 'connected' : 'not connected: wheems channel connect ' + r.driver}, ${String(r.allowedUsers)} allowed ${r.allowedUsers === 1 ? 'person' : 'people'}${r.workspaces.map((w) => `\n  ${w.id} in ${w.where}`).join('')}`,
          )
          .join('\n')}\n`,
      );
    });

  channel
    .command('connect')
    .description('Connect a chat app: its own steps, then its tokens saved privately')
    .argument('<driver>', 'the chat app, such as slack')
    .option('--home <dir>', homeHelp)
    .action(async (driver: string, options: { home?: string }) => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error('wheems channel connect asks questions, so it needs a terminal.');
      }
      const home = resolve(options.home ?? defaultHome(io.env));
      const where = paths(home, io.env);
      const registry = io.registry();
      const ui = clackUi();
      await ensureInstall(where);
      try {
        await connectChannel(
          { home, env: io.env, ui, registry, actions: setupActions(io, home, registry) },
          where,
          driver,
        );
      } catch (error) {
        if (error instanceof SetupCancelled) {
          ui.cancel('Left it; nothing was saved.');
          return;
        }
        throw error;
      }
    });

  channel
    .command('manifest')
    .description("Print a chat app's manifest, to create the app from (Slack has one)")
    .argument('<driver>', 'the chat app, such as slack')
    .action((driver: string) => {
      io.out(channelManifest(io, driver));
    });
}

/** A channel driver's app manifest, from its registry entry. */
export function channelManifest(io: Io, driver: string): string {
  const entry = io
    .registry()
    .catalog('channel')
    .find((e) => e.name === driver);
  if (!entry) throw new Error(`No channel driver "${driver}"`);
  if (!entry.manifest) throw new Error(`${entry.label} has no app manifest`);
  return entry.manifest();
}
