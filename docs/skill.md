# The `/jira-report` Claude Code Skill (Phase 4)

Code: `skill/` (the package: `jira-report/SKILL.md`, `jira-report/reference/*.md`,
`agents/jira-reporter.md`), `src/skill` (arguments, package checks, permission rules, installer),
`src/cli/commands/skill.ts`, `src/delivery/receipt.ts`, and the `report request|receipt|verify-comment`
commands. Tests: `tests/skill` (a simulated Claude Code session drives the real CLI, real Git, and the
shipped `SKILL.md` permission rules; no real Claude Code, Jira, or MCP server).

## Installation

```sh
git2jira skill install            # once per user; works in every repository
git2jira skill status             # installed, outdated, modified, or conflict
git2jira skill verify             # package checks + permission-rule scan
git2jira skill install            # again after upgrading the CLI: upgrades in place
git2jira skill uninstall          # removes only what Git2Jira installed
```

| Installed file                                          | Purpose                                                 |
| ------------------------------------------------------- | ------------------------------------------------------- |
| `<claude home>/skills/jira-report/SKILL.md`             | The Skill: workflow, rules, `allowed-tools`             |
| `<claude home>/skills/jira-report/reference/`           | Manual, MCP, report-contract, and recovery instructions |
| `<claude home>/skills/jira-report/.git2jira-skill.json` | Manifest: version and SHA-256 of every installed file   |
| `<claude home>/agents/jira-reporter.md`                 | Read-only report-writing subagent                       |

