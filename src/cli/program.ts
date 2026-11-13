import { resolve } from 'node:path';
import { text as readStream } from 'node:stream/consumers';
import { styleText } from 'node:util';
import { Command, CommanderError } from 'commander';
import { crossCheck } from '../config/check.js';
import { loadInstall, validateFile, type Problem } from '../config/load.js';
import type { HealthCheck } from '../contracts/driver.js';
import type { DriverRegistry } from '../contracts/registry.js';
import { createDriverRegistry } from '../drivers/index.js';
import { slackManifest } from '../drivers/channel/slack/setup.js';
import { defaultHome, runDoctor, type DoctorReport } from '../doctor/doctor.js';
import { stat } from 'node:fs/promises';
import { initWorkspace } from './commands/init.js';
import { registerKb } from './commands/kb.js';
import { registerNote } from './commands/note.js';
import { registerReply } from './commands/reply.js';
import { registerService } from './commands/service.js';
import { setup } from './commands/setup.js';
import { clackUi } from './clack-ui.js';
import { installAndWait, serviceAnswers } from './commands/service.js';
import { runCommand, runInteractive } from '../util/process.js';
import { SetupCancelled } from '../contracts/setup.js';
import { paths } from '../home.js';
import { packageVersion } from './version.js';

export { packageVersion };

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  env: NodeJS.ProcessEnv;
  color: boolean;
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
    .action(async (options: { home?: string; quick?: boolean; json?: boolean }) => {
      const report = await runDoctor({
        home: resolve(options.home ?? defaultHome(io.env)),
        registry: io.registry(),
        quick: options.quick === true,
        env: io.env,
      });
      if (options.json === true) io.out(`${JSON.stringify(report, null, 2)}\n`);
      else io.out(formatReport(report, io.color));
      if (!report.ok) process.exitCode = 1;
    });

  program
    .command('validate')
    .description(
      'Validate config files, or a whole install folder with the links between its files',
    )
    .argument('[paths...]', 'files or install folders (default: the install folder)')
    .option('--home <dir>', 'the install folder (default: $WHEEMS_HOME or ~/wheems)')
    .action(async (paths: string[], options: { home?: string }) => {
      const targets = paths.length > 0 ? paths : [options.home ?? defaultHome(io.env)];
      const problems: Problem[] = [];
      for (const target of targets) {
        const path = resolve(target);
        if ((await stat(path)).isDirectory()) {
          const install = await loadInstall(path);
          problems.push(...install.problems, ...crossCheck(install));
        } else {
          problems.push(...(await validateFile(path)).problems);
        }
      }
      for (const problem of problems) io.out(`${formatProblem(problem, io.color)}\n`);
      const errors = problems.filter((p) => p.level === 'error').length;
      const warnings = problems.length - errors;
      io.out(
        errors > 0
          ? `${paint('red', `${errors} ${errors === 1 ? 'error' : 'errors'}`, io.color)}${warnings > 0 ? `, ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}` : ''}\n`
          : `${paint('green', 'Valid', io.color)}${warnings > 0 ? `, with ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}` : ''}\n`,
      );
      if (errors > 0) process.exitCode = 1;
    });

  program
    .command('setup')
    .description('Set up Wheems: connect channels, create workspaces, run the service')
    .option('--home <dir>', 'the install folder (default: $WHEEMS_HOME or ~/wheems)')
    .action(async (options: { home?: string }) => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error('wheems setup asks questions, so it needs a terminal.');
      }
      const home = resolve(options.home ?? defaultHome(io.env));
      const where = paths(home, io.env);
      const registry = io.registry();
      const ui = clackUi();
      ui.intro(' Wheems setup ');
      try {
        await setup({
          home,
          env: io.env,
          ui,
          registry,
          actions: {
            run: (command, cwd) =>
              runInteractive(command[0] ?? '', command.slice(1), {
                ...(cwd !== undefined && { cwd }),
              }),
            installService: () => installAndWait(where),
            serviceRunning: () => serviceAnswers(where),
            copy: async (text) =>
              process.platform === 'darwin' &&
              (await runCommand('pbcopy', [], { input: text })).code === 0,
            openUrl: async (url) =>
              (await runCommand(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]))
                .code === 0,
            doctor: async () => {
              const report = await runDoctor({ home, registry, env: io.env, quick: true });
              return { ok: report.ok, report: formatReport(report, true) };
            },
          },
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

  program
    .command('init')
    .description('Create a workspace with its chief of staff')
    .argument('<workspace>', 'the workspace id, such as personal')
    .option('--name <name>', 'its display name (default: from the id)')
    .option('--channel <channel>', "chat in this channel instead of the bot's direct messages")
    .option(
      '--engine <engine>',
      'what the chief of staff runs in: claude-code, codex or opencode',
      'claude-code',
    )
    .option('--model <model>', "the engine's model (default: the engine's usual one)")
    .option('--home <dir>', 'the install folder (default: $WHEEMS_HOME or ~/wheems)')
    .action(
      async (
        id: string,
        options: { name?: string; channel?: string; engine: string; model?: string; home?: string },
      ) => {
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
        const dir = await initWorkspace({
          home: resolve(options.home ?? defaultHome(io.env)),
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
        const trust = setup.trust;
        io.out(
          [
            `Created ${dir}, with its chief of staff on ${entry.label}`,
            '',
            ...(trust !== null
              ? [
                  `${entry.label} asks once whether to trust a new folder, and nobody can answer it from Slack.`,
                  'Answer it now: run the two lines below, say yes, then quit it.',
                  '',
                  `  cd ${shellPath(dir)}`,
                  `  ${trust.join(' ')}`,
                  '',
                ]
              : []),
            options.channel !== undefined
              ? `Then invite the bot to #${options.channel.replace(/^#/, '')} and restart the service: wheems service restart`
              : 'Then message the bot in Slack. If the service is already running, restart it first: wheems service restart',
            '',
          ].join('\n'),
        );
      },
    );

  program
    .command('slack')
    .description('Slack helpers')
    .command('manifest')
    .description('Print the Slack app manifest to create the app from')
    .action(() => {
      io.out(slackManifest());
    });

  registerService(program, io);
  registerReply(program, io);
  registerNote(program, io);
  registerKb(program, io);

  return program;
}

function shellPath(path: string): string {
  return /^[\w./-]+$/.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`;
}

/** Runs the CLI and returns the exit code. */
export async function run(argv: string[], io: Io): Promise<number> {
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

function formatProblem(problem: Problem, color: boolean): string {
  const where = problem.line !== undefined ? `${problem.file}:${problem.line}` : problem.file;
  const level =
    problem.level === 'error' ? paint('red', 'error', color) : paint('yellow', 'warning', color);
  return `${where}: ${level} ${problem.message}`;
}

function paint(format: Parameters<typeof styleText>[0], text: string, color: boolean): string {
  return color ? styleText(format, text) : text;
}
