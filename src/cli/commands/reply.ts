import { resolve } from 'node:path';
import type { Command } from 'commander';
import { defaultHome, paths } from '../../home.js';
import { request } from '../../service/control.js';
import type { Io } from '../program.js';
import { speakerFrom } from '../caller.js';

/**
 * `wheems chat`: the conversation an agent is in. `chat reply` posts a progress note to its
 * thread. (Planned: `chat post` and `chat ask` for the approvals and updates channels.)
 */
export function registerChat(program: Command, io: Io): void {
  const chat = program
    .command('chat')
    .description(
      'Talk in the current conversation: progress notes to its thread (agents run this)',
    );
  addReply(chat.command('reply'), io, 'wheems chat reply');
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
