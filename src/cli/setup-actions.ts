import type { DriverRegistry } from '../contracts/registry.js';
import type { SetupActions } from './commands/setup.js';
import { installAndWait, serviceAnswers } from './commands/service.js';
import { runDoctor } from '../doctor/doctor.js';
import { paths } from '../home.js';
import { request } from '../service/control.js';
import { runCommand, runInteractive } from '../util/process.js';
import { formatReport, type Io } from './program.js';

/**
 * What setup, and the area commands built from its steps (`wheems channel connect`,
 * `wheems engine install`), do outside the install folder.
 */
export function setupActions(io: Io, home: string, registry: DriverRegistry): SetupActions {
  const where = paths(home, io.env);
  return {
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
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    copy: async (text) =>
      process.platform === 'darwin' && (await runCommand('pbcopy', [], { input: text })).code === 0,
    openUrl: async (url) =>
      (await runCommand(process.platform === 'darwin' ? 'open' : 'xdg-open', [url])).code === 0,
    doctor: async () => {
      const report = await runDoctor({ home, registry, env: io.env, quick: true });
      return { ok: report.ok, report: formatReport(report, true) };
    },
  };
}
