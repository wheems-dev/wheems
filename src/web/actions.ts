import { basename } from 'node:path';
import { loadInstall } from '../config/load.js';
import { paths } from '../home.js';
import {
  approveAboutYou,
  approveSkill,
  declineAboutYou,
  declineSkill,
  listAboutYou,
  withReviewLock,
} from '../review/review.js';
import { request } from '../service/control.js';
import { listProposals } from '../skills/proposals.js';
import { fingerprint, type WebContext } from './data.js';

/** What came of an action, shown once at the top of the page it returns to. */
export interface Flash {
  ok: boolean;
  text: string;
}

/** A submitted form: each field's values, in order. */
export type Form = Map<string, string[]>;

export function parseForm(body: string): Form {
  const form: Form = new Map();
  for (const [key, value] of new URLSearchParams(body)) {
    form.set(key, [...(form.get(key) ?? []), value]);
  }
  return form;
}

/**
 * Review changes rewrite shared files (the library, skills.yaml, agent files, about-you.md), so
 * one runs at a time: in this process by this queue, and across processes (wheems review, another
 * web app) by the install-wide review lock. Each reads what the one before left.
 */
let reviewing: Promise<unknown> = Promise.resolve();

function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const next = reviewing.then(work, work);
  reviewing = next.catch(() => undefined);
  return next;
}

function field(form: Form, name: string): string | undefined {
  return form.get(name)?.[0];
}

/**
 * Approves or declines a skill proposal from a workspace, as `wheems review` does: approving
 * adds it to the library, pins it in the workspace and gives it to the agents chosen.
 */
export function decideProposal(
  context: WebContext,
  workspace: string,
  id: string,
  form: Form,
): Promise<Flash> {
  const state = paths(context.home, context.env).state;
  return oneAtATime(() =>
    withReviewLock(state, () => decideProposalNow(context, workspace, id, form)),
  );
}

async function decideProposalNow(
  context: WebContext,
  workspace: string,
  id: string,
  form: Form,
): Promise<Flash> {
  const where = paths(context.home, context.env);
  const waiting = (await listProposals(where.state)).find(
    (p) => p.proposal.id === id && p.proposal.workspace === workspace,
  );
  if (!waiting) return { ok: false, text: 'That proposal has already been dealt with.' };
  const name = waiting.proposal.name;
  if (field(form, 'seen') !== fingerprint(waiting.text)) {
    return { ok: false, text: `${name} changed since the page showed it. Look at it again.` };
  }
  if (field(form, 'decision') === 'decline') {
    await declineSkill(waiting);
    return { ok: true, text: `Declined ${name}.` };
  }
  if (field(form, 'decision') !== 'approve')
    return { ok: false, text: 'Choose approve or decline.' };
  const install = await loadInstall(context.home);
  const known = new Set(
    install.workspaces.find((w) => w.id === workspace)?.agents.map((a) => a.definition.name) ?? [],
  );
  const agents = (form.get('agents') ?? []).filter((a) => known.has(a));
  const edited = field(form, 'text');
  const text =
    edited !== undefined && edited.trim() !== '' ? edited.replace(/\r\n/g, '\n') : waiting.text;
  try {
    const result = await approveSkill({ install, waiting, text, agents });
    const who = agents.length > 0 ? `, for ${agents.join(', ')}` : '';
    const commit = result.committed ? '' : ` Not committed: ${result.reason ?? 'unknown reason'}.`;
    return {
      ok: true,
      text: `Added ${name} version ${String(result.version)} to the library, pinned in ${workspace}${who}.${commit}`,
    };
  } catch (error) {
    return { ok: false, text: `Not approved: ${describe(error)}` };
  }
}

/** Approves or declines a suggested change to `about-you.md`, as `wheems review` does. */
export function decideAboutYou(context: WebContext, name: string, form: Form): Promise<Flash> {
  const state = paths(context.home, context.env).state;
  return oneAtATime(() => withReviewLock(state, () => decideAboutYouNow(context, name, form)));
}

