import { resolve } from 'node:path';
import type { Command } from 'commander';
import type { CatalogEntry } from '../../contracts/registry.js';
import { SetupCancelled, type EngineSetup } from '../../contracts/setup.js';
import { defaultHome, tilde } from '../../home.js';
import { runInteractive } from '../../util/process.js';
import { clackUi } from '../clack-ui.js';
import type { Io } from '../program.js';
import { setupActions } from '../setup-actions.js';
import { engineNames, offerTrust, setUpEngine } from './setup.js';

const homeHelp = 'the install folder (default: $WHEEMS_HOME or ~/wheems)';

/** `wheems engine`: the CLIs agents run in (Claude Code, Codex, opencode). */
export function registerEngine(program: Command, io: Io): void {
  const engine = program
    .command('engine')
    .description(
      'Install engines (Claude Code, Codex, opencode), sign them in and trust the install',
    );

  engine
    .command('list')
    .description(
      'Each engine: installed or not, signed in, and whether it trusts the install folder',
    )
    .option('--json', 'print them as JSON')
    .option('--home <dir>', homeHelp)
    .action(async (options: { json?: boolean; home?: string }) => {
      const home = resolve(options.home ?? defaultHome(io.env));
      const rows = await Promise.all(
        engines(io).map(async ({ entry, setup }) => {
          const version = entry.available ? await setup.version() : null;
          return {
            name: entry.name,
            label: entry.label,
            version,
            signedIn: version !== null ? await setup.signedIn() : null,
            trusted: version !== null && setup.trusted ? await setup.trusted(home) : null,
          };
        }),
      );
      if (options.json === true) {
        io.out(`${JSON.stringify(rows, null, 2)}\n`);
        return;
      }
      io.out(
        `${rows
          .map((r) =>
            r.version === null
              ? `${r.name}  not installed: wheems engine install ${r.name}`
              : `${r.name}  ${r.version}${r.signedIn === true ? ', signed in' : r.signedIn === false ? `, not signed in: wheems engine login ${r.name}` : ''}${r.trusted === true ? ', trusts the install' : r.trusted === false ? `, doesn't trust ${tilde(home, io.env)}: wheems engine trust ${r.name}` : ''}`,
          )
          .join('\n')}\n`,
      );
    });

  engine
    .command('install')
    .description('Install an engine, asking first, then offer to sign it in')
    .argument('<engine>', 'claude-code, codex or opencode')
    .option('--home <dir>', homeHelp)
    .action(async (name: string, options: { home?: string }) => {
      terminal('wheems engine install');
      const home = resolve(options.home ?? defaultHome(io.env));
      const registry = io.registry();
      const ui = clackUi();
      try {
        await setUpEngine(
          { home, env: io.env, ui, registry, actions: setupActions(io, home, registry) },
          name,
        );
      } catch (error) {
        if (error instanceof SetupCancelled) return;
        throw error;
      }
    });

  engine
    .command('login')
    .description('Sign an engine in, with its own sign-in on this terminal')
    .argument('<engine>', 'claude-code, codex or opencode')
    .action(async (name: string) => {
      terminal('wheems engine login');
      const { entry, setup } = find(io, name);
      if (setup.signIn === null) {
        io.out(`${entry.label} has nothing to sign in to.\n`);
        return;
      }
      await runInteractive(setup.signIn[0] ?? '', setup.signIn.slice(1));
      const signedIn = await setup.signedIn();
      io.out(
        signedIn === false
          ? `${entry.label} still isn't signed in.\n`
          : `${entry.label} is signed in.\n`,
      );
    });

  engine
    .command('trust')
    .description(
      'Trust the install folder for an engine: Wheems marks it, or opens the engine to answer its question',
    )
    .argument('<engine>', 'claude-code or codex')
    .option('--home <dir>', homeHelp)
    .action(async (name: string, options: { home?: string }) => {
      terminal('wheems engine trust');
      const home = resolve(options.home ?? defaultHome(io.env));
      const { entry, setup } = find(io, name);
      if (setup.trust === null) {
        io.out(`${entry.label} doesn't ask to trust folders.\n`);
        return;
      }
      if ((await setup.version()) === null) {
        io.out(`${entry.label} isn't installed: wheems engine install ${entry.name}\n`);
        return;
      }
      if ((await setup.trusted?.(home)) === true) {
        io.out(`${entry.label} trusts ${tilde(home, io.env)} already.\n`);
        return;
      }
      const registry = io.registry();
      await offerTrust(
        { home, env: io.env, ui: clackUi(), registry, actions: setupActions(io, home, registry) },
        entry.name,
      );
    });
}

function engines(io: Io): { entry: CatalogEntry; setup: EngineSetup }[] {
  return io
    .registry()
    .catalog('engine')
    .flatMap((entry) => (entry.engine ? [{ entry, setup: entry.engine }] : []));
}

function find(io: Io, name: string): { entry: CatalogEntry; setup: EngineSetup } {
  const found = engines(io).find((e) => e.entry.name === name && e.entry.available);
  if (!found) {
    throw new Error(
      `No engine "${name}". Choose one of: ${engineNames({ registry: io.registry() })}`,
    );
  }
  return found;
}

function terminal(command: string): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`${command} runs on your terminal, so it needs one.`);
  }
}