`<claude home>` is `$CLAUDE_CONFIG_DIR` or `~/.claude` (Claude Code's own rule). User-level Skills and
agents are discovered by Claude Code in every project, so nothing is copied into repositories. Claude
Code must be restarted (or a new session started) to see a newly installed Skill.

The installer:

- **Detects conflicts.** A `skills/jira-report` directory without a Git2Jira manifest, an unreadable
  manifest, or an `agents/jira-reporter.md` that Git2Jira did not write is a `conflict`: nothing is
  touched, even with `--force`. Move it away yourself.
- **Detects modifications.** If installed files no longer match the manifest hashes, install and
  uninstall refuse without `--force`.
- **Upgrades in place.** Managed files are replaced one by one (each atomically), files that the new
  package no longer has are removed, and the manifest is written last. Files you added to the Skill
  directory are kept and listed. A fresh install is staged next to the target and renamed into place.
- **Refuses a broken package.** Before writing, the shipped package is checked (below); a package that
  would pre-approve a gated command is never installed.
- **Uninstalls only its own files**, then removes empty directories.

## Invocation

```
/jira-report
/jira-report --language en
/jira-report --language uk
/jira-report --issue LSND-1234
/jira-report --mode manual
/jira-report --mode mcp
```

Options can be combined; `--name=value` and `-l`/`-m`/`-i` also work. Claude Code passes the text to the
Skill as `$ARGUMENTS`; the Skill hands it unchanged to `git2jira skill context --args`, and the CLI
validates it (`src/skill/args.ts`): unknown options, repeated options, positional words, values with
quotes or shell characters, unsupported languages (`ua`), `--mode api-token`, and malformed issue keys
are usage errors. Explicit arguments win over repository and global configuration; the context output
says where each value came from.

The Skill has `disable-model-invocation: true`: only the user can start it, Claude cannot decide to
run it.

## Workflow

| #     | Step                                                                                         | Who                                                     |
| ----- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 1–8   | repository, CLI, config, branch, issue key, mode, language, last checkpoint, pending reports | `git2jira skill context` (read-only)                    |
| 9–11  | candidate snapshot, incremental change set, stop if nothing changed                          | `git2jira report prepare`                               |
| 12    | issue details (MCP: exact issue lookup)                                                      | the session, through the authorized MCP tools           |
| 13–14 | analysis and structured report                                                               | the session (or the read-only `jira-reporter` subagent) |
| 15    | validation against Git's facts                                                               | `git2jira report submit`                                |
| 16    | complete report shown                                                                        | the session, from the submit output                     |
| 17    | next actions                                                                                 | the session, with `AskUserQuestion`                     |
| 18    | lifecycle (confirm / publish / record)                                                       | gated CLI commands and the MCP comment tool             |
| 19    | outcome and checkpoint                                                                       | `git2jira report receipt`                               |

Nothing is reported as done before the CLI says so: the final message is taken from the receipt.

### Manual mode

1. The report is shown; the user may copy it (`report copy`, clipboard) or save it (`report export`).
   Neither moves the checkpoint.
2. The Skill asks with `AskUserQuestion` whether the report is in Jira. Only the option "Yes, it is
   published in Jira" leads to `report confirm --report <id> --digest <d> --attest-manual-publication`,
   which is never pre-approved: Claude Code shows the user the exact command and asks again.
3. The checkpoint is promoted from the snapshot captured at `prepare`, recorded as `user-attested`.
4. "Not yet" leaves the draft and its candidate snapshot as they are; the next `/jira-report` finds it in
   `pending` and offers to continue. "Cancel" runs `report cancel` (approval prompt).

The CLI's own boundary: `confirm` needs the digest of the shown report (a forged digest is refused) and,
without a terminal, the explicit `--attest-manual-publication` flag. The model cannot answer Claude
Code's permission prompt.

### MCP mode

1. **Access check.** The Skill lists the session's `mcp__` tool names, calls the read-only Atlassian tools
   (sites, account, exact issue), and passes the raw results to `git2jira mcp verify`. Tool names come
   from `skill context` (`mcp.tools`) and are used only if the session actually has them. Anything but
   `ready` (`no-tools`, `not-authenticated`, `read-only`, `blocked-by-policy`, `no-jira-access`, `unknown`)
   leads to "Atlassian MCP is unavailable. You can generate and copy the report using Manual mode." and a
   question; there is no silent switch.
2. **Prepare** with the raw issue lookup; the CLI checks it is exactly the branch's issue.
3. **Write, submit, show**, then ask: publish, switch to manual, keep pending, or cancel.
4. **Publish**: `report publish --report <id> --digest <d>` (approval prompt) records the attempt
   (write-ahead journal) and returns the payload. The Skill calls `addOrEditJiraIssueComment` once, never
   with a comment id (approval prompt), and hands the raw result to `report record-result` (approval
   prompt).
5. **Verify**: after `PUBLISHED`, the Skill lists the issue's comments and runs `report verify-comment`;
   the receipt's `verifiedInJira` is true only when the listing shows the marker on the recorded comment.
6. **Ambiguity**: an unclear result is `UNCERTAIN`. Nothing is re-sent, the report cannot be cancelled
   or switched to manual, and `report reconcile` with a complete comment listing settles it
   (`RECOVERED` or `FAILED`).
7. **Fallback**: an MCP report that is definitely not in Jira switches to manual with `report fallback`,
   keeping the same snapshot, text, and digest; nothing is regenerated.

## Skill-to-CLI bridge

All messages are JSON. The Skill passes them on stdin with a quoted heredoc
(`--input - <<'<heredocDelimiter>'`, delimiter generated per run by `skill context`), so nothing is
written into the working tree and the shell expands nothing.

| Command                                          | Input (validated)                        | Output                                           | Pre-approved |
| ------------------------------------------------ | ---------------------------------------- | ------------------------------------------------ | ------------ |
| `skill context --json --args <raw>`              | the `/jira-report` arguments             | resolved run context, pending reports, MCP names | yes          |
| `report prepare --json …`                        | MCP: raw issue lookup                    | draft summary, change set, `generation` request  | yes          |
| `report request --report <id> --json`            | –                                        | the same request, also written to a private file | yes          |
| `report submit --report <id> --json --input -`   | structured report (schema v1/v2, strict) | Markdown, digest                                 | yes          |
| `report show / pending / copy / export`          | –                                        | text, list, clipboard, file                      | yes          |
| `report receipt --report <id> --json`            | –                                        | publication receipt                              | yes          |
| `mcp status`, `mcp verify --json --input -`      | `McpProbeSchema`                         | access state                                     | yes          |
| `report confirm`                                 | report id, digest, attestation flag      | user-attested checkpoint                         | **no**       |
| `report publish`                                 | report id, digest                        | comment payload; journal entry                   | **no**       |
| `report record-result`                           | `McpWriteResultSchema` envelope          | state + receipt                                  | **no**       |
| `report verify-comment`                          | `McpReconcileInputSchema`                | read-back result + receipt                       | **no**       |
| `report reconcile`                               | `McpReconcileInputSchema`                | state + receipt                                  | **no**       |
| `report fallback`, `cancel`, `revoke`, `recover` | report id                                | state                                            | **no**       |

`src/skill/permissions.ts` holds both lists. `checkAllowedTools` rejects any `allowed-tools` entry that
would match a gated command (including `Bash`, `Bash(git2jira *)`, `Bash(git2jira:*)`), any write tool,
and any Atlassian tool other than the four read-only ones. The package tests, the installer, and
`skill verify` all run it.

### Generation requests

`report request` writes `<git common dir>/git2jira/requests/<reportId>.json` (directory 0700, file 0600)
for the subagent to read. It contains the redacted, nonce-fenced change set and the writing rules; it is
overwritten on the next request for the same report.

### Publication receipt

`report receipt` (and the `--json` output of `record-result`, `reconcile`, `verify-comment`) returns
`PublicationReceiptSchema` (`src/delivery/receipt.ts`):

| Field                                      | Source                                                                                                                     |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `reportId`, `issueKey`, `sequence`, `site` | the draft                                                                                                                  |
| `snapshot.id`, `snapshot.tree`             | the candidate snapshot captured at `prepare`                                                                               |
| `reportDigest`, `marker`                   | the approved text; the marker line every comment carries                                                                   |
| `operation`                                | `pending`, `in-flight`, `published`, `recovered`, `user-attested`, `failed`, `uncertain`, `cancelled`, `recovery-required` |
| `comment`                                  | id and URL, from the validated tool result or listing                                                                      |
| `evidence`                                 | `tool-result`, `read-back`, or `user-attested`                                                                             |
| `verifiedInJira`                           | true only when a comment listing showed the marker (`read-back`, or a matching `verify-comment`)                           |
| `checkpoint.advanced`                      | read from the lineage journal: a `published` record with a checkpoint ref                                                  |

The receipt is derived from CLI state every time. No command accepts a receipt as input, and
`record-result` accepts only the strict envelopes (`tool-returned` / `tool-error` / `not-called`): a body
like `{ "published": true }` is rejected, and a "result" without this report's marker leaves the report
`UNCERTAIN`.

### Snapshot correctness

The draft is bound to the candidate snapshot (tree and commit, including uncommitted changes) captured
at `prepare`. Confirmation and publication promote exactly that snapshot. Edits made while the user
reviews the report are not part of the checkpoint and appear in the next report. `publish` re-checks the
snapshot and the change list before authorizing the write.

## The `jira-reporter` subagent

`tools: Read, Grep, Glob` (an explicit list, so it inherits no Bash, write, or MCP tool). It reads the
request file, may read the repository to understand a change, and returns only the report JSON. It
cannot run commands, publish, or call Jira; the main session validates its answer with `report submit`.
The Skill delegates to it for large change sets (several diff parts, or many files); otherwise the main
session writes the report itself.

## Permission settings

`skill verify` reads `permissions.allow` and `permissions.defaultMode` (nothing else) from
`<claude home>/settings.json` and the repository's `.claude/settings.json` and
`.claude/settings.local.json`, and warns about:

- rules that would pre-approve a gated `git2jira` command (`Bash`, `Bash(git2jira *)`, …);
- rules that would pre-approve the Atlassian comment tool (`mcp__atlassian`, `mcp__atlassian__*`, …);
- `defaultMode: "bypassPermissions"`, which removes every prompt.

These settings are the user's choice; Git2Jira does not change them. With them, the approval boundary
described here does not hold.

## What needs real Claude Code and Atlassian MCP to validate

The automated tests exercise the CLI side of every step with a simulated session. These need a real
environment (see [skill-verification.md](skill-verification.md)):

| Capability                                                                        | Needs                                   |
| --------------------------------------------------------------------------------- | --------------------------------------- |
| Claude Code lists `/jira-report` from `~/.claude/skills` and passes `$ARGUMENTS`  | Claude Code                             |
| `allowed-tools` patterns pre-approve the read-only commands (incl. heredoc stdin) | Claude Code                             |
| Gated commands and the comment tool show a permission prompt                      | Claude Code                             |
| The model follows the Skill (AskUserQuestion, no inferred confirmation)           | Claude Code                             |
| The `jira-reporter` subagent is available and read-only                           | Claude Code                             |
| Tool names, parameter names, and result shapes of Rovo MCP                        | Claude Code + authorized Atlassian MCP  |
| Comment body format (Markdown or ADF) and the marker surviving                    | Claude Code + authorized Atlassian MCP  |
| `read-only`, `not-authenticated`, `blocked-by-policy` classification              | Atlassian MCP with those configurations |
| Comment listing pagination and completeness (`total`, `isLast`)                   | Authorized Atlassian MCP                |
