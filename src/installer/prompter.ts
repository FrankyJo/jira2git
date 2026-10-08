/**
 * Minimal interactive prompt surface. Services depend on this interface, not
 * on @clack/prompts, so they can be tested with scripted answers and run in
 * non-interactive environments.
 */
export interface SelectOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

export interface Prompter {
  intro(title: string): void;
  outro(message: string): void;
  note(message: string, title?: string): void;
  select<T extends string>(
    message: string,
    options: readonly SelectOption<T>[],
    initialValue?: T,
  ): Promise<T>;
  text(
    message: string,
    options?: { placeholder?: string; validate?: (value: string) => string | undefined },
  ): Promise<string>;
  /** Masked input for secrets. The value must never be echoed or logged. */
  password(message: string): Promise<string>;
  confirm(message: string, initialValue?: boolean): Promise<boolean>;
}

/** Raised when the user cancels a prompt (Ctrl+C / Esc). */
export class PromptCancelledError extends Error {
  constructor() {
    super('Cancelled by user.');
    this.name = 'PromptCancelledError';
  }
}
