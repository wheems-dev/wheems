import { resolve } from 'node:path';
import { text as readStream } from 'node:stream/consumers';
import { styleText } from 'node:util';
import { Command, CommanderError } from 'commander';
import type { Problem } from '../config/load.js';
import type { HealthCheck } from '../contracts/driver.js';
import type { DriverRegistry } from '../contracts/registry.js';
import { createDriverRegistry } from '../drivers/index.js';
import { defaultHome, runDoctor, type DoctorReport } from '../doctor/doctor.js';
import { offerFixes } from '../doctor/fix.js';
import { registerKb } from './commands/kb.js';
import { registerReview } from './commands/review.js';
import { registerSkill } from './commands/skill.js';
import { registerNote } from './commands/note.js';
import { registerChat, registerReply } from './commands/reply.js';
import { registerService } from './commands/service.js';
import { registerSession } from './commands/session.js';
import { setup } from './commands/setup.js';
import { clackUi } from './clack-ui.js';
import { setupActions } from './setup-actions.js';
import { channelManifest, registerChannel } from './commands/channel.js';
import { registerConfig, validate } from './commands/config.js';
import { registerEngine } from './commands/engine.js';
import {
  createWorkspace,
  registerWorkspace,
  withCreateOptions,
  type CreateOptions,
} from './commands/workspace.js';
import {
  canWink,
  renderWelcomeHead,
  renderWelcomeTail,
  SHOW_CURSOR,
  showCloud,
  welcomeStatus,
  wink,
} from './welcome.js';
import { installAndWait } from './commands/service.js';
import { runInteractive } from '../util/process.js';
import { request } from '../service/control.js';
import { SetupCancelled } from '../contracts/setup.js';
import { paths } from '../home.js';
import { packageVersion } from './version.js';

export { packageVersion };

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  env: NodeJS.ProcessEnv;
  color: boolean;
  /** The folder the command runs in; process.cwd() unless a test says otherwise. */
  cwd?: () => string;
  /** The terminal's width, or undefined when the output isn't a terminal. */
  columns?: number | undefined;
  registry: () => DriverRegistry;
  stdin: () => Promise<string>;
}

/** The parts of Io that tests rarely need to replace. */
export function defaultIo(): Pick<Io, 'registry' | 'stdin'> {
  return {
    registry: createDriverRegistry,
    stdin: () => readStream(process.stdin),
  };
}

