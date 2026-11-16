import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { DriverRegistry } from '../contracts/registry.js';
import { paths } from '../home.js';
import { actOnSession, decideAboutYou, decideProposal, parseForm, type Flash } from './actions.js';
import { CSS, SCRIPT } from './assets.js';
import {
  aboutYouData,
  connectionsData,
  doctorReport,
  installSummary,
  reviewData,
  sessionMessages,
  settingsData,
  workspacePage,
  type InstallSummary,
  type WebContext,
} from './data.js';
import {
  aboutYouPage,
  connectionsPage,
  esc,
  messagePage,
  overviewPage,
  reviewPage,
  sessionsPage,
  settingsPage,
  setupPage,
} from './pages.js';

/** The web app's port unless `--port` or `WHEEMS_WEB_PORT` says otherwise. */
export const DEFAULT_WEB_PORT = 4317;

export interface WebOptions {
  home: string;
  env: NodeJS.ProcessEnv;
  registry: DriverRegistry;
  port?: number;
  log?: (message: string) => void;
  /** How long a send waits before the page moves on; tests shorten it. */
  sendWaitMs?: number;
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
  return token === undefined ? base : `${base}k/${token}/`;
}

/**
 * Serves the web app on 127.0.0.1. It reads config, the session store (read-only) and doctor's
 * checks, and acts only through the code the CLI uses (actions.ts). Every request needs the token, and the Host header must be
 * this address, so neither another user's process nor another site in the browser can use it.
 */
