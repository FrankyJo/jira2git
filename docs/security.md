# Security

## Threat model

| Asset                    | Threat                                                                  | Control                                                                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jira credentials         | Leak via repository, config, logs, prompts, crash reports, process list | OS credential store only, written over stdin (never argv); strict config schemas reject secret fields; credentials only reach the HTTP layer; redirects not followed        |
| Jira issue               | Unwanted, duplicated, or manipulated comment                            | Approval bound to the report digest; seven pre-publish checks; no automatic retry of comment creation; reconciliation by report id; no edit/delete API exists in the client |
| Developer's terminal     | Escape sequences in Jira text (summaries, error messages)               | Jira text printed through `terminalSafe`                                                                                                                                    |
| Developer's working tree | Modification during analysis                                            | Snapshots use a temporary index; no checkout, stash, reset, or write to tracked files                                                                                       |
| Developer's machine      | Command injection through branch names, paths, or diff content          | `execFile` with argument arrays only; `exec`/`execSync` banned by lint rule                                                                                                 |
| Report integrity         | Prompt injection from code, README, or Jira text                        | Untrusted content is quoted data; model output is schema-validated, size-bounded, rendered as plain ADF text                                                                |
| Billing                  | Silent switch from subscription to API-key billing                      | Headless mode checks for API-key configuration and stops to ask                                                                                                             |
| Claude Code credentials  | Extraction or reuse                                                     | Never read; Skill mode runs in the existing session                                                                                                                         |
| Approval boundary        | Skill or settings pre-approving a confirmation or publication           | `allowed-tools` checked at build, install, and `skill verify`; `skill verify` warns about permissive user/project rules and `bypassPermissions`                             |
| User's Claude Code files | Skill installer overwriting or deleting unrelated Skills or agents      | Hash manifest; conflicts are never overwritten; modified files only with `--force`; uninstall removes only manifest files                                                   |

## Rules

1. **No credentials in Git.** Repository config (`.git2jira.json`) is strictly validated and has no
   credential fields. `.env*` files are ignored.
2. **No secrets to Claude.** `ReportGenerationRequest` has no field that can hold credentials.
   Environment variables are not forwarded to model context. Common secret files (`.env*`, `*.pem`,
   `*.key`, `id_rsa*`, `.npmrc`, `.netrc`, …) are listed by name but excluded from the diff text that
   is analyzed, even if they were committed.
3. **No Jira writes without explicit approval.** Approval is a human action bound to a plan id and
   SHA-256 digest of the exact previewed report. In Skill mode the publish command (and, in MCP mode,
   the MCP comment tool) is never pre-approved, so Claude Code's own permission prompt applies. Standalone mode needs an interactive TTY
   confirmation. There is no `--yes` flag for publishing.
4. **No working-tree modification.** See [git-snapshots.md](git-snapshots.md).
5. **Untrusted input stays data.** Instructions inside analyzed files, commit messages, READMEs, or Jira
   descriptions are never followed. They cannot change which commands run, which issue is targeted, or
   whether publishing happens; those are decided by code.
6. **No shell interpolation.** Child processes use `execFile`/`spawn` with `shell: false` and argument
   arrays. Git runs with `GIT_TERMINAL_PROMPT=0`, `--no-ext-diff`, `--no-textconv`, and no pager.
7. **Deterministic authorization.** Which issue, which site, and whether to publish are computed in code,
   never inferred from model output. The issue key in a model-produced report must equal the key the CLI
   detected.
8. **Bounded model output.** `StructuredReportSchema` enforces strict keys and length limits. Report text
   is emitted only as ADF `text` nodes, so it cannot create links, mentions, or macros.
9. **Honest failures.** Unavailable features exit non-zero. A missing secure credential backend is an
   error, never a plaintext fallback.
10. **Minimal dependencies.** Three runtime dependencies; lockfile committed; CI installs with
    `--frozen-lockfile`. The Jira client uses Node's built-in `fetch`; OS credential stores are reached
    through their own command-line tools, so no native module is needed.
11. **Uncertain writes are reconciled, not repeated.** A comment request with an unknown outcome is
    looked up in Jira by its report id, considering only comments by the authenticated account. It is
    sent again only after a definite rejection, or a complete scan plus a settle window. Exactly-once
    delivery is not claimed: Jira has no idempotency key for comments.
12. **Validated Jira data.** Every Jira response is schema-validated; path parameters are validated
    before URLs are built; comment metadata read back from Jira is validated and treated as untrusted.
13. **Checkpoints move only on evidence.** Generating, showing, copying, or exporting a report never
    moves a checkpoint. Manual mode moves it only on the user's own confirmation of the exact digest
    (recorded as `user-attested`, never presented as verified). MCP mode moves it only on a tool result or
    comment listing that carries the report's marker; a model-reported "success" flag is not accepted.
14. **MCP authorization stays in Claude Code.** Git2Jira never reads, extracts, or reuses Claude Code's
    OAuth tokens or configuration files; it uses only the `claude mcp` commands. It never claims MCP access
    works before a tool call from the session proved it, never works around organization controls, and
    never edits or replaces an existing MCP server registration.
15. **Pasted text is escaped.** The Markdown report escapes model text so it cannot create links,
    images, HTML, headings, or tables when Jira or the MCP server interprets Markdown.
16. **Model context is minimized and redacted.** Secret files are never read into the analysis package;
    secret-looking values in diffs, commit subjects, Jira text, user context, and test output are
    redacted; untrusted text is fenced with a random nonce; the headless writer runs without tools, MCP,
    or the repository as working directory. See [ai-reporting.md](ai-reporting.md).
