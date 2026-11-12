import type { FinalMessage } from '../../src/contracts/engine.js';
import type { ProgramFactory } from '../../src/testing/index.js';

export interface FakeFilerOptions {
  /** Where its answers go, by session id, for the stub engine to read. */
  answers: Map<string, FinalMessage[]>;
  /** What it does in its folder; returns its answer, or null to give none. */
  act: (cwd: string, task: string) => Promise<string | null> | string | null;
  /** False for an agent that reports no status. */
  reportsStatus?: boolean;
  /** Never finishes, like a filer stuck on a question. */
  hang?: boolean;
}

/** A simulated filer: takes its task at launch, works in its folder, answers, and stops working. */
export function fakeFiler(options: FakeFilerOptions): ProgramFactory {
  let count = 0;
  return ({ env, cwd }) => ({
    start(io) {
      const report = (status: Parameters<typeof io.status>[0]) => {
        if (options.reportsStatus !== false) io.status(status);
      };
      report('idle');
      report('working');
      if (options.hang === true) return;
      setTimeout(() => {
        void (async () => {
          const answer = await options.act(cwd, env.STUB_TASK ?? '');
          if (answer !== null) {
            const id = env.STUB_SESSION ?? '';
            options.answers.set(id, [
              ...(options.answers.get(id) ?? []),
              { id: `filer-${String(++count)}`, text: answer },
            ]);
          }
          report('done');
        })();
      }, 5);
    },
    input: () => undefined,
  });
}
