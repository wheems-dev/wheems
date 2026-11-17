import { resolve } from 'node:path';
import type { Command } from 'commander';
import { defaultHome, paths } from '../../home.js';
import { request } from '../../service/control.js';
import type { Io } from '../program.js';
import { callerFrom, speakerFrom, workspaceHere } from '../caller.js';

/**
 * `wheems chat`: talking to the person. `chat reply` posts a progress note to the agent's own
 * thread; `chat post` posts one-way to a named channel, such as `updates`. Asking for a decision
 * is `wheems approval request`, which goes wherever its decider is.
 */
export function registerChat(program: Command, io: Io): void {
  const chat = program
    .command('chat')
    .description(
      'Talk to the person: progress notes to a thread, and posts to a channel (agents run this)',
    );
  addReply(chat.command('reply'), io, 'wheems chat reply');
  chat
    .command('post')
    .description(
      "Post to one of the workspace's channels, such as updates, as the chief (chiefs and you run this)",
    )
    .argument(
      '<channel>',
      "the channel's name in workspace.yaml: updates, approvals, chat or another",
    )
    .argument('[text...]', 'the post, in Markdown; "-" or nothing reads it from standard input')
    .option(
      '--workspace <id>',
      "the workspace, when you run it yourself (default: the one whose folder you're in)",
    )
    .option('--home <dir>', 'the install folder (default: $WHEEMS_HOME or ~/wheems)')
    .action(
      async (channel: string, words: string[], options: { workspace?: string; home?: string }) => {
        const home = resolve(options.home ?? defaultHome(io.env));
        const text = (
          words.length === 0 || (words.length === 1 && words[0] === '-')
            ? await io.stdin()
            : words.join(' ')
        ).trim();
        if (text === '') throw new Error('Nothing to post.');
        const answer = await request(paths(home, io.env).socket, {
          op: 'chat-post',
          caller: callerFrom(io.env, options.workspace ?? workspaceHere(io, home)),
          channel,
          text,
        });
        if (!answer.ok) throw new Error(answer.error);
        io.out(`${answer.message ?? 'Posted.'}\n`);
      },
    );
}

/** The old `wheems reply`, kept for a release: it says what it's called now. */
export function registerReply(program: Command, io: Io): void {
  addReply(program.command('reply', { hidden: true }), io, 'wheems reply', () => {
    io.err('wheems reply is now wheems chat reply.\n');
  });
}

function addReply(command: Command, io: Io, name: string, notice?: () => void): void {
  command
    .description('Reply to the person in the current conversation (agents run this)')
    .argument('[text...]', 'the reply; "-" or nothing reads it from standard input')
    .option('--home <dir>', 'the install folder (default: $WHEEMS_HOME or ~/wheems)')
    .action(async (words: string[], options: { home?: string }) => {
      notice?.();
      const from = speakerFrom(io.env, name);
      const text = (
        words.length === 0 || (words.length === 1 && words[0] === '-')
          ? await io.stdin()
          : words.join(' ')
      ).trim();
      if (text === '') throw new Error('Nothing to reply.');
      const where = paths(resolve(options.home ?? defaultHome(io.env)), io.env);
      const answer = await request(where.socket, { op: 'reply', ...from, text });
      if (!answer.ok) throw new Error(answer.error);
      io.out('Sent.\n');
    });
}
