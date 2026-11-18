/**
 * Serves the web app with live reload (`bun run dev:web`), passing /api to a running Wheems
 * (WHEEMS_WEB_PORT, or 4317) as if from its own page, with its Host and Origin, which it requires.
 * It listens on PORT, or on 5173 or the next free port after it, as Vite did.
 */
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
console.log(`Web app: ${server.url.href}, with /api from ${wheems}`);
