import * as clack from '@clack/prompts';
import { PromptCancelledError, type Prompter } from './prompter';

function unwrap<T>(value: T): Exclude<T, symbol> {
  if (clack.isCancel(value)) throw new PromptCancelledError();
  return value as Exclude<T, symbol>;
}

/** Prompter backed by @clack/prompts. Requires an interactive TTY. */
export function createClackPrompter(): Prompter {
  return {
    intro: (title) => {
      clack.intro(title);
    },
    outro: (message) => {
      clack.outro(message);
    },
    note: (message, title) => {
      clack.note(message, title);
    },
    async select<T extends string>(
      message: string,
      options: readonly { value: T; label: string; hint?: string }[],
      initialValue?: T,
    ): Promise<T> {
      const result = await clack.select<T>({
        message,
        options: options.map((o) =>
          o.hint === undefined
            ? { value: o.value, label: o.label }
            : { value: o.value, label: o.label, hint: o.hint },
        ) as clack.Option<T>[],
        ...(initialValue === undefined ? {} : { initialValue }),
      });
      return unwrap(result);
    },
    async text(message, options) {
      const validate = options?.validate;
      return unwrap(
        await clack.text({
          message,
          ...(options?.placeholder === undefined ? {} : { placeholder: options.placeholder }),
          ...(validate ? { validate: (value: string | undefined) => validate(value ?? '') } : {}),
        }),
      );
    },
    async password(message) {
      return unwrap(await clack.password({ message }));
    },
    async confirm(message, initialValue = false) {
      return unwrap(await clack.confirm({ message, initialValue }));
    },
  };
}
