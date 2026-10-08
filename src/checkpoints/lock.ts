import { hostname } from 'node:os';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { processAlive } from '../snapshots/engine';
import { LockBusyError } from './errors';

export interface LockOptions {
  /** How long to wait for a busy lock before giving up. */
  timeoutMs?: number;
  /** Locks older than this are considered abandoned. */
  staleMs?: number;
}

interface LockOwner {
  pid: number;
  host: string;
  createdAt: string;
}

/**
 * Cross-process exclusive lock using an O_EXCL lock file. A lock whose owner
 * process is gone (same host) or that is older than `staleMs` is broken.
 */
export async function withFileLock<T>(
  file: string,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const staleMs = options.staleMs ?? 10 * 60_000;
  await mkdir(path.dirname(file), { recursive: true });
  const owner: LockOwner = {
    pid: process.pid,
    host: hostname(),
    createdAt: new Date().toISOString(),
  };
  const token = `${JSON.stringify(owner)}\n${randomBytes(8).toString('hex')}`;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      await writeFile(file, token, { flag: 'wx' });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (await isAbandoned(file, staleMs)) {
      // Move it aside first so only one contender removes it.
      const aside = `${file}.stale-${randomBytes(4).toString('hex')}`;
      await rename(file, aside).then(
        () => rm(aside, { force: true }),
        () => undefined,
      );
      continue;
    }
    if (Date.now() >= deadline) throw new LockBusyError(file);
    await new Promise((resolve) => setTimeout(resolve, 25 + Math.random() * 50));
  }

  try {
    return await fn();
  } finally {
    const current = await readFile(file, 'utf8').catch(() => undefined);
    if (current === token) await rm(file, { force: true });
  }
}

async function isAbandoned(file: string, staleMs: number): Promise<boolean> {
  try {
    const [content, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
    if (Date.now() - info.mtimeMs > staleMs) return true;
    const owner = JSON.parse(content.split('\n')[0] ?? '') as Partial<LockOwner>;
    return owner.host === hostname() && typeof owner.pid === 'number' && !processAlive(owner.pid);
  } catch {
    // Unreadable or half-written lock: treat as busy unless it is old.
    try {
      return Date.now() - (await stat(file)).mtimeMs > staleMs;
    } catch {
      return false;
    }
  }
}
