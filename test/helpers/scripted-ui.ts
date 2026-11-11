import { SetupCancelled, type Choice, type SetupUi } from '../../src/contracts/setup.js';

export const CANCEL = Symbol('cancel');
export type Answer = string | boolean | typeof CANCEL;

export interface Shown {
  kind: 'note' | 'info' | 'success' | 'warn' | 'task' | 'invalid' | 'question';
  message: string;
  choices?: Choice<string>[];
}

/**
 * A SetupUi that plays a person's answers in order. Like clack, it asks again when an
 * answer fails validation; refuses disabled or unknown choices; and records everything shown.
 */
export function scriptedUi(
  answers: Answer[],
): SetupUi & { shown: Shown[]; remaining: () => number } {
  const shown: Shown[] = [];
  const next = (message: string, validate?: (value: string) => string | undefined): Answer => {
    shown.push({ kind: 'question', message });
    for (;;) {
      if (answers.length === 0) throw new Error(`No scripted answer for: ${message}`);
      const value = answers.shift() as Answer;
      if (value === CANCEL) throw new SetupCancelled();
      const problem = typeof value === 'string' ? validate?.(value) : undefined;
      if (problem === undefined) return value;
      shown.push({ kind: 'invalid', message: problem });
    }
  };
  return {
    shown,
    remaining: () => answers.length,
    note: (message) => shown.push({ kind: 'note', message }),
    info: (message) => shown.push({ kind: 'info', message }),
    success: (message) => shown.push({ kind: 'success', message }),
    warn: (message) => shown.push({ kind: 'warn', message }),
    text: (options) => Promise.resolve(String(next(options.message, options.validate))),
    secret: (options) => Promise.resolve(String(next(options.message, options.validate))),
    confirm: (message) => Promise.resolve(next(message) === true),
    select: <T extends string>(options: { message: string; choices: Choice<T>[] }) => {
      const value = next(options.message);
      const asked = shown.findLast((s) => s.kind === 'question');
      if (asked) asked.choices = options.choices;
      const choice = options.choices.find((c) => c.value === value);
      if (!choice || choice.disabled === true) {
        throw new Error(`"${String(value)}" is not a choice for: ${options.message}`);
      }
      return Promise.resolve(choice.value);
    },
    async task(message, run, done) {
      const result = await run();
      shown.push({ kind: 'task', message: `${message}: ${done(result)}` });
      return result;
    },
  };
}
