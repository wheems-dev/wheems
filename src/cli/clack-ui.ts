import * as clack from '@clack/prompts';
import { SetupCancelled, type Choice, type SetupUi } from '../contracts/setup.js';

function answer<T>(value: T): Exclude<T, symbol> {
  if (clack.isCancel(value)) throw new SetupCancelled();
  return value as Exclude<T, symbol>;
}

/** The setup UI on this terminal, drawn with @clack/prompts. */
export function clackUi(): SetupUi & {
  intro(title: string): void;
  outro(message: string): void;
  cancel(message: string): void;
} {
  return {
    intro: (title) => {
      clack.intro(title);
    },
    outro: (message) => {
      clack.outro(message);
    },
    cancel: (message) => {
      clack.cancel(message);
    },
    note: (message, title) => {
      clack.note(message, title);
    },
    info: (message) => {
      clack.log.info(message);
    },
    success: (message) => {
      clack.log.success(message);
    },
    warn: (message) => {
      clack.log.warn(message);
    },
    async text(options) {
      return answer(
        await clack.text({
          message: options.message,
          ...(options.placeholder !== undefined && { placeholder: options.placeholder }),
          ...(options.initial !== undefined && { initialValue: options.initial }),
          ...(options.validate !== undefined && {
            validate: (value: string | undefined) => options.validate?.(value ?? ''),
          }),
        }),
      );
    },
    async secret(options) {
      return answer(
        await clack.password({
          message: options.message,
          ...(options.validate !== undefined && {
            validate: (value: string | undefined) => options.validate?.(value ?? ''),
          }),
        }),
      );
    },
    async confirm(message, initial = true) {
      return answer(await clack.confirm({ message, initialValue: initial }));
    },
    async select<T extends string>(options: {
      message: string;
      choices: Choice<T>[];
      initial?: T;
    }) {
      return answer(
        await clack.select<T>({
          message: options.message,
          options: options.choices.map((c) => ({
            value: c.value,
            label: c.label,
            ...(c.hint !== undefined && { hint: c.hint }),
            ...(c.disabled === true && { disabled: true }),
          })) as Parameters<typeof clack.select<T>>[0]['options'],
          ...(options.initial !== undefined && { initialValue: options.initial }),
        }),
      );
    },
    async task(message, run, done) {
      const spin = clack.spinner();
      spin.start(message);
      try {
        const result = await run();
        spin.stop(done(result));
        return result;
      } catch (error) {
        spin.error(error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
  };
}
