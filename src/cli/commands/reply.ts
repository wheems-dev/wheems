import { resolve } from 'node:path';
import type { Command } from 'commander';
import { defaultHome, paths } from '../../home.js';
import { request } from '../../service/control.js';
import type { Io } from '../program.js';
import { speakerFrom } from '../caller.js';

export function registerReply(program: Command, io: Io): void {
  program
    .command('reply')
    .description('Reply to the person in the current conversation (agents run this)')
    .argument('[text...]', 'the reply; "-" or nothing reads it from standard input')
    .option('--home <dir>', 'the install folder (default: $WHEEMS_HOME or ~/wheems)')
    .action(async (words: string[], options: { home?: string }) => {
      const from = speakerFrom(io.env, 'wheems reply');
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
