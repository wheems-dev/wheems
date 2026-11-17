/**
 * Approvals: questions that wait for a decision (docs/approvals.md). An agent asks its decider:
 * a sub-agent asks its chief, which answers it or brings it to the person; the chief asks the
 * person. The person only ever deals with the chief: everything posted for them is in the
 * chief's name, in the chat thread the work came from.
 *
 * In milestone 3 an approval is a promise the agents keep: nothing yet stops an agent acting
 * without one. The record is kept ready for the broker, which will make it the gate.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { LoadedWorkspace } from '../config/load.js';
import type { InstallConfig } from '../config/schemas.js';
import type { Button, ButtonPress, InboundMessage } from '../contracts/channel.js';
import { holdsCredential } from '../knowledge/notes.js';
import type {
  AnsweredVia,
  ApprovalRecord,
  ApprovalState,
  Decider,
  SessionRecord,
  StateStore,
} from '../state/store.js';
import type { ChatPoster, Post, Posted } from './poster.js';
import type { Caller, SessionService } from './sessions.js';

export const DEFAULT_CHOICES = ['Approve', 'Decline'] as const;
const MAX_CHOICES = 4;
const CHOICE_LIMIT = 30;
const QUESTION_LIMIT = 300;
/** Details are cut to this, not refused. */
export const DETAILS_LIMIT = 3000;
const REASON_LIMIT = 1000;
const NOTE_LIMIT = 1000;
/** Most approvals one session may have open at once. */
export const MAX_OPEN_PER_SESSION = 5;
export const DEFAULT_EXPIRES_SECONDS = 24 * 3600;
export const MAX_EXPIRES_SECONDS = 7 * 24 * 3600;
/** The longest `request --wait` waits, as `session send --wait` does. */
export const DEFAULT_WAIT_SECONDS = 600;
/** The hour, local time, after which the day's list of the chief's decisions goes out. */
const DAILY_LIST_HOUR = 18;
/** Ids are short, so the person can type one: six hex digits. */
const ID_PATTERN = /^[0-9a-f]{6}$/;
const OPEN: readonly ApprovalState[] = ['waiting', 'escalated'];

export interface NewRequest {
  question: string;
  details?: string;
  choices?: string[];
  expiresSeconds?: number;
  wait?: boolean;
  waitSeconds?: number;
}

export interface RequestResult {
  approval: ApprovalRecord;
  /** With `wait`, the approval once settled in time; null when it wasn't. */
  settled: ApprovalRecord | null;
  /** What happens next, when it hasn't been settled here. */
  next: string;
}

export interface ApprovalServiceOptions {
  install: InstallConfig;
  workspaces: LoadedWorkspace[];
  state: StateStore;
  sessions: SessionService;
  poster: ChatPoster;
  log?: (message: string) => void;
  /** How often to expire approvals and send the daily list, in milliseconds. 0 for never. */
  tickMs?: number;
  now?: () => Date;
}

export class ApprovalService {
  private readonly log: (message: string) => void;
  private readonly now: () => Date;
  /** Askers waiting on an answer with `request --wait`, by approval id. */
  private readonly waiters = new Map<string, (approval: ApprovalRecord | null) => void>();
  /** Approvals whose outcome is being delivered now. */
  private readonly settling = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private stopped = false;
  /** The local day the daily list last went out, so it goes once a day. */
  private listedDay: string | null = null;

  constructor(private readonly options: ApprovalServiceOptions) {
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? (() => new Date());
  }

  /**
   * At service start: expires what ran out while it was down, delivers outcomes that hadn't
   * reached their agent, and from then on checks each minute.
   */
  async start(): Promise<void> {
    await this.tick();
    const every = this.options.tickMs ?? 60_000;
    if (every > 0) {
      this.timer = setInterval(() => void this.tick(), every);
      this.timer.unref();
    }
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    for (const resolve of [...this.waiters.values()]) resolve(null);
    this.waiters.clear();
  }

  /** Expires the approvals that have run out, and changes their posts to say so. */
  private async expireOverdue(): Promise<void> {
    for (const approval of this.options.state.expireApprovals(this.now())) {
      this.log(`Approval ${approval.id} in ${approval.workspace} expired with no answer`);
      await this.redraw(approval);
    }
  }

