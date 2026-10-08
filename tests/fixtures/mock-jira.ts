import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { FetchLike } from '../../src/jira/client/http';

/**
 * In-process mock of the Jira Cloud REST v3 endpoints Git2Jira uses, served
 * over a real local HTTP socket so timeouts, dropped connections, and
 * Retry-After behave like the network. Tests reach it through `fetch`, which
 * rewrites https://example.atlassian.net and https://api.atlassian.com to it.
 * Nothing here talks to a real Jira site.
 */
export interface MockAccount {
  email: string;
  token: string;
  accountId: string;
  displayName: string;
  /** Scoped tokens only work through api.atlassian.com/ex/jira/{cloudId}. */
  scoped?: boolean;
}

export interface MockIssue {
  id: string;
  key: string;
  summary: string;
  description?: unknown;
  status?: string;
  /** Account ids that may see the issue (all when omitted). Others get 404, like Jira. */
  viewers?: string[];
  /** Account ids that may comment (all viewers when omitted). Others get 403. */
  commenters?: string[];
}

export interface MockComment {
  id: string;
  created: string;
  author: { accountId: string; displayName: string };
  body: unknown;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  gateway: boolean;
  body?: unknown;
}

/**
 * - `{ status }`: answer with this status (and optional headers/body) without processing.
 * - `hang`: never answer (client timeout), without processing.
 * - `drop`: destroy the connection without processing.
 * - `process-then-drop` / `process-then-hang` / `process-then-status`: perform the request,
 *   then lose the response.
 */
export type MockFault =
  | { status: number; headers?: Record<string, string>; body?: unknown }
  | { kind: 'hang' | 'drop' | 'process-then-drop' | 'process-then-hang' }
  | { kind: 'process-then-status'; status: number };

interface FaultRule {
  method: string;
  pathPattern: RegExp;
  fault: MockFault;
  remaining: number;
}

export const SITE_URL = 'https://example.atlassian.net';
export const CLOUD_ID = '11111111-2222-4333-8444-555555555555';

export class MockJira {
  readonly accounts: MockAccount[] = [];
  readonly issues = new Map<string, MockIssue>();
  /** Old key → current key (moved issues). */
  readonly moved = new Map<string, string>();
  readonly comments = new Map<string, MockComment[]>();
  readonly properties = new Map<string, Map<string, unknown>>();
  readonly requests: RecordedRequest[] = [];
  /** Server-side cap on maxResults, to force pagination. */
  pageCap = 2;
  /** Simulates Jira dropping `properties` sent with a new comment. */
  ignorePropertiesOnCreate = false;
  /** Makes property PUTs fail with 500. */
  failPropertyWrites = false;
  /** Clock for comment timestamps. */
  now: () => Date = () => new Date();

  private nextCommentId = 10_000;
  private readonly faults: FaultRule[] = [];
  private readonly sockets = new Set<Socket>();
  private constructor(
    private readonly server: Server,
    readonly origin: string,
  ) {}

