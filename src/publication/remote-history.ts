import { findReportMarkers } from '../adf/footer';
import { adfToPlainText } from '../adf/text';
import type { IssueKey } from '../git/types';
import type { JiraClient, JiraComment } from '../jira/client/types';
import { REPORT_PROPERTY_KEY, ReportMetadataSchema, type ReportMetadata } from './metadata';

/** A Git2Jira report found among an issue's Jira comments. */
export interface RemoteReport {
  commentId: string;
  created: string;
  authorAccountId: string | undefined;
  reportId: string;
  sequence: number;
  /** Validated comment property, when present. */
  metadata: ReportMetadata | undefined;
  /** How the comment was recognized. */
  source: 'property' | 'marker' | 'both';
}

export interface RemoteScan {
  /** True only when every comment of the issue was read. Absence is meaningful only then. */
  complete: boolean;
  scannedComments: number;
  reports: RemoteReport[];
  error?: Error;
}

export interface ScanOptions {
  pageSize?: number;
  /** Safety bound for very long discussions. */
  maxComments?: number;
  signal?: AbortSignal;
}

/**
 * Reads all comments of an issue (paginated, with properties) and returns the
 * ones that are Git2Jira reports. A comment is recognized by its validated
 * metadata property, or by exactly one footer marker. Comment text is
 * untrusted: a comment quoting several markers identifies nothing.
 */
export async function scanRemoteReports(
  client: JiraClient,
  issueKey: IssueKey,
  options: ScanOptions = {},
): Promise<RemoteScan> {
  const pageSize = options.pageSize ?? 100;
  const maxComments = options.maxComments ?? 10_000;
  const reports: RemoteReport[] = [];
  let startAt = 0;
  let scanned = 0;
  try {
    for (;;) {
      const page = await client.listComments(
        issueKey,
        { startAt, maxResults: pageSize, expandProperties: true },
        options.signal,
      );
      for (const comment of page.values) {
        const report = recognize(comment);
        if (report) reports.push(report);
      }
      scanned += page.values.length;
      startAt = page.startAt + page.values.length;
      if (startAt >= page.total) return { complete: true, scannedComments: scanned, reports };
      // An empty page before the end, or too many comments: we cannot claim completeness.
      if (page.values.length === 0 || scanned >= maxComments) {
        return { complete: false, scannedComments: scanned, reports };
      }
    }
  } catch (error) {
    return {
      complete: false,
      scannedComments: scanned,
      reports,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

export function recognize(comment: JiraComment): RemoteReport | undefined {
  const property = comment.properties?.find((p) => p.key === REPORT_PROPERTY_KEY);
  const parsed = property ? ReportMetadataSchema.safeParse(property.value) : undefined;
  const metadata = parsed?.success ? parsed.data : undefined;
  const markers = findReportMarkers(adfToPlainText(comment.body));
  const marker = markers.length === 1 ? markers[0] : undefined;

  const base = {
    commentId: comment.id,
    created: comment.created,
    authorAccountId: comment.author?.accountId,
  };
  if (metadata) {
    return {
      ...base,
      reportId: metadata.reportId,
      sequence: metadata.sequence,
      metadata,
      source: marker?.reportId === metadata.reportId ? 'both' : 'property',
    };
  }
  if (marker) {
    return {
      ...base,
      reportId: marker.reportId,
      sequence: marker.sequence,
      metadata,
      source: 'marker',
    };
  }
  return undefined;
}
