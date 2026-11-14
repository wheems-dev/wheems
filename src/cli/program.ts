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
import { offerFixes } from '../doctor/fix.js';
import { stat } from 'node:fs/promises';
import { initWorkspace } from './commands/init.js';
import { registerKb } from './commands/kb.js';
import { registerReview } from './commands/review.js';
import { registerSkill } from './commands/skill.js';
import { registerNote } from './commands/note.js';
import { registerReply } from './commands/reply.js';
import { registerService } from './commands/service.js';
import { registerSession } from './commands/session.js';
import { ensureInstall, setup } from './commands/setup.js';
import { clackUi } from './clack-ui.js';
import {
  canWink,
  renderWelcomeHead,
  renderWelcomeTail,
  SHOW_CURSOR,
  showCloud,
  welcomeStatus,
  wink,
} from './welcome.js';
import { installAndWait, serviceAnswers } from './commands/service.js';
import { runCommand, runInteractive } from '../util/process.js';
import { request } from '../service/control.js';
import { SetupCancelled } from '../contracts/setup.js';
import { paths, tilde } from '../home.js';
import { shellPath } from '../util/trust.js';
import { packageVersion } from './version.js';

export { packageVersion };

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  env: NodeJS.ProcessEnv;
  color: boolean;
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
    .description('Set up Wheems: engines, chat channels, workspaces, search and the service')
    .option('--home <dir>', 'the install folder (default: $WHEEMS_HOME or ~/wheems)')
    .action(async (options: { home?: string }) => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error('wheems setup asks questions, so it needs a terminal.');
      }
      const home = resolve(options.home ?? defaultHome(io.env));
      const where = paths(home, io.env);
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
          actions: {
            run: (command, cwd) =>
              runInteractive(command[0] ?? '', command.slice(1), {
                ...(cwd !== undefined && { cwd }),
              }),
            installService: () => installAndWait(where),
            serviceRunning: () => serviceAnswers(where),
            greet: async () => {
              try {
                const answer = await request(where.socket, { op: 'greet', once: true });
                return answer.ok
                  ? {
                      ok: true,
                      message: answer.message ?? '',
                      ...(answer.skipped === true && { skipped: true }),
                    }
                  : { ok: false, message: answer.error };
              } catch (error) {
                return {
                  ok: false,
                  message: error instanceof Error ? error.message : String(error),
                };
              }
            },
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
    .description('Create a workspace with its chief of staff (and the install, if there is none)')
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
        const home = resolve(options.home ?? defaultHome(io.env));
        // On a fresh machine, init makes the install too, so setup can be scripted.
        const createdInstall = await ensureInstall(paths(home, io.env));
        if (createdInstall) io.out(`Created the install at ${home} (a git folder)\n`);
        const dir = await initWorkspace({
          home,
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
        // A trusted install folder covers every workspace in it; ask only when it isn't.
        const trust =
          setup.trust !== null && (await setup.trusted?.(home)) !== true ? setup.trust : null;
        io.out(
          [
            `Created ${dir}, with its chief of staff on ${entry.label}`,
            '',
            ...(trust !== null
              ? [
                  `${entry.label} asks once whether to trust a folder, and nobody can answer it from Slack.`,
                  'Answer it now for your install folder, which covers every workspace in it: run the two lines below, say yes, then quit it.',
                  '',
                  `  cd ${shellPath(tilde(home, io.env))}`,
                  `  ${trust.join(' ')}`,
                  '',
                ]
              : []),
            options.channel !== undefined
              ? `Then invite the bot to #${options.channel.replace(/^#/, '')} and restart the service: wheems restart`
              : 'Then message the bot in Slack. If the service is already running, restart it first: wheems restart',
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
  registerSession(program, io);
  registerKb(program, io);
  registerSkill(program, io);
  registerReview(program, io);

  return program;
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

function formatProblem(problem: Problem, color: boolean): string {
  const where = problem.line !== undefined ? `${problem.file}:${problem.line}` : problem.file;
  const level =
    problem.level === 'error' ? paint('red', 'error', color) : paint('yellow', 'warning', color);
  return `${where}: ${level} ${problem.message}`;
}

function paint(format: Parameters<typeof styleText>[0], text: string, color: boolean): string {
  return color ? styleText(format, text) : text;
}