  static async start(): Promise<MockJira> {
    const handlers: { handle?: (req: IncomingMessage, res: ServerResponse) => Promise<void> } = {};
    const server = createServer((req, res) => {
      void handlers.handle?.(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const mock = new MockJira(server, `http://127.0.0.1:${String(port)}`);
    handlers.handle = (req, res) => mock.handle(req, res);
    server.on('connection', (socket) => {
      mock.sockets.add(socket);
      socket.on('close', () => {
        mock.sockets.delete(socket);
      });
    });
    return mock;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }

  /** Fetch that routes the Jira site and the API gateway to this server. */
  readonly fetch: FetchLike = (input, init) => {
    const url = new URL(input);
    let target: string;
    if (url.origin === SITE_URL) target = `${this.origin}${url.pathname}${url.search}`;
    else if (url.origin === 'https://api.atlassian.com')
      target = `${this.origin}/__gateway${url.pathname}${url.search}`;
    else throw new TypeError(`fetch failed: unexpected host ${url.origin}`);
    return fetch(target, init);
  };

  addAccount(account: MockAccount): MockAccount {
    this.accounts.push(account);
    return account;
  }

  issue(key: string): MockIssue {
    const issue = this.issues.get(key);
    if (!issue) throw new Error(`no mock issue ${key}`);
    return issue;
  }

  addIssue(issue: MockIssue): MockIssue {
    this.issues.set(issue.key, issue);
    this.comments.set(issue.key, this.comments.get(issue.key) ?? []);
    return issue;
  }

  /** Adds a comment directly (as if posted by someone, or by a process that crashed). */
  insertComment(
    issueKey: string,
    author: MockAccount,
    body: unknown,
    properties: Record<string, unknown> = {},
  ): MockComment {
    const comment: MockComment = {
      id: String(this.nextCommentId++),
      created: jiraTime(this.now()),
      author: { accountId: author.accountId, displayName: author.displayName },
      body,
    };
    this.comments.get(issueKey)?.push(comment);
    const map = new Map(Object.entries(properties));
    this.properties.set(comment.id, map);
    return comment;
  }

  fault(method: string, pathPattern: RegExp, fault: MockFault, times = 1): void {
    this.faults.push({ method, pathPattern, fault, remaining: times });
  }

  clearFaults(): void {
    this.faults.length = 0;
  }

  count(method: string, pathPattern: RegExp): number {
    return this.requests.filter((r) => r.method === method && pathPattern.test(r.path)).length;
  }

  // ---------------------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.origin);
    let path = url.pathname;
    let gateway = false;
    const gatewayPrefix = `/__gateway/ex/jira/${CLOUD_ID}`;
    if (path.startsWith('/__gateway')) {
      if (!path.startsWith(gatewayPrefix)) {
        this.send(res, 404, { errorMessages: ['Unknown cloud id'] });
        return;
      }
      path = path.slice(gatewayPrefix.length);
      gateway = true;
    }
    const raw = await readBody(req);
    const body = raw ? (JSON.parse(raw) as unknown) : undefined;
    this.requests.push({
      method: req.method ?? 'GET',
      path,
      query: Object.fromEntries(url.searchParams),
      gateway,
      ...(body === undefined ? {} : { body }),
    });

    const rule = this.faults.find(
      (f) => f.remaining > 0 && f.method === req.method && f.pathPattern.test(path),
    );
    if (rule) rule.remaining--;
    const fault = rule?.fault;
    if (fault && 'status' in fault && !('kind' in fault)) {
      this.send(
        res,
        fault.status,
        fault.body ?? { errorMessages: ['Injected failure'] },
        fault.headers,
      );
      return;
    }
    if (fault && 'kind' in fault) {
      if (fault.kind === 'hang') return;
      if (fault.kind === 'drop') {
        req.socket.destroy();
        return;
      }
    }

    const [status, payload] = this.route(
      req.method ?? 'GET',
      path,
      url.searchParams,
      body,
      gateway,
      req,
    );
    if (fault && 'kind' in fault) {
      if (fault.kind === 'process-then-drop') {
        req.socket.destroy();
        return;
      }
      if (fault.kind === 'process-then-hang') return;
      if (fault.kind === 'process-then-status') {
        this.send(res, fault.status, { errorMessages: ['Gateway timeout'] });
        return;
      }
    }
    this.send(res, status, payload);
  }

  private route(
    method: string,
    path: string,
    query: URLSearchParams,
    body: unknown,
    gateway: boolean,
    req: IncomingMessage,
  ): [number, unknown] {
    if (method === 'GET' && path === '/_edge/tenant_info') return [200, { cloudId: CLOUD_ID }];

    const account = this.authenticate(req.headers.authorization, gateway);
    if (!account)
      return [401, { errorMessages: ['Client must be authenticated to access this resource.'] }];

    if (method === 'GET' && path === '/rest/api/3/myself') {
      return [
        200,
        {
          accountId: account.accountId,
          displayName: account.displayName,
          emailAddress: account.email,
          active: true,
        },
      ];
    }

    let match = /^\/rest\/api\/3\/issue\/([^/]+)$/.exec(path);
    if (method === 'GET' && match) {
      const issue = this.visibleIssue(decodeURIComponent(match[1] ?? ''), account);
      if (!issue) return notFound();
      return [
        200,
        {
          id: issue.id,
          key: issue.key,
          fields: {
            summary: issue.summary,
            description: issue.description ?? null,
            status: { name: issue.status ?? 'In Progress' },
          },
        },
      ];
    }

    match = /^\/rest\/api\/3\/issue\/([^/]+)\/comment$/.exec(path);
    if (match) {
      const issue = this.visibleIssue(decodeURIComponent(match[1] ?? ''), account);
      if (!issue) return notFound();
      const list = this.comments.get(issue.key) ?? [];
      if (method === 'GET') {
        const startAt = Number(query.get('startAt') ?? 0);
        const maxResults = Math.min(Number(query.get('maxResults') ?? 50), this.pageCap);
        const expand = query.get('expand')?.split(',').includes('properties') ?? false;
        const page = list.slice(startAt, startAt + maxResults);
        return [
          200,
          {
            startAt,
            maxResults,
            total: list.length,
            comments: page.map((c) => this.commentJson(c, expand)),
          },
        ];
      }
      if (method === 'POST') {
        if (issue.commenters && !issue.commenters.includes(account.accountId)) {
          return [
            403,
            { errorMessages: ['You do not have the permission to comment on this issue.'] },
          ];
        }
        const request = body as {
          body?: { type?: string };
          properties?: { key: string; value: unknown }[];
        };
        if (request.body?.type !== 'doc')
          return [400, { errors: { comment: 'Comment body is not valid!' } }];
        const comment = this.insertComment(issue.key, account, request.body);
        if (!this.ignorePropertiesOnCreate) {
          for (const property of request.properties ?? []) {
            this.properties.get(comment.id)?.set(property.key, property.value);
          }
        }
        return [201, this.commentJson(comment, false)];
      }
    }

    match = /^\/rest\/api\/3\/issue\/([^/]+)\/comment\/([^/]+)$/.exec(path);
    if (method === 'GET' && match) {
      const issue = this.visibleIssue(decodeURIComponent(match[1] ?? ''), account);
      const comment = issue
        ? this.comments.get(issue.key)?.find((c) => c.id === match?.[2])
        : undefined;
      return comment ? [200, this.commentJson(comment, true)] : notFound();
    }

    match = /^\/rest\/api\/3\/comment\/([^/]+)\/properties\/([^/]+)$/.exec(path);
    if (match) {
      const properties = this.properties.get(match[1] ?? '');
      const key = decodeURIComponent(match[2] ?? '');
      if (!properties) return notFound();
      if (method === 'GET') {
        return properties.has(key) ? [200, { key, value: properties.get(key) }] : notFound();
      }
      if (method === 'PUT') {
        if (this.failPropertyWrites) return [500, { errorMessages: ['Internal error'] }];
        const created = !properties.has(key);
        properties.set(key, body);
        return [created ? 201 : 200, undefined];
      }
    }
    return [404, { errorMessages: [`No route for ${method} ${path}`] }];
  }

  private authenticate(header: string | undefined, gateway: boolean): MockAccount | undefined {
    if (!header?.startsWith('Basic ')) return undefined;
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    const email = decoded.slice(0, separator);
    const token = decoded.slice(separator + 1);
    const account = this.accounts.find((a) => a.email === email && a.token === token);
    if (!account) return undefined;
    // Scoped tokens are rejected on the site URL, classic ones on the gateway.
    return Boolean(account.scoped) === gateway ? account : undefined;
  }

  private visibleIssue(key: string, account: MockAccount): MockIssue | undefined {
    const issue = this.issues.get(this.moved.get(key) ?? key);
    if (!issue) return undefined;
    if (issue.viewers && !issue.viewers.includes(account.accountId)) return undefined;
    return issue;
  }

  private commentJson(comment: MockComment, expandProperties: boolean) {
    const properties = this.properties.get(comment.id) ?? new Map<string, unknown>();
    return {
      id: comment.id,
      self: `${SITE_URL}/rest/api/3/comment/${comment.id}`,
      author: comment.author,
      body: comment.body,
      created: comment.created,
      updated: comment.created,
      ...(expandProperties
        ? { properties: [...properties].map(([key, value]) => ({ key, value })) }
        : {}),
    };
  }

  private send(
    res: ServerResponse,
    status: number,
    payload: unknown,
    headers: Record<string, string> = {},
  ): void {
    const text = payload === undefined ? '' : JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(text);
  }
}

function notFound(): [number, unknown] {
  return [
    404,
    { errorMessages: ['Issue does not exist or you do not have permission to see it.'] },
  ];
}

/** Jira's timestamp format, e.g. 2026-10-08T12:00:00.000+0000. */
function jiraTime(date: Date): string {
  return date.toISOString().replace('Z', '+0000');
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => {
      resolve('');
    });
  });
}

/** A credential store for tests only. Production code has no in-memory or file fallback. */
export class MemoryCredentialStore {
  readonly backend = 'macos-keychain' as const;
  readonly secrets = new Map<string, string>();
  available = true;
  isAvailable(): Promise<boolean> {
    return Promise.resolve(this.available);
  }
  get(reference: { account: string }): Promise<string | undefined> {
    return Promise.resolve(this.secrets.get(reference.account));
  }
  set(reference: { account: string }, secret: string): Promise<void> {
    this.secrets.set(reference.account, secret);
    return Promise.resolve();
  }
  delete(reference: { account: string }): Promise<boolean> {
    return Promise.resolve(this.secrets.delete(reference.account));
  }
}