/** Builds the `wheems` command. */
export function createProgram(io: Io): Command {
  const program = new Command('wheems')
    .description('An opinionated framework for running teams of AI agents, on Herdr core')
    .version(packageVersion(), '-v, --version')
    .configureOutput({ writeOut: io.out, writeErr: io.err })
    .exitOverride()
    .showHelpAfterError();

  program
    .command('doctor')
    .description('Check that this machine, Herdr core and the install are healthy')
    .option('--home <dir>', 'the install folder (default: $WHEEMS_HOME or ~/wheems)')
    .option('--quick', 'skip starting a test session in Herdr core')
    .option('--json', 'print the report as JSON')
    .option(
      '--fix',
      'offer to fix what it safely can, asking before each fix (never the chat app or its tokens)',
    )
    .action(async (options: { home?: string; quick?: boolean; json?: boolean; fix?: boolean }) => {
      const home = resolve(options.home ?? defaultHome(io.env));
      const fixing = options.fix === true;
      if (fixing && (options.json === true || !process.stdin.isTTY || !process.stdout.isTTY)) {
        throw new Error('wheems doctor --fix asks before each fix, so it needs a terminal.');
      }
      const where = paths(home, io.env);
      const doctor = () =>
        runDoctor({
          home,
          registry: io.registry(),
          quick: options.quick === true,
          env: io.env,
          ...(fixing && {
            fixes: {
              startService: () => installAndWait(where),
              run: (command: string[], cwd: string) =>
                runInteractive(command[0] ?? '', command.slice(1), { cwd }),
              reindex: async (workspace: string) => {
                const answer = await request(
                  where.socket,
                  { op: 'reindex', workspace },
                  60 * 60_000,
                );
                if (!answer.ok) throw new Error(answer.error);
              },
            },
          }),
        });
      const report = await doctor();
      if (options.json === true) io.out(`${JSON.stringify(report, null, 2)}\n`);
      else io.out(formatReport(report, io.color));
      if (!fixing) {
        if (!report.ok) process.exitCode = 1;
        return;
      }
      const ui = clackUi();
      const { fixed } = await offerFixes(report, {
        ask: (question) => ui.confirm(question, false).catch(() => false),
        out: io.out,
      });
      if (fixed === 0) {
        if (!report.ok) process.exitCode = 1;
        return;
      }
      io.out('\nChecking again.\n\n');
      const after = await runDoctor({ home, registry: io.registry(), quick: true, env: io.env });
      io.out(formatReport(after, io.color));
      if (!after.ok) process.exitCode = 1;
    });

  program
    .command('setup')
    .description('Set up Wheems: engines, chat channels, workspaces, search and the service')
    .option('--home <dir>', 'the install folder (default: $WHEEMS_HOME or ~/wheems)')
    .action(async (options: { home?: string }) => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error('wheems setup asks questions, so it needs a terminal.');
      }
      const home = resolve(options.home ?? defaultHome(io.env));
      const registry = io.registry();
      const ui = clackUi();
      io.out(
        renderWelcomeHead({
          version: packageVersion(),
          color: io.color,
          cloud: showCloud(io.columns),
        }),
      );
      if (canWink(io.columns, io.env)) await winkOnce(io);
      ui.intro(' Wheems setup ');
      try {
        await setup({
          home,
          env: io.env,
          ui,
          registry,
          actions: setupActions(io, home, registry),
        });
        ui.outro('All set. Run wheems setup again any time to change things.');
      } catch (error) {
        if (error instanceof SetupCancelled) {
          ui.cancel('Setup stopped. Everything you finished is saved.');
          return;
        }
        throw error;
      }
    });

  // Old names, kept for a release: each says what it's called now (see docs/cli.md).
  program
    .command('validate', { hidden: true })
    .argument('[paths...]')
    .option('--home <dir>')
    .action(async (targets: string[], options: { home?: string }) => {
      io.err('wheems validate is now wheems config validate.\n');
      await validate(io, targets, options);
    });
  program
    .command('slack', { hidden: true })
    .command('manifest')
    .action(() => {
      io.err('wheems slack manifest is now wheems channel manifest slack.\n');
      io.out(channelManifest(io, 'slack'));
    });
  withCreateOptions(
    program.command('init', { hidden: true }).argument('<workspace>', 'the workspace id'),
  ).action(async (id: string, options: CreateOptions) => {
    io.err('wheems init is now wheems workspace create.\n');
    await createWorkspace(io, id, options);
  });

  registerService(program, io);
  registerReply(program, io);
  registerNote(program, io);
  registerWorkspace(program, io);
  registerChat(program, io);
  registerSession(program, io);
  registerKb(program, io);
  registerSkill(program, io);
  registerChannel(program, io);
  registerEngine(program, io);
  registerConfig(program, io);
  registerReview(program, io);

  program
    .command('list')
    .description('Every command, grouped by area, as php artisan list does')
    .action(() => {
      io.out(listCommands(program, io.color));
    });

  for (const command of program.commands) {
    const group = COMMAND_GROUPS[command.name()];
    if (group !== undefined) command.helpGroup(group);
  }
  return program;
}

/**
 * The top-level commands and where `--help` and `wheems list` show them. Everything else is an
 * area: `wheems <area> <action>` (docs/cli.md). A test keeps new top-level commands out of here
 * unless they're added on purpose.
 */
export const COMMAND_GROUPS: Record<string, string> = {
  setup: 'Start here:',
  doctor: 'Start here:',
  list: 'Start here:',
  status: 'Every day (shortcuts for wheems service …):',
  start: 'Every day (shortcuts for wheems service …):',
  stop: 'Every day (shortcuts for wheems service …):',
  restart: 'Every day (shortcuts for wheems service …):',
  logs: 'Every day (shortcuts for wheems service …):',
  review: 'Every day (shortcuts for wheems service …):',
  workspace: 'Areas: wheems <area> <action>',
  chat: 'Areas: wheems <area> <action>',
  session: 'Areas: wheems <area> <action>',
  kb: 'Areas: wheems <area> <action>',
  skill: 'Areas: wheems <area> <action>',
  channel: 'Areas: wheems <area> <action>',
  engine: 'Areas: wheems <area> <action>',
  service: 'Areas: wheems <area> <action>',
  config: 'Areas: wheems <area> <action>',
};

