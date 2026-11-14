import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { nodeVersionProblem } from '../../util/node-support.js';
import { runInteractive } from '../../util/process.js';
import { defaultHome, paths, tilde, type Paths } from '../../home.js';
import { request, type ServiceReport } from '../../service/control.js';
import {
  installService,
  installedHome,
  plistPath,
  serviceInstalled,
  serviceStatus,
  stopService,
  uninstallService,
  type LaunchdStatus,
} from '../../service/launchd.js';
import { runService } from '../../service/service.js';
import type { Io } from '../program.js';
import { packageVersion } from '../version.js';

/** The script that is running this CLI, resolved through npm links. */
export function cliPath(): string {
  return realpathSync(process.argv[1] ?? '');
}

/**
 * Runs the service under launchd with this Node.js and build, replacing a copy already
 * running, and waits for it to answer.
 */
export async function installAndWait(where: Paths): Promise<boolean> {
  const problem = nodeVersionProblem(process.versions.node);
  if (problem !== null) throw new Error(problem);
  const cli = cliPath();
  if (!cli.endsWith('.js')) {
    throw new Error('Run the service from a build of Wheems (npm run build), not from source.');
  }
  await installService({
    node: process.execPath,
    cli,
    home: where.home,
    logFile: logFile(where),
  });
  // Connecting to every chat app can take a while on a slow network.
  for (let i = 0; i < 60; i++) {
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

function logFile(where: Paths): string {
  return `${where.logs}/service.log`;
}

/** Everything `wheems status` knows, gathered first so formatting it is testable. */
export interface StatusFacts {
  launchd: LaunchdStatus;
  /** Whether launchd has the service's plist, running or stopped. */
  installed: boolean;
  /** Whether the control socket answers. */
  answering: boolean;
  /** What the service says about itself; null from one too old to say. */
  report: ServiceReport | null;
  /** The version a service too old for a report gave when pinged. */
  version?: string;
  logFile: string;
  env: NodeJS.ProcessEnv;
  now?: number;
}

/** `wheems status`: one line per fact, marked ✓, ! or ✗ like the welcome screen. */
export function formatStatus(facts: StatusFacts, color: boolean): { text: string; ok: boolean } {
  const paint = (code: string, text: string) => (color ? `${code}${text}\x1b[0m` : text);
  const mark = { '✓': '\x1b[32m', '!': '\x1b[33m', '✗': '\x1b[31m', '-': '\x1b[2m' } as const;
  const line = (m: keyof typeof mark, text: string) => `${paint(mark[m], m)} ${text}`;
  const lines: string[] = [];
  const { report } = facts;
  if (facts.answering && report) {
    lines.push(
      line(
        '✓',
        `Running: Wheems ${report.version}, pid ${String(report.pid)}, up ${since(report.startedAt, facts.now ?? Date.now())}`,
      ),
    );
    for (const connection of report.connections)
      lines.push(line('✓', `Connected to ${connection}`));
    for (const workspace of report.workspaces) {
      if (workspace.chat === null) lines.push(line('-', `${workspace.id}: no chat channel`));
      else if (workspace.problem !== undefined)
        lines.push(line('!', `${workspace.id}: ${workspace.problem}`));
      else lines.push(line('✓', `${workspace.id}: ${workspace.chat}`));
    }
  } else if (facts.answering) {
    lines.push(
      line(
        '✓',
        `Running: Wheems ${facts.version ?? 'unknown'}. Restart it (wheems restart) to see its channels here.`,
      ),
    );
  } else if (facts.launchd.running) {
    lines.push(
      line(
        '!',
        `Starting, or stuck: launchd runs it (pid ${String(facts.launchd.pid)}), but it isn't answering yet. See wheems logs.`,
      ),
    );
  } else if (facts.launchd.loaded) {
    lines.push(
      line(
        '✗',
        `Not running: it stopped${facts.launchd.lastExit !== null ? ` (last exit ${facts.launchd.lastExit})` : ''}, and launchd tries again every 30 seconds. See why: wheems logs`,
      ),
    );
  } else if (facts.installed) {
    lines.push(line('!', 'Stopped, so nothing answers in chat. Start it with: wheems start'));
  } else {
    lines.push(
      line('!', 'Not running yet, so nothing answers in chat. Start it with: wheems start'),
    );
  }
  lines.push(paint('\x1b[2m', `Log: ${tilde(facts.logFile, facts.env)}`));
  return { text: `${lines.join('\n')}\n`, ok: facts.answering };
}

/** How long ago a time was, roughly: "4m", "2h 14m", "3d 2h". */
export function since(iso: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ${String(minutes % 60)}m`;
  return `${String(Math.floor(hours / 24))}d ${String(hours % 24)}h`;
}

async function statusFacts(where: Paths, env: NodeJS.ProcessEnv): Promise<StatusFacts> {
  const [launchd, installed, answer] = await Promise.all([
    serviceStatus(),
    serviceInstalled(),
    request(where.socket, { op: 'status' }, 2000).catch(() => null),
  ]);
  const facts = { launchd, installed, logFile: logFile(where), env };
  if (answer?.ok === true && answer.status) {
    return { ...facts, answering: true, report: answer.status };
  }
  // A service from before `status` existed still answers ping.
  const ping = await request(where.socket, { op: 'ping' }, 2000).catch(() => null);
  return {
    ...facts,
    answering: ping?.ok === true,
    report: null,
    ...(ping?.ok === true && ping.version !== undefined && { version: ping.version }),
  };
}

async function printStatus(where: Paths, io: Io): Promise<boolean> {
  const { text, ok } = formatStatus(await statusFacts(where, io.env), io.color);
  io.out(text);
  return ok;
}

/** The last lines of the service's log, or null when it has none. */
async function logTail(where: Paths, lines: number): Promise<string | null> {
  const text = await readFile(logFile(where), 'utf8').catch(() => null);
  if (text === null || text.trim() === '') return null;
  return `${text.trimEnd().split('\n').slice(-lines).join('\n')}\n`;
}

/** Starts the service, or restarts it with this build and the latest config. */
async function start(where: Paths, io: Io, restart: boolean): Promise<void> {
  if (!restart && (await serviceAnswers(where))) {
    io.out('Already running.\n');
    await printStatus(where, io);
    return;
  }
  // Checked before the running copy is replaced, so a wrong folder doesn't stop a working one.
  const hasInstall = await readFile(where.install).then(
    () => true,
    () => false,
  );
  if (!hasInstall) {
    throw new Error(
      `No install at ${tilde(where.home, io.env)}: run wheems setup, or give the install folder with --home.`,
    );
  }
  io.out(
    `${restart ? 'Restarting' : 'Starting'} with Node.js ${process.versions.node} and Wheems from ${tilde(cliPath(), io.env)}\n`,
  );
  if (await installAndWait(where)) {
    io.out(
      `${restart ? 'Restarted' : 'Started'}. It runs in the background, and starts again at every login.\n`,
    );
    await printStatus(where, io);
    return;
  }
  const tail = await logTail(where, 15);
  io.out(
    tail !== null
      ? `It hasn't answered yet. The end of its log:\n\n${tail}\nMore with: wheems logs\n`
      : "It hasn't answered yet, and has written no log. To watch it start, run it in this terminal: wheems service run\n",
  );
  process.exitCode = 1;
}

async function stop(io: Io): Promise<void> {
  const launchd = await serviceStatus();
  if (!launchd.loaded && !(await serviceInstalled())) {
    io.out("It isn't set up to run, so there's nothing to stop.\n");
    return;
  }
  await stopService();
  io.out(
    'Stopped. Nothing answers in chat until you start it again, even after you log in again: wheems start\n',
  );
}

async function logs(where: Paths, io: Io, options: { lines: string; follow?: boolean }) {
  const lines = Number(options.lines);
  if (!Number.isInteger(lines) || lines < 1) throw new Error('--lines takes a whole number');
  const file = logFile(where);
  if (options.follow === true) {
    // tail -F waits for the file if it isn't there yet, and keeps up when it's replaced.
    await runInteractive('tail', ['-n', String(lines), '-F', file]);
    return;
  }
  const tail = await logTail(where, lines);
  io.out(tail ?? "No log yet: the service hasn't run. Start it with: wheems start\n");
}

export function registerService(program: Command, io: Io): void {
  const homeOption = '--home <dir>';
  const homeHelp = 'the install folder (default: $WHEEMS_HOME or ~/wheems)';
  const where = (options: { home?: string }) =>
    paths(resolve(options.home ?? defaultHome(io.env)), io.env);
  /**
   * The install the service commands act on: --home, then $WHEEMS_HOME, then the one the
   * service was started for, so restarting it doesn't move it to ~/wheems.
   */
  const serviceWhere = async (options: { home?: string }) => {
    if (options.home !== undefined || (io.env.WHEEMS_HOME ?? '') !== '') return where(options);
    return paths((await installedHome()) ?? defaultHome(io.env), io.env);
  };

  /** Adds the everyday commands to a command: the top level, and `wheems service`. */
  const lifecycle = (parent: Command) => {
    parent
      .command('start')
      .description('Start the service, so your agents answer in chat, now and at every login')
      .option(homeOption, homeHelp)
      .action(async (options: { home?: string }) => {
        await start(await serviceWhere(options), io, false);
      });
    parent
      .command('stop')
      .description('Stop the service; it stays stopped until wheems start')
      .action(() => stop(io));
    parent
      .command('restart')
      .description('Restart the service, after changing config or updating Wheems')
      .option(homeOption, homeHelp)
      .action(async (options: { home?: string }) => {
        await start(await serviceWhere(options), io, true);
      });
    parent
      .command('status')
      .description('Show whether the service is running, and where each workspace chats')
      .option(homeOption, homeHelp)
      .action(async (options: { home?: string }) => {
        if (!(await printStatus(await serviceWhere(options), io))) process.exitCode = 1;
      });
    parent
      .command('logs')
      .description("Print the end of the service's log")
      .option(homeOption, homeHelp)
      .option('-n, --lines <n>', 'how many lines', '50')
      .option('-f, --follow', 'keep printing new lines as they come, until Ctrl+C')
      .action(async (options: { home?: string; lines: string; follow?: boolean }) => {
        await logs(await serviceWhere(options), io, options);
      });
  };

  lifecycle(program);

  const service = program
    .command('service')
    .description('The always-running service that connects chat to agents');
  lifecycle(service);

  service
    .command('run')
    .description('Run the service in this terminal, as launchd does')
    .option(homeOption, homeHelp)
    .action(async (options: { home?: string }) => {
      const running = await runService({
        home: where(options).home,
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

  // An old name for wheems start, kept for a release.
  service
    .command('install', { hidden: true })
    .description('The same as wheems start')
    .option(homeOption, homeHelp)
    .action(async (options: { home?: string }) => {
      await start(await serviceWhere(options), io, false);
    });

  service
    .command('uninstall')
    .description('Stop the service and remove it from launchd')
    .action(async () => {
      await uninstallService();
      io.out(`The service is stopped, and ${tilde(plistPath(), io.env)} is removed.\n`);
    });
}
