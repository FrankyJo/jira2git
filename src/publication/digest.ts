import { createHash } from 'node:crypto';
import type { ReportFile } from '../adf/types';

/** JSON with object keys sorted recursively, so equal values always hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Digest of the changed-file list a preview showed. */
export function changesDigest(files: readonly ReportFile[]): string {
  return sha256(
    canonicalJson(
      [...files]
        .map((f) => ({ status: f.status, path: f.path, previousPath: f.previousPath }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    ),
  );
}

export interface DigestInput {
  siteId: string;
  issueKey: string;
  reportId: string;
  sequence: number;
  baseTree: string;
  targetTree: string;
  snapshotCommit: string;
  /** The exact ADF document that will be posted. */
  document: unknown;
}

/**
 * The approval digest binds the user's approval to the exact comment, the
 * exact issue and site, and the exact snapshot. Any change to any of them
 * produces a different digest and invalidates the approval.
 */
export function reportDigest(input: DigestInput): string {
  return sha256(canonicalJson({ v: 1, ...input }));
}
