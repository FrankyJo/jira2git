import type { ServiceContainer } from '../app/container';

export interface OutputStream {
  write(chunk: string): unknown;
}

/** Everything a command needs from its environment, injected for testability. */
export interface CliContext {
  container: ServiceContainer;
  cwd: string;
  stdout: OutputStream;
  stderr: OutputStream;
  /** Source for `--token-stdin`. */
  stdin?: AsyncIterable<Buffer | string>;
  /** Whether prompts may be shown (stdin and stdout are terminals). */
  interactive?: boolean;
}

export function println(stream: OutputStream, line = ''): void {
  stream.write(`${line}\n`);
}