async function decideAboutYouNow(context: WebContext, name: string, form: Form): Promise<Flash> {
  const where = paths(context.home, context.env);
  const install = await loadInstall(context.home);
  const suggestion = (
    await listAboutYou(
      where.state,
      install.workspaces.map((w) => w.id),
    )
  ).find((s) => basename(s.file) === name);
  if (!suggestion) return { ok: false, text: 'That suggestion has already been dealt with.' };
  // Only the version the page showed, in full, is approved.
  if (field(form, 'seen') !== fingerprint(suggestion.text)) {
    return {
      ok: false,
      text: 'The suggestion changed since the page showed it. Look at it again.',
    };
  }
  if (field(form, 'decision') === 'decline') {
    await declineAboutYou(suggestion);
    return { ok: true, text: 'Declined the change to about-you.md.' };
  }
  if (field(form, 'decision') !== 'approve')
    return { ok: false, text: 'Choose approve or decline.' };
  try {
    const result = await approveAboutYou({
      home: context.home,
      aboutYouFile: where.aboutYou,
      suggestion,
      text: suggestion.text,
    });
    return {
      ok: true,
      text: `Updated about-you.md.${result.committed ? '' : ` Not committed: ${result.reason ?? 'unknown reason'}.`}`,
    };
  } catch (error) {
    return { ok: false, text: `Not approved: ${describe(error)}` };
  }
}

/** How long a send waits for the service before saying the session is starting up. */
const SEND_WAIT_MS = 15_000;

/**
 * Sends a message into a session, or ends one, through the service, as `wheems session send`
 * and `wheems session end` do, as the person, in the session's workspace.
 */
export async function actOnSession(
  context: WebContext,
  workspace: string,
  id: string,
  form: Form,
  log: (message: string) => void,
  /** Records how a slow send or end turned out, for the session's page to show next. */
  later: (flash: Flash) => void,
  /** How long a send waits before the page moves on; tests shorten it. */
  waitMs = SEND_WAIT_MS,
): Promise<Flash> {
  const where = paths(context.home, context.env);
  const caller = { workspace };
  const action = field(form, 'action');
  if (action === 'send') {
    const text = (field(form, 'text') ?? '').replace(/\r\n/g, '\n').trim();
    if (text === '') return { ok: false, text: 'Write a message to send.' };
    const sending = request(where.socket, { op: 'session-send', caller, id, text }, 180_000);
    const outcome = await Promise.race([
      sending.then(
        (answer) => answer,
        (error: unknown) => error as Error,
      ),
      after(waitMs),
    ]);
    if (outcome === 'slow') {
      sending.then(
        (answer) => {
          if (answer.ok) later({ ok: true, text: 'Your message was delivered.' });
          else {
            log(`Sending to ${id}: ${answer.error}`);
            later({ ok: false, text: `Your message wasn't sent: ${answer.error}` });
          }
        },
        (error: unknown) => {
          log(`Sending to ${id}: ${describe(error)}`);
          later({ ok: false, text: notReached(error as Error) });
        },
      );
      return {
        ok: true,
        text: "Sending: it's starting up first. Reload this page to see whether it was delivered.",
      };
    }
    if (outcome instanceof Error) return { ok: false, text: notReached(outcome) };
    return outcome.ok
      ? { ok: true, text: 'Sent. Its answer will show here when it has one.' }
      : { ok: false, text: `Not sent: ${outcome.error}` };
  }
  if (action === 'end') {
    // A session gets up to ten minutes to write its note, so the page doesn't wait for it.
    const ending = request(where.socket, { op: 'session-end', caller, id }, 12 * 60_000);
    const quick = await Promise.race([
      ending.then(
        (answer) => answer,
        (error: unknown) => error as Error,
      ),
      after(Math.min(waitMs, 3000)),
    ]);
    if (quick === 'slow') {
      ending.then(
        (answer) => {
          if (answer.ok) later({ ok: true, text: 'It has ended.' });
          else {
            log(`Ending ${id}: ${answer.error}`);
            later({ ok: false, text: `It wasn't ended: ${answer.error}` });
          }
        },
        (error: unknown) => {
          log(`Ending ${id}: ${describe(error)}`);
          later({ ok: false, text: notReached(error as Error) });
        },
      );
      return {
        ok: true,
        text: 'Ending it: it writes its note first, then stops. Reload this page to see when it has.',
      };
    }
    if (quick instanceof Error) return { ok: false, text: notReached(quick) };
    return quick.ok
      ? { ok: true, text: 'Ended it.' }
      : { ok: false, text: `Not ended: ${quick.error}` };
  }
  return { ok: false, text: 'Choose send or end.' };
}

/** 'slow' after a while, so a page needn't wait for the service longer than that. */
function after(ms: number): Promise<'slow'> {
  return new Promise((done) => {
    setTimeout(() => {
      done('slow');
    }, ms).unref();
  });
}

function notReached(error: Error): string {
  return /not running/.test(error.message)
    ? "The service isn't running, so nothing was sent. Start it with wheems start."
    : `The service didn't answer: ${error.message}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
