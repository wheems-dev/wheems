import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initWorkspace } from '../src/cli/commands/init.js';
import { defaultIo, run } from '../src/cli/program.js';
import { installYaml } from '../src/cli/templates.js';
import type { FinalMessage } from '../src/contracts/engine.js';
import { DriverRegistry } from '../src/contracts/registry.js';
import { paths } from '../src/home.js';
import { writeSecret } from '../src/secrets.js';
import { conversationKey, uuidFor } from '../src/service/conversations.js';
import { runService, type RunningService } from '../src/service/service.js';
import { StateStore, type ApprovalRecord, type SessionRecord } from '../src/state/store.js';
import { MemoryChannel, MemoryRuntime, StubEngine } from '../src/testing/index.js';
import { fakeAgent, type Behaviour } from './helpers/fake-agent.js';

describe('approvals', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let channel: MemoryChannel;
  let runtime: MemoryRuntime;
  let service: RunningService | undefined;
  let received: Map<string, string[]>;
  let answers: Map<string, FinalMessage[]>;
  let behave: (line: string) => Behaviour;

  const wheems = async (args: string[], as: Record<string, string> = {}, stdin = '') => {
    let out = '';
    let err = '';
    const previous = process.exitCode;
    process.exitCode = undefined;
    try {
      const code = await run(args, {
        ...defaultIo(),
        out: (t) => (out += t),
        err: (t) => (err += t),
        env: { ...env, ...as },
        color: false,
        stdin: () => Promise.resolve(stdin),
      });
      return { code, out, err };
    } finally {
      process.exitCode = previous;
    }
  };

  const start = async () => {
    const stub = new StubEngine({ command: ['fake-agent'], answers });
    const registry = new DriverRegistry()
      .register('runtime', 'herdr', () => runtime)
      .register('engine', 'claude-code', () => stub, { label: 'Claude Code', description: 'x' })
      .register('channel', 'slack', () => channel);
    service = await runService({
      home,
      registry,
      node: '/usr/local/bin/node',
      cli: '/opt/wheems/dist/cli/main.js',
      version: '9.9.9',
      env,
      log: () => undefined,
      pollMs: 5,
      startupSeconds: 2,
      noteSweepMs: 0,
      approvalTickMs: 20,
    });
  };

  const stored = async <T>(read: (state: StateStore) => T): Promise<T> => {
    const state = await StateStore.open(paths(home, env).store, { readOnly: true });
    try {
      return read(state);
    } finally {
      state.close();
    }
  };
  const approval = (id: string) =>
    stored((s) => s.workspace('personal').approval(id) as ApprovalRecord);

  /** Changes the store directly, as nothing else can: to make time pass. */
  const write = (sql: string, ...values: string[]) => {
    const db = new DatabaseSync(paths(home, env).store);
    try {
      db.prepare(sql).run(...values);
    } finally {
      db.close();
    }
  };

  /** A chief's thread session, started by a message in chat; returns its environment. */
  const chiefThread = async (text = 'hello'): Promise<Record<string, string>> => {
    const before = channel.sent.length;
    const thread = await channel.receive({ channel: 'D1', text, userId: 'UME', direct: true });
    await waitFor(() => channel.sent.length > before);
    const key = conversationKey('personal', 'slack', 'D1', thread);
    return { WHEEMS_SESSION: uuidFor(key), WHEEMS_CONVERSATION: key };
  };

  /** What a session (by its Wheems id) has been sent. */
  const heard = async (sessionId: string): Promise<string[]> => {
    const [live] = await runtime.list({ labels: { wheems: sessionId } });
    return live ? (received.get(live.id) ?? []) : [];
  };

  /** An ad-hoc session the chief started, and its environment. */
  const teamSession = async (
    chief: Record<string, string>,
    title = 'checkout fix',
  ): Promise<{ session: SessionRecord; as: Record<string, string> }> => {
    const result = await wheems(
      [
        'session',
        'create',
        '--title',
        title,
        '--purpose',
        `fix the ${title}`,
        '--done-when',
        'tests pass',
        '--json',
      ],
      chief,
    );
    expect(result.err).toBe('');
    const session = JSON.parse(result.out) as SessionRecord;
    await waitFor(async () => (await heard(session.id)).length > 0);
    return { session, as: { WHEEMS_SESSION: session.id } };
  };

  const ask = async (as: Record<string, string>, question: string, extra: string[] = []) => {
    const result = await wheems(['approval', 'request', question, ...extra, '--json'], as);
    expect(result.err).toBe('');
    return JSON.parse(result.out) as ApprovalRecord;
  };

  /** The post for an approval, as the channel shows it now. */
  const postOf = (record: ApprovalRecord) =>
    channel.sent.find((m) => m.buttons?.some((b) => b.id.startsWith(`approval:${record.id}:`)));

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'ap-'));
    env = { ...process.env, WHEEMS_HOME: home, WHEEMS_SECRETS: join(home, 'secrets.json') };
    delete env.WHEEMS_SESSION;
    delete env.WHEEMS_CONVERSATION;
    writeFileSync(
      join(home, 'install.yaml'),
      installYaml().replace('allowed_users: []', 'allowed_users: [UME]'),
    );
    await initWorkspace({ home, id: 'personal' });
    await writeSecret(env.WHEEMS_SECRETS!, 'slack', { bot_token: 'x', app_token: 'y' });
    channel = new MemoryChannel();
    behave = (line) => (line.startsWith('hello') ? 'reply' : 'answer');
    received = new Map();
    answers = new Map();
    runtime = new MemoryRuntime({
      'fake-agent': fakeAgent({
        behaviour: (line) => behave(line),
        reply: async (conversation, text) => {
          const result = await wheems(['chat', 'reply', text], {
            WHEEMS_CONVERSATION: conversation,
          });
          if (result.code !== 0) throw new Error(result.err);
        },
        received,
        answers,
      }),
    });
    await start();
  });

  afterEach(async () => {
    await service?.stop();
    service = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  it("posts the chief's question in its thread, and one tap answers it", async () => {
    const chief = await chiefThread();
    const asked = await ask(chief, 'Deploy storefront to staging?', [
      '--details',
      'The checkout fix is on fix/checkout-total; tests pass.',
    ]);
    expect(asked).toMatchObject({
      decider: 'person',
      state: 'waiting',
      chiefSession: chief.WHEEMS_SESSION,
      choices: ['Approve', 'Decline'],
    });
    expect(asked.id).toMatch(/^[0-9a-f]{6}$/);

    const post = postOf(asked);
    expect(post).toBeDefined();
    // In the chief's thread, in its name, mentioning the person.
    expect(post).toMatchObject({
      channel: 'D1',
      threadId: asked.post?.thread,
      mentions: ['UME'],
      identity: { name: 'Personal chief of staff' },
    });
    expect(post!.text).toContain('**Approval needed**');
    expect(post!.text).toContain('Deploy storefront to staging?');
    expect(post!.text).toContain('The checkout fix is on fix/checkout-total');
    expect(post!.buttons).toEqual([
      { id: `approval:${asked.id}:0`, label: 'Approve', style: 'primary' },
      { id: `approval:${asked.id}:1`, label: 'Decline', style: 'danger' },
    ]);

    // Someone else's press counts for nothing.
    await channel.press({
      channel: 'D1',
      messageId: post!.messageId,
      buttonId: `approval:${asked.id}:0`,
      userId: 'USOMEONE',
    });
    expect((await approval(asked.id)).state).toBe('waiting');

    await channel.press({
      channel: 'D1',
      messageId: post!.messageId,
      buttonId: `approval:${asked.id}:0`,
      userId: 'UME',
    });
    const answered = await approval(asked.id);
    expect(answered).toMatchObject({
      state: 'answered',
      answer: 'Approve',
      answeredBy: 'person',
      answeredVia: 'chat',
    });
    // The post changes in place: the answer shown, the buttons gone.
    const changed = channel.sent.find((m) => m.messageId === post!.messageId)!;
    expect(changed.buttons).toBeUndefined();
    expect(changed.text).toContain('**Approval answered: Approve**');
    expect(changed.text).toContain('Approve, by you,');
    // The chief hears the answer in its conversation, and carries on there.
    await waitFor(async () =>
      (await heard(chief.WHEEMS_SESSION!)).some((m) =>
        m.startsWith(`Wheems: approval ${asked.id} answered: Approve (by the person`),
      ),
    );
    await waitFor(async () => (await approval(asked.id)).deliveredAt !== null);

    // A later press changes nothing: the first answer stands, and the post is redrawn as it is.
    const updates = channel.updates.length;
    await channel
      .press({
        channel: 'D1',
        messageId: post!.messageId,
        buttonId: `approval:${asked.id}:0`,
        userId: 'UME',
      })
      .catch(() => undefined);
    expect((await approval(asked.id)).answer).toBe('Approve');
    expect(channel.updates.length).toBeGreaterThanOrEqual(updates);
  });

  it('brings a request from the team to the chief, which answers it itself', async () => {
    const chief = await chiefThread();
    const { session, as } = await teamSession(chief);
    const asked = await ask(as, 'Merge the fix to the staging branch?');
    expect(asked).toMatchObject({
      decider: 'chief',
      askerSession: session.id,
      chiefSession: chief.WHEEMS_SESSION,
    });
    // Nothing is posted for the person: the chief decides this one.
    expect(postOf(asked)).toBeUndefined();
    await waitFor(async () =>
      (await heard(chief.WHEEMS_SESSION!)).some((m) =>
        m.startsWith(`Wheems: approval ${asked.id} from session ${session.id}`),
      ),
    );
    const told = (await heard(chief.WHEEMS_SESSION!)).find((m) => m.includes(asked.id))!;
    expect(told).toContain('Merge the fix to the staging branch?');
    expect(told).toContain(`wheems approval answer ${asked.id}`);
    expect(told).toContain(`wheems approval escalate ${asked.id}`);

    // The team member can't answer its own, nor can anyone but the chief or the person.
    expect((await wheems(['approval', 'answer', asked.id, 'Approve'], as)).err).toContain(
      'Only your chief of staff or the person answers approvals',
    );
    const answer = await wheems(
      ['approval', 'answer', asked.id, 'approve', '--reason', 'Staging only.'],
      chief,
    );
    expect(answer.err).toBe('');
    expect(await approval(asked.id)).toMatchObject({
      state: 'answered',
      answer: 'Approve',
      answeredBy: 'chief',
      answeredVia: 'session',
      reason: 'Staging only.',
    });
    await waitFor(async () =>
      (await heard(session.id)).some((m) =>
        m.startsWith(`Wheems: approval ${asked.id} answered: Approve (by your chief of staff`),
      ),
    );
    const outcome = (await heard(session.id)).find((m) =>
      m.includes(`approval ${asked.id} answered`),
    );
    expect(outcome).toContain('Reason: Staging only.');
    // A second answer doesn't count.
    expect((await wheems(['approval', 'answer', asked.id, 'Decline'], chief)).err).toContain(
      'answered (Approve) already',
    );
  });

  it('lets the chief bring a request to the person, and tells both the answer', async () => {
    const chief = await chiefThread();
    const { session, as } = await teamSession(chief);
    const asked = await ask(as, 'Deploy storefront to production?', [
      '--choices',
      'Now,Tonight,Neither',
    ]);
    const escalated = await wheems(
      ['approval', 'escalate', asked.id, '--note', 'Production, so it is yours.'],
      chief,
    );
    expect(escalated.err).toBe('');
    const now = await approval(asked.id);
    expect(now.state).toBe('escalated');
    const post = postOf(now)!;
    expect(post.threadId).toBe(now.post?.thread);
    expect(post.text).toContain('_Asked by chief-of-staff, working on "checkout fix"._');
    expect(post.text).toContain('_My note: Production, so it is yours._');
    expect(post.buttons?.map((b) => b.label)).toEqual(['Now', 'Tonight', 'Neither']);
    // Once it's the person's, the chief can't answer it.
    expect((await wheems(['approval', 'answer', asked.id, 'Now'], chief)).err).toContain(
      'waiting on the person, not you',
    );

    await channel.press({
      channel: 'D1',
      messageId: post.messageId,
      buttonId: `approval:${asked.id}:1`,
      userId: 'UME',
    });
    expect((await approval(asked.id)).answer).toBe('Tonight');
    await waitFor(async () =>
      (await heard(session.id)).some((m) =>
        m.startsWith(`Wheems: approval ${asked.id} answered: Tonight (by the person`),
      ),
    );
    await waitFor(async () =>
      (await heard(chief.WHEEMS_SESSION!)).some(
        (m) =>
          m.includes(`approval ${asked.id} answered: Tonight`) &&
          m.includes(`That was session ${session.id}'s request. It has been told.`),
      ),
    );
  });

  it("refuses what isn't the caller's, and checks what's asked", async () => {
    const chief = await chiefThread();
    const { as } = await teamSession(chief);
    const { as: other } = await teamSession(chief, 'other job');
    const mine = await ask(chief, 'Spend £20 on a domain?');
    // The chief can't answer its own question: the person does.
    expect((await wheems(['approval', 'answer', mine.id, 'Approve'], chief)).err).toContain(
      'You asked approval',
    );
    // A team member sees only its own requests.
    const theirs = await ask(as, 'Rename the branch?');
    expect((await wheems(['approval', 'show', theirs.id], other)).err).toContain(
      `No approval ${theirs.id}`,
    );
    expect((await wheems(['approval', 'withdraw', theirs.id], other)).err).toContain(
      `No approval ${theirs.id}`,
    );
    // The person asks nothing: they answer.
    expect((await wheems(['approval', 'request', 'Go?'])).err).toContain(
      'Approvals are asked by agents',
    );
    expect((await wheems(['approval', 'request', 'one\ntwo'], as)).err).toContain(
      'The question is one line',
    );
    expect(
      (await wheems(['approval', 'request', 'Pick', '--choices', 'Only one'], as)).err,
    ).toContain('Give two to 4 choices');
    expect(
      (await wheems(['approval', 'request', 'Use password=hunter2hunter2?'], as)).err,
    ).toContain('secret');
    expect((await wheems(['approval', 'request', 'Go?', '--expires', '30d'], as)).err).toContain(
      'from a minute to a week',
    );
    for (let i = 1; i < 5; i++) await ask(as, `Question ${String(i)}?`);
    expect((await wheems(['approval', 'request', 'One too many?'], as)).err).toContain(
      'You already have 5 approvals waiting',
    );

    // The person sees everything waiting, and can answer any of it from a terminal.
    const list = await wheems(['approval', 'list']);
    expect(list.out).toContain(mine.id);
    expect(list.out).toContain(theirs.id);
    expect((await wheems(['approval', 'answer', theirs.id, 'Decline'])).err).toBe('');
    expect(await approval(theirs.id)).toMatchObject({
      answer: 'Decline',
      answeredBy: 'person',
      answeredVia: 'terminal',
    });
    expect((await wheems(['approval', 'answer', mine.id, 'Maybe'])).err).toContain(
      `"Maybe" isn't one of its choices: Approve, Decline.`,
    );
    const shown = await wheems(['approval', 'show', mine.id]);
    expect(shown.out).toContain(`Approval ${mine.id}: Spend £20 on a domain?`);
  });

  it('takes a request back when its asker withdraws it or ends', async () => {
    const chief = await chiefThread();
    const asked = await ask(chief, 'Publish the post?');
    expect((await wheems(['approval', 'withdraw', asked.id], chief)).err).toBe('');
    expect((await approval(asked.id)).state).toBe('withdrawn');
    const post = channel.sent.find((m) => m.messageId === asked.post?.message)!;
    expect(post.buttons).toBeUndefined();
    expect(post.text).toContain('Withdrawn,');

    const { session, as } = await teamSession(chief);
    const waiting = await ask(as, 'Delete the old branch?');
    expect((await wheems(['session', 'end', session.id], chief)).err).toBe('');
    await waitFor(async () => (await approval(waiting.id)).state === 'withdrawn');
    await waitFor(async () =>
      (await heard(chief.WHEEMS_SESSION!)).some((m) =>
        m.includes(
          `approval ${waiting.id} from session ${session.id} was withdrawn, because the session ended`,
        ),
      ),
    );
  });

  it('waits for the answer with --wait, and then hands nothing back', async () => {
    const chief = await chiefThread();
    const { session, as } = await teamSession(chief);
    const waiting = wheems(['approval', 'request', 'Merge it?', '--wait', '--timeout', '20'], as);
    await waitFor(
      async () =>
        (await stored((s) => s.workspace('personal').approvals({ states: ['waiting'] }))).length ===
        1,
    );
    const [open] = await stored((s) => s.workspace('personal').approvals({ states: ['waiting'] }));
    expect((await wheems(['approval', 'answer', open!.id, 'Approve'], chief)).err).toBe('');
    const result = await waiting;
    expect(result.err).toBe('');
    expect(result.out).toBe(`Approval ${open!.id} answered: Approve (by the chief of staff).\n`);
    await new Promise((r) => setTimeout(r, 100));
    expect((await heard(session.id)).some((m) => m.includes(`approval ${open!.id} answered`))).toBe(
      false,
    );
  });

  it('expires what nobody answered, and says so', async () => {
    const chief = await chiefThread();
    const { session, as } = await teamSession(chief);
    const asked = await ask(as, 'Rename the product?', ['--expires', '2h']);
    const mine = await ask(chief, 'Order the boxes?');
    write(
      'UPDATE approvals SET expires_at = ? WHERE id IN (?, ?)',
      new Date(Date.now() - 1000).toISOString(),
      asked.id,
      mine.id,
    );
    await waitFor(async () => (await approval(asked.id)).state === 'expired');
    await waitFor(async () =>
      (await heard(session.id)).some((m) =>
        m.startsWith(`Wheems: approval ${asked.id} expired with no answer, so it isn't approved.`),
      ),
    );
    await waitFor(async () => (await approval(mine.id)).state === 'expired');
    const post = channel.sent.find((m) => m.messageId === mine.post?.message)!;
    expect(post.buttons).toBeUndefined();
    expect(post.text).toContain('Expired with no answer');
    // Silence is never a yes.
    expect((await wheems(['approval', 'answer', mine.id, 'Approve'])).err).toContain(
      'was expired already',
    );
  });

  it('delivers an answer again after a restart, if it had not been', async () => {
    const chief = await chiefThread();
    const { session, as } = await teamSession(chief);
    const asked = await ask(as, 'Merge it?');
    await service?.stop();
    service = undefined;
    // Answered while the service was away, or before its answer was kept for the asker.
    write(
      "UPDATE approvals SET state = 'answered', answer = 'Approve', answered_by = 'person', answered_via = 'terminal', answered_at = ? WHERE id = ?",
      new Date().toISOString(),
      asked.id,
    );
    await start();
    await waitFor(async () =>
      (await heard(session.id)).some((m) =>
        m.startsWith(`Wheems: approval ${asked.id} answered: Approve (by the person`),
      ),
    );
    expect((await approval(asked.id)).deliveredAt).not.toBeNull();
  });

  it('takes an answer in words on a channel without buttons', async () => {
    await service?.stop();
    channel = new MemoryChannel({ buttons: false }, { updates: false });
    await start();
    const chief = await chiefThread();
    const asked = await ask(chief, 'Send the newsletter?');
    const post = channel.sent.find((m) => m.messageId === asked.post?.message)!;
    expect(post.buttons).toBeUndefined();
    expect(post.text).toContain(`Answer with \`approve ${asked.id}\` or \`decline ${asked.id}\`.`);
    const before = channel.sent.length;
    await channel.receive({
      channel: 'D1',
      text: `Decline ${asked.id}`,
      threadId: asked.post!.thread!,
      userId: 'UME',
      direct: true,
    });
    expect(await approval(asked.id)).toMatchObject({ answer: 'Decline', answeredVia: 'chat' });
    // A channel that can't change a post gets a reply under it instead.
    const reply = channel.sent.slice(before).find((m) => m.text.includes('Decline, by you'));
    expect(reply?.threadId).toBe(asked.post?.thread);
  });

  it('posts updates from the chief to the chat channel without an updates channel', async () => {
    const chief = await chiefThread();
    const before = channel.sent.length;
    const result = await wheems(['chat', 'post', 'updates', 'Nightly backup finished.'], chief);
    expect(result.err).toBe('');
    const post = channel.sent.slice(before).find((m) => m.text === 'Nightly backup finished.');
    // Direct messages with the person, as a new post.
    expect(post).toMatchObject({ channel: 'D-UME', identity: { name: 'Personal chief of staff' } });
    expect(post?.threadId).toBeUndefined();
    const { as } = await teamSession(chief);
    expect((await wheems(['chat', 'post', 'updates', 'Hi'], as)).err).toContain(
      'Only your chief of staff posts to a channel',
    );
    expect((await wheems(['chat', 'post', 'briefs', 'Hi'], chief)).err).toContain(
      'has no briefs channel',
    );
  });
});

async function waitFor(check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}