  /** Expires approvals that ran out, delivers outcomes not yet delivered, and the daily list. */
  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      await this.expireOverdue();
      for (const approval of this.options.state.undeliveredApprovals()) {
        await this.settle(approval);
      }
      await this.dailyList();
    } catch (error) {
      this.log(`Approvals: ${describe(error)}`);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Asks the caller's decider: a sub-agent's chief, or for the chief, the person. Returns at once
   * with the approval, or with `wait`, once it's answered or the wait runs out.
   */
  async request(caller: Caller, request: NewRequest): Promise<RequestResult> {
    const asker = caller.session;
    if (asker === null) {
      throw new Error(
        'Approvals are asked by agents. You answer them: wheems approval list shows what is waiting.',
      );
    }
    const workspace = caller.workspace;
    const question = request.question.trim();
    if (question === '') throw new Error('The question is empty.');
    if (question.includes('\n')) {
      throw new Error('The question is one line. Put the rest in --details.');
    }
    if (question.length > QUESTION_LIMIT) {
      throw new Error(
        `The question is longer than ${String(QUESTION_LIMIT)} characters. Put the rest in --details.`,
      );
    }
    let details = request.details?.trim() ?? '';
    if (details.length > DETAILS_LIMIT) details = `${details.slice(0, DETAILS_LIMIT)}…`;
    if (holdsCredential(question) || holdsCredential(details)) {
      throw new Error(
        'That looks like it has a password, token or other secret in it. Approvals are posted in chat: leave secrets out.',
      );
    }
    const choices = checkChoices(request.choices ?? [...DEFAULT_CHOICES]);
    const seconds = request.expiresSeconds ?? DEFAULT_EXPIRES_SECONDS;
    if (!Number.isFinite(seconds) || seconds < 60 || seconds > MAX_EXPIRES_SECONDS) {
      throw new Error('An approval can stay open from a minute to a week (--expires).');
    }
    const sessions = this.options.state.workspace(workspace.id);
    const open = sessions.openApprovals(asker.id);
    if (open >= MAX_OPEN_PER_SESSION) {
      throw new Error(
        `You already have ${String(open)} approvals waiting, the most allowed. Wait for an answer, or take one back with wheems approval withdraw <id>.`,
      );
    }
    const chief = this.options.sessions.chiefThreadOf(asker);
    // A sub-agent asks its chief; the chief, or a session with no chief above it, asks the person.
    const decider: Decider = asker.kind !== 'thread' && chief !== null ? 'chief' : 'person';
    const now = this.now();
    const approval = sessions.addApproval({
      id: this.newId(),
      kind: 'request',
      askerSession: asker.id,
      askerAgent: asker.agent,
      decider,
      personOnly: false,
      chiefSession: chief?.id ?? null,
      question,
      details: details === '' ? null : details,
      choices,
      fingerprint: fingerprint('request', question, details, choices),
      askedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + seconds * 1000).toISOString(),
    });
    this.log(
      `Approval ${approval.id} in ${workspace.id}: session ${asker.id} asked the ${decider}: ${question}`,
    );
    // Waiting starts before anyone is asked, so an answer can't slip past it.
    const settled = request.wait === true ? this.waitFor(approval.id, request.waitSeconds) : null;
    try {
      if (decider === 'chief' && chief !== null) {
        const kept = await this.options.sessions.notify(
          workspace.id,
          chief.id,
          asker.id,
          this.forChief(approval, asker),
        );
        if (!kept) throw new Error("your chief of staff's conversation can't be reached");
      } else {
        await this.postForPerson(workspace, approval);
      }
    } catch (error) {
      // Nobody could be asked: it's taken back, rather than left to wait for nobody.
      sessions.withdrawApproval(approval.id, this.now().toISOString());
      this.waiters.get(approval.id)?.(approval);
      throw new Error(`Couldn't ask for approval ${approval.id}: ${describe(error)}`, {
        cause: error,
      });
    }
    const who = decider === 'chief' ? 'your chief of staff' : 'the person';
    const later =
      asker.kind === 'thread'
        ? 'The answer will come to you in this conversation, as a message from Wheems.'
        : 'The answer will be typed into your session, as a message from Wheems.';
    if (settled === null) {
      return {
        approval: sessions.approval(approval.id) ?? approval,
        settled: null,
        next: `Asked ${who}. ${later}`,
      };
    }
    const outcome = await settled;
    return {
      approval: sessions.approval(approval.id) ?? approval,
      settled: outcome,
      next:
        outcome === null
          ? `Not answered within ${String(this.waitSeconds(request.waitSeconds))} seconds. ${later}`
          : '',
    };
  }

  /**
   * Answers an approval: the chief, for a request from its team that's still its to decide; or
   * the person (no calling session), for any approval still open.
   */
  async answer(
    caller: Caller,
    id: string,
    choice: string,
    options: { reason?: string; via?: AnsweredVia } = {},
  ): Promise<ApprovalRecord> {
    const approval = this.find(caller, id);
    const me = caller.session;
    const by: Decider = me === null ? 'person' : 'chief';
    if (me !== null) {
      if (me.kind !== 'thread') {
        throw new Error(
          'Only your chief of staff or the person answers approvals. Ask yours with wheems approval request.',
        );
      }
      if (approval.askerSession === me.id) {
        throw new Error(`You asked approval ${id}, so you can't answer it: the person does.`);
      }
      if (approval.personOnly) {
        throw new Error(
          `Approval ${id} is the person's only. Bring it to them with wheems approval escalate ${id}.`,
        );
      }
      if (approval.decider !== 'chief' || approval.state === 'escalated') {
        throw new Error(`Approval ${id} is waiting on the person, not you.`);
      }
    }
    this.checkOpen(approval);
    const answer = matchChoice(approval.choices, choice);
    const reason = options.reason?.trim() ?? '';
    if (reason.length > REASON_LIMIT) {
      throw new Error(`The reason is longer than ${String(REASON_LIMIT)} characters.`);
    }
    const via: AnsweredVia = me === null ? (options.via ?? 'terminal') : 'session';
    const sessions = this.options.state.workspace(caller.workspace.id);
    const counted = sessions.answerApproval(
      id,
      { answer, reason: reason === '' ? null : reason, by, via, at: this.now().toISOString() },
      by === 'chief' ? ['waiting'] : OPEN,
    );
    if (!counted) {
      // Someone else's answer came first, and it stands; or it had run out, and is expired now.
      await this.expireOverdue();
      throw new Error(
        `Approval ${id} was ${describeState(sessions.approval(id) ?? approval)} already.`,
      );
    }
    const now = sessions.approval(id) ?? approval;
    this.log(`Approval ${id} in ${caller.workspace.id}: ${answer}, by the ${by} (${via})`);
    await this.redraw(now);
    await this.settle(now);
    return now;
  }

  /** The chief brings a request from its team to the person, with its note. */
  async escalate(caller: Caller, id: string, note?: string): Promise<ApprovalRecord> {
    const approval = this.find(caller, id);
    const me = caller.session;
    if (me?.kind !== 'thread') {
      throw new Error('Only your chief of staff brings an approval to the person.');
    }
    if (approval.decider !== 'chief') {
      throw new Error(`Approval ${id} is already the person's to answer.`);
    }
    if (approval.state === 'escalated')
      throw new Error(`Approval ${id} is already with the person.`);
    this.checkOpen(approval);
    const text = note?.trim() ?? '';
    if (text.length > NOTE_LIMIT) {
      throw new Error(`The note is longer than ${String(NOTE_LIMIT)} characters.`);
    }
    if (holdsCredential(text)) {
      throw new Error('That note looks like it has a secret in it. Leave secrets out of chat.');
    }
    const sessions = this.options.state.workspace(caller.workspace.id);
    if (!sessions.escalateApproval(id, text === '' ? null : text, this.now().toISOString())) {
      await this.expireOverdue();
      throw new Error(
        `Approval ${id} was ${describeState(sessions.approval(id) ?? approval)} already.`,
      );
    }
    const escalated = sessions.approval(id) ?? approval;
    this.log(`Approval ${id} in ${caller.workspace.id}: brought to the person`);
    try {
      await this.postForPerson(caller.workspace, escalated);
    } catch (error) {
      this.log(`Couldn't post approval ${id} for the person: ${describe(error)}`);
      throw new Error(
        `Approval ${id} is with the person now, but posting it failed: ${describe(error)}. Tell them in your answer, and they can answer it with wheems approval answer.`,
        { cause: error },
      );
    }
    return sessions.approval(id) ?? escalated;
  }

  /** The agent that asked takes its request back. */
  async withdraw(caller: Caller, id: string): Promise<ApprovalRecord> {
    const approval = this.find(caller, id);
    if (caller.session === null || approval.askerSession !== caller.session.id) {
      throw new Error(`Only the agent that asked can take approval ${id} back.`);
    }
    this.checkOpen(approval);
    return this.takeBack(approval, 'asked');
  }

  /** On ending a session: withdraws the approvals it has open. */
  async withdrawFor(session: SessionRecord): Promise<void> {
    const sessions = this.options.state.workspace(session.workspace);
    for (const approval of sessions.approvals({ states: OPEN, askerSession: session.id })) {
      await this.takeBack(approval, 'ended').catch((error: unknown) => {
        this.log(`Couldn't withdraw approval ${approval.id}: ${describe(error)}`);
      });
    }
  }

  /**
   * What the caller may see: the person, everything; a chief, everything in the workspace; any
   * other session, what it asked. Open ones only, unless `all`.
   */
  list(caller: Caller, options: { all?: boolean } = {}): ApprovalRecord[] {
    const sessions = this.options.state.workspace(caller.workspace.id);
    const me = caller.session;
    return sessions.approvals({
      ...(options.all !== true && { states: OPEN }),
      ...(me !== null && me.kind !== 'thread' && { askerSession: me.id }),
      limit: options.all === true ? 100 : 50,
    });
  }

  show(caller: Caller, id: string): ApprovalRecord {
    return this.find(caller, id);
  }

  /**
   * A press of an approval's button: the person answering, if it's theirs to press. A later
   * press changes nothing; the post is redrawn as it stands.
   */
  async press(connection: string, event: ButtonPress): Promise<boolean> {
    const parsed = /^approval:([0-9a-f]{6}):(\d)$/.exec(event.buttonId);
    if (!parsed) return false;
    const [, id = '', index = '0'] = parsed;
    const approval = this.options.state.approvalAnywhere(id);
    if (
      approval?.post?.connection !== connection ||
      approval.post.channel !== event.channel ||
      approval.post.message !== event.messageId
    ) {
      this.log(`A press on ${connection} for approval ${id} didn't match its post; ignored`);
      return true;
    }
    if (!this.options.poster.people(connection).includes(event.userId)) {
      this.log(
        `Ignored a press on approval ${id} from ${event.userId}, who is not in allowed_users`,
      );
      return true;
    }
    const choice = approval.choices[Number(index)];
    if (choice === undefined || !OPEN.includes(approval.state)) {
      await this.redraw(approval);
      return true;
    }
    const workspace = this.workspace(approval.workspace);
    try {
      await this.answer({ workspace, session: null, owner: null }, id, choice, { via: 'chat' });
    } catch (error) {
      this.log(`Approval ${id}: ${describe(error)}`);
      await this.redraw(this.options.state.approvalAnywhere(id) ?? approval);
    }
    return true;
  }

  /**
   * A message in chat that answers an approval in words, such as `approve a1b2c3`, for
   * channels without buttons. True when it was one, and has been dealt with.
   */
  async replyInWords(connection: string, event: InboundMessage): Promise<boolean> {
    const words = /^\s*(.+?)\s+([0-9a-f]{6})\s*[.!]?\s*$/i.exec(event.text);
    if (!words) return false;
    const [, said = '', id = ''] = words;
    const approval = this.options.state.approvalAnywhere(id.toLowerCase());
    if (approval?.post?.connection !== connection) return false;
    if (!this.options.poster.people(connection).includes(event.userId)) return false;
    let choice: string;
    try {
      choice = matchChoice(approval.choices, said);
    } catch {
      return false;
    }
    if (!OPEN.includes(approval.state)) {
      await this.redraw(approval);
      return true;
    }
    const workspace = this.workspace(approval.workspace);
    await this.answer({ workspace, session: null, owner: null }, approval.id, choice, {
      via: 'chat',
    }).catch(async (error: unknown) => {
      this.log(`Approval ${approval.id}: ${describe(error)}`);
      await this.redraw(this.options.state.approvalAnywhere(approval.id) ?? approval);
    });
    return true;
  }

  // ---------------------------------------------------------------------------

  /** Withdraws an open approval, redraws its post, and tells the chief if it was waiting on it. */
  private async takeBack(
    approval: ApprovalRecord,
    why: 'asked' | 'ended',
  ): Promise<ApprovalRecord> {
    const sessions = this.options.state.workspace(approval.workspace);
    if (!sessions.withdrawApproval(approval.id, this.now().toISOString())) {
      throw new Error(
        `Approval ${approval.id} was ${describeState(sessions.approval(approval.id) ?? approval)} already.`,
      );
    }
    const now = sessions.approval(approval.id) ?? approval;
    this.log(`Approval ${approval.id} in ${approval.workspace}: withdrawn (${why})`);
    this.waiters.get(approval.id)?.(now);
    await this.redraw(now);
    if (approval.decider === 'chief' && approval.chiefSession !== null) {
      const asker = approval.askerSession ?? 'an agent';
      await this.options.sessions
        .notify(
          approval.workspace,
          approval.chiefSession,
          approval.askerSession,
          `Wheems: approval ${approval.id} from session ${asker} was withdrawn${why === 'ended' ? ', because the session ended' : ''}: "${approval.question}". It no longer needs an answer.`,
        )
        .catch((error: unknown) => {
          this.log(
            `Couldn't tell the chief approval ${approval.id} was withdrawn: ${describe(error)}`,
          );
        });
    }
    return now;
  }

  /**
   * Delivers an answered or expired approval's outcome: to the asker waiting on it, or as a
   * message from Wheems (to its owner, if it has ended); and to the chief too, when the person
   * decided a request from its team. Marked first, so it's delivered once; each message is kept
   * as a hand-back, so a restart delivers it again if it hadn't arrived.
   */
  private async settle(approval: ApprovalRecord): Promise<void> {
    if (approval.state !== 'answered' && approval.state !== 'expired') return;
    // One at a time: an answer and the minute's check could otherwise both deliver it.
    if (this.settling.has(approval.id)) return;
    this.settling.add(approval.id);
    try {
      await this.settleNow(approval);
    } finally {
      this.settling.delete(approval.id);
    }
  }

  private async settleNow(approval: ApprovalRecord): Promise<void> {
    const sessions = this.options.state.workspace(approval.workspace);
    if (sessions.approval(approval.id)?.deliveredAt !== null) return;
    const asker =
      approval.askerSession !== null ? sessions.session(approval.askerSession) : undefined;
    const chief = approval.chiefSession;
    // The chief hears what the person decided for its team, so it stays in charge of the work.
    const chiefToo =
      chief !== null && chief !== approval.askerSession && approval.answeredBy !== 'chief';
    const sends: { to: string; about: string | null; text: string }[] = [];
    const waiter = this.waiters.get(approval.id);
    if (waiter) {
      // The asker hears it from the command it's waiting on.
      waiter(approval);
    } else if (asker && asker.state !== 'ended') {
      sends.push({ to: asker.id, about: null, text: outcomeText(approval) });
    } else {
      // Its asker has ended: its owner hears instead, unless that's the chief, told below.
      const owner = asker ? this.options.sessions.ownerOf(asker) : null;
      const to = owner?.id ?? chief;
      if (to !== null && !(chiefToo && to === chief)) {
        sends.push({
          to,
          about: approval.askerSession,
          text: `${outcomeText(approval, 'its')} Session ${approval.askerSession ?? ''} has ended, so this comes to you.`,
        });
      } else if (!chiefToo) {
        this.log(`Approval ${approval.id}'s outcome had no one to go to`);
      }
    }
    if (chiefToo) {
      const told =
        asker && asker.state !== 'ended'
          ? ' It has been told.'
          : ' It has ended, so act on it yourself if it still matters.';
      sends.push({
        to: chief,
        about: approval.askerSession,
        text: `${outcomeText(approval, 'its')} That was session ${approval.askerSession ?? ''}'s request.${told}`,
      });
    }
    // Marked delivered once each message is kept, which delivers it again after a restart if
    // need be. One not kept because the service is stopping is tried again when it next starts.
    let again = false;
    const done = new Set(sessions.approval(approval.id)?.deliveredTo ?? []);
    for (const send of sends) {
      // Kept for it on an earlier try: a retry doesn't send it twice.
      if (done.has(send.to)) continue;
      try {
        const kept = await this.options.sessions.notify(
          approval.workspace,
          send.to,
          send.about,
          send.text,
        );
        if (kept) sessions.markApprovalDeliveredTo(approval.id, send.to);
        if (!kept && this.stopped) again = true;
        else if (!kept)
          this.log(`Approval ${approval.id}'s outcome couldn't reach session ${send.to}`);
      } catch (error) {
        again = true;
        this.log(
          `Couldn't deliver approval ${approval.id}'s outcome to ${send.to}: ${describe(error)}`,
        );
      }
    }
    if (!again) sessions.markApprovalDelivered(approval.id, this.now().toISOString());
  }

  /** Posts an approval for the person, with buttons, mentioning them. */
  private async postForPerson(workspace: LoadedWorkspace, approval: ApprovalRecord): Promise<void> {
    const sessions = this.options.state.workspace(workspace.id);
    const post = (connection: string): Post => ({
      text: postText(workspace, approval, sessions.session(approval.askerSession ?? ''), {
        buttons: this.options.poster.hasButtons(connection),
      }),
      buttons: buttonsFor(approval),
      mention: true,
    });
    const { poster } = this.options;
    let posted: Posted | null = null;
    if (approval.chiefSession !== null) {
      const thread = this.options.state.threadKeyOf(approval.chiefSession);
      const connection =
        thread !== undefined ? this.options.state.conversation(thread)?.connection : undefined;
      if (connection !== undefined) {
        posted = await poster.inThread(workspace, approval.chiefSession, post(connection));
      }
    }
    if (posted === null) {
      const connection = this.connectionFor(workspace, 'approvals');
      posted = await poster.toChannel(workspace, 'approvals', post(connection));
    }
    sessions.setApprovalPost(approval.id, posted);
  }

  /** Changes an approval's post to show it as it stands now, its buttons gone once it's closed. */
  private async redraw(approval: ApprovalRecord): Promise<void> {
    if (approval.post === null) return;
    const workspace = this.workspaceOrNull(approval.workspace);
    if (!workspace) return;
    const sessions = this.options.state.workspace(workspace.id);
    try {
      await this.options.poster.update(workspace, approval.post, {
        text: postText(workspace, approval, sessions.session(approval.askerSession ?? ''), {
          buttons: this.options.poster.hasButtons(approval.post.connection),
        }),
        buttons: OPEN.includes(approval.state) ? buttonsFor(approval) : [],
      });
    } catch (error) {
      this.log(`Couldn't change approval ${approval.id}'s post: ${describe(error)}`);
    }
  }

  /** The message that brings a team request to the chief. */
  private forChief(approval: ApprovalRecord, asker: SessionRecord): string {
    const details = approval.details !== null ? `\n\n${quote(approval.details)}` : '';
    return `Wheems: approval ${approval.id} from session ${asker.id} ("${asker.title ?? ''}", ${agentName(asker.agent)}) is waiting on you:

${quote(approval.question)}${details}

Choices: ${approval.choices.join(', ')}. Open until ${when(approval.expiresAt)}.

Decide it with the wheems-approvals skill. If it's yours to decide (Decisions, in your instructions, says what's the person's), answer it: wheems approval answer ${approval.id} "<choice>". If it's the person's, bring it to them: wheems approval escalate ${approval.id} --note "…".`;
  }

  private waitFor(id: string, seconds?: number): Promise<ApprovalRecord | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => {
          this.waiters.delete(id);
          resolve(null);
        },
        this.waitSeconds(seconds) * 1000,
      );
      this.waiters.set(id, (approval) => {
        clearTimeout(timer);
        this.waiters.delete(id);
        resolve(approval);
      });
    });
  }

  private waitSeconds(seconds?: number): number {
    return Math.min(3600, Math.max(1, seconds ?? DEFAULT_WAIT_SECONDS));
  }

  /** Each day after six, each chief's decisions since its last list, to the person. */
  private async dailyList(): Promise<void> {
    const now = this.now();
    const day = now.toDateString();
    if (now.getHours() < DAILY_LIST_HOUR || this.listedDay === day) return;
    this.listedDay = day;
    for (const workspace of this.options.workspaces) {
      if (!workspace.config) continue;
      const sessions = this.options.state.workspace(workspace.id);
      const decisions = sessions.unreportedDecisions();
      if (decisions.length === 0) continue;
      const lines = decisions.map((d) => {
        const asker = d.askerSession !== null ? sessions.session(d.askerSession) : undefined;
        const reason = d.reason !== null ? ` (${d.reason})` : '';
        return `- ${d.answer ?? ''} on "${d.question}", for ${agentName(asker?.agent ?? d.askerAgent)}${reason}`;
      });
      try {
        await this.options.poster.toChannel(workspace, 'updates', {
          text: `**Decisions I made since my last list**\n\n${lines.join('\n')}\n\n_Tell me if any of these should have been yours._`,
        });
        sessions.markReported(
          decisions.map((d) => d.id),
          now.toISOString(),
        );
      } catch (error) {
        this.log(`Couldn't post ${workspace.id}'s daily list of decisions: ${describe(error)}`);
      }
    }
  }

  /** An approval in the caller's workspace that the caller may see. */
  private find(caller: Caller, id: string): ApprovalRecord {
    const clean = id.trim().toLowerCase();
    const approval = ID_PATTERN.test(clean)
      ? this.options.state.workspace(caller.workspace.id).approval(clean)
      : undefined;
    const me = caller.session;
    if (!approval || (me !== null && me.kind !== 'thread' && approval.askerSession !== me.id)) {
      throw new Error(`No approval ${id} in ${caller.workspace.id}.`);
    }
    return approval;
  }

  private checkOpen(approval: ApprovalRecord): void {
    if (!OPEN.includes(approval.state)) {
      throw new Error(`Approval ${approval.id} was ${describeState(approval)} already.`);
    }
  }

  private connectionFor(workspace: LoadedWorkspace, name: string): string {
    const named = workspace.config?.channels[name];
    if (named) return named.connection;
    return workspace.config?.channels.chat?.connection ?? '';
  }

  private newId(): string {
    for (let attempt = 0; attempt < 20; attempt++) {
      const id = randomBytes(3).toString('hex');
      if (!this.options.state.approvalAnywhere(id)) return id;
    }
    throw new Error("Couldn't find a free approval id");
  }

  private workspace(id: string): LoadedWorkspace {
    const workspace = this.workspaceOrNull(id);
    if (!workspace) throw new Error(`Workspace ${id} isn't running`);
    return workspace;
  }

  private workspaceOrNull(id: string): LoadedWorkspace | null {
    return this.options.workspaces.find((w) => w.id === id && w.config !== null) ?? null;
  }
}

