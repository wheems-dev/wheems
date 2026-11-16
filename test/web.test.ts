import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initWorkspace } from '../src/cli/commands/init.js';
import { installYaml } from '../src/cli/templates.js';
import { DriverRegistry } from '../src/contracts/registry.js';
import { paths } from '../src/home.js';
import { MIGRATIONS } from '../src/state/schema.js';
import { StateStore } from '../src/state/store.js';
import { esc } from '../src/web/pages.js';
import { startWeb, webToken, type RunningWeb } from '../src/web/server.js';

describe('the web app', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let web: RunningWeb;
  let token: string;

  /** A GET, with the cookie unless `cookie` is false, and the Host header given. */
  const get = (
    path: string,
    options: { cookie?: boolean; host?: string; method?: string } = {},
  ): Promise<{ status: number; body: string; headers: Record<string, unknown> }> =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: web.port,
          path,
          method: options.method ?? 'GET',
          headers: {
            Host: options.host ?? `127.0.0.1:${String(web.port)}`,
            ...(options.cookie !== false && { Cookie: `wheems_web=${token}` }),
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => (body += chunk.toString()));
          res.on('end', () => {
            resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
          });
        },
      );
      req.on('error', reject);
      req.end();
    });

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'web-'));
    env = { ...process.env, WHEEMS_HOME: home, WHEEMS_SECRETS: join(home, 'secrets.json') };
    writeFileSync(join(home, 'install.yaml'), installYaml());
    await initWorkspace({ home, id: 'default', env });
    const state = await StateStore.open(paths(home, env).store);
    const sessions = state.workspace('default');
    const now = new Date().toISOString();
    const base = { project: null, agent: 'default/chief-of-staff', folder: home, createdAt: now };
    sessions.create({
      ...base,
      id: 'root',
      owner: null,
      parent: null,
      title: 'Shortlist <b>marinas</b>',
      purpose: 'Three marinas within an hour',
      ask: 'Shortlist marinas for the winter',
      herdrName: 'default-sroot',
    });
    sessions.create({
      ...base,
      id: 'child',
      owner: 'root',
      parent: 'root',
      title: 'Check prices',
      purpose: 'Prices for each marina',
      ask: 'Shortlist marinas for the winter',
      herdrName: 'default-schild',
    });
    state.close();
    web = await startWeb({ home, env, registry: new DriverRegistry(), port: 0 });
    token = await webToken(home, env);
  });

  afterEach(async () => {
    await web.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('keeps its token owner-only, and lets in only a browser that has it', async () => {
    expect(statSync(join(home, '.wheems', 'web-token')).mode & 0o777).toBe(0o600);
    expect((await get('/health', { cookie: false })).status).toBe(200);
    const outside = await get('/w/default', { cookie: false });
    expect(outside.status).toBe(401);
    expect(outside.body).toContain('wheems web open');
    expect((await get('/?token=wrong', { cookie: false })).status).toBe(403);
    const signIn = await get(`/w/default?token=${token}`, { cookie: false });
    expect(signIn.status).toBe(303);
    expect(signIn.headers.location).toBe('/w/default');
    expect(String(signIn.headers['set-cookie'])).toContain('HttpOnly; SameSite=Strict');
  });

  it('refuses another host and anything but reading', async () => {
    expect((await get('/w/default', { host: 'evil.example:80' })).status).toBe(421);
    expect((await get('/w/default', { method: 'POST' })).status).toBe(405);
    const page = await get('/w/default');
    expect(String(page.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
  });

  it("shows a workspace's sessions as a tree, with what was asked, escaping what it shows", async () => {
    expect((await get('/')).headers.location).toBe('/w/default');
    const overview = await get('/w/default');
    expect(overview.status).toBe(200);
    expect(overview.body).toContain('<h1>Default</h1>');
    expect(overview.body).toContain(esc('Shortlist <b>marinas</b>'));
    expect(overview.body).not.toContain('<b>marinas</b>');
    // The session it started sits a level deeper.
    expect(overview.body).toMatch(/padding-left:48px[^>]*s=child/);

    const detail = await get('/w/default/sessions?s=child');
    expect(detail.body).toContain('Your original ask');
    expect(detail.body).toContain('Shortlist marinas for the winter');
    expect(detail.body).toContain('Prices for each marina');
    expect((await get('/w/nope')).status).toBe(404);
  });

  it('reads a session store from an older Wheems without changing it', async () => {
    await web.close();
    const store = paths(home, env).store;
    rmSync(store, { force: true });
    const db = new DatabaseSync(store);
    db.exec(MIGRATIONS[0] ?? '');
    db.exec(MIGRATIONS[1] ?? '');
    db.exec('PRAGMA user_version = 2');
    db.exec(
      "INSERT INTO sessions (id, workspace, kind, title, state, created_at, last_active_at) VALUES ('old', 'default', 'adhoc', 'An old session', 'idle', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')",
    );
    db.close();
    web = await startWeb({ home, env, registry: new DriverRegistry(), port: 0 });
    const page = await get('/w/default/sessions?s=old');
    expect(page.status).toBe(200);
    expect(page.body).toContain('An old session');
    expect(page.body).not.toContain('Your original ask');
    const after = new DatabaseSync(store, { readOnly: true });
    expect(after.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 });
    after.close();
  });
});
