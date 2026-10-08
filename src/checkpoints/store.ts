import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { stateDir } from '../snapshots/engine';
import type { IssueKey, RepositoryInfo } from '../git/types';
import { CheckpointCorruptedError } from './errors';
import { withFileLock, type LockOptions } from './lock';
import {
  LineageJournalSchema,
  RepositoryIdentitySchema,
  type LineageJournal,
  type RepositoryIdentity,
} from './types';

/**
 * File layout below `<git common dir>/git2jira/`:
 *
 *   repository.json                       repository identity (random UUID)
 *   lineages/<siteId>/<ISSUE>.json        report journal per site and issue
 *   locks/<siteId>-<ISSUE>.lock           per-lineage lock
 *   tmp/                                  temporary indexes
 *
 * The common directory is shared by all worktrees and is never part of the
 * working tree, so nothing here can be committed by accident.
 */
export class LineageStore {
  constructor(private readonly lockOptions: LockOptions = {}) {}

  journalPath(repository: RepositoryInfo, siteId: string, issueKey: IssueKey): string {
    return path.join(stateDir(repository), 'lineages', siteId, `${issueKey}.json`);
  }

  async read(
    repository: RepositoryInfo,
    siteId: string,
    issueKey: IssueKey,
  ): Promise<LineageJournal | undefined> {
    const file = this.journalPath(repository, siteId, issueKey);
    const raw = await readOptional(file);
    if (raw === undefined) return undefined;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new CheckpointCorruptedError(file, 'invalid JSON');
    }
    const parsed = LineageJournalSchema.safeParse(json);
    if (!parsed.success)
      throw new CheckpointCorruptedError(file, z.prettifyError(parsed.error).split('\n')[0] ?? '');
    const journal = parsed.data;
    const identity = await this.repositoryIdentity(repository);
    if (journal.site.id !== siteId || journal.issueKey !== issueKey) {
      throw new CheckpointCorruptedError(file, 'journal belongs to a different site or issue');
    }
    if (journal.repository.id !== identity.id) {
      throw new CheckpointCorruptedError(file, 'journal belongs to a different repository');
    }
    return journal;
  }

  async write(repository: RepositoryInfo, journal: LineageJournal): Promise<void> {
    const file = this.journalPath(repository, journal.site.id, journal.issueKey);
    const validated = LineageJournalSchema.parse(journal);
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, file);
  }

  /** Moves an unreadable journal aside (kept for inspection) before it is rebuilt. */
  async quarantine(
    repository: RepositoryInfo,
    siteId: string,
    issueKey: IssueKey,
  ): Promise<string | undefined> {
    const file = this.journalPath(repository, siteId, issueKey);
    const target = `${file}.corrupt-${new Date().toISOString().replaceAll(':', '-')}`;
    try {
      await rename(file, target);
      return target;
    } catch {
      return undefined;
    }
  }

  /** Site ids that have a journal for this issue. */
  async sitesWithJournal(repository: RepositoryInfo, issueKey: IssueKey): Promise<string[]> {
    const root = path.join(stateDir(repository), 'lineages');
    let sites: string[];
    try {
      sites = await readdir(root);
    } catch {
      return [];
    }
    const found: string[] = [];
    for (const site of sites) {
      if ((await readOptional(path.join(root, site, `${issueKey}.json`))) !== undefined)
        found.push(site);
    }
    return found;
  }

  withLock<T>(
    repository: RepositoryInfo,
    siteId: string,
    issueKey: IssueKey,
    fn: () => Promise<T>,
  ): Promise<T> {
    const file = path.join(stateDir(repository), 'locks', `${siteId}-${issueKey}.lock`);
    return withFileLock(file, fn, this.lockOptions);
  }

  /** Returns the repository identity, creating it atomically on first use. */
  async repositoryIdentity(repository: RepositoryInfo): Promise<RepositoryIdentity> {
    const file = path.join(stateDir(repository), 'repository.json');
    await mkdir(path.dirname(file), { recursive: true });
    try {
      await writeFile(file, `${JSON.stringify({ id: randomUUID() }, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const raw = await readOptional(file);
    const parsed = RepositoryIdentitySchema.safeParse(
      raw === undefined ? undefined : safeJson(raw),
    );
    if (!parsed.success) throw new CheckpointCorruptedError(file, 'invalid repository identity');
    return parsed.data;
  }
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
