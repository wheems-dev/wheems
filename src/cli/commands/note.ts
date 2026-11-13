import { relative, resolve } from 'node:path';
import type { Command } from 'commander';
import { defaultHome, paths } from '../../home.js';
import { request } from '../../service/control.js';
import type { Io } from '../program.js';

export function registerNote(program: Command, io: Io): void {
  program
    .command('note')
    .description("Save a note to the workspace's knowledge inbox (agents run this)")
    .argument('[text...]', 'the note, in Markdown; "-" or nothing reads it from standard input')
    .option('--home <dir>', 'the install folder (default: $WHEEMS_HOME or ~/wheems)')
    .action(async (words: string[], options: { home?: string }) => {
      const conversation = io.env.WHEEMS_CONVERSATION;
      if (conversation === undefined || conversation === '') {
        throw new Error(
          'wheems note works inside a conversation started by Wheems (WHEEMS_CONVERSATION is not set).',
        );
      }
      const text = (
        words.length === 0 || (words.length === 1 && words[0] === '-')
          ? await io.stdin()
          : words.join(' ')
      ).trim();
      if (text === '') throw new Error('The note is empty.');
      const home = resolve(options.home ?? defaultHome(io.env));
      const answer = await request(paths(home, io.env).socket, { op: 'note', conversation, text });
      if (!answer.ok) throw new Error(answer.error);
      io.out(
        `Saved to ${answer.path !== undefined ? relative(home, answer.path) : 'the inbox'}.\n`,
      );
    });
}
