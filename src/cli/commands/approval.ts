import { resolve } from 'node:path';
import type { Command } from 'commander';
import { defaultHome, paths } from '../../home.js';
import { request, type ControlRequest, type ControlResponse } from '../../service/control.js';
import type { ApprovalRecord } from '../../state/store.js';
import { callerFrom, workspaceHere } from '../caller.js';
import type { Io } from '../program.js';

const homeHelp = 'the install folder (default: $WHEEMS_HOME or ~/wheems)';
const workspaceHelp =
  "the workspace, when you run it yourself (default: the one whose folder you're in); inside a session it's always the session's own";

/**
 * `wheems approval`: ask for a decision and wait for it, answer one, bring one to the person,
 * or take one back (docs/approvals.md). Agents ask; the chief and the person answer.
 */
export function registerApproval(program: Command, io: Io): void {
  const approval = program
    .command('approval')
    .description('Ask for a decision, answer one, and see what is waiting (docs/approvals.md)');

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
  const print = (record: ApprovalRecord | undefined, json: boolean | undefined) => {
    if (!record) throw new Error('The service gave no approval back');
    io.out(json === true ? `${JSON.stringify(record, null, 2)}\n` : formatApproval(record));
  };

  approval
    .command('request')
    .description(
      'Ask for a decision: your chief of staff decides, or brings it to the person (agents run this)',
    )
    .argument('<question>', 'the question, one line, such as "Deploy storefront to staging?"')
    .option('--details <text>', 'what the decider needs to know; "-" reads it from standard input')
    .option(
      '--choices <list>',
      'two to four choices, separated by commas (default: Approve,Decline)',
    )
    .option(
      '--expires <time>',
      'how long it stays open, such as 30m, 4h or 2d (default 24h, at most 7d)',
    )
    .option('--wait', 'wait for the answer and print it (up to --timeout)')
    .option(
      '--timeout <seconds>',
      'how long --wait waits; after that the answer comes back as without --wait',
      '600',
    )
    .option('--json', 'print the approval as JSON')
    .option('--home <dir>', homeHelp)
    .action(
      async (
        question: string,
        options: {
          details?: string;
          choices?: string;
          expires?: string;
          wait?: boolean;
          timeout: string;
          json?: boolean;
          home?: string;
        },
      ) => {
        const seconds = Number(options.timeout);
        if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) {
          throw new Error('--timeout is a whole number of seconds, from 1 to 3600');
        }
        const details =
          options.details === '-' ? (await io.stdin()).trim() : options.details?.trim();
        const wait = options.wait === true;
        const answer = await ask(
          options,
          {
            op: 'approval-request',
            caller: caller({ ...(options.home !== undefined && { home: options.home }) }),
            question,
            ...(details !== undefined && details !== '' && { details }),
            ...(options.choices !== undefined && { choices: options.choices.split(',') }),
            ...(options.expires !== undefined && {
              expires_seconds: parseDuration(options.expires),
            }),
            ...(wait && { wait: true, wait_seconds: seconds }),
          },
          (wait ? seconds : 0) * 1000 + 60_000,
        );
        const record = answer.approval;
        if (!record) throw new Error('The service gave no approval back');
        if (options.json === true) {
          io.out(`${JSON.stringify(record, null, 2)}\n`);
          return;
        }
        if (
          record.state === 'answered' ||
          record.state === 'expired' ||
          record.state === 'withdrawn'
        ) {
          io.out(formatOutcome(record));
          return;
        }
        io.out(`Asked: approval ${record.id}. ${answer.message ?? ''}\n`);
      },
    );

  approval
    .command('answer')
    .description('Answer an approval: the chief for its team, or you for anything waiting on you')
    .argument('<id>', "the approval's id")
    .argument('<choice>', 'one of its choices, such as Approve or Decline')
    .option('--reason <text>', 'why, in a sentence, passed on with the answer')
    .option('--workspace <id>', workspaceHelp)
    .option('--json', 'print the approval as JSON')
    .option('--home <dir>', homeHelp)
    .action(
      async (
        id: string,
        choice: string,
        options: { reason?: string; workspace?: string; json?: boolean; home?: string },
      ) => {
        const answer = await ask(options, {
          op: 'approval-answer',
          caller: caller(options),
          id,
          choice,
          ...(options.reason !== undefined && { reason: options.reason }),
          via: 'terminal',
        });
        if (options.json === true) {
          print(answer.approval, true);
          return;
        }
        io.out(
          `Answered approval ${id}: ${answer.approval?.answer ?? choice}. Whoever asked is told.\n`,
        );
      },
    );

  approval
    .command('escalate')
    .description('Bring a request from your team to the person (chiefs run this)')
    .argument('<id>', "the approval's id")
    .option('--note <text>', 'what the person should know, in your words')
    .option('--json', 'print the approval as JSON')
    .option('--home <dir>', homeHelp)
    .action(async (id: string, options: { note?: string; json?: boolean; home?: string }) => {
      const answer = await ask(options, {
        op: 'approval-escalate',
        caller: caller({ ...(options.home !== undefined && { home: options.home }) }),
        id,
        ...(options.note !== undefined && { note: options.note }),
      });
      if (options.json === true) {
        print(answer.approval, true);
        return;
      }
      io.out(
        `Brought approval ${id} to the person. Their answer goes to the agent that asked, and to you.\n`,
      );
    });

  approval
    .command('withdraw')
    .description('Take back an approval you asked, when it is no longer needed')
    .argument('<id>', "the approval's id")
    .option('--home <dir>', homeHelp)
    .action(async (id: string, options: { home?: string }) => {
      await ask(options, {
        op: 'approval-withdraw',
        caller: caller({ ...(options.home !== undefined && { home: options.home }) }),
        id,
      });
      io.out(`Withdrew approval ${id}.\n`);
    });

  approval
    .command('list')
    .description("What's waiting for a decision (--all for the history too)")
    .option('--all', 'include answered, expired and withdrawn ones')
    .option('--workspace <id>', workspaceHelp)
    .option('--json', 'print them as JSON')
    .option('--home <dir>', homeHelp)
    .action(
      async (options: { all?: boolean; workspace?: string; json?: boolean; home?: string }) => {
        const answer = await ask(options, {
          op: 'approval-list',
          caller: caller(options),
          ...(options.all === true && { all: true }),
        });
        const list = answer.approvals ?? [];
        if (options.json === true) {
          io.out(`${JSON.stringify(list, null, 2)}\n`);
          return;
        }
        io.out(
          list.length === 0
            ? options.all === true
              ? 'No approvals.\n'
              : 'Nothing is waiting for a decision.\n'
            : `${list.map(approvalLine).join('\n')}\n`,
        );
      },
    );

  approval
    .command('show')
    .description('One approval: its question, details, choices and what became of it')
    .argument('<id>', "the approval's id")
    .option('--workspace <id>', workspaceHelp)
    .option('--json', 'print it as JSON')
    .option('--home <dir>', homeHelp)
    .action(async (id: string, options: { workspace?: string; json?: boolean; home?: string }) => {
      const answer = await ask(options, {
        op: 'approval-show',
        caller: caller(options),
        id,
      });
      print(answer.approval, options.json);
    });
}

