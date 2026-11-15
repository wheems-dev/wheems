import { resolve } from 'node:path';
import type { Command } from 'commander';
import { defaultHome, paths } from '../../home.js';
import { request, type ControlRequest, type ControlResponse } from '../../service/control.js';
import type { SessionDetails } from '../../service/sessions.js';
import type { SessionRecord } from '../../state/store.js';
import { callerFrom, workspaceHere } from '../caller.js';
import type { Io } from '../program.js';
import { since } from './service.js';

const homeHelp = 'the install folder (default: $WHEEMS_HOME or ~/wheems)';
const workspaceHelp =
  "the workspace, when you run it yourself (default: the one whose folder you're in); inside a session it's always the session's own";
const STATES = ['starting', 'working', 'idle', 'stopped', 'ended'] as const;
const KINDS = ['thread', 'adhoc', 'task'] as const;

/** `wheems session`: start, find, show and end ad-hoc sessions, through the service. */
export function registerSession(program: Command, io: Io): void {
  const session = program
    .command('session')
    .description(
      'Start, find and end sessions: agent sessions that stay open for one piece of work',
    );

  /** Who's calling: the session, or the person, in the workspace named or whose folder it is. */
  const caller = (options: { workspace?: string; home?: string }) =>
    callerFrom(
      io.env,
      options.workspace ?? workspaceHere(io, resolve(options.home ?? defaultHome(io.env))),
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

  const create = (command: Command, notice?: () => void) =>
    command
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
          notice?.();
          const answer = await ask(
            options,
            {
              op: 'session-new',
              caller: caller(options),
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

  create(session.command('create'));
  // The old name, kept for a release: it says what it's called now.
  create(session.command('new', { hidden: true }), () => {
    io.err('wheems session new is now wheems session create.\n');
  });

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
          caller: caller(options),
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
          caller: caller(options),
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
        caller: caller(options),
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
    .command('send')
    .description(
      'Send a message into a session, resuming it if it has stopped; its answer comes back to you',
    )
    .argument('<id>', "the session's id, or owner for your own owner (inside a session)")
    .argument('[text...]', 'the message; "-" or nothing reads it from standard input')
    .option('--wait', 'wait for its answer and print it (up to --timeout)')
    .option(
      '--timeout <seconds>',
      'how long --wait waits; after that the answer comes back as without --wait',
      '600',
    )
    .option('--workspace <id>', workspaceHelp)
    .option('--json', 'print the result as JSON')
    .option('--home <dir>', homeHelp)
    .action(
      async (
        id: string,
        words: string[],
        options: {
          wait?: boolean;
          timeout: string;
          workspace?: string;
          json?: boolean;
          home?: string;
        },
      ) => {
        const seconds = Number(options.timeout);
        if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) {
          throw new Error('--timeout is a whole number of seconds, from 1 to 3600');
        }
        const text = (
          words.length === 0 || (words.length === 1 && words[0] === '-')
            ? await io.stdin()
            : words.join(' ')
        ).trim();
        if (text === '') throw new Error('Nothing to send.');
        const wait = options.wait === true;
        const answer = await ask(
          options,
          {
            op: 'session-send',
            caller: caller(options),
            id,
            text,
            ...(wait && { wait: true, wait_seconds: seconds }),
          },
          // Resuming a stopped session can take its start-up time; a wait, as long as it waits.
          (wait ? seconds : 0) * 1000 + 180_000,
        );
        if (options.json === true) {
          const { ok: _ok, ...rest } = answer;
          io.out(`${JSON.stringify(rest, null, 2)}\n`);
          return;
        }
        if (answer.answer !== undefined) {
          io.out(`${answer.answer.trim()}\n`);
          return;
        }
        io.out(`Sent to ${id}. ${answer.message ?? ''}\n`);
      },
    );

  session
    .command('end')
    .description('End an ad-hoc session you own: it is asked for its note first')
    .argument('<id>', "the session's id")
    .option('--workspace <id>', workspaceHelp)
    .option('--home <dir>', homeHelp)
    .action(async (id: string, options: { workspace?: string; home?: string }) => {
      const answer = await ask(
        options,
        { op: 'session-end', caller: caller(options), id },
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
  if (details.messages.length > 0) {
    lines.push('', 'Recent messages:');
    for (const m of details.messages) {
      const way = m.receiver === s.id ? `from ${m.sender ?? 'the person'}` : `to ${m.receiver}`;
      lines.push(`- ${way}, ${since(m.sentAt, now)} ago, ${m.state}: ${m.preview}`);
    }
  }
  if (details.runtimeId !== null) lines.push('', `Watch it: hc attach ${details.runtimeId}`);
  return `${lines.join('\n')}\n`;
}
