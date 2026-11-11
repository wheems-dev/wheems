import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { NODE_MINIMUM_VERSION } from '../../doctor/doctor.js';
import { defaultHome, paths, type Paths } from '../../home.js';
import { request } from '../../service/control.js';
import {
  installService,
  plistPath,
  restartService,
  serviceStatus,
  uninstallService,
} from '../../service/launchd.js';
import { runService } from '../../service/service.js';
import { isAtLeast } from '../../util/version.js';
import type { Io } from '../program.js';
import { packageVersion } from '../version.js';

/** The script that is running this CLI, resolved through npm links. */
export function cliPath(): string {
  return realpathSync(process.argv[1] ?? '');
}

/** Installs the service under launchd with this Node.js and build, and waits for it to answer. */
export async function installAndWait(where: Paths): Promise<boolean> {
  if (!isAtLeast(process.versions.node, NODE_MINIMUM_VERSION)) {
    throw new Error(
      `The service needs Node.js ${NODE_MINIMUM_VERSION} or later, and this is ${process.versions.node}.`,
    );
  }
  const cli = cliPath();
  if (!cli.endsWith('.js')) {
    throw new Error('Install the service from a build of Opinr (npm run build), not from source.');
  }
  await installService({
    node: process.execPath,
    cli,
    home: where.home,
    logFile: `${where.logs}/service.log`,
  });
  for (let i = 0; i < 20; i++) {
    if (await serviceAnswers(where)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Whether the service answers on its control socket. */
export async function serviceAnswers(where: Paths): Promise<boolean> {
  return request(where.socket, { op: 'ping' }, 2000).then(
    (answer) => answer.ok,
    () => false,
  );
}

export function registerService(program: Command, io: Io): void {
  const service = program
    .command('service')
    .description('The always-running service that connects chat to agents');
  const homeOption = '--home <dir>';
  const homeHelp = 'the install folder (default: $OPINR_HOME or ~/opinr)';
  const home = (options: { home?: string }) => resolve(options.home ?? defaultHome(io.env));

  service
    .command('run')
    .description('Run the service in the foreground (launchd runs this)')
    .option(homeOption, homeHelp)
    .action(async (options: { home?: string }) => {
      const running = await runService({
        home: home(options),
        registry: io.registry(),
        node: process.execPath,
        cli: cliPath(),
        version: packageVersion(),
        env: io.env,
      });
      await new Promise<void>((done) => {
        process.once('SIGTERM', done);
        process.once('SIGINT', done);
      });
      await running.stop();
    });

  service
    .command('install')
    .description('Run the service under launchd, now and at every login')
    .option(homeOption, homeHelp)
    .action(async (options: { home?: string }) => {
      const where = paths(home(options), io.env);
      io.out(`Installing ${plistPath()}\nNode.js: ${process.execPath}\nOpinr: ${cliPath()}\n`);
      if (await installAndWait(where)) {
        io.out('The service is running.\n');
        return;
      }
      io.out(`The service has not answered yet. Check its log: opinr service logs\n`);
      process.exitCode = 1;
    });

  service
    .command('uninstall')
    .description('Stop the service and remove it from launchd')
    .action(async () => {
      await uninstallService();
      io.out('The service is stopped and removed.\n');
    });

  service
    .command('restart')
    .description('Restart the service, for example after changing config')
    .action(async () => {
      await restartService();
      io.out('Restarted.\n');
    });

  service
    .command('status')
    .description('Show whether the service is running')
    .option(homeOption, homeHelp)
    .action(async (options: { home?: string }) => {
      const launchd = await serviceStatus();
      const where = paths(home(options), io.env);
      const answering = await request(where.socket, { op: 'ping' }, 2000).then(
        (answer) => answer.ok,
        () => false,
      );
      io.out(
        [
          `launchd: ${launchd.loaded ? (launchd.running ? `running (pid ${String(launchd.pid)})` : `loaded, not running (last exit ${launchd.lastExit ?? 'unknown'})`) : 'not installed'}`,
          `control socket: ${answering ? 'answering' : 'not answering'}`,
        ].join('\n') + '\n',
      );
      if (!answering) process.exitCode = 1;
    });

  service
    .command('logs')
    .description("Print the end of the service's log")
    .option(homeOption, homeHelp)
    .option('-n, --lines <n>', 'how many lines', '50')
    .action(async (options: { home?: string; lines: string }) => {
      const file = `${paths(home(options), io.env).logs}/service.log`;
      const text = await readFile(file, 'utf8').catch(() => '');
      io.out(
        text
          .split('\n')
          .slice(-Number(options.lines) - 1)
          .join('\n'),
      );
    });
}
