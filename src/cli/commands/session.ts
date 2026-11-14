import { resolve } from 'node:path';
import type { Command } from 'commander';
import { defaultHome, paths } from '../../home.js';
import { request, type ControlRequest, type ControlResponse } from '../../service/control.js';
import type { SessionDetails } from '../../service/sessions.js';
import type { SessionRecord } from '../../state/store.js';
import { callerFrom } from '../caller.js';
import type { Io } from '../program.js';
import { since } from './service.js';

const homeHelp = 'the install folder (default: $WHEEMS_HOME or ~/wheems)';
const workspaceHelp =
  "the workspace, when you run it yourself; inside a session it's always the session's own";
const STATES = ['starting', 'working', 'idle', 'stopped', 'ended'] as const;
const KINDS = ['thread', 'adhoc', 'task'] as const;

/** `wheems session`: start, find, show and end ad-hoc sessions, through the service. */
export function registerSession(program: Command, io: Io): void {
  const session = program
    .command('session')
    .description(
      'Start, find and end sessions: agent sessions that stay open for one piece of work',
    );

  const ask = async (
    options: { home?: string },
    body: ControlRequest,
    timeoutMs?: number,
  ): Promise<ControlResponse & { ok: true }> => {
    const home = resolve(options.home ?? defaultHome(io.env));
    const answer = await request(paths(home, io.env).socket, body, timeoutMs);
    if (!answer.ok) throw new Error(answer.error);
    return answer;
  };

  session
    .command('new')
    .description('Start an ad-hoc session, owned by you, working on its purpose at once')
    .argument('[agent]', "the agent in the workspace's agents/ (default: your own)")
    .requiredOption('--title <title>', 'a short title, one line')
    .requiredOption('--purpose <text>', 'what it is for: what to do and what to hand back')
    .option('--project <name>', 'the project it works on (milestone 4)')
    .option('--workspace <id>', workspaceHelp)
    .option('--json', 'print the session as JSON')
    .option('--home <dir>', homeHelp)
    .action(
      async (
        agent: string | undefined,
        options: {
          title: string;
          purpose: string;
          project?: string;
          workspace?: string;
          json?: boolean;
          home?: string;
        },
      ) => {
        const answer = await ask(
          options,
          {
            op: 'session-new',
            caller: callerFrom(io.env, options.workspace),
            title: options.title,
            purpose: options.purpose,
            ...(agent !== undefined && { agent }),
            ...(options.project !== undefined && { project: options.project }),
          },
          // Starting an agent can take a while: up to its start-up time before it reports in.
          180_000,
        );
        const created = answer.session;
        if (!created) throw new Error('The service started no session');
        if (options.json === true) {
          io.out(`${JSON.stringify(created, null, 2)}\n`);
          return;
        }
        io.out(
          `Started ${created.id} (${agentName(created)}): ${created.title ?? ''}\nIt's working on its purpose. See it with: wheems session show ${created.id}\n`,
        );
      },
    );

  session
    .command('list')
    .description('Sessions in your workspace, most recently active first (open ones unless --all)')
    .option('--mine', 'only the ones you own')
    .option('--agent <name>', 'only those running this agent')
    .option('--project <name>', 'only those on this project')
    .option('--state <state>', `only those in this state: ${STATES.join(', ')}`)
    .option('--kind <kind>', `only this kind: ${KINDS.join(', ')}`)
    .option('--all', 'include ended sessions')
    .option('--workspace <id>', workspaceHelp)
    .option('--json', 'print them as JSON')
    .option('--home <dir>', homeHelp)
    .action(
      async (options: {
        mine?: boolean;
        agent?: string;
        project?: string;
        state?: string;
        kind?: string;
        all?: boolean;
        workspace?: string;
        json?: boolean;
        home?: string;
      }) => {
        const state = oneOf('state', options.state, STATES);
        const kind = oneOf('kind', options.kind, KINDS);
        const answer = await ask(options, {
          op: 'session-list',
          caller: callerFrom(io.env, options.workspace),
          ...(options.mine === true && { mine: true }),
          ...(options.agent !== undefined && { agent: options.agent }),
          ...(options.project !== undefined && { project: options.project }),
          ...(state !== undefined && { state }),
          ...(kind !== undefined && { kind }),
          ...(options.all === true && { all: true }),
        });
        io.out(formatSessions(answer.sessions ?? [], options.json === true, 'No sessions.'));
      },
    );

  session
    .command('search')
    .description('Find sessions in your workspace by title, purpose, summary, agent or project')
    .argument('<words...>', 'what to look for')
    .option('--workspace <id>', workspaceHelp)
    .option('--json', 'print them as JSON')
    .option('--home <dir>', homeHelp)
    .action(
      async (words: string[], options: { workspace?: string; json?: boolean; home?: string }) => {
        const answer = await ask(options, {
          op: 'session-search',
          caller: callerFrom(io.env, options.workspace),
          words: words.join(' '),
        });
        io.out(formatSessions(answer.sessions ?? [], options.json === true, 'No session matches.'));
      },
    );

  session
    .command('show')
    .description("A session's details, its latest answer and how to watch it")
    .argument('<id>', "the session's id")
    .option('--workspace <id>', workspaceHelp)
    .option('--json', 'print it as JSON')
    .option('--home <dir>', homeHelp)
    .action(async (id: string, options: { workspace?: string; json?: boolean; home?: string }) => {
      const answer = await ask(options, {
        op: 'session-show',
        caller: callerFrom(io.env, options.workspace),
        id,
      });
      const details = answer.details;
      if (!details) throw new Error(`No session ${id}`);
      io.out(
        options.json === true
          ? `${JSON.stringify(details, null, 2)}\n`
          : formatDetails(details, Date.now()),
      );
    });

  session
    .command('end')
    .description('End an ad-hoc session you own: it is asked for its note first')
    .argument('<id>', "the session's id")
    .option('--workspace <id>', workspaceHelp)
    .option('--home <dir>', homeHelp)
    .action(async (id: string, options: { workspace?: string; home?: string }) => {
      const answer = await ask(
        options,
        { op: 'session-end', caller: callerFrom(io.env, options.workspace), id },
        // It gets up to ten minutes to write its note.
        12 * 60_000,
      );
      io.out(`Ended ${id}. ${answer.message ?? ''}\n`);
    });
}

