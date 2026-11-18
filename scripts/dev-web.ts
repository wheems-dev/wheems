/**
 * Serves the web app with live reload (`bun run dev:web`), passing /api to a running Wheems
 * (WHEEMS_WEB_PORT, or 4317) as if from its own page, with its Host and Origin, which it requires.
 * It listens on PORT, or on 5173 or the next free port after it, as Vite did, and prints the
 * link with the token of the Wheems in ~/wheems (or WHEEMS_HOME), so the page opens signed in.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultHome, paths } from '../src/home.js';
import app from '../web/index.html';

const wheems = `http://127.0.0.1:${process.env.WHEEMS_WEB_PORT ?? '4317'}`;

const serve = (port: number) =>
  Bun.serve({
    hostname: '127.0.0.1',
    port,
    development: { hmr: true, console: true },
    routes: {
      '/api/*': (request) => {
        const url = new URL(request.url);
        const headers = new Headers(request.headers);
        headers.set('host', new URL(wheems).host);
        headers.set('origin', wheems);
        return fetch(`${wheems}${url.pathname}${url.search}`, {
          method: request.method,
          headers,
          body: request.body,
          redirect: 'manual',
        }).catch(
          () =>
            new Response(`Wheems isn't running at ${wheems}: start it, or set WHEEMS_WEB_PORT.\n`, {
              status: 502,
            }),
        );
      },
      // Every other address is a page of the app, which routes itself.
      '/*': app,
    },
  });

const chosen = process.env.PORT;
let server: ReturnType<typeof serve> | undefined;
for (let port = 5173; server === undefined; port++) {
  try {
    server = serve(chosen === undefined ? port : Number(chosen));
  } catch (error) {
    // Another program has it (often another project's Vite): try the next, unless PORT says.
    const inUse = (error as { code?: string }).code === 'EADDRINUSE';
    if (!inUse || chosen !== undefined || port >= 5199) throw error;
  }
}
// The link with the running Wheems's token after the #, so the page opens signed in (read only:
// a Wheems that has never served its web app has no token yet).
const token = await readFile(join(paths(defaultHome()).state, 'web-token'), 'utf8').then(
  (text) => text.trim(),
  () => '',
);
console.log(`Web app: ${server.url.href}${token === '' ? '' : `#token=${token}`}`);
console.log(`Passing /api to the Wheems at ${wheems}`);