/** Checks a list of choices: two to four short, different labels. */
export function checkChoices(choices: readonly string[]): string[] {
  const clean = choices.map((c) => c.trim()).filter((c) => c !== '');
  if (clean.length < 2 || clean.length > MAX_CHOICES) {
    throw new Error(`Give two to ${String(MAX_CHOICES)} choices.`);
  }
  const seen = new Set<string>();
  for (const choice of clean) {
    if (choice.length > CHOICE_LIMIT) {
      throw new Error(`Each choice is ${String(CHOICE_LIMIT)} characters at most: "${choice}".`);
    }
    if (choice.includes('\n')) throw new Error('Each choice is one line.');
    if (seen.has(choice.toLowerCase())) throw new Error(`"${choice}" is given twice.`);
    seen.add(choice.toLowerCase());
  }
  return clean;
}

/** The choice a word names, matched without regard to case; throws for none. */
export function matchChoice(choices: readonly string[], said: string): string {
  const word = said.trim().toLowerCase();
  const found = choices.find((c) => c.toLowerCase() === word);
  if (found === undefined) {
    throw new Error(`"${said.trim()}" isn't one of its choices: ${choices.join(', ')}.`);
  }
  return found;
}

/** A fingerprint of exactly what was asked, so an answer can be tied to it. */
function fingerprint(kind: string, question: string, details: string, choices: string[]): string {
  return createHash('sha256')
    .update(JSON.stringify({ kind, question, details, choices }))
    .digest('hex');
}