export async function startWeb(options: WebOptions): Promise<RunningWeb> {
  const token = await webToken(options.home, options.env);
  const context: WebContext = { home: options.home, env: options.env, registry: options.registry };
  // The port it ends up on, known once it listens (port 0 lets the system choose).
  const web = {
    port: 0,
    token,
    context,
    flashes: new Flashes(),
    log: options.log ?? (() => undefined),
    outcomes: new Map<string, Flash>(),
    sendWaitMs: options.sendWaitMs,
  };
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
  web: {
    port: number;
    token: string;
    context: WebContext;
    flashes: Flashes;
    log: (message: string) => void;
    /** How a slow send or end turned out, by workspace/session, until its page shows it. */
    outcomes: Map<string, Flash>;
    sendWaitMs: number | undefined;
  },
): Promise<void> {
  const allowedHosts = [`127.0.0.1:${String(web.port)}`, `localhost:${String(web.port)}`];
  if (!allowedHosts.includes(req.headers.host ?? '')) {
    send(res, 421, 'Wrong host', 'text/plain; charset=utf-8');
    return;
  }
  const posting = req.method === 'POST';
  if (req.method !== 'GET' && req.method !== 'HEAD' && !posting) {
    send(res, 405, 'Only GET and POST are served', 'text/plain; charset=utf-8');
    return;
  }
  // A form may be sent only from this page: browsers name the page a POST came from, and a
  // form on another site can't send this one's Origin. The token in the address is a second lock.
  if (posting) {
    const origins = allowedHosts.map((h) => `http://${h}`);
    if (!origins.includes(req.headers.origin ?? '')) {
      send(res, 403, 'Forms are accepted only from the Wheems page', 'text/plain; charset=utf-8');
      return;
    }
  }
  const url = new URL(req.url ?? '/', `http://${allowedHosts[0] ?? ''}`);
  if (url.pathname === '/health') {
    send(res, 200, '{"wheems":true}', 'application/json');
    return;
  }
  if (url.pathname === '/app.css' || url.pathname.endsWith('/app.css')) {
    send(res, 200, CSS, 'text/css; charset=utf-8');
    return;
  }
  if (url.pathname === '/app.js' || url.pathname.endsWith('/app.js')) {
    send(res, 200, SCRIPT, 'text/javascript; charset=utf-8');
    return;
  }

  // Pages live under /k/<token>/: the token is in every address, never in a cookie, because a
  // browser sends cookies for 127.0.0.1 to every port on it, and other local servers could
  // read them. `wheems web open` gives the address; an old ?token= link is moved there.
  const offered = url.searchParams.get('token');
  if (offered !== null && same(offered, web.token)) {
    url.searchParams.delete('token');
    redirect(res, `/k/${web.token}${url.pathname}${url.search}`);
    return;
  }
  const all = url.pathname.split('/').filter((p) => p !== '');
  if (all[0] !== 'k' || !same(all[1] ?? '', web.token)) {
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
  const base = `/k/${web.token}`;
  const page = (status: number, html: string, eventual?: Flash) => {
    // Every link and form on the page stays under the token, and an action's outcome shows once.
    const flash = web.flashes.take(url.searchParams.get('flash')) ?? eventual;
    const shown = flash
      ? html.replace(
          '<div class="wrap">',
          `<div class="wrap"><p class="card pad flash ${flash.ok ? 'ok' : 'no'}" role="status">${esc(flash.text)}</p>`,
        )
      : html;
    send(
      res,
      status,
      shown.replaceAll('href="/', `href="${base}/`).replaceAll('action="/', `action="${base}/`),
    );
  };

  if (posting) {
    const form = parseForm(await readBody(req));
    const done = (flash: Flash, to: string) => {
      const sep = to.includes('?') ? '&' : '?';
      redirect(res, `${base}${to}${sep}flash=${web.flashes.put(flash)}`);
    };
    const [area, id, sub, item] = all.slice(2).map((p) => decodeURIComponent(p));
    if (area === 'w' && id !== undefined && sub === 'review' && item !== undefined) {
      done(
        await decideProposal(web.context, id, item, form),
        `/w/${encodeURIComponent(id)}/review`,
      );
      return;
    }
    if (area === 'w' && id !== undefined && sub === 'sessions' && item !== undefined) {
      const key = `${id}/${item}`;
      web.outcomes.delete(key);
      const flash = await actOnSession(
        web.context,
        id,
        item,
        form,
        web.log,
        (later) => {
          web.outcomes.set(key, later);
        },
        web.sendWaitMs,
      );
      done(flash, `/w/${encodeURIComponent(id)}/sessions?s=${encodeURIComponent(item)}`);
      return;
    }
    if (area === 'about-you' && id !== undefined && sub === undefined) {
      const back = url.searchParams.get('w');
      done(
        await decideAboutYou(web.context, id, form),
        `/about-you${back !== null ? `?w=${encodeURIComponent(back)}` : ''}`,
      );
      return;
    }
    send(res, 404, 'No such action', 'text/plain; charset=utf-8');
    return;
  }

  const parts = all.slice(2);
  if (parts.length === 0) {
    const { summary } = await installSummary(web.context);
    const first = summary.workspaces[0];
    redirect(res, first ? `${base}/w/${encodeURIComponent(first.id)}` : `${base}/setup`);
    return;
  }
  // Install pages keep the workspace the person came from (?w=) in the switcher.
  const chosen = (summary: InstallSummary) =>
    summary.workspaces.find((w) => w.id === url.searchParams.get('w')) ??
    summary.workspaces[0] ??
    null;
  if (parts[0] === 'setup' && parts.length === 1) {
    const { summary } = await installSummary(web.context);
    const report = await doctorReport(web.context);
    page(200, setupPage(summary, chosen(summary), report));
    return;
  }
  if (parts[0] === 'connections' && parts.length === 1) {
    const view = await connectionsData(web.context);
    page(200, connectionsPage(view, chosen(view.install)));
    return;
  }
  if (parts[0] === 'about-you' && parts.length === 1) {
    const view = await aboutYouData(web.context);
    page(200, aboutYouPage(view, chosen(view.install)));
    return;
  }
  if (parts[0] === 'w' && parts[1] !== undefined && parts.length === 3) {
    const id = decodeURIComponent(parts[1]);
    if (parts[2] === 'review') {
      const view = await reviewData(web.context, id);
      if (view) {
        page(200, reviewPage(view));
        return;
      }
    }
    if (parts[2] === 'settings') {
      const view = await settingsData(web.context, id);
      if (view) {
        page(200, settingsPage(view));
        return;
      }
    }
  }
  if (parts[0] === 'w' && parts[1] !== undefined && parts.length <= 3) {
    const id = decodeURIComponent(parts[1]);
    const view = parts[2] ?? 'overview';
    const includeEnded = url.searchParams.get('ended') === '1';
    const data = await workspacePage(web.context, id, {
      includeEnded: view === 'sessions' && includeEnded,
    });
    if (!data) {
      page(
        404,
        messagePage(
          'No such workspace',
          `There's no workspace <span class="mono">${esc(id)}</span> in this install.`,
        ),
      );
      return;
    }
    if (view === 'overview') {
      page(200, overviewPage(data));
      return;
    }
    if (view === 'sessions') {
      const wanted = url.searchParams.get('s');
      const sessions = [...data.chiefTree, ...data.mine].map((i) => i.session);
      const selected =
        (wanted !== null ? sessions.find((s) => s.id === wanted) : sessions[0]) ?? null;
      const messages = selected ? await sessionMessages(web.context, id, selected) : [];
      // How a slow send or end turned out, once it has.
      const key = selected ? `${id}/${selected.id}` : '';
      // Kept for later only when this visit has another message still to show; a reload of a
      // page whose message was shown already shows it.
      const flashId = url.searchParams.get('flash');
      const eventual =
        flashId !== null && web.flashes.has(flashId) ? undefined : web.outcomes.get(key);
      if (eventual) web.outcomes.delete(key);
      page(200, sessionsPage(data, selected, messages, includeEnded), eventual);
      return;
    }
  }
  page(404, messagePage('Not found', 'There\'s no page here. <a href="/">Go to the start</a>.'));
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
    // same-origin: the token in the address never reaches another site, and the page's own
    // forms still carry their Origin (no-referrer makes browsers send Origin: null).
    'Referrer-Policy': 'same-origin',
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

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The most a form may send: a skill's text, edited, fits well within it. */
const MAX_FORM = 256 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_FORM) {
        reject(new Error('The form is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

/** Outcomes of actions, each shown once by the page an action returns to, then forgotten. */
class Flashes {
  private readonly kept = new Map<string, { flash: Flash; until: number }>();

  put(flash: Flash): string {
    const now = Date.now();
    for (const [id, entry] of this.kept) if (entry.until < now) this.kept.delete(id);
    const id = randomBytes(9).toString('base64url');
    this.kept.set(id, { flash, until: now + 5 * 60_000 });
    return id;
  }

  /** Whether a message is still waiting to be shown. */
  has(id: string): boolean {
    const entry = this.kept.get(id);
    return entry !== undefined && entry.until >= Date.now();
  }

  take(id: string | null): Flash | undefined {
    if (id === null) return undefined;
    const entry = this.kept.get(id);
    this.kept.delete(id);
    return entry && entry.until >= Date.now() ? entry.flash : undefined;
  }
}
