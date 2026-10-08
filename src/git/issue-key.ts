import { InvalidIssueKeyError } from './errors';
import {
  IssueKeySchema,
  type IssueKey,
  type IssueKeyDetection,
  type IssueKeyDetector,
  type IssueKeyDetectorOptions,
} from './types';

/**
 * Candidate keys inside a branch name. A key must not be glued to a preceding
 * letter, digit, or underscore (so `xLSND-1` and `MY_LSND-1` do not yield
 * `LSND-1`), and its number must not continue with more digits.
 */
const CANDIDATE = /(?<![A-Za-z0-9_])[A-Z][A-Z0-9_]*-[0-9]+(?![0-9])/g;

export class BranchIssueKeyDetector implements IssueKeyDetector {
  detect(branch: string, options: IssueKeyDetectorOptions = {}): IssueKeyDetection {
    const allowed = options.projectKeys ? new Set(options.projectKeys) : undefined;
    const keys = new Set<IssueKey>();
    for (const match of branch.matchAll(CANDIDATE)) {
      const parsed = IssueKeySchema.safeParse(match[0]);
      if (!parsed.success) continue;
      if (allowed && !allowed.has(projectOf(parsed.data))) continue;
      keys.add(parsed.data);
    }
    const [first, ...others] = keys;
    if (first === undefined) return { status: 'not-found' };
    if (others.length > 0) return { status: 'ambiguous', candidates: [first, ...others] };
    return { status: 'found', issueKey: first };
  }
}

export function projectOf(issueKey: IssueKey): string {
  return issueKey.slice(0, issueKey.lastIndexOf('-'));
}

/** Validates a manually supplied issue key (`--issue`). Case is not corrected: no guessing. */
export function parseIssueKey(value: string): IssueKey {
  const parsed = IssueKeySchema.safeParse(value.trim());
  if (!parsed.success) throw new InvalidIssueKeyError(value);
  return parsed.data;
}