function buttonsFor(approval: ApprovalRecord): Button[] {
  const last = approval.choices.length - 1;
  return approval.choices.map((label, index) => ({
    id: `approval:${approval.id}:${String(index)}`,
    label,
    // The first choice is the yes, the last the no.
    ...(index === 0
      ? { style: 'primary' as const }
      : index === last
        ? { style: 'danger' as const }
        : {}),
  }));
}

/** The post the person sees for an approval, as it stands. */
export function postText(
  workspace: LoadedWorkspace,
  approval: ApprovalRecord,
  asker: SessionRecord | undefined,
  options: { buttons: boolean },
): string {
  const chief =
    workspace.config?.identity?.name ??
    `${workspace.config?.name ?? workspace.id}'s chief of staff`;
  const open = OPEN.includes(approval.state);
  const head = open
    ? `**Approval needed** · _${chief}_`
    : `**Approval ${approval.state === 'answered' ? `answered: ${approval.answer ?? ''}` : approval.state}** · _${chief}_`;
  const parts = [head, approval.question];
  if (approval.details !== null) parts.push(approval.details);
  if (asker && asker.kind !== 'thread') {
    parts.push(`_Asked by ${agentName(asker.agent)}, working on "${asker.title ?? ''}"._`);
  }
  if (approval.note !== null) parts.push(`_My note: ${approval.note}_`);
  if (open) {
    const how = options.buttons
      ? ''
      : ` Answer with ${approval.choices.map((c) => `\`${c.toLowerCase()} ${approval.id}\``).join(' or ')}.`;
    parts.push(`_Open until ${when(approval.expiresAt)}. Approval ${approval.id}.${how}_`);
  } else {
    parts.push(`_${closedLine(approval)}_`);
  }
  return parts.join('\n\n');
}

/** How an approval ended, in a line. */
function closedLine(approval: ApprovalRecord): string {
  const at = approval.answeredAt !== null ? when(approval.answeredAt) : '';
  switch (approval.state) {
    case 'answered': {
      const who = approval.answeredBy === 'person' ? 'you' : 'me';
      const reason = approval.reason !== null ? ` Reason: ${approval.reason}` : '';
      return `${approval.answer ?? ''}, by ${who}, ${at}.${reason}`;
    }
    case 'expired':
      return `Expired with no answer, ${at}. Nothing was approved.`;
    case 'withdrawn':
      return `Withdrawn, ${at}: no longer needed.`;
    default:
      return '';
  }
}

/** The message that tells an asker how its approval ended. */
export function outcomeText(approval: ApprovalRecord, whose: 'your' | 'its' = 'your'): string {
  const asked = whose === 'your' ? 'Your question was' : 'The question was';
  if (approval.state === 'expired') {
    return `Wheems: approval ${approval.id} expired with no answer, so it isn't approved. ${asked}: "${approval.question}".${whose === 'your' ? ' Ask again if you still need it.' : ''}`;
  }
  const who =
    approval.answeredBy === 'person'
      ? 'the person'
      : whose === 'your'
        ? 'your chief of staff'
        : 'you';
  const at = approval.answeredAt !== null ? `, ${when(approval.answeredAt)}` : '';
  const reason = approval.reason !== null ? ` Reason: ${approval.reason}.` : '';
  return `Wheems: approval ${approval.id} answered: ${approval.answer ?? ''} (by ${who}${at}).${reason} ${asked}: "${approval.question}"`;
}

function describeState(approval: ApprovalRecord): string {
  switch (approval.state) {
    case 'answered':
      return `answered (${approval.answer ?? ''})`;
    case 'escalated':
      return 'brought to the person';
    default:
      return approval.state;
  }
}

/** A time as the person reads it: "18 Nov, 14:02". */
export function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const day = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${day}, ${time}`;
}

function agentName(agent: string | null | undefined): string {
  return agent?.split('/').at(-1) ?? 'an agent';
}

function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
