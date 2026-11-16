import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { DriverRegistry } from '../contracts/registry.js';
import { paths } from '../home.js';
import { CSS, SCRIPT } from './assets.js';
import {
  doctorReport,
  installSummary,
  sessionMessages,
  workspacePage,
  type WebContext,
} from './data.js';
import { esc, messagePage, overviewPage, sessionsPage, setupPage } from './pages.js';

/** The web app's port unless `--port` or `WHEEMS_WEB_PORT` says otherwise. */
export const DEFAULT_WEB_PORT = 4317;

const COOKIE = 'wheems_web';

export interface WebOptions {
  home: string;
  env: NodeJS.ProcessEnv;
  registry: DriverRegistry;
  port?: number;
  log?: (message: string) => void;
}

export interface RunningWeb {
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * The port to use: `port` when given, else `WHEEMS_WEB_PORT`, else the default. 0 means any
 * free port, which tests use.
 */
export function webPort(env: NodeJS.ProcessEnv, port?: number): number {
  if (port !== undefined) return port;
  const fromEnv = Number.parseInt(env.WHEEMS_WEB_PORT ?? '', 10);
  return Number.isInteger(fromEnv) && fromEnv >= 0 && fromEnv < 65536 ? fromEnv : DEFAULT_WEB_PORT;
}

/**
 * The token that lets a browser in, kept in `.wheems/web-token`, readable only by the person.
 * Made the first time it's needed.
 */
export async function webToken(home: string, env: NodeJS.ProcessEnv): Promise<string> {
  const where = paths(home, env);
  const file = join(where.state, 'web-token');
  const existing = await readFile(file, 'utf8').then(
    (text) => text.trim(),
    () => '',
  );
  if (existing.length >= 32) return existing;
  await mkdir(where.state, { recursive: true });
  const token = randomBytes(32).toString('base64url');
  await writeFile(file, `${token}\n`, { mode: 0o600 });
  return token;
}

/** The address that opens the web app, with the token that lets the browser in. */
export function webUrl(port: number, token?: string): string {
  const base = `http://127.0.0.1:${String(port)}/`;
  return token === undefined ? base : `${base}?token=${encodeURIComponent(token)}`;
}

/**
 * Serves the web app on 127.0.0.1. It only reads for now: config, the session store
 * (read-only) and doctor's checks. Every request needs the token, and the Host header must be
 * this address, so neither another user's process nor another site in the browser can use it.
 */
export async function startWeb(options: WebOptions): Promise<RunningWeb> {
  const token = await webToken(options.home, options.env);
  const context: WebContext = { home: options.home, env: options.env, registry: options.registry };
  // The port it ends up on, known once it listens (port 0 lets the system choose).
  const web = { port: 0, token, context };
  const server = createServer((req, res) => {
    handle(req, res, web).catch((error: unknown) => {
      options.log?.(`Web app: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent)
        send(
          res,
          500,
          messagePage(
            'Something went wrong',
            "The page couldn't be made. The service log says why.",
          ),
        );
      else res.end();
    });
  });
  await listen(server, webPort(options.env, options.port));
  const address = server.address();
  web.port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: webUrl(web.port),
    port: web.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  web: { port: number; token: string; context: WebContext },
): Promise<void> {
  const allowedHosts = [`127.0.0.1:${String(web.port)}`, `localhost:${String(web.port)}`];
  if (!allowedHosts.includes(req.headers.host ?? '')) {
    send(res, 421, 'Wrong host', 'text/plain; charset=utf-8');
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Only GET is served', 'text/plain; charset=utf-8');
    return;
  }
  const url = new URL(req.url ?? '/', `http://${allowedHosts[0] ?? ''}`);
  if (url.pathname === '/health') {
    send(res, 200, '{"wheems":true}', 'application/json');
    return;
  }
  if (url.pathname === '/app.css') {
    send(res, 200, CSS, 'text/css; charset=utf-8');
    return;
  }
  if (url.pathname === '/app.js') {
    send(res, 200, SCRIPT, 'text/javascript; charset=utf-8');
    return;
  }

  // The token arrives once in the address from `wheems web open`; the cookie carries it after.
  const offered = url.searchParams.get('token');
  if (offered !== null) {
    if (!same(offered, web.token)) {
      send(
        res,
        403,
        messagePage(
          'That link has expired',
          'Open the web app again with <span class="mono">wheems web open</span>.',
        ),
      );
      return;
    }
    url.searchParams.delete('token');
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${web.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
    );
    redirect(res, `${url.pathname}${url.search}`);
    return;
  }
  if (!same(cookie(req, COOKIE) ?? '', web.token)) {
    send(
      res,
      401,
      messagePage(
        'Open it from Wheems',
        'For your privacy, the web app only opens from this computer, with the link <span class="mono">wheems web open</span> gives you.',
      ),
    );
    return;
  }

  const parts = url.pathname.split('/').filter((p) => p !== '');
  if (parts.length === 0) {
    const { summary } = await installSummary(web.context);
    const first = summary.workspaces[0];
    redirect(res, first ? `/w/${encodeURIComponent(first.id)}` : '/setup');
    return;
  }
  if (parts[0] === 'setup' && parts.length === 1) {
    const { summary } = await installSummary(web.context);
    const report = await doctorReport(web.context);
    send(res, 200, setupPage(summary, summary.workspaces[0] ?? null, report));
    return;
  }
  if (parts[0] === 'w' && parts[1] !== undefined && parts.length <= 3) {
    const id = decodeURIComponent(parts[1]);
    const view = parts[2] ?? 'overview';
    const includeEnded = url.searchParams.get('ended') === '1';
    const page = await workspacePage(web.context, id, {
      includeEnded: view === 'sessions' && includeEnded,
    });
    if (!page) {
      send(
        res,
        404,
        messagePage(
          'No such workspace',
          `There's no workspace <span class="mono">${esc(id)}</span> in this install.`,
        ),
      );
      return;
    }
    if (view === 'overview') {
      send(res, 200, overviewPage(page));
      return;
    }
    if (view === 'sessions') {
      const wanted = url.searchParams.get('s');
      const sessions = [...page.chiefTree, ...page.mine].map((i) => i.session);
      const selected =
        (wanted !== null ? sessions.find((s) => s.id === wanted) : sessions[0]) ?? null;
      const messages = selected ? await sessionMessages(web.context, id, selected) : [];
      send(res, 200, sessionsPage(page, selected, messages, includeEnded));
      return;
    }
  }
  send(
    res,
    404,
    messagePage('Not found', 'There\'s no page here. <a href="/">Go to the start</a>.'),
  );
}

function send(
  res: ServerResponse,
  status: number,
  body: string,
  type = 'text/html; charset=utf-8',
): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy':
      "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(body);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
