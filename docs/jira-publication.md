# Jira publication

Status: **API-token publication implemented in Phase 2; manual and Atlassian MCP delivery in Phase 2.5**
(see [Delivery modes](#delivery-modes)). Code: `src/jira`, `src/adf`, `src/publication`,
`src/credentials`, `src/delivery`, `src/mcp`.
Tests: `tests/jira`, `tests/adf`, `tests/publication`, `tests/credentials`, `tests/cli/jira-commands.test.ts`
(all against a mocked Jira server; no test talks to a real site).

The `git2jira report` command drives this flow end to end since Phase 3 (see
[ai-reporting.md](ai-reporting.md)); the Skill arrives in Phase 4. Phase 2 delivers the service it will call (`JiraPublicationService`) and the
`login`, `logout`, `connections`, `history`, `recover`, and `status --jira` commands.

## Jira REST client

`JiraRestClient` (`src/jira/client/rest-client.ts`) uses Jira Cloud REST v3 over native `fetch`:

| Operation                 | Endpoint                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| Current user (auth check) | `GET /rest/api/3/myself`                                                                   |
| Issue by exact key        | `GET /rest/api/3/issue/{key}?fields=summary,description,status`                            |
| Comments (paginated)      | `GET /rest/api/3/issue/{key}/comment?startAt&maxResults&orderBy=created&expand=properties` |
| One comment               | `GET /rest/api/3/issue/{key}/comment/{id}?expand=properties`                               |
| Create comment            | `POST /rest/api/3/issue/{key}/comment` with `{ body, properties }`                         |
| Comment property          | `GET`/`PUT /rest/api/3/comment/{id}/properties/git2jira.report`                            |
| Cloud id (scoped tokens)  | `GET {site}/_edge/tenant_info` (unauthenticated)                                           |

There is no method to edit or delete comments. Every response is validated with Zod
(`src/jira/client/schemas.ts`); path parameters (issue keys, comment ids, property keys) are validated
before a URL is built. Redirects are never followed, so the `Authorization` header cannot be forwarded
elsewhere. Jira text printed to the terminal goes through `terminalSafe` (control characters, including
ANSI escapes, are neutralized).

If Jira answers a request for `ABC-1` with another key (the issue was moved), `getIssue` fails with
`IssueKeyMismatchError`. Git2Jira never switches issues on its own.

### Errors, retries, and delivery

`JiraHttp` (`src/jira/client/http.ts`) maps failures to typed errors (`JiraAuthenticationError` 401,
`JiraPermissionError` 403, `JiraNotFoundError` 404, `JiraRateLimitError` 429, `JiraServerError` 5xx,
`JiraTimeoutError`, `JiraNetworkError`, `JiraResponseError`). Each carries a **delivery state**:

| Delivery   | Meaning                                          | Examples                                         |
| ---------- | ------------------------------------------------ | ------------------------------------------------ |
| `not-sent` | The request never reached Jira                   | DNS failure, connection refused, TLS failure     |
| `rejected` | Jira answered with an error; nothing was changed | 400, 401, 403, 404, 429                          |
| `unknown`  | Jira may or may not have acted                   | timeout, dropped connection, 5xx, unreadable 2xx |

Retries:

- **Reads and the idempotent property `PUT`** are retried on 429, 500/502/503/504, timeouts, and network
  errors: at most 4 attempts, exponential backoff from 1 s (cap 15 s) with ±30 % jitter. `Retry-After`
  (seconds or HTTP date) is honored; a wait longer than 60 s is not attempted and the error is shown.
- **Comment creation is never retried automatically**, not even after a 429 (Atlassian recommends
  retrying only idempotent requests). Each request has a 30 s timeout.

## ADF rendering

`StructuredReportRenderer` (`src/adf/render.ts`) turns a validated `StructuredReport` plus Git's list of
changed files into Atlassian Document Format. It is deterministic: the same input always produces the
same document, which is what the approval digest covers.

| Section (en / uk)                                           | Content                                                               |
| ----------------------------------------------------------- | --------------------------------------------------------------------- |
| Implementation Report #N / Звіт про реалізацію #N           | heading                                                               |
| Summary / Підсумок                                          | `summary`                                                             |
| Completed Work / Виконані роботи                            | `changes` and `apiChanges`, with localized kind labels                |
| Created Files / Створені файли                              | added and copied paths (from Git)                                     |
| Modified Files / Змінені файли                              | modified and type-changed paths (from Git)                            |
| Deleted or Renamed Files / Видалені або перейменовані файли | deleted paths, renames as `old → new` (from Git)                      |
| Testing and Validation / Тестування та перевірки            | `testing` (omitted when empty)                                        |
| Known Limitations / Відомі обмеження                        | `risks` and `followUps` (omitted when empty)                          |
| footer                                                      | `Git2Jira report <uuid> · #N · <base>..<target> · git2jira <version>` |

- Paths and endpoints are shown verbatim in `code` marks; report text only ever lands in `text` nodes,
  so it cannot create links, mentions, or macros. Line breaks become `hardBreak`; control characters
  become U+FFFD.
- File lists come from Git, not from the model. More than 100 entries in a section end with
  "… and N more".
- `validateAdfDocument` (`src/adf/validate.ts`) checks the exact node subset (strict schema), non-empty
  text nodes, the `code`-mark rule, and size (30,000 characters of text, below Jira's 32,767 limit)
  before anything is sent.

## Publication state machine

Each report has a stable UUID (`reportId`) and a plan file in `<git common dir>/git2jira/plans/`.

```
DRAFT ─► READY_FOR_REVIEW ─► APPROVED ─► PUBLISHING ─► PUBLISHED
            ▲    │  ▲            │            ├─► FAILED ─► PUBLISHING (retry of the same report)
            └────┘  └────────────┘            └─► UNCERTAIN ─► RECOVERED | FAILED
```

| State              | Meaning                                                                            |
| ------------------ | ---------------------------------------------------------------------------------- |
| `DRAFT`            | Issue verified in Jira, snapshot captured under a candidate ref, no report yet     |
| `READY_FOR_REVIEW` | Report validated, rendered, ADF validated, digest computed                         |
| `APPROVED`         | The user approved exactly that digest                                              |
| `PUBLISHING`       | Journal entry written, comment request in flight (or the process died)             |
| `PUBLISHED`        | Jira returned the comment id; checkpoint promoted                                  |
| `FAILED`           | Jira definitely did not create the comment (retryable unless the body was invalid) |
| `UNCERTAIN`        | The outcome could not be established; never retried blindly                        |
| `RECOVERED`        | An uncertain or interrupted publication was found in Jira and recorded             |

`JiraPublicationService`: `prepare` → `review(report)` → `approve(digest)` → `publish(digest)`, plus
`cancel`, `recover`, and `history`. Replacing the report after approval returns to `READY_FOR_REVIEW`
and clears the approval. The lower-level journal (Phase 1) records `publishing`, `confirmed`,
`published`, `failed`, and `cancelled`.

### Approval digest

`reportDigest` is SHA-256 over canonical JSON of the site id, issue key, report id, sequence, baseline
tree, snapshot tree and commit, and the exact ADF document. Approval stores that digest; `publish`
requires the same digest as an argument, recomputes it from the stored document, and refuses on any
difference.

## Before and after publishing

`publish` holds a per-issue publication lock (`locks/publish-<site>-<ISSUE>.lock`) and checks, in order:

1. **Site**: the plan's connection still points at the site the report was prepared for.
2. **Issue**: the report targets the prepared key; Jira still returns that key with the same issue id
   (this also verifies authentication before anything is recorded).
3. **Snapshot**: same repository id; the candidate ref still points at the snapshot commit, whose tree
   matches.
4. **Changes**: the previewed file list and a fresh `git diff-tree` of the two trees both match the
   digest recorded at preparation.
5. **Lock** held.
6. **Existing records**: the journal has no other entry for this report id; on a retry, the issue's
   comments are scanned and an existing comment for this report id is recorded instead of posting again.
7. **Approval**: re-read under the lock and verified against the digest.

Then the journal entry `publishing` is written, the plan becomes `PUBLISHING`, and the comment is posted
once, with the metadata property attached. On success:

1. The returned comment id is verified: the comment must contain this report's marker.
2. The id is recorded in the journal and the checkpoint is promoted.
3. The `git2jira.report` property is confirmed (and written with `PUT` if Jira did not keep it).
4. The plan becomes `PUBLISHED` with the comment URL
   (`<site>/browse/<ISSUE>?focusedCommentId=<id>`).

On failure: `not-sent` or `rejected` → `FAILED` (the snapshot is kept so the same approved report can be
retried; a 400/413 is not retryable). `unknown` → `UNCERTAIN`, then the comments are scanned once; if
the comment is there, the report is `RECOVERED`.

### No exactly-once guarantee

Jira's comment API has no idempotency key, so Git2Jira **cannot guarantee exactly-once delivery**. What it
does guarantee:

- A comment request is sent again only after Jira **definitely** rejected the previous one, or after a
  complete scan of the issue's comments found no comment for that report id **and** the settle window
  (2 minutes) has passed since the attempt. A request that timed out may still be processed by Jira
  later; the window reduces, but cannot eliminate, that risk.
- Only comments written by the authenticated account count when reconciling; anyone can paste a marker
  into a comment.
- If a duplicate does appear, `recover` reports it. Git2Jira cannot delete comments.

### Report metadata

Every comment carries a non-secret identity in two places:

- the **footer marker** `Git2Jira report <uuid> · #N · …` in the comment text, and
- the **comment property** `git2jira.report`: schema version, report id, sequence, issue key, site id,
  repository id (random UUID), base and target trees, snapshot commit, report digest, language, tool
  version.

The marker survives when the property is lost; the property survives edits to the text.

## Recovery

`git2jira recover` holds the publication lock and never posts a comment:

| Situation                                       | What recover does                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| Timeout, or comment created but response lost   | Scans comments; found → `RECOVERED` and checkpoint promoted               |
| Not found after a complete scan + settle window | `FAILED` (retryable); `publish` sends the same report again               |
| Scan incomplete, Jira unreachable, too early    | Stays `UNCERTAIN`; says why; nothing re-sent                              |
| Comment created but property not stored         | Writes the property (`PUT`), marks the plan                               |
| Process crash at any point                      | Journal `publishing` → as above; plans synced with the journal            |
| Checkpoint not promoted                         | Promotes `confirmed` records (Phase 1 recovery)                           |
| Journal lost or corrupted                       | Quarantines and rebuilds from checkpoint refs (Phase 1 recovery)          |
| Several comments with one report id             | Uses the earliest, lists the others                                       |
| Jira has reports this repository does not know  | Lists them (another clone or machine)                                     |
| A recorded comment was deleted in Jira          | Reports it; local history is kept                                         |
| Authentication failed after preparing           | The plan stays `APPROVED`; `git2jira login`, then publish the same report |

The relationship between comments and snapshots is kept in three places: the journal, the checkpoint
commit message under `refs/git2jira/…`, and the comment's metadata property.

## Commands

```sh
git2jira login [--connection work] [--site URL] [--email EMAIL] [--token-stdin] [--project LSND]
git2jira connections [--check] [--json]
git2jira logout [--connection work | --all] [--forget]
git2jira status --jira                 # verify the issue in Jira (read-only)
git2jira history [--offline] [--json]  # local history, cross-checked with Jira
git2jira recover [--json]              # settle interrupted publications
```

All accept `--connection`/`--site` where a site must be chosen (see
[authentication.md](authentication.md#multiple-connections)).

## Delivery modes

Phase 2.5 adds two ways to get a report into Jira besides the API token. All three share the same
snapshots, lineage journal, and checkpoint refs, so a lineage (repository × Jira site × issue) can mix
modes: a manual report #1 is the baseline for an MCP or API-token report #2.

| Mode (`jira.mode`) | Jira credentials in Git2Jira      | Who calls Jira                 | Evidence that moves the checkpoint (`confirmedBy`)                    |
| ------------------ | --------------------------------- | ------------------------------ | --------------------------------------------------------------------- |
| `manual` (default) | none                              | the user, by pasting           | the user's confirmation of the exact digest (`user-attested`)         |
| `mcp`              | none (OAuth stays in Claude Code) | the user's Claude Code session | an MCP tool result or listing carrying the report marker (`mcp-tool`) |
| `api-token`        | API token in the OS store         | `git2jira`                     | Jira's REST response (`jira-api`)                                     |

Mode precedence: `report prepare --mode`, repository `jira.mode`, global `jira.mode`, then `manual`.
There is no automatic fallback: when the chosen mode cannot work, the command stops and says so; switching
a report to manual (`report fallback`) is an explicit user action.

**Site.** Checkpoints are kept per Jira site. Manual mode does not need one: without `--site` or
`jira.site` (repository, or global), manual reports use the placeholder lineage
`https://jira-site-not-configured.invalid`. Set `jira.site` to share history with MCP or API-token
reports; history recorded under the placeholder is not merged automatically.

### Drafts

Manual and MCP reports are **drafts** in `<git common dir>/git2jira/drafts/<reportId>.json` (strict Zod
schema, `src/delivery/draft.ts`). A draft holds the candidate snapshot and its ref, baseline, sequence,
issue key, language, the changed files from Git, the structured report, the three renderings (Markdown,
plain text, ADF), the digest, and a timestamped event list. Only one open draft per lineage exists;
`report prepare` returns the pending one instead of creating another.

The digest (`draftDigest`) is SHA-256 over canonical JSON of site, issue, report id, sequence, both
trees, the snapshot commit, and all three renderings. Approval (MCP) and attestation (manual) are bound to
it; any change to the text produces a new digest.

The pasted text and the MCP Markdown body are rendered deterministically by `src/delivery/render.ts`:
the same sections and localized headings as the ADF comment, file lists from Git, model text
Markdown-escaped (no links, images, HTML, headings, or tables can come from it). The only machine line is
the marker `Git2Jira report <uuid> · #N`, kept so a later MCP or API-token scan can recognize the comment
(duplicate detection and recovery). Trees, tool version, and metadata properties are not included.

## Manual mode

```
DRAFT ─► READY_TO_COPY ─► AWAITING_MANUAL_CONFIRMATION ─► MANUALLY_CONFIRMED
            ▲  │                 │      ▲                        │
            └──┘ (new text)      │      └──── report revoke ─────┘
  ─────────────────────────────────► CANCELLED
  open states ─► RECOVERY_REQUIRED ─► back | CANCELLED | MANUALLY_CONFIRMED
```

| State                          | Meaning                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `DRAFT`                        | Snapshot captured under a candidate ref; no text yet                                 |
| `READY_TO_COPY`                | Report validated and rendered; digest computed; saved in the draft                   |
| `AWAITING_MANUAL_CONFIRMATION` | Copied to the clipboard or exported to a file                                        |
| `MANUALLY_CONFIRMED`           | The user confirmed this digest is in Jira; checkpoint promoted                       |
| `CANCELLED`                    | Abandoned; candidate ref removed; baseline unchanged                                 |
| `RECOVERY_REQUIRED`            | Snapshot lost, a newer report was confirmed first, or a confirmation was interrupted |

Workflow: `report prepare` (branch → issue key → last checkpoint → snapshot → change set; prints the
generation request with untrusted content marked) → the report writer produces the structured report →
`report submit` → `report show | copy | export` → the user pastes it into the issue → `report confirm
--report <id> --digest <d>`.

- Generating, showing, copying, or exporting never moves the checkpoint. Not confirming leaves the
  report pending; the next `prepare` offers it again.
- `confirm` asks "Did you paste report #N into ISSUE?" on a terminal; without one it requires
  `--attest-manual-publication`. In a Skill, `confirm` is never pre-approved, so Claude Code's permission
  prompt shows the user the exact command: the model cannot confirm on the user's behalf.
- On confirmation the attestation is written to the draft first, then the journal entry, then the
  checkpoint is promoted **from the candidate snapshot captured at `prepare`**. Files changed after the
  report was generated are not part of the checkpoint and appear in the next report.
- The journal record says `confirmedBy: "user-attested"` and has no comment id. Nothing was verified in
  Jira; `history` and `report pending --json` say so.
- `report recover` finishes a confirmation interrupted after the journal entry (the attestation proves
  the user confirmed), treats a journal entry without matching attestation as not published, flags
  drafts whose snapshot or baseline no longer holds, and never contacts Jira.
- `report revoke` withdraws an accidental confirmation: only the latest checkpoint, only if
  user-attested. The snapshot goes back under its candidate ref, the checkpoint ref is deleted, the journal
  record becomes `revoked` (kept for audit), and the draft returns to `AWAITING_MANUAL_CONFIRMATION`. A
  report confirmed through Jira's API or MCP cannot be revoked: a comment exists, and Git2Jira cannot
  delete comments.
- Candidate refs of open drafts are never removed by recovery, however long the user waits.

## MCP mode

### Boundary

The Atlassian Rovo MCP server (`https://mcp.atlassian.com/v2/mcp`) is authorized with OAuth **inside
Claude Code**. Git2Jira does not read, extract, or reuse that authorization, and the Node.js CLI never
calls MCP. The split:

- **CLI**: snapshots, checkpoints, draft state, validation, the approval digest, the write-ahead journal
  entry, interpreting results, and every decision about retries and checkpoints.
- **Claude Code session (Skill)**: writes the report, shows it, asks for approval, and calls the MCP
  tools. It hands raw tool results to the CLI as JSON files (`src/mcp/bridge.ts`).
- The read-only analysis subagent (Phase 4) gets no write tools.

### Tools

Names from Atlassian's supported-tools page (read 2026-10-08), in `src/mcp/tools.ts`. The page lists
names and groups, not parameters or result shapes.

| Capability          | Tool                              | Group      |
| ------------------- | --------------------------------- | ---------- |
| Sites and cloud ids | `getAccessibleAtlassianResources` | common     |
| Signed-in account   | `atlassianUserInfo`               | common     |
| Exact issue lookup  | `getJiraIssue`                    | read_jira  |
| Existing comments   | `listJiraIssueComments`           | read_jira  |
| New comment         | `addOrEditJiraIssueComment`       | write_jira |

The Skill reports the tool names its session actually has; only those matching a documented name for
the configured server (`mcp__<server>__<tool>`) are used. `addOrEditJiraIssueComment` can also edit; the
Skill must never pass an existing comment id. Jira **comment properties are not assumed** to be available
through MCP (even though entity-property tools exist): the marker in the comment text is the only
publication identifier.

### Access check (`git2jira mcp verify`)

The Skill calls the read-only tools and passes `{ tools, server, probes: { resources, userInfo, issue } }`.
`assessMcpAccess` returns one of:

| State               | Meaning                                                                                    | Publication |
| ------------------- | ------------------------------------------------------------------------------------------ | ----------- |
| `ready`             | Reads worked; all needed tools visible. Writing is confirmed only by the first publication | on          |
| `read-only`         | No `addOrEditJiraIssueComment` (write_jira not granted or disabled)                        | off         |
| `no-tools`          | No Atlassian tools in the session: not registered or OAuth not completed (`/mcp`)          | off         |
| `not-authenticated` | The server rejected the authorization                                                      | off         |
| `blocked-by-policy` | An organization/admin control blocks access; Git2Jira does not work around it              | off         |
| `no-jira-access`    | No Jira site for this account, or the issue cannot be read                                 | off         |
| `unknown`           | Tools visible but no successful read reported                                              | off         |

Anything but `ready` means: offer manual mode. The last result is stored (no secrets) in
`<config dir>/mcp-verification.json` and shown by `git2jira mcp status`.

### Publication

```
DRAFT ─► READY_FOR_REVIEW ─► APPROVED ─► PUBLISHING ─► PUBLISHED
                                              ├─► FAILED ─► PUBLISHING (retry, needs a listing)
                                              └─► UNCERTAIN ─► RECOVERED | FAILED
```

1. `report prepare --mode mcp --site <url> --cloud-id <id> --issue-lookup <file>`: the lookup result
   must return exactly the branch's issue key (a moved issue fails with `IssueKeyMismatchError`).
2. `report submit` → `READY_FOR_REVIEW`; the Skill shows the text and digest.
3. The user approves. `report publish --report <id> --digest <d>` (never pre-approved) re-checks the
   digest, snapshot, and change list, records approval, writes the journal entry `publishing`, and prints
   the payload: `cloudId`, `issueKey`, the tool name, and the body as `markdown` and `adf` (the Skill uses
   whichever the tool's input schema accepts, verbatim).
4. The Skill calls `addOrEditJiraIssueComment` once. Claude Code's own permission prompt for that tool
   is a second, independent approval.
5. `report record-result --input <file>` with one of
   `{ outcome: "tool-returned", toolResult }`, `{ outcome: "tool-error", error: { message, status? } }`,
   `{ outcome: "not-called", reason }`:
   - a returned comment whose text carries **this report's marker** → `PUBLISHED`, checkpoint promoted
     (`confirmedBy: "mcp-tool"`, evidence `tool-result`);
   - a result without a readable comment or without the marker → `UNCERTAIN`;
   - 400/401/403/404/413/429, or a clear auth/permission message → `FAILED` (Jira refused; 400/413 not
     retryable); write denied ends here, with `report fallback` offered;
   - timeouts, 5xx, network errors, anything unclear → `UNCERTAIN`.
6. `UNCERTAIN` is settled with `report reconcile --input '{ "comments": <listing>, "account": <user> }'`
   from `listJiraIssueComments` (one page or an array of pages) and `atlassianUserInfo`: a comment by
   that account carrying the marker → `RECOVERED`; absent from a **complete** listing (needs `total` or
   `isLast`) after the 2-minute settle window → `FAILED` (retryable); otherwise it stays `UNCERTAIN`.
   Nothing is re-sent while uncertain, and an uncertain report cannot be cancelled or switched to manual.
7. Retrying a `FAILED` report requires `report publish … --comments <listing>` showing the report is
   absent.

`report fallback --report <id>` turns an MCP draft that is definitely not in Jira (`DRAFT`,
`READY_FOR_REVIEW`, `APPROVED`, `FAILED`) into a manual draft with the same snapshot, text, and digest.

**Trust.** The CLI cannot fetch anything from Jira in MCP mode, so its evidence is what the Claude Code
session relays. It validates structure, the comment id format, the exact issue key, and the report
marker, and it requires the user-approved digest before authorizing a write; but it cannot detect a
session that fabricates a tool result. That is why `record-result` and `reconcile` must not be
pre-approved either.

### Setup (`git2jira mcp setup`, installer)

Uses only the documented `claude mcp` commands, never Claude Code's files or credentials:

1. `claude --version`: is Claude Code installed?
2. `claude mcp list`: is a server on `mcp.atlassian.com` already registered (any name, any scope)? If
   so, it is reused and not modified; a legacy `/v1/sse` endpoint is reported, not changed.
3. Otherwise, after confirmation: `claude mcp add --transport http --scope user <name> https://mcp.atlassian.com/v2/mcp`.
   If `<name>` (default `atlassian`) belongs to an unrelated server, another free name is used.
4. Explain the sign-in: `/mcp` in Claude Code → Authenticate. Git2Jira never claims the sign-in
   succeeded; `claude mcp list` health text is shown as Claude Code's own statement only.
5. Fall back to manual mode when Claude Code is missing, registration fails or is declined, or the last
   access check showed a block.

### What has and has not been verified

| Item                                                                    | Status                                                                                                       |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Tool names and groups                                                   | From Atlassian's documentation only                                                                          |
| Tool parameters (e.g. comment body format: Markdown or ADF, `cloudId`)  | **Not verified**; the Skill must read the tool schema                                                        |
| Result shapes (comment object, comment listing pagination, issue, user) | **Not verified**; parsers accept Jira REST shapes and treat anything else as unknown                         |
| Whether the comment body keeps the marker line intact                   | **Not verified**                                                                                             |
| Error format for 401/403/policy blocks                                  | **Not verified**; classified conservatively                                                                  |
| `claude mcp add/list` behaviour                                         | Checked against Claude Code 2.1.294 (`list` output format, `get`); `add` exercised only with a mocked runner |
| OAuth flow via `/mcp`                                                   | Documented by Atlassian; not exercised by Git2Jira                                                           |
| CLI, state machines, checkpoints, recovery, parsing rules               | Unit and integration tests with mocked MCP results and a real Git repository                                 |

No automated test contacts Jira or an MCP server. The first real publication should be done on a test
issue.

## Report commands (Phase 2.5)

```sh
git2jira report prepare [--mode manual|mcp] [--language en|uk] [--issue KEY] [--base BRANCH]
                        [--site URL] [--context TEXT] [--json]
                        # MCP: --server NAME --cloud-id ID --issue-lookup FILE
git2jira report submit --report ID --input FILE|-
git2jira report show [--report ID] [--format markdown|text|adf|json]      # read-only
git2jira report copy | export [--report ID] [--format markdown|text] [--output FILE]
git2jira report pending [--all] [--json]
git2jira report confirm --report ID --digest SHA256 [--attest-manual-publication]   # manual
git2jira report revoke --report ID [--reason TEXT]                                  # manual
git2jira report cancel --report ID
git2jira report recover [--json]
git2jira report publish --report ID --digest SHA256 [--comments FILE]               # MCP
git2jira report record-result --report ID --input FILE                              # MCP
git2jira report reconcile --report ID --input FILE                                  # MCP
git2jira report fallback --report ID                                                # MCP → manual
git2jira mcp setup [--name NAME] [--scope user|local|project] [--yes]
git2jira mcp status | verify --input FILE
```

Safe to pre-approve in a Skill (no Jira write, no checkpoint move): `report prepare`, `submit`, `show`,
`pending`, `export`, `copy`, `mcp status`, `mcp verify`. Never pre-approved: `report confirm`, `revoke`,
`cancel`, `publish`, `record-result`, `reconcile`, `fallback`, `mcp setup`, and the MCP comment tool.

`git2jira report` without a subcommand (Phase 3) writes, previews, and delivers a report end to end,
in every mode; see [ai-reporting.md](ai-reporting.md). `report prepare --json` now also includes the
analysis `coverage`, `testStatus`, `warnings`, and the `generation` request (instructions, parts,
schema); `report submit` accepts schema v2 content (and v1) and validates it against Git's facts.
