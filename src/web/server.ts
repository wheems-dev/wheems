import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DriverRegistry } from '../contracts/registry.js';
import { paths } from '../home.js';
import { actOnSession, decideAboutYou, decideProposal, type Flash, type Form } from './actions.js';
import {
  aboutYouData,
  connectionsData,
  doctorReport,
  installSummary,
  reviewData,
  sessionMessages,
  settingsData,
  workspacePage,
  type WebContext,
} from './data.js';

/** The web app's port unless `--port` or `WHEEMS_WEB_PORT` says otherwise. */
export const DEFAULT_WEB_PORT = 4317;

export interface WebOptions {
  home: string;
  env: NodeJS.ProcessEnv;
  registry: DriverRegistry;
  port?: number;
  log?: (message: string) => void;
  /** How long a send waits before answering; tests shorten it. */
  sendWaitMs?: number;
  /** The built app's folder. Default: `app/` beside this file, as `npm run build` makes it. */
  appDir?: string;
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

/**
 * The address that opens the web app. The token goes after `#`, which a browser never sends to
 * any server: the app keeps it in this origin's own storage and sends it with each request.
 */
export function webUrl(port: number, token?: string): string {
  const base = `http://127.0.0.1:${String(port)}/`;
  return token === undefined ? base : `${base}#token=${token}`;
}

interface Web {
  port: number;
  token: string;
  context: WebContext;
  log: (message: string) => void;
  /** How a slow send or end turned out, by workspace/session, until the app asks for it. */
  outcomes: Map<string, Flash>;
  sendWaitMs: number | undefined;
  appDir: string;
}

/**
 * Serves the web app on 127.0.0.1: the built React app (web/), and a JSON API under /api that
 * reads config, the session store (read-only) and doctor's checks, and acts only through the
 * code the CLI uses (actions.ts). The API needs the token in an Authorization header, which only
 * the app, from this origin, holds; the Host header must be this address; and changes must come
 * from this page's Origin. The app's files hold no data, so they're served to anyone local.
 */
export async function startWeb(options: WebOptions): Promise<RunningWeb> {
  const token = await webToken(options.home, options.env);
  const context: WebContext = { home: options.home, env: options.env, registry: options.registry };
  // The port it ends up on, known once it listens (port 0 lets the system choose).
  const web: Web = {
    port: 0,
    token,
    context,
    log: options.log ?? (() => undefined),
    outcomes: new Map<string, Flash>(),
    sendWaitMs: options.sendWaitMs,
    appDir: options.appDir ?? fileURLToPath(new URL('./app/', import.meta.url)),
  };
  const server = createServer((req, res) => {
    handle(req, res, web).catch((error: unknown) => {
      web.log(`Web app: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent)
        json(res, 500, { error: 'Something went wrong. The service log says why.' });
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

async function handle(req: IncomingMessage, res: ServerResponse, web: Web): Promise<void> {
  const allowedHosts = [`127.0.0.1:${String(web.port)}`, `localhost:${String(web.port)}`];
  if (!allowedHosts.includes(req.headers.host ?? '')) {
    text(res, 421, 'Wrong host');
    return;
  }
  const posting = req.method === 'POST';
  if (req.method !== 'GET' && req.method !== 'HEAD' && !posting) {
    text(res, 405, 'Only GET and POST are served');
    return;
  }
  const url = new URL(req.url ?? '/', `http://${allowedHosts[0] ?? ''}`);
  if (url.pathname === '/health') {
    json(res, 200, { wheems: true });
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    // The token comes only in a header the app sets: a link or a form on another site can't.
    const auth = req.headers.authorization ?? '';
    if (!same(auth.replace(/^Bearer /, ''), web.token) || !auth.startsWith('Bearer ')) {
      json(res, 401, { error: 'Open the web app with wheems web open.' });
      return;
    }
    // Changes must come from this page: browsers name the page a request came from.
    if (posting && !allowedHosts.map((h) => `http://${h}`).includes(req.headers.origin ?? '')) {
      json(res, 403, { error: 'Changes are accepted only from the Wheems page.' });
      return;
    }
    await api(req, res, url, web, posting);
    return;
  }
  if (posting) {
    text(res, 405, 'Changes go through /api');
    return;
  }

  // Links from before the app kept the token in the path: move it after the #.
  const old = /^\/k\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (old) {
    if (!same(old[1] ?? '', web.token)) {
      text(res, 401, 'That link has expired. Open the web app with wheems web open.');
      return;
    }
    redirect(res, `${old[2] ?? '/'}${url.search}#token=${web.token}`);
    return;
  }
  await serveApp(res, url.pathname, web.appDir);
}

/** The JSON API. Every answer is the view a page shows, from data.ts, or an action's outcome. */
async function api(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  web: Web,
  posting: boolean,
): Promise<void> {
  const parts = url.pathname
    .slice('/api/'.length)
    .split('/')
    .filter((p) => p !== '')
    .map((p) => decodeURIComponent(p));
  const [area, id, sub, item] = parts;
  const found = (value: unknown) => {
    if (value === null || value === undefined) json(res, 404, { error: 'Not found' });
    else json(res, 200, value);
  };

  if (posting) {
    const form = await readForm(req);
    if (form === null) {
      json(res, 400, { error: 'Send JSON.' });
      return;
    }
    if (area === 'w' && id !== undefined && sub === 'review' && item !== undefined) {
      json(res, 200, await decideProposal(web.context, id, item, form));
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
      json(res, 200, flash);
      return;
    }
    if (area === 'about-you' && id !== undefined && sub === undefined) {
      json(res, 200, await decideAboutYou(web.context, id, form));
      return;
    }
    json(res, 404, { error: 'No such action' });
    return;
  }

  if (area === 'install' && id === undefined) {
    found((await installSummary(web.context)).summary);
    return;
  }
  if (area === 'setup' && id === undefined) {
    const { summary } = await installSummary(web.context);
    json(res, 200, { install: summary, report: await doctorReport(web.context) });
    return;
  }
  if (area === 'connections' && id === undefined) {
    found(await connectionsData(web.context));
    return;
  }
  if (area === 'about-you' && id === undefined) {
    found(await aboutYouData(web.context));
    return;
  }
  if (area === 'w' && id !== undefined) {
    if (sub === undefined) {
      found(await workspacePage(web.context, id));
      return;
    }
    if (sub === 'review' && item === undefined) {
      found(await reviewData(web.context, id));
      return;
    }
    if (sub === 'settings' && item === undefined) {
      found(await settingsData(web.context, id));
      return;
    }
    if (sub === 'sessions') {
      const page = await workspacePage(web.context, id, {
        includeEnded: url.searchParams.get('ended') === '1',
      });
      if (!page) {
        found(null);
        return;
      }
      if (item === undefined) {
        json(res, 200, page);
        return;
      }
      const tree = [...page.chiefTree, ...page.mine];
      const chosen = tree.find((i) => i.session.id === item);
      if (!chosen) {
        found(null);
        return;
      }
      // How a slow send or end turned out, given once.
      const key = `${id}/${item}`;
      const outcome = web.outcomes.get(key) ?? null;
      web.outcomes.delete(key);
      json(res, 200, {
        item: chosen,
        messages: await sessionMessages(web.context, id, chosen.session),
        outcome,
      });
      return;
    }
  }
  json(res, 404, { error: 'Not found' });
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

/** A file of the built app, or its index.html for any page address (the app routes itself). */
async function serveApp(res: ServerResponse, pathname: string, appDir: string): Promise<void> {
  const root = appDir.endsWith(sep) ? appDir : `${appDir}${sep}`;
  const wanted = normalize(join(root, decodeURIComponent(pathname)));
  const isFile = extname(pathname) !== '' && wanted.startsWith(root);
  const file = isFile ? wanted : join(root, 'index.html');
  const body = await readFile(file).catch(() => null);
  if (body === null) {
    if (isFile) text(res, 404, 'Not found');
    else
      text(
        res,
        503,
        "The web app isn't built. In the Wheems repository, run npm run build; an installed Wheems has it.",
      );
    return;
  }
  const hashed = pathname.startsWith('/assets/');
  res.writeHead(200, {
    ...SECURITY,
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    // Built assets are named by their content, so they never change; the page itself might.
    'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-store',
  });
  res.end(body);
}

const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  // same-origin: nothing about the app reaches another site, and its own requests carry their
  // Origin (no-referrer makes browsers send Origin: null).
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    ...SECURITY,
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    ...SECURITY,
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { ...SECURITY, Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The most a request may send: a skill's text, edited, fits well within it. */
const MAX_BODY = 256 * 1024;

/** A JSON body as a form: each field's values, so the actions read it the same way. */
async function readForm(req: IncomingMessage): Promise<Form | null> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return null;
  const body = await new Promise<string>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('The request is too large'));
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const form: Form = new Map();
  for (const [key, value] of Object.entries(parsed)) {
    const values = (Array.isArray(value) ? value : [value]).filter(
      (v): v is string => typeof v === 'string',
    );
    form.set(key, values);
  }
  return form;
}
