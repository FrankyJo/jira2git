# Authentication

Status: **API-token authentication is implemented (Phase 2).** Git2Jira's own OAuth is an interface
only (`src/jira/auth/oauth.ts`); no OAuth flow exists in the CLI and none is simulated. Since Phase 2.5,
the API token is **optional**: manual mode needs no Jira authorization, and MCP mode uses the OAuth
sign-in of the Atlassian Rovo MCP server inside Claude Code.

## Which authorization each mode uses

| Mode (`jira.mode`) | Authorization                                         | Where it lives             | Git2Jira sees it       |
| ------------------ | ----------------------------------------------------- | -------------------------- | ---------------------- |
| `manual` (default) | None. The user pastes the report into Jira themselves | the user's browser session | No                     |
| `mcp`              | OAuth 2.1 consent for the Atlassian Rovo MCP server   | Claude Code (`/mcp`)       | **No**                 |
| `api-token`        | Personal API token (legacy/personal, optional)        | OS credential store        | Yes, sent only to Jira |

### Atlassian MCP (OAuth in Claude Code)

- Endpoint: `https://mcp.atlassian.com/v2/mcp` (registered with `git2jira mcp setup`, or
  `claude mcp add --transport http --scope user atlassian https://mcp.atlassian.com/v2/mcp`).
- Sign-in: in Claude Code, run `/mcp`, select the server, choose Authenticate, and approve the consent in
  the browser (Claude Code 2.1 also offers `claude mcp login <name>`). The tokens stay in Claude Code.
