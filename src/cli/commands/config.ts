import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { crossCheck } from '../../config/check.js';
import { loadInstall, validateFile, type Problem } from '../../config/load.js';
import { defaultHome } from '../../home.js';
import { formatProblem, paint, type Io } from '../program.js';

/**
 * `wheems configuration`: the install's YAML and Markdown config. `config`, its old name, still
 * works hidden, and says what it's called now.
 */
export function registerConfiguration(program: Command, io: Io): void {
  addActions(program.command('configuration').description("Check the install's config files"), io);
  addActions(
    program.command('config', { hidden: true }).hook('preAction', () => {
      io.err('wheems config is now wheems configuration.\n');
    }),
    io,
  );
}

function addActions(config: Command, io: Io): void {
  config
    .command('validate')
    .description(
      'Validate config files, or a whole install folder with the links between its files',
    )
    .argument('[paths...]', 'files or install folders (default: the install folder)')
    .option('--home <dir>', 'the install folder (default: $WHEEMS_HOME or ~/wheems)')
    .action(async (targets: string[], options: { home?: string }) => {
      await validate(io, targets, options);
    });
}

/** Validates config files or install folders, printing each problem; exit code 1 on errors. */
export async function validate(io: Io, paths: string[], options: { home?: string }): Promise<void> {
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
}
