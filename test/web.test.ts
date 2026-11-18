/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- the API's JSON, checked by each assertion */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { loadInstall } from '../src/config/load.js';
import { StubEngine } from '../src/testing/index.js';
import { initWorkspace } from '../src/cli/commands/init.js';
import { installYaml } from '../src/cli/templates.js';
import { DriverRegistry } from '../src/contracts/registry.js';
import { paths } from '../src/home.js';
import { withReviewLock } from '../src/review/review.js';
import { MIGRATIONS } from '../src/state/schema.js';
import { ConversationStore } from '../src/service/store.js';
import { StateStore } from '../src/state/store.js';
import { fingerprint } from '../src/web/data.js';
import { embedApp } from '../src/util/standalone.js';
import { startWeb, webToken, webUrl, type RunningWeb } from '../src/web/server.js';

interface Answer {
  status: number;
  body: string;
  headers: Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the API's answers, read in tests
  json: () => any;
}

describe('the web app', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let web: RunningWeb;
  let token: string;
  let appDir: string;

  /** A request, with the token in its Authorization header unless `token` says otherwise. */
  const send = (
    path: string,
    options: {
      method?: string;
      body?: unknown;
      token?: string | null;
      origin?: string | null;
      host?: string;
    } = {},
  ): Promise<Answer> =>
    new Promise((resolve, reject) => {
      const bearer = options.token === undefined ? token : options.token;
      const origin =
        options.origin === undefined ? `http://127.0.0.1:${String(web.port)}` : options.origin;
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: web.port,
          path,
          method: options.method ?? 'GET',
          headers: {
            Host: options.host ?? `127.0.0.1:${String(web.port)}`,
            ...(bearer !== null && { Authorization: `Bearer ${bearer}` }),
            ...(options.body !== undefined && { 'Content-Type': 'application/json' }),
            ...(origin !== null && options.method === 'POST' && { Origin: origin }),
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => (body += chunk.toString()));
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              body,
              headers: res.headers,
              json: () => JSON.parse(body) as unknown,
            });
          });
        },
      );
      req.on('error', reject);
      req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
    });

  const get = (path: string) => send(`/api${path}`);
  const post = (path: string, body: unknown, options: { origin?: string | null } = {}) =>
    send(`/api${path}`, { method: 'POST', body, ...options });

  const propose = (id: string, name: string, text?: string) => {
    const dir = join(home, '.wheems', 'review', 'skills', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'proposal.json'),
      JSON.stringify({
        id,
        name,
        workspace: 'default',
        agent: 'chief-of-staff',
        conversation: null,
        created: new Date().toISOString(),
        basedOn: null,
        similar: [],
      }),
    );
    const skill = text ?? `---\nname: ${name}\ndescription: ${name}\n---\n\n# ${name}\n`;
    writeFileSync(join(dir, 'SKILL.md'), skill);
    return fingerprint(skill);
  };

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
      title: 'Shortlist marinas',
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
    // A built app of our own, so the files it serves are known.
    appDir = join(home, 'app');
    mkdirSync(join(appDir, 'assets'), { recursive: true });
    writeFileSync(join(appDir, 'index.html'), '<!doctype html><div id="root"></div>');
    writeFileSync(join(appDir, 'assets', 'index-abc.js'), 'console.log(1)');
    web = await startWeb({ home, env, registry: new DriverRegistry(), port: 0, appDir });
    token = await webToken(home, env);
  });

  afterEach(async () => {
    await web.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('keeps its token owner-only, gives it after the # and answers the API only with it in a header', async () => {
    expect(statSync(join(home, '.wheems', 'web-token')).mode & 0o777).toBe(0o600);
    expect(webUrl(4317, 'abc')).toBe('http://127.0.0.1:4317/#token=abc');
    expect((await send('/health', { token: null })).status).toBe(200);
    expect((await send('/api/install', { token: null })).status).toBe(401);
    expect((await send('/api/install', { token: 'wrong' })).status).toBe(401);
    const install = await get('/install');
    expect(install.status).toBe(200);
    expect(install.json().workspaces[0]).toMatchObject({ id: 'default', name: 'Default' });
    // A link from before the app moves its token after the #, which no browser sends on.
    const old = await send(`/k/${token}/w/default`, { token: null });
    expect(old.status).toBe(303);
    expect(old.headers.location).toBe(`/w/default#token=${token}`);
    expect((await send('/k/wrong/w/default', { token: null })).status).toBe(401);
  });

  it('refuses another host, other methods, and changes from elsewhere', async () => {
    expect((await send('/api/install', { host: 'evil.example:80' })).status).toBe(421);
    expect((await send('/api/install', { method: 'PUT' })).status).toBe(405);
    expect(
      (await post('/w/default/review/p1', { decision: 'decline' }, { origin: null })).status,
    ).toBe(403);
    expect(
      (
        await post(
          '/w/default/review/p1',
          { decision: 'decline' },
          { origin: 'https://evil.example' },
        )
      ).status,
    ).toBe(403);
    expect(
      (await send('/api/w/default/review/p1', { method: 'POST', body: 'x', token: null })).status,
    ).toBe(401);
    expect((await send('/w/default', { method: 'POST', token: null })).status).toBe(405);
  });

  it('serves the app for any page, its assets, and nothing outside its folder', async () => {
    writeFileSync(join(home, 'secret.txt'), 'never served');
    const page = await send('/w/default/sessions', { token: null });
    expect(page.status).toBe(200);
    expect(page.body).toContain('<div id="root">');
    // same-origin, never no-referrer: with no-referrer a browser sends Origin: null.
    expect(page.headers['referrer-policy']).toBe('same-origin');
    expect(String(page.headers['content-security-policy'])).toContain("script-src 'self'");
    const asset = await send('/assets/index-abc.js', { token: null });
    expect(asset.headers['content-type']).toContain('text/javascript');
    expect(asset.headers['cache-control']).toContain('immutable');
    const escape = await send('/%2e%2e/secret.txt', { token: null });
    expect(escape.body).not.toContain('never served');
    expect((await send('/assets/missing.js', { token: null })).status).toBe(404);
  });

  it('serves the app carried inside the one-file executable, and nothing else', async () => {
    const inside = join(home, 'bunfs');
    mkdirSync(inside);
    writeFileSync(join(inside, 'page'), '<!doctype html><div id="embedded"></div>');
    writeFileSync(join(inside, 'script'), 'console.log(2)');
    embedApp({ 'index.html': join(inside, 'page'), 'assets/index-def.js': join(inside, 'script') });
    try {
      expect((await send('/w/default/review', { token: null })).body).toContain('embedded');
      const asset = await send('/assets/index-def.js', { token: null });
      expect(asset.body).toBe('console.log(2)');
      expect(asset.headers['cache-control']).toContain('immutable');
      // Not the app in appDir, nor anything else.
      expect((await send('/assets/index-abc.js', { token: null })).status).toBe(404);
      expect((await send('/%2e%2e/bunfs/script', { token: null })).body).not.toContain('log(2)');
    } finally {
      embedApp(undefined);
    }
  });

  it("gives a workspace's sessions as a tree, with what was asked", async () => {
    const page = (await get('/w/default')).json();
    expect(page.workspace).toMatchObject({ id: 'default', name: 'Default' });
    expect(
      page.mine.map((i: { session: { id: string }; depth: number }) => [i.session.id, i.depth]),
    ).toEqual([
      ['root', 1],
      ['child', 2],
    ]);
    const detail = (await get('/w/default/sessions/child')).json();
    expect(detail.item.session).toMatchObject({
      ask: 'Shortlist marinas for the winter',
      purpose: 'Prices for each marina',
    });
    expect(detail.outcome).toBeNull();
    expect((await get('/w/nope')).status).toBe(404);
    expect((await get('/w/default/sessions/nope')).status).toBe(404);
  });

  it("shows a session's chat and the messages sent to it, oldest first, the latest only", async () => {
    const state = await StateStore.open(paths(home, env).store);
    const sessions = state.workspace('default');
    const at = (minute: number) => `2026-11-16T10:${String(minute).padStart(2, '0')}:00.000Z`;
    sessions.addChat({ session: 'root', author: 'person', text: 'Find a marina', at: at(1) });
    sessions.addChat({ session: 'root', author: 'agent', text: 'On it.', at: at(2) });
    const file = join(home, 'sent.md');
    writeFileSync(file, 'How are prices looking?');
    sessions.addMessage({
      id: 'm1',
      sender: null,
      receiver: 'root',
      messageFile: file,
      sentAt: at(3),
    });
    sessions.addChat({
      session: 'root',
      author: 'wheems',
      text: 'The agent hit an error.',
      at: at(4),
    });
    for (let i = 0; i < 14; i++) {
      sessions.addChat({
        session: 'child',
        author: 'person',
        text: `ping ${String(i)}`,
        at: at(10 + i),
      });
    }
    state.close();
    const root = (await get('/w/default/sessions/root')).json();
    expect(root.messages.map((m: { who: string; text: string }) => [m.who, m.text])).toEqual([
      ['You', 'Find a marina'],
      ['This session', 'On it.'],
      ['You', 'How are prices looking?'],
      ['Wheems', 'The agent hit an error.'],
    ]);
    const child = (await get('/w/default/sessions/child')).json();
    expect(child.messages).toHaveLength(12);
    expect(child.messages[0].text).toBe('ping 2');
    expect(child.messages[11].text).toBe('ping 13');
    const keys: string[] = child.messages.map((m: { key: string }) => m.key);
    expect(new Set(keys).size).toBe(12);
  });

  it('shows a session still running under an ended one, and ended ones when asked', async () => {
    const state = await StateStore.open(paths(home, env).store);
    state
      .workspace('default')
      .update('root', { state: 'ended', endedAt: new Date().toISOString() });
    state.close();
    const open = (await get('/w/default/sessions')).json();
    expect(open.mine.map((i: { session: { id: string } }) => i.session.id)).toEqual([
      'root',
      'child',
    ]);
    expect((await get('/w/default/sessions/root?ended=1')).status).toBe(200);
  });

  it('gives what waits for review, the settings, the connections and about you, never a credential', async () => {
    propose('p1', 'boat-maintenance');
    mkdirSync(join(home, '.wheems', 'review', 'about-you'), { recursive: true });
    writeFileSync(
      join(home, '.wheems', 'review', 'about-you', 'n1-default.md'),
      'Prefers the 08:15 ferry.',
    );
    writeFileSync(join(home, 'about-you.md'), 'Lives by the sea.');
    writeFileSync(
      join(home, 'secrets.json'),
      JSON.stringify({ slack: { bot_token: 'xoxb-never-shown', app_token: 'xapp-never-shown' } }),
    );
    expect((await get('/install')).json().workspaces[0].waiting).toBe(1);
    const review = (await get('/w/default/review')).json();
    expect(review.proposals[0]).toMatchObject({ name: 'boat-maintenance' });
    expect(review.proposals[0].agents).toEqual([{ name: 'chief-of-staff', checked: true }]);
    const settings = (await get('/w/default/settings')).json();
    expect(settings.chief.file).toBe('WHEEMS.md');
    const connections = await get('/connections');
    expect(connections.json().connections[0]).toMatchObject({ name: 'slack', connected: true });
    expect(connections.body).not.toContain('never-shown');
    const about = (await get('/about-you')).json();
    expect(about.current).toBe('Lives by the sea.');
    expect(about.suggestions[0]).toMatchObject({
      name: 'n1-default.md',
      text: 'Prefers the 08:15 ferry.',
    });
    expect((await get('/w/nope/settings')).status).toBe(404);
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
    web = await startWeb({ home, env, registry: new DriverRegistry(), port: 0, appDir });
    const detail = await get('/w/default/sessions/old');
    expect(detail.status).toBe(200);
    expect(detail.json().item.session).toMatchObject({ title: 'An old session', ask: null });
    expect(detail.json().messages).toEqual([]);
    // No approvals were asked before version 7.
    expect((await get('/w/default/review')).json().approvals).toEqual({ open: [], history: [] });
    const after = new DatabaseSync(store, { readOnly: true });
    expect(after.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 });
    after.close();
  });

  it('approves a skill for the agents chosen, only as seen, and declines a change about you', async () => {
    const seen = propose('p2', 'ferry-times');
    const stale = (await post('/w/default/review/p2', { decision: 'approve', seen: 'old' })).json();
    expect(stale).toMatchObject({ ok: false });
    expect(stale.text).toContain('changed since the page showed it');
    const approved = (
      await post('/w/default/review/p2', {
        decision: 'approve',
        seen,
        agents: ['chief-of-staff', 'not-an-agent'],
      })
    ).json();
    expect(approved).toEqual({
      ok: true,
      text: expect.stringContaining(
        'Added ferry-times version 1 to the library, pinned in default, for chief-of-staff.',
      ),
    });
    expect(readFileSync(join(home, 'workspaces', 'default', 'skills.yaml'), 'utf8')).toContain(
      'ferry-times: 1',
    );
    expect(readFileSync(join(home, 'workspaces', 'default', 'WHEEMS.md'), 'utf8')).toContain(
      'ferry-times',
    );
    expect(
      (await post('/w/default/review/p2', { decision: 'approve', seen })).json(),
    ).toMatchObject({
      ok: false,
      text: 'That proposal has already been dealt with.',
    });

    mkdirSync(join(home, '.wheems', 'review', 'about-you'), { recursive: true });
    const suggestion = join(home, '.wheems', 'review', 'about-you', 'n9-default.md');
    writeFileSync(suggestion, 'Prefers tea.');
    const declined = (
      await post('/about-you/n9-default.md', {
        decision: 'decline',
        seen: fingerprint('Prefers tea.'),
      })
    ).json();
    expect(declined).toEqual({ ok: true, text: 'Declined the change to about-you.md.' });
    expect(existsSync(suggestion)).toBe(false);
  });

  it('applies two approvals at once one after the other, losing neither', async () => {
    const a = propose('pa', 'tide-tables');
    const b = propose('pb', 'mooring-fees');
    await Promise.all([
      post('/w/default/review/pa', { decision: 'approve', seen: a, agents: ['chief-of-staff'] }),
      post('/w/default/review/pb', { decision: 'approve', seen: b, agents: ['chief-of-staff'] }),
    ]);
    const pinned = readFileSync(join(home, 'workspaces', 'default', 'skills.yaml'), 'utf8');
    expect(pinned).toContain('tide-tables: 1');
    expect(pinned).toContain('mooring-fees: 1');
  });

  it('gives a long change about you in full, with the fingerprint approving needs', async () => {
    mkdirSync(join(home, '.wheems', 'review', 'about-you'), { recursive: true });
    const long = `${'Likes sailing. '.repeat(700)}The end.`;
    writeFileSync(join(home, '.wheems', 'review', 'about-you', 'n8-default.md'), long);
    const about = (await get('/about-you')).json();
    expect(about.suggestions[0]).toMatchObject({ text: long, seen: fingerprint(long) });
  });

  it("saves settings to workspace.yaml and the chief's agent file, keeping comments, only as seen", async () => {
    await web.close();
    const registry = new DriverRegistry()
      .register('engine', 'claude-code', () => new StubEngine({ name: 'claude-code' }))
      .register('engine', 'codex', () => new StubEngine({ name: 'codex' }));
    web = await startWeb({ home, env, registry, port: 0, appDir });
    const dir = join(home, 'workspaces', 'default');
    const yamlFile = join(dir, 'workspace.yaml');
    const chiefFile = join(dir, 'WHEEMS.md');
    writeFileSync(yamlFile, `# Kept by hand.\n${readFileSync(yamlFile, 'utf8')}`);
    const chiefBefore = readFileSync(chiefFile, 'utf8');

    const view = (await get('/w/default/settings')).json();
    expect(view.engines).toEqual(['claude-code', 'codex']);
    const stale = (await post('/w/default/settings', { seen: 'old', name: 'Home' })).json();
    expect(stale).toEqual({ ok: false, text: expect.stringContaining('changed since') });

    const bad = (
      await post('/w/default/settings', {
        seen: view.seen,
        maxDepth: '0',
        noteAfterIdle: '',
        engine: 'nope',
        account: 'someone-else',
        tidyAt: '25:00',
      })
    ).json();
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain('How deep sessions may start sessions must be a whole number');
    expect(bad.text).toContain('Minutes before a note must be a whole number, 0 or more.');
    expect(bad.text).toContain("There's no engine called nope.");
    expect(bad.text).toContain('The account must be one this workspace may use');
    expect(bad.text).toContain('24-hour time');
    expect(readFileSync(chiefFile, 'utf8')).toBe(chiefBefore);

    const saved = (
      await post('/w/default/settings', {
        seen: view.seen,
        name: 'Home',
        description: 'Everything at home',
        maxDepth: '3',
        tidyAt: 'off',
        postsAs: 'Home desk',
        engine: 'codex',
        model: 'gpt-6',
        permissions: 'ask',
      })
    ).json();
    expect(saved).toEqual({
      ok: true,
      text: 'Saved. Not committed to git. The service uses it once it restarts.',
    });
    const yaml = readFileSync(yamlFile, 'utf8');
    expect(yaml).toContain('# Kept by hand.');
    // A new description goes beside the name.
    expect(yaml).toMatch(/^name: "Home"\ndescription: Everything at home\n/m);
    const loaded = (await loadInstall(home)).workspaces.find((w) => w.id === 'default');
    expect(loaded?.config).toMatchObject({
      name: 'Home',
      description: 'Everything at home',
      sessions: { max_depth: 3 },
      knowledge: { tidy_at: false },
      identity: { name: 'Home desk' },
    });
    const chief = loaded?.agents.find((a) => a.definition.name === 'chief-of-staff');
    expect(chief?.config).toMatchObject({ engine: 'codex', model: 'gpt-6', permissions: 'ask' });
    // The agent file's instructions are kept as they were.
    expect(readFileSync(chiefFile, 'utf8')).toContain(
      chiefBefore.split('---').slice(2).join('---'),
    );

    const again = (await get('/w/default/settings')).json();
    expect(again.seen).not.toBe(view.seen);
    expect((await post('/w/default/settings', { seen: again.seen, name: 'Home' })).json()).toEqual({
      ok: true,
      text: 'Nothing changed.',
    });
  });

  it('lists and restarts conversations through the service, and says so without one', async () => {
    expect((await get('/w/default/conversations')).json()).toMatchObject({
      conversations: [],
      problem: expect.stringContaining("The service isn't running") as string,
    });
    expect(
      (await post('/w/default/conversations', { 's:root': 'hand-over' })).json(),
    ).toMatchObject({
      ok: false,
      text: expect.stringContaining("The service isn't running") as string,
    });
    expect((await post('/w/default/conversations', { 's:root': 'later' })).json()).toMatchObject({
      ok: false,
      text: 'Choose carry on, hand over or start fresh.',
    });
    // A chat thread's session shows its handovers; another kind shows none.
    expect((await get('/w/default/sessions/root')).json().handovers).toEqual([]);
  });

  it("says so when there's no service to restart", async () => {
    const restarted = (await post('/restart', {})).json();
    expect(restarted).toMatchObject({ ok: false });
    expect(restarted.text).toContain("The service isn't running");
  });

  it("says so when the service isn't there to send to", async () => {
    const sent = (
      await post('/w/default/sessions/child', { action: 'send', text: 'Any news?' })
    ).json();
    expect(sent).toMatchObject({ ok: false });
    expect(sent.text).toContain("The service isn't running");
  });

  it("won't send to a chat thread's session, and says to reply in the thread", async () => {
    const state = await StateStore.open(paths(home, env).store);
    await new ConversationStore(state).set('default:slack:D1:1', {
      workspace: 'default',
      connection: 'slack',
      channel: 'D1',
      thread: '1',
      sessionId: 'thread-id',
      sessionName: 'default-thread',
      createdAt: '2026-11-16T10:00:00.000Z',
      lastActiveAt: '2026-11-16T10:00:00.000Z',
    });
    expect(state.workspace('default').session('thread-id')).toMatchObject({ kind: 'thread' });
    state.close();
    const sent = (
      await post('/w/default/sessions/thread-id', { action: 'send', text: 'Any news?' })
    ).json();
    expect(sent).toEqual({
      ok: false,
      text: "Not sent: it's a conversation in chat. Reply in its chat thread, and it hears you there.",
    });
  });

  it('gives how a slow send turned out, even a failure, once', async () => {
    await web.close();
    web = await startWeb({
      home,
      env,
      registry: new DriverRegistry(),
      port: 0,
      appDir,
      sendWaitMs: 20,
    });
    const socket = paths(home, env).socket;
    mkdirSync(dirname(socket), { recursive: true });
    const slowService = createServer((conn) => {
      conn.on('data', () => {
        setTimeout(() => conn.end('{"ok":false,"error":"it could not be resumed"}\n'), 150);
      });
    });
    await new Promise<void>((done) => slowService.listen(socket, done));
    try {
      const first = (
        await post('/w/default/sessions/child', { action: 'send', text: 'Any news?' })
      ).json();
      expect(first.text).toMatch(/^Sending: it's starting up first/);
      await new Promise((done) => setTimeout(done, 400));
      expect((await get('/w/default/sessions/child')).json().outcome).toEqual({
        ok: false,
        text: "Your message wasn't sent: it could not be resumed",
      });
      expect((await get('/w/default/sessions/child')).json().outcome).toBeNull();
    } finally {
      await new Promise((done) => slowService.close(done));
    }
  });

  it('shows approvals waiting and answered, and answers one through the service as the person', async () => {
    const state = await StateStore.open(paths(home, env).store);
    const sessions = state.workspace('default');
    const asked = new Date(Date.now() - 60_000).toISOString();
    const expires = new Date(Date.now() + 3_600_000).toISOString();
    const base = {
      kind: 'request' as const,
      askerSession: 'child',
      askerAgent: 'default/chief-of-staff',
      personOnly: false,
      chiefSession: null,
      details: 'Two quotes, both under £40.',
      choices: ['Approve', 'Decline'],
      fingerprint: 'f',
      askedAt: asked,
      expiresAt: expires,
    };
    sessions.addApproval({
      ...base,
      id: 'a1b2c3',
      decider: 'person',
      question: 'Book the cheaper one?',
    });
    sessions.addApproval({
      ...base,
      id: 'd4e5f6',
      decider: 'chief',
      question: 'Email the marina?',
    });
    sessions.answerApproval(
      'd4e5f6',
      { answer: 'Decline', reason: 'Not yet.', by: 'chief', via: 'session', at: asked },
      ['waiting'],
    );
    state.close();
    const review = (await get('/w/default/review')).json();
    expect(review.approvals.open).toMatchObject([
      {
        id: 'a1b2c3',
        question: 'Book the cheaper one?',
        waitingOn: 'person',
        askedBy: 'chief-of-staff',
        working: 'Check prices',
        ask: 'Shortlist marinas for the winter',
      },
    ]);
    expect(review.approvals.history).toMatchObject([
      {
        id: 'd4e5f6',
        state: 'answered',
        answer: 'Decline',
        answeredBy: 'chief',
        reason: 'Not yet.',
      },
    ]);

    // Answering goes to the service, as the person, from the web app.
    const socket = paths(home, env).socket;
    mkdirSync(dirname(socket), { recursive: true });
    const seen: unknown[] = [];
    const service = createServer((conn) => {
      conn.on('data', (chunk: Buffer) => {
        seen.push(JSON.parse(chunk.toString()));
        conn.end('{"ok":true,"approval":{"answer":"Approve"}}\n');
      });
    });
    await new Promise<void>((done) => service.listen(socket, done));
    try {
      expect((await post('/w/default/approvals/a1b2c3', {})).json()).toEqual({
        ok: false,
        text: 'Choose an answer.',
      });
      const answered = (
        await post('/w/default/approvals/a1b2c3', { choice: 'Approve', reason: 'Cheaper.' })
      ).json();
      expect(answered).toEqual({ ok: true, text: 'Answered: Approve. Whoever asked is told.' });
      expect(seen).toEqual([
        {
          op: 'approval-answer',
          caller: { workspace: 'default' },
          id: 'a1b2c3',
          choice: 'Approve',
          reason: 'Cheaper.',
          via: 'web',
        },
      ]);
    } finally {
      await new Promise((done) => service.close(done));
    }
  });

  it('holds one review change at a time across processes, and never takes over an abandoned lock', async () => {
    const state = paths(home, env).state;
    const file = join(home, 'shared.txt');
    writeFileSync(file, '');
    // Two writers that each read, wait, then write: without the lock one would lose the other's line.
    const append = (line: string) =>
      withReviewLock(state, async () => {
        const before = readFileSync(file, 'utf8');
        await new Promise((done) => setTimeout(done, 50));
        writeFileSync(file, `${before}${line}\n`);
      });
    await Promise.all([append('one'), append('two')]);
    expect(readFileSync(file, 'utf8').split('\n').filter(Boolean).sort()).toEqual(['one', 'two']);
    // A lock left by a process that died is never taken over, since two processes could both
    // take it: both contenders are told how to clear it, and neither runs.
    const lock = join(state, 'review', '.lock');
    mkdirSync(lock, { recursive: true });
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, old, old);
    let ran = 0;
    const contend = () =>
      withReviewLock(state, () => {
        ran += 1;
        return Promise.resolve();
      });
    const results = await Promise.allSettled([contend(), contend()]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(String((results[0] as PromiseRejectedResult).reason)).toContain(
      'Another review seems stuck',
    );
    expect(ran).toBe(0);
    expect(existsSync(lock)).toBe(true);
  });
});