function oneOf<T extends string>(
  what: string,
  value: string | undefined,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`--${what} is one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function agentName(session: SessionRecord): string {
  return session.agent?.split('/').at(-1) ?? 'agent';
}

function ownerName(session: SessionRecord): string {
  if (session.kind === 'thread') return 'a conversation';
  return session.owner === null ? 'you' : (session.owner.split('/').at(-1) ?? session.owner);
}

/** One line per session: id, agent, owner, state, when last active, and summary. */
export function formatSessions(sessions: SessionRecord[], json: boolean, none: string): string {
  if (json) return `${JSON.stringify(sessions, null, 2)}\n`;
  if (sessions.length === 0) return `${none}\n`;
  const now = Date.now();
  return `${sessions
    .map((s) => {
      const what = s.kind === 'adhoc' ? (s.title ?? '') : `${s.kind} session`;
      const summary = s.summary !== null && s.summary !== s.title ? `\n  ${s.summary}` : '';
      return `${s.id}  ${what}\n  ${agentName(s)}, owner ${ownerName(s)}, ${s.state}, active ${since(s.lastActiveAt, now)} ago${summary}`;
    })
    .join('\n')}\n`;
}

export function formatDetails(details: SessionDetails, now: number): string {
  const s = details.session;
  const lines = [
    `${s.id}  ${s.title ?? `${s.kind} session`}`,
    `Agent: ${agentName(s)}`,
    `Owner: ${ownerName(s)}`,
    `State: ${s.state}${details.status !== null ? ` (${details.status})` : ''}`,
    `Started ${since(s.createdAt, now)} ago, last active ${since(s.lastActiveAt, now)} ago${s.endedAt !== null ? `, ended ${since(s.endedAt, now)} ago` : ''}`,
  ];
  if (s.purpose !== null) lines.push('', 'Purpose:', s.purpose);
  if (s.summary !== null && s.summary !== s.purpose) lines.push('', `Summary: ${s.summary}`);
  if (details.latestAnswer !== null) lines.push('', 'Latest answer:', details.latestAnswer.trim());
  if (details.runtimeId !== null) lines.push('', `Watch it: hc attach ${details.runtimeId}`);
  return `${lines.join('\n')}\n`;
}
