import { resolve } from 'node:path';
import type { Command } from 'commander';
import { defaultHome } from '../../home.js';
import { runCommand } from '../../util/process.js';
import { startWeb, webPort, webToken, webUrl } from '../../web/server.js';
import type { Io } from '../program.js';

const homeHelp = 'the install folder (default: $WHEEMS_HOME or ~/wheems)';
const portHelp = 'the port on 127.0.0.1 (default: $WHEEMS_WEB_PORT or 4317)';

/**
 * `wheems web`: the web app. The service serves it whenever it runs (`wheems start`); `run`
 * serves it on its own in this terminal, and `open` opens it in the browser.
 */
export function registerWeb(program: Command, io: Io): void {
  const web = program
    .command('web')
    .description('The web app: setup and health, sessions and more, in your browser');

  web
    .command('open')
    .description('Open the web app in your browser')
    .option('--port <port>', portHelp)
    .option('--home <dir>', homeHelp)
    .action(async (options: { port?: string; home?: string }) => {
      const home = resolve(options.home ?? defaultHome(io.env));
      const port = webPort(io.env, parsePort(options.port));
      if (!(await answers(port))) {
        throw new Error(
          `The web app isn't running on port ${String(port)}. Start Wheems with wheems start, which serves it, or serve it on its own with wheems web run.`,
        );
      }
      const url = webUrl(port, await webToken(home, io.env));
      const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
      const opened = (await runCommand(opener, [url])).code === 0;
      io.out(opened ? `Opened the web app.\n` : `Open this in your browser:\n${url}\n`);
    });

  web
    .command('run')
    .description('Serve the web app on its own in this terminal, until Ctrl+C')
    .option('--port <port>', portHelp)
    .option('--home <dir>', homeHelp)
    .action(async (options: { port?: string; home?: string }) => {
      const home = resolve(options.home ?? defaultHome(io.env));
      const port = webPort(io.env, parsePort(options.port));
      const running = await startWeb({
        home,
        env: io.env,
        registry: io.registry(),
        port,
        log: (message) => {
          io.err(`${message}\n`);
        },
      }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
          throw new Error(
            `Port ${String(port)} is in use. If Wheems is running, it serves the web app already: open it with wheems web open. Or choose another port with --port.`,
          );
        }
        throw error;
      });
      io.out(
        `Serving the web app at ${running.url}. Open it with:\n${webUrl(port, await webToken(home, io.env))}\nPress Ctrl+C to stop.\n`,
      );
      await new Promise<void>((done) => {
        process.once('SIGTERM', done);
        process.once('SIGINT', done);
      });
      await running.close();
    });
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== value.trim()) {
    throw new Error('--port takes a number from 1 to 65535');
  }
  return port;
}

/** Whether a Wheems web app answers on the port. */
async function answers(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok && ((await response.json()) as { wheems?: boolean }).wheems === true;
  } catch {
    return false;
  }
}
