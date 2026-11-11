import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { styleText } from 'node:util';
import { Command, CommanderError } from 'commander';
import { crossCheck } from '../config/check.js';
import { loadInstall, validateFile, type Problem } from '../config/load.js';
import type { HealthCheck } from '../contracts/driver.js';
import { createDriverRegistry } from '../drivers/index.js';
import { defaultHome, runDoctor, type DoctorReport } from '../doctor/doctor.js';
import { stat } from 'node:fs/promises';

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  env: NodeJS.ProcessEnv;
  color: boolean;
}

export function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

/** Builds the `opinr` command. Milestone 0 has doctor and validate; later milestones add the rest. */
export function createProgram(io: Io): Command {
  const program = new Command('opinr')
    .description('An opinionated framework for running teams of AI agents, on Herdr core')
    .version(packageVersion(), '-v, --version')
    .configureOutput({ writeOut: io.out, writeErr: io.err })
    .exitOverride()
    .showHelpAfterError();

  program
    .command('doctor')
    .description('Check that this machine, Herdr core and the install are healthy')
    .option('--home <dir>', 'the install folder (default: $OPINR_HOME or ~/opinr)')
    .option('--quick', 'skip starting a test session in Herdr core')
    .option('--json', 'print the report as JSON')
    .action(async (options: { home?: string; quick?: boolean; json?: boolean }) => {
      const report = await runDoctor({
        home: resolve(options.home ?? defaultHome(io.env)),
        registry: createDriverRegistry(),
        quick: options.quick === true,
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
    .option('--home <dir>', 'the install folder (default: $OPINR_HOME or ~/opinr)')
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

  return program;
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
