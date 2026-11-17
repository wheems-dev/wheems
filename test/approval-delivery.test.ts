import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LoadedWorkspace } from '../src/config/load.js';
import type { InstallConfig } from '../src/config/schemas.js';
import { ApprovalService } from '../src/service/approvals.js';
import type { ChatPoster } from '../src/service/poster.js';
import type { Caller, SessionService } from '../src/service/sessions.js';
import { StateStore, type SessionRecord } from '../src/state/store.js';

/** Delivering an approval's outcome, with the sessions and chat stood in for. */
describe('approval delivery', () => {
  let dir: string;
  let state: StateStore;
  /** Every message Wheems kept for a session, and whether keeping it should fail. */
  let sent: { to: string; text: string }[];
  let failFor: Set<string>;
  let approvals: ApprovalService;
  let worker: SessionRecord;
  let chief: SessionRecord;
  const workspace = {
    id: 'acme',
    config: { name: 'Acme', channels: {} },
  } as unknown as LoadedWorkspace;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ad-'));
    state = await StateStore.open(join(dir, 'state.sqlite'));
    const now = new Date().toISOString();
    worker = state.workspace('acme').create({
      id: 'worker',
      project: null,
      agent: 'acme/developer',
      owner: 'acme/chief-of-staff',
      // Its chief's thread is stood in for, so it isn't in the store.
      parent: null,
      title: 'Checkout fix',
      purpose: 'Fix it.',
      ask: null,
      herdrName: 'acme-sworker',
      folder: dir,
      createdAt: now,
    });
    chief = { ...worker, id: 'chief', kind: 'thread', parent: null, agent: 'acme/chief-of-staff' };
    sent = [];
    failFor = new Set();
    const sessions = {
      chiefThreadOf: () => chief,
      ownerOf: () => chief,
      notify: (_ws: string, to: string, _about: string | null, text: string) => {
        if (failFor.has(to)) return Promise.reject(new Error('the store is busy'));
        sent.push({ to, text });
        return Promise.resolve(true);
      },
    } as unknown as SessionService;
    const poster = {
      inThread: () => Promise.resolve(null),
      toChannel: () =>
        Promise.resolve({ connection: 'slack', channel: 'C1', thread: null, message: '1' }),
      update: () => Promise.resolve(),
      hasButtons: () => true,
      people: () => ['UME'],
    } as unknown as ChatPoster;
    approvals = new ApprovalService({
      install: { connections: {} } as unknown as InstallConfig,
      workspaces: [workspace],
      state,
      sessions,
      poster,
      tickMs: 0,
    });
  });

  afterEach(() => {
    approvals.stop();
    state.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const as = (session: SessionRecord | null): Caller => ({ workspace, session, owner: null });

  it("doesn't send a waiting asker its answer again when telling the chief fails", async () => {
    const asking = approvals.request(as(worker), {
      question: 'Deploy to production?',
      wait: true,
      waitSeconds: 30,
    });
    await waitFor(() => sent.length === 1);
    const id = /approval ([0-9a-f]{6})/.exec(sent[0]!.text)![1]!;
    await approvals.escalate(as(chief), id, 'Production, so yours.');
    sent.length = 0;
    // Telling the chief fails the first time, after the waiting asker has its answer.
    failFor.add('chief');
    await approvals.answer(as(null), id, 'Approve');
    const result = await asking;
    expect(result.settled).toMatchObject({ answer: 'Approve' });
    expect(sent).toEqual([]);
    expect(state.workspace('acme').approval(id)).toMatchObject({
      deliveredAt: null,
      deliveredTo: ['worker'],
    });
    // The retry tells only the chief.
    failFor.clear();
    await approvals.tick();
    expect(sent.map((s) => s.to)).toEqual(['chief']);
    expect(state.workspace('acme').approval(id)?.deliveredAt).not.toBeNull();
    await approvals.tick();
    expect(sent).toHaveLength(1);
  });
});

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}
