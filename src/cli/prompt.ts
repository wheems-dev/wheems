import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

export interface Prompter {
  /** Asks a question. With `secret`, what is typed is not shown. */
  ask(question: string, options?: { secret?: boolean }): Promise<string>;
  close(): void;
}

/** Asks on this terminal. */
export function terminalPrompter(): Prompter {
  let muted = false;
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY });
  return {
    async ask(question, options = {}) {
      process.stdout.write(question);
      muted = options.secret === true;
      try {
        const answer = await rl.question('');
        return answer.trim();
      } finally {
        if (muted) process.stdout.write('\n');
        muted = false;
      }
    },
    close: () => {
      rl.close();
    },
  };
}