17. **The Skill cannot approve for the user.** `/jira-report` is user-invoked only
    (`disable-model-invocation`), pre-approves only read-only commands and read-only Atlassian tools,
    asks for publication with `AskUserQuestion`, and every confirmation, publication, result recording,
    or fallback goes through Claude Code's permission prompt. Publication receipts are derived from CLI
    state and never accepted as input. See [skill.md](skill.md).
18. **Repositories cannot choose commands to run.** `report.testCommand` exists only in the global
    configuration, never in `.git2jira.json`, and runs without a shell; repository files cannot make
    Git2Jira execute anything.
19. **Setup is consent-based.** `git2jira init` changes nothing before the summary is confirmed,
    registers an MCP server only after consent and never edits existing ones, never signs in to Claude
    Code or Atlassian on the user's behalf, and reads Claude Code's state only through
    `claude --version`, `claude auth status --json`, and `claude mcp list`.
20. **Model output is checked against Git.** Reports naming files outside the change set, another issue,
    language, or snapshot, or claiming tests, deployments, or approvals without evidence are rejected.

## File permissions

The global config directory is created with mode `0700` and files with `0600` (POSIX). Writes are atomic
(temp file + rename).

## Phase 6 audit (2026-10-08)

Independent review of the whole codebase against the threat model above, with regression tests in
`tests/security/hardening.test.ts` and end-to-end scenarios in `tests/e2e/scenarios.test.ts`.

### Findings and fixes

| ID  | Severity | Finding                                                                                                                                                      | Fix                                                                                                     |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| F1  | High     | `report export --output <path>` is pre-approved in the Skill and overwrote any file: a prompt-injected session could replace e.g. a shell rc file unprompted | Refused inside Claude Code; from a terminal never overwrites (`wx`) and only `.md`/`.txt`               |
| F5  | High     | `report prepare --json` printed the raw diff (`untrusted.patch`) and commit subjects, bypassing value redaction, so secrets in diffs reached the session     | All untrusted fields of that output are redacted with the same rules as the generation request          |
| F2  | Medium   | A repository's local `core.fsmonitor` made Git run a program during snapshot capture (reproduced: the hook ran)                                              | Every Git call passes `-c core.fsmonitor=false`                                                         |
| F3  | Medium   | `report publish` (MCP) did not require an access check; only the Skill's instructions kept a read-only or blocked connection from attempting to publish      | Requires the last `mcp verify` for the same server to be `ready`, with the comment tool, < 12 hours old |
| F4  | Low      | `report open` (pre-approved) opened whatever site a draft named; `report prepare --site` is also pre-approved                                                | Opens only `*.atlassian.net`, `*.jira.com`, or the configured `jira.site`; prints anything else         |
| F6  | Low      | `claude mcp list` server names were printed unsanitized                                                                                                      | Sanitized with `terminalSafeLine`                                                                       |
| F7  | Process  | One test without an isolated store wrote `~/.config/git2jira/mcp-verification.json` during the audit (test data only; removed)                               | `tests/setup.ts` points `GIT2JIRA_CONFIG_DIR` and `CLAUDE_CONFIG_DIR` at a temp dir for every test run  |

### Reviewed and found sound

Credential storage (OS store only, stdin, verified before storing, no plaintext fallback); token
leakage (tokens never in plans, journals, refs, config, logs; tested); command and argument injection
(`spawn` with arrays, `--end-of-options` for refs, issue keys and `/jira-report` arguments validated
against strict patterns, test commands split without a shell and global-only); path traversal (report
ids are UUIDs, issue keys validated before use in file names, the Skill manifest rejects `..` paths and a
tampered manifest blocks uninstall); symlink traversal (symlinks are captured as links, never followed;
tested with a link to a file outside the repository); prompt injection (nonce-fenced data, warnings,
validation against Git; tested with instructions in a diff and in a Jira description); MCP permissions
(only four read-only tools pre-approved; comment tool and every recording command always prompt);
unauthorized writes (no edit/delete API; digest-bound approval); supply chain (three runtime
dependencies, no install scripts, lockfile, `onlyBuiltDependencies: esbuild`, `pnpm audit --prod`
clean).

### Remaining risks (accepted, documented)

- **The approval boundary is Claude Code's permission prompt.** In `bypassPermissions` mode, or with
  user rules such as `Bash(git2jira *)`, a session can confirm or publish without asking.
  `git2jira skill verify` warns; Git2Jira cannot prevent it.
- **MCP evidence is relayed by the session.** The CLI validates structure, issue key, comment id, and
  the report marker, but cannot detect a session that fabricates a tool result. That is why recording
  commands always prompt.
- **Exactly-once publication is not guaranteed.** Jira has no idempotency key; duplicates are prevented
  by the journal, the marker search, and the `UNCERTAIN` state, not by a transaction.
- **Pre-approved readers can read files the user can read.** `report submit --input`, `prepare
--issue-lookup`, and `mcp verify --input` accept paths; non-JSON content is rejected without echoing
  it, but a JSON file elsewhere could be parsed. Claude Code's own Read tool has the same reach.
- **Git clean/smudge filters** configured locally still run during capture, as they do for `git add`.
- **Redaction is heuristic.** Unusual secret formats in source code can pass; secret _files_ are always
  excluded by name.
- **Dev-only advisory**: esbuild (via tsup) GHSA-g7r4-m6w7-qqqr, low, affects only esbuild's dev server
  on Windows, which this project never runs. Runtime dependencies have no known advisories.

## Reporting vulnerabilities

See [SECURITY.md](../SECURITY.md): report privately through GitHub Security Advisories.
