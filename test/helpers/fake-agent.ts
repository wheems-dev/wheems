import type { FinalMessage } from '../../src/contracts/engine.js';
import type { ProgramFactory } from '../../src/testing/index.js';

export type Behaviour =
  | 'reply'
  | 'answer'
  | 'progress-and-answer'
  | 'reply-and-answer-same'
  | 'same-answer'
  | 'silent'
  | 'block'
  | 'never-start'
  | 'exit';

export interface FakeAgentOptions {
  /** What the agent does with each message. Defaults to `reply`. */
  behaviour?: (line: string) => Behaviour;
  /** How the agent replies: with `opinr reply`, in effect. */
  reply: (conversation: string, text: string) => Promise<void>;
  /** Every message each session received, by session id. */
  received?: Map<string, string[]>;
  /** Where the agent's final messages go, by conversation id, for an engine to read. */
  answers?: Map<string, FinalMessage[]>;
  /** How long each turn takes, in milliseconds. Defaults to 5. */
  delayMs?: number;
}

/**
 * A simulated agent CLI, run by MemoryRuntime: it reports idle on start, works on
 * its first task (from the stub engine's STUB_TASK) and on each later line, and
 * replies "echo: <message>" through `reply`, like an agent running `opinr reply`.
 * Lines typed while it works wait, and it takes each in a turn of its own, as
 * Claude Code does with queued messages.
 */
export function fakeAgent(options: FakeAgentOptions): ProgramFactory {
  let answerCount = 0;
  return ({ env, sessionId }) => {
    const queue: string[] = [];
    let busy = false;
    type Io = Parameters<NonNullable<ReturnType<ProgramFactory>['start']>>[0];
    const handle = (line: string, io: Io) => {
      const behaviour = options.behaviour?.(line) ?? 'reply';
      if (behaviour === 'never-start') return;
      if (busy) {
        queue.push(line);
        return;
      }
      options.received?.set(sessionId, [...(options.received.get(sessionId) ?? []), line]);
      busy = true;
      io.status('working');
      setTimeout(() => {
        void (async () => {
          if (behaviour === 'block') {
            io.status('blocked');
            return;
          }
          if (behaviour === 'exit') {
            io.exit(0);
            return;
          }
          const conversation = env.OPINR_CONVERSATION ?? '';
          const answer = (text: string) => {
            const id = env.STUB_SESSION ?? '';
            const list = options.answers?.get(id) ?? [];
            options.answers?.set(id, [...list, { id: `answer-${String(++answerCount)}`, text }]);
          };
          if (behaviour === 'reply') await options.reply(conversation, `echo: ${line}`);
          if (behaviour === 'answer') answer(`answer: ${line}`);
          if (behaviour === 'same-answer') answer('Yes.');
          if (behaviour === 'progress-and-answer') {
            await options.reply(conversation, 'On it.');
            answer(`answer: ${line}`);
          }
          if (behaviour === 'reply-and-answer-same') {
            await options.reply(conversation, `echo: ${line}`);
            answer(`echo: ${line}`);
          }
          busy = false;
          io.status('done');
          const next = queue.shift();
          if (next !== undefined) {
            setTimeout(() => {
              handle(next, io);
            }, 2);
          }
        })();
      }, options.delayMs ?? 5);
    };
    return {
      start(io) {
        if (options.behaviour?.(env.STUB_TASK ?? '') === 'never-start') return;
        io.status('idle');
        if (env.STUB_TASK !== undefined) handle(env.STUB_TASK, io);
      },
      input: handle,
    };
  };
}
