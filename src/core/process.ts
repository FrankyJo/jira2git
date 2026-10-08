import { spawn } from 'node:child_process';

export interface ProcessOptions {
  /** Written to stdin, then stdin is closed. Secrets travel here, never in argv. */
  input?: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** Working directory of the child; the caller's by default. */
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  /** `null` when the program could not be started or was killed. */
  exitCode: number | null;
  /** The executable does not exist. */
  notFound: boolean;
  timedOut: boolean;
}

/** Runs external programs. Abstracted so OS adapters can be tested without the OS tool. */
export interface ProcessRunner {
  run(file: string, args: readonly string[], options?: ProcessOptions): Promise<ProcessResult>;
}

/**
 * `spawn` with `shell: false` and an argument array. Output is bounded; the
 * child is killed on timeout. Never rejects: failures are reported in the result.
 */
export class SpawnProcessRunner implements ProcessRunner {
  run(file: string, args: readonly string[], options: ProcessOptions = {}): Promise<ProcessResult> {
    const limit = options.maxOutputBytes ?? 1024 * 1024;
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(file, args, {
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          ...(options.env ? { env: options.env } : {}),
          ...(options.cwd ? { cwd: options.cwd } : {}),
        });
      } catch {
        resolve({ stdout: '', stderr: '', exitCode: null, notFound: true, timedOut: false });
        return;
      }
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let size = 0;
      let timedOut = false;
      let notFound = false;
      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        size += chunk.length;
        if (size <= limit) target.push(chunk);
        else child.kill();
      };
      child.stdout.on('data', collect(stdout));
      child.stderr.on('data', collect(stderr));
      const timer =
        options.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              child.kill();
            }, options.timeoutMs);
      child.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') notFound = true;
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolve({
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          exitCode: notFound ? null : code,
          notFound,
          timedOut,
        });
      });
      child.stdin.on('error', () => {
        // The child may exit before reading stdin; its exit code reports the outcome.
      });
      child.stdin.end(options.input ?? '');
    });
  }
}