/** A duration such as `90s`, `30m`, `4h` or `2d` (or plain seconds), in seconds. */
export function parseDuration(text: string): number {
  const match = /^\s*(\d+)\s*([smhd]?)\s*$/i.exec(text);
  if (!match) throw new Error(`"${text}" isn't a time: write it like 30m, 4h or 2d.`);
  const unit = (match[2] ?? '').toLowerCase();
  const scale = unit === 'm' ? 60 : unit === 'h' ? 3600 : unit === 'd' ? 86_400 : 1;
  return Number(match[1]) * scale;
}

function approvalLine(a: ApprovalRecord): string {
  const who = a.state === 'waiting' && a.decider === 'chief' ? 'the chief' : 'the person';
  const status =
    a.state === 'waiting' || a.state === 'escalated'
      ? `waiting on ${a.state === 'escalated' ? 'the person' : who}`
      : a.state === 'answered'
        ? `${a.answer ?? ''} (by the ${a.answeredBy ?? 'person'})`
        : a.state;
  return `${a.id}  ${status.padEnd(24)} ${a.question}`;
}

export function formatApproval(a: ApprovalRecord): string {
  const lines = [
    `Approval ${a.id}: ${a.question}`,
    ...(a.details !== null ? ['', a.details, ''] : []),
    `  Choices:  ${a.choices.join(', ')}`,
    `  Asked by: ${a.askerAgent ?? 'a rule'}${a.askerSession !== null ? ` (session ${a.askerSession})` : ''}, ${a.askedAt}`,
    `  Decides:  ${a.state === 'escalated' || a.decider === 'person' ? 'the person' : 'the chief of staff'}${a.personOnly ? " (the person's only)" : ''}`,
    `  State:    ${a.state}${a.answer !== null ? `: ${a.answer} by the ${a.answeredBy ?? ''} (${a.answeredVia ?? ''}), ${a.answeredAt ?? ''}` : ''}`,
    ...(a.reason !== null ? [`  Reason:   ${a.reason}`] : []),
    ...(a.note !== null ? [`  Note:     ${a.note}`] : []),
    `  Expires:  ${a.expiresAt}`,
  ];
  return `${lines.join('\n')}\n`;
}

function formatOutcome(a: ApprovalRecord): string {
  switch (a.state) {
    case 'answered':
      return `Approval ${a.id} answered: ${a.answer ?? ''} (by the ${a.answeredBy === 'person' ? 'person' : 'chief of staff'}).${a.reason !== null ? ` Reason: ${a.reason}` : ''}\n`;
    case 'expired':
      return `Approval ${a.id} expired with no answer, so it isn't approved.\n`;
    default:
      return `Approval ${a.id} was withdrawn.\n`;
  }
}
