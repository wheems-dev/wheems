import type { ProgramFactory } from '../../src/testing/index.js';

export type Behaviour =
  | 'reply'
  | 'answer'
  | 'progress-and-answer'
  | 'reply-and-answer-same'
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
  answers?: Map<string, string>;
}

/**
 * A simulated agent CLI, run by MemoryRuntime: it reports idle on start, works on
 * its first task (from the stub engine's STUB_TASK) and on each later line, and
 * replies "echo: <message>" through `reply`, like an agent running `opinr reply`.
 */
export function fakeAgent(options: FakeAgentOptions): ProgramFactory {
  return ({ env, sessionId }) => {
    const handle = (
      line: string,
      io: Parameters<NonNullable<ReturnType<ProgramFactory>['start']>>[0],
    ) => {
      options.received?.set(sessionId, [...(options.received.get(sessionId) ?? []), line]);
      const behaviour = options.behaviour?.(line) ?? 'reply';
      if (behaviour === 'never-start') return;
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
          const answer = (text: string) => options.answers?.set(env.STUB_SESSION ?? '', text);
          if (behaviour === 'reply') await options.reply(conversation, `echo: ${line}`);
          if (behaviour === 'answer') answer(`answer: ${line}`);
          if (behaviour === 'progress-and-answer') {
            await options.reply(conversation, 'On it.');
            answer(`answer: ${line}`);
          }
          if (behaviour === 'reply-and-answer-same') {
            await options.reply(conversation, `echo: ${line}`);
            answer(`echo: ${line}`);
          }
          io.status('done');
        })();
      }, 5);
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