- Git2Jira does not extract, read, or reuse those tokens, and the Node.js CLI cannot call MCP: every MCP
  call is made by the Claude Code session, and its results are handed to the CLI for validation
  ([jira-publication.md](jira-publication.md#mcp-mode)).
- Git2Jira cannot observe the sign-in. It only reports access as verified after read-only tool calls from
  the session succeeded (`git2jira mcp verify`), and write access only after the first comment exists.
- Atlassian documents that actions respect the user's existing Jira permissions, that admins control
  API-token access to Rovo MCP and some tool groups (`delete_jira`, `manage_jira` are off by default),
  and that the `write_jira` group holds comment creation. If an admin control blocks access, Git2Jira
  says so and offers manual mode; it never tries another way in.
- Exact error messages for blocked or expired access have not been observed yet; they are classified
  conservatively.
- Since Phase 6 the CLI enforces it: `report publish` refuses unless the last access check for the same
  server was `ready` (reads worked, comment tool visible) and is less than 12 hours old. Read-only,
  blocked, or unchecked access keeps automatic publication off; manual mode stays available.
- `git2jira doctor` shows four separate facts: registered (`claude mcp list`), authorized (Claude
  Code's health status, its own statement), Jira read access verified, comment tool available.
- **Not verified against a real Atlassian site** (see [release-checklist.md](release-checklist.md#readiness)).

## Provider abstraction

```ts
interface JiraAuthProvider {
  readonly method: 'api-token' | 'oauth';
  readonly connection: string;
  hasCredentials(): Promise<boolean>;
  logout(): Promise<boolean>;
  authorize(): Promise<JiraAuthorization>; // { apiBaseUrl, headers.Authorization }
}
```

`JiraAuthorization` is only handed to the HTTP layer (`JiraHttp`). It is never logged, persisted,
included in errors, or included in any data sent to Claude. Sign-in, sign-out, and checks are done by
`JiraConnectionManager` (`src/jira/connections.ts`).

## Personal use: Jira Cloud API token (optional)

```sh
git2jira login                                   # prompts for site, email, and token (masked)
echo "$TOKEN" | git2jira login --site https://example.atlassian.net \
    --email you@example.com --token-stdin       # non-interactive
git2jira connections --check                     # verify stored credentials (read-only)
git2jira logout                                  # delete the token from the OS store
git2jira logout --forget                         # also delete the connection settings
```

1. You create a token at <https://id.atlassian.com/manage-profile/security/api-tokens>.
2. `login` verifies it with a read-only call (`GET /rest/api/3/myself`) **before** storing anything.
3. The token goes into the OS credential store (service `git2jira-ai`, account
   `jira-api-token:<connection>`). If storing succeeds but saving the settings fails, the token is
   removed again.
4. Only non-secret settings go into the global config: site URL, auth method, email, token type, cloud
   id, project routing.
5. Requests use HTTP Basic authentication (`email:token`) over HTTPS.

The token is never accepted as a command-line argument (it would end up in shell history and the process
list). It comes from a masked prompt or from stdin (`--token-stdin`).

### Token types

| Token                        | API base URL                                  | How Git2Jira handles it                                                                                                                           |
| ---------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Classic (unscoped) API token | `https://<site>.atlassian.net`                | Default; tried first                                                                                                                              |
| Scoped API token             | `https://api.atlassian.com/ex/jira/<cloudId>` | With `--token-type auto` (default), a 401 on the site URL is retried once through the gateway; the cloud id comes from `<site>/_edge/tenant_info` |

Atlassian documents that scoped tokens only work through the `api.atlassian.com` gateway, and that
service accounts can only use scoped tokens. Force a type with `--token-type classic|scoped`.

**Scopes for a scoped token.** Git2Jira reads the current user, issues, comments, and comment properties,
and creates comments and comment properties. The classic scopes `read:jira-user`, `read:jira-work`, and
`write:jira-work` cover this. If you choose granular scopes instead, they must cover the same operations
(users, issues, comments, comment properties: read; comments, comment properties: write). The exact
granular scope names have not been verified against a live site; check Atlassian's scope reference for
each endpoint listed in [jira-publication.md](jira-publication.md).

**Expiry.** API tokens expire (Atlassian lets you choose up to one year). Jira answers an expired,
revoked, or wrong token with 401 and does not say which. `connections --check` reports `rejected`, and
publishing fails before anything is recorded; run `git2jira login` again.

**Jira permissions.** Besides token scopes, the account needs Browse Projects and Add Comments on the
issue's project. A missing permission shows up as 404 (issue invisible) or 403 (comment refused).

### Credential storage

| OS      | Backend                    | Tool                                               | Secret passed via                   |
| ------- | -------------------------- | -------------------------------------------------- | ----------------------------------- |
| macOS   | Keychain                   | `/usr/bin/security`                                | stdin of `security -i`, hex-encoded |
| Linux   | Secret Service (libsecret) | `secret-tool` (package `libsecret-tools`)          | stdin of `secret-tool store`        |
| Windows | Credential Manager         | `powershell.exe` with Win32 `CredWrite`/`CredRead` | stdin; script via `-EncodedCommand` |

- Secrets never appear in command-line arguments, where other local processes could read them.
- Without a usable backend (for example a headless Linux machine without a D-Bus session), `login`
  fails with a clear message. **There is no plaintext fallback.**
- The macOS adapter is tested against a throwaway keychain file (opt-in:
  `GIT2JIRA_TEST_KEYCHAIN=1 pnpm test`). The Linux and Windows adapters are tested with a scripted
  process runner only; they have not yet been exercised on real Linux or Windows machines.

## Multiple connections

A connection is a named site + account (`git2jira login --connection oss --site https://oss.atlassian.net`).
For every command that acts on an issue, the connection is chosen deterministically:

1. `--connection <name>`
2. `--site <url>` (the connection for that site)
3. `jira.site` in `.git2jira.json` (`git2jira config set jira.site https://… --repo`)
4. the site this issue already has report history for in this repository
5. a connection whose `projectKeys` contain the issue's project (`login --project LSND`)
6. `jira.defaultConnection` (`git2jira config set jira.defaultConnection work`)
7. the only connection, if there is exactly one

When a rule matches several connections, the default wins if it is among them; otherwise Git2Jira
stops and asks for `--connection`. It never guesses. The prepared report remembers its connection, and
`publish` refuses if that connection now points at another site.

## Public distribution: OAuth (not implemented)

Personal API tokens are fine for one developer on their own machine. A publicly distributed tool used by
many people on many Jira sites should use OAuth 2.0 (3LO), so users grant scoped, revocable access to an
app instead of handing it their personal token. That requires an Atlassian app registration and
decisions that are not code:

**Fixed constraints**

- **No confidential client secret is ever embedded in distributed software.** A secret shipped in an
  npm package is public. `OAuthClientRegistration` has no secret field by design.
- PKCE alone does not make a native, distributed client acceptable. What matters is which grant and
  client types Atlassian supports for this app type, and its distribution rules.

**Candidate architectures**

1. **Public-client authorization code flow with PKCE**, only if Atlassian supports public clients
   without a secret for this app type at that time.
2. **Token-exchange broker**: a small service operated by the project holds the client secret and
   performs code exchange and refresh (`tokenBrokerUrl`). The CLI never sees the secret. This adds
   hosting, privacy, and operational responsibilities that must be accepted explicitly.
3. **An Atlassian platform app** (for example Forge), if the platform's distribution model fits.

**Evaluation checklist** (open): supported grants and client types; loopback redirect URI rules;
refresh-token rotation (`OAuthAuthorizationFlow.refresh` replaces the stored set atomically); required
scopes; app review and distribution requirements; data residency. OAuth calls go to
`api.atlassian.com/ex/jira/{cloudId}`, like scoped tokens, so the HTTP client and connection model
already support them.

| Aspect                    | Personal token mode (now)                                  | Public OAuth distribution (future)             |
| ------------------------- | ---------------------------------------------------------- | ---------------------------------------------- |
| Who registers what        | Each user creates their own API token                      | The project registers an Atlassian OAuth app   |
| Secret on the user's disk | The user's API token, in the OS store                      | Access/refresh tokens, in the OS store         |
| Client secret             | None                                                       | Never in the CLI; broker or public client only |
| Revocation                | User deletes the token at id.atlassian.com                 | User revokes the app grant                     |
| Scope                     | Everything the user can do (classic) or the token's scopes | The app's approved scopes                      |
| Operational burden        | None for the project                                       | App review; possibly running a broker service  |

A connection with `authMethod: "oauth"` is rejected with a clear message until this is implemented.
