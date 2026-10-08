import { VERSION } from '../../core/version';
import type { JiraAuthorization } from '../auth/types';
import {
  JiraAuthenticationError,
  JiraClientError,
  JiraNetworkError,
  JiraNotFoundError,
  JiraPermissionError,
  JiraRateLimitError,
  JiraRequestError,
  JiraResponseError,
  JiraServerError,
  JiraTimeoutError,
  type DeliveryState,
  type JiraErrorDetails,
} from './errors';
import { JiraErrorBodySchema } from './schemas';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface RetryPolicy {
  /** Total attempts for a retryable request, including the first. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** A longer Retry-After than this is not waited for; the error is surfaced instead. */
  maxRetryAfterMs: number;
}

export interface JiraHttpOptions {
  authorize: () => Promise<JiraAuthorization>;
  fetch?: FetchLike;
  timeoutMs?: number;
  retry?: Partial<RetryPolicy>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  maxResponseBytes?: number;
}

export interface JiraHttpRequest {
  method: 'GET' | 'POST' | 'PUT';
  /** Absolute API path, e.g. `/rest/api/3/myself`. Callers encode path segments. */
  path: string;
  query?: Readonly<Record<string, string | number>>;
  body?: unknown;
  /**
   * Whether repeating the request is harmless: reads, and PUTs of a fixed
   * value. Only idempotent requests are retried automatically.
   */
  idempotent: boolean;
  signal?: AbortSignal | undefined;
}

export interface JiraHttpResponse {
  status: number;
  /** Parsed JSON body; `undefined` for an empty body. */
  data: unknown;
}

const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 1_000,
  maxDelayMs: 15_000,
  maxRetryAfterMs: 60_000,
};

/** Error codes raised before any byte of the request reached the server. */
const NOT_SENT_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * HTTPS transport for Jira Cloud. Adds authorization, enforces a per-request
 * timeout, maps failures to typed errors with a delivery classification, and
 * retries only idempotent requests with bounded, jittered backoff that honors
 * Retry-After. Credentials never appear in errors.
 */
export class JiraHttp {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly retry: RetryPolicy;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly maxResponseBytes: number;

  constructor(private readonly options: JiraHttpOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retry = { ...DEFAULT_RETRY, ...options.retry };
    this.sleep = options.sleep ?? abortableSleep;
    this.random = options.random ?? Math.random;
    this.maxResponseBytes = options.maxResponseBytes ?? 16 * 1024 * 1024;
  }

  async send(request: JiraHttpRequest): Promise<JiraHttpResponse> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.once(request);
      } catch (error) {
        if (!(error instanceof JiraRequestError)) throw error;
        if (!request.idempotent || !isTransient(error) || attempt >= this.retry.maxAttempts)
          throw error;
        if (request.signal?.aborted) throw error;
        const delay =
          error instanceof JiraRateLimitError && error.retryAfterMs !== undefined
            ? error.retryAfterMs
            : this.backoff(attempt);
        if (delay > this.retry.maxRetryAfterMs) throw error;
        await this.sleep(delay, request.signal);
      }
    }
  }

  private backoff(attempt: number): number {
    const exponential = Math.min(
      this.retry.maxDelayMs,
      this.retry.baseDelayMs * 2 ** (attempt - 1),
    );
    // ±30 % jitter so parallel clients do not retry in lockstep.
    return Math.round(exponential * (0.7 + 0.6 * this.random()));
  }

  private async once(request: JiraHttpRequest): Promise<JiraHttpResponse> {
    const auth = await this.options.authorize();
    const url = new URL(`${auth.apiBaseUrl.replace(/\/+$/, '')}${request.path}`);
    if (url.protocol !== 'https:') throw new Error('Jira API base URL must use https.');
    for (const [name, value] of Object.entries(request.query ?? {})) {
      url.searchParams.set(name, String(value));
    }
    const details = (delivery: DeliveryState, status?: number): JiraErrorDetails => ({
      method: request.method,
      path: request.path,
      delivery,
      ...(status === undefined ? {} : { status }),
    });

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    const headers: Record<string, string> = {
      Authorization: auth.headers.Authorization,
      Accept: 'application/json',
      'User-Agent': `git2jira/${VERSION}`,
    };
    if (request.body !== undefined) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: request.method,
        headers,
        // Never follow redirects: they could carry the Authorization header elsewhere.
        redirect: 'manual',
        signal,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });
    } catch (error) {
      throw transportError(error, request, timeout, details);
    }

    const status = response.status;
    let text: string;
    try {
      text = await readLimited(response, this.maxResponseBytes);
    } catch (error) {
      // The status line arrived; a 4xx is still a definite rejection.
      if (status >= 400 && status < 500) text = '';
      else throw transportError(error, request, timeout, () => details('unknown', status));
    }

    if (status >= 200 && status < 300) {
      if (text.trim() === '') return { status, data: undefined };
      try {
        return { status, data: JSON.parse(text) as unknown };
      } catch {
        throw new JiraResponseError(
          `Jira returned an unreadable response to ${request.method} ${request.path}.`,
          details('unknown', status),
        );
      }
    }
    throw statusError(status, text, response.headers, request, details);
  }
}