/** `wheems list`: every visible command, top-level ones by group, then each area's actions. */
export function listCommands(program: Command, color: boolean): string {
  const help = program.createHelp();
  const lines: string[] = [];
  const top = help.visibleCommands(program).filter((c) => c.name() !== 'help');
  const width = 24;
  for (const group of [...new Set(Object.values(COMMAND_GROUPS))]) {
    const order = Object.keys(COMMAND_GROUPS);
    const members = top
      .filter((c) => COMMAND_GROUPS[c.name()] === group)
      .sort((a, b) => order.indexOf(a.name()) - order.indexOf(b.name()));
    if (members.length === 0) continue;
    lines.push(paint('yellow', group.replace(/:$/, ''), color));
    for (const command of members) {
      const actions = help.visibleCommands(command).filter((c) => c.name() !== 'help');
      const alias = command.aliases()[0];
      const name = alias !== undefined ? `${command.name()} (${alias})` : command.name();
      if (actions.length === 0) {
        lines.push(`  ${paint('green', name.padEnd(width), color)}${command.description()}`);
        continue;
      }
      lines.push(`  ${paint('green', name, color)}`);
      for (const action of actions) {
        lines.push(
          `    ${paint('green', `${command.name()} ${action.name()}`.padEnd(width - 2), color)}${action.description()}`,
        );
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * The cloud winks once. Ctrl+C meanwhile still gives the terminal its cursor back before
 * stopping, as it would have done without the wink.
 */
async function winkOnce(io: Io): Promise<void> {
  const interrupted = () => {
    io.out(SHOW_CURSOR);
    process.exit(130);
  };
  process.once('SIGINT', interrupted);
  try {
    await wink({ version: packageVersion(), color: io.color, write: io.out });
  } finally {
    process.off('SIGINT', interrupted);
  }
}

/** Runs the CLI and returns the exit code. With no command, it shows the welcome screen. */
export async function run(argv: string[], io: Io): Promise<number> {
  if (argv.length === 0) {
    const home = resolve(defaultHome(io.env));
    // The welcome never fails: a problem reading the install becomes one of its lines.
    // The status is read while the cloud is drawn and winks.
    const reading = welcomeStatus(home, io.env).catch((error: unknown) => [
      {
        mark: '!' as const,
        text: `Couldn't read the install at ${home}: ${error instanceof Error ? error.message : String(error)}. Run wheems doctor.`,
      },
    ]);
    io.out(
      renderWelcomeHead({
        version: packageVersion(),
        color: io.color,
        cloud: showCloud(io.columns),
      }),
    );
    if (canWink(io.columns, io.env)) await winkOnce(io);
    io.out(renderWelcomeTail({ status: await reading, color: io.color }));
    return 0;
  }
  const program = createProgram(io);
  try {
    await program.parseAsync(argv, { from: 'user' });
    return typeof process.exitCode === 'number' ? process.exitCode : 0;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    io.err(
      `${paint('red', 'Error:', io.color)} ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

const SYMBOLS: Record<
  HealthCheck['status'],
  { mark: string; color: 'green' | 'yellow' | 'red' | 'gray' }
> = {
  pass: { mark: '✓', color: 'green' },
  warn: { mark: '!', color: 'yellow' },
  fail: { mark: '✗', color: 'red' },
  skip: { mark: '-', color: 'gray' },
};

export function formatReport(report: DoctorReport, color: boolean): string {
  const lines: string[] = [];
  for (const section of report.sections) {
    lines.push(paint('bold', section.title, color));
    for (const check of section.checks) {
      const { mark, color: c } = SYMBOLS[check.status];
      lines.push(`  ${paint(c, mark, color)} ${check.name}: ${check.message}`);
      if (check.hint !== undefined && check.status !== 'pass')
        lines.push(`      ${paint('gray', check.hint, color)}`);
    }
    lines.push('');
  }
  const failed = report.sections.flatMap((s) => s.checks).filter((c) => c.status === 'fail').length;
  lines.push(
    report.ok
      ? paint('green', 'Doctor passed.', color)
      : paint(
          'red',
          `Doctor failed: ${failed} ${failed === 1 ? 'check' : 'checks'} failed.`,
          color,
        ),
  );
  return `${lines.join('\n')}\n`;
}

export function formatProblem(problem: Problem, color: boolean): string {
  const where = problem.line !== undefined ? `${problem.file}:${problem.line}` : problem.file;
  const level =
    problem.level === 'error' ? paint('red', 'error', color) : paint('yellow', 'warning', color);
  return `${where}: ${level} ${problem.message}`;
}

export function paint(
  format: Parameters<typeof styleText>[0],
  text: string,
  color: boolean,
): string {
  return color ? styleText(format, text) : text;
}