function isTransient(error: JiraRequestError): boolean {
  if (error instanceof JiraRateLimitError) return true;
  if (error instanceof JiraNetworkError || error instanceof JiraTimeoutError) return true;
  return error instanceof JiraServerError && [500, 502, 503, 504].includes(error.status ?? 0);
}

function statusError(
  status: number,
  text: string,
  headers: Headers,
  request: JiraHttpRequest,
  details: (delivery: DeliveryState, status?: number) => JiraErrorDetails,
): JiraRequestError {
  const jiraMessages = parseErrorMessages(text);
  const target = `${request.method} ${request.path}`;
  // Any answered 4xx means Jira did not perform the request; 5xx might have.
  const info = { ...details(status < 500 ? 'rejected' : 'unknown', status), jiraMessages };
  switch (status) {
    case 401:
      return new JiraAuthenticationError(
        'Jira rejected the credentials (401). The API token may be wrong, expired, or revoked, ' +
          'or a scoped token was used with the site URL. Run "git2jira login" again.',
        info,
      );
    case 403:
      return new JiraPermissionError(
        `Jira denied ${target} (403): the account or token lacks a permission or scope for it.`,
        info,
      );
    case 404:
      return new JiraNotFoundError(
        `Not found in Jira (${target}): it does not exist or this account cannot see it.`,
        info,
      );
    case 429: {
      const retryAfterMs = parseRetryAfter(headers.get('retry-after'));
      return new JiraRateLimitError(
        `Jira rate limit reached (429)${retryAfterMs === undefined ? '' : `; retry after ${String(Math.ceil(retryAfterMs / 1000))} s`}.`,
        info,
        retryAfterMs,
      );
    }
  }
  if (status >= 500)
    return new JiraServerError(`Jira server error ${String(status)} on ${target}.`, info);
  if (status >= 300 && status < 400) {
    return new JiraResponseError(`Jira redirected ${target} (${String(status)}); not followed.`, {
      ...info,
      delivery: 'unknown',
    });
  }
  return new JiraClientError(`Jira refused ${target} (${String(status)}).`, info);
}

function transportError(
  error: unknown,
  request: JiraHttpRequest,
  timeout: AbortSignal,
  details: (delivery: DeliveryState) => JiraErrorDetails,
): JiraRequestError {
  const target = `${request.method} ${request.path}`;
  if (timeout.aborted) {
    return new JiraTimeoutError(`Jira did not answer ${target} in time.`, details('unknown'), {
      cause: error,
    });
  }
  if (request.signal?.aborted) {
    return new JiraNetworkError(`Request ${target} was interrupted.`, details('unknown'), {
      cause: error,
    });
  }
  const code = errorCode(error);
  const delivery: DeliveryState =
    code !== undefined && NOT_SENT_CODES.has(code) ? 'not-sent' : 'unknown';
  return new JiraNetworkError(
    `Could not reach Jira for ${target}${code ? ` (${code})` : ''}.`,
    details(delivery),
    { cause: error },
  );
}

function errorCode(error: unknown): string | undefined {
  for (let current = error, depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function parseErrorMessages(text: string): string[] {
  try {
    const parsed = JiraErrorBodySchema.safeParse(JSON.parse(text));
    if (!parsed.success) return [];
    const { errorMessages = [], errors = {}, message } = parsed.data;
    return [
      ...errorMessages,
      ...Object.entries(errors).map(([field, msg]) => `${field}: ${msg}`),
      ...(message ? [message] : []),
    ].slice(0, 5);
  } catch {
    return [];
  }
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

async function readLimited(response: Response, limit: number): Promise<string> {
  if (!response.body) return '';
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error(`Jira response exceeds ${String(limit)} bytes.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
