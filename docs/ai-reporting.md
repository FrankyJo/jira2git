# AI reporting (Phase 3)

Code: `src/ai` (analysis package, prompt, engine, headless provider, redaction, test runner),
`src/report` (schema, validation, preview), `src/cli/commands/report-run.ts` (`git2jira report`).
Tests: `tests/ai`, `tests/report`, `tests/cli/report-run.test.ts` (fake model, temporary Git
repositories, mocked Jira; no test calls a real model, Jira site, or MCP server).

## Flow

```
git2jira report [--language en|uk] [--mode manual|mcp|api-token] [--issue KEY] [--dry-run]
  resolve mode, language (option → repository → global → en), site
  collect optional issue details (--issue-title, --issue-description) and test evidence
  prepare: candidate snapshot under a private ref (or resume the pending draft for this issue)
  analysis package: diff baseline..snapshot, redacted, chunked, coverage
  writer: Claude Code session (hand-off) | headless `claude -p`
  validate + finalize against Git's facts → render Markdown, text, ADF → digest
  preview → actions (manual: copy, export, confirm, regenerate, keep, cancel)
```

The Git engine owns the baseline and the snapshot. The first report compares the snapshot with the
merge base of the base branch; later reports compare `LAST_CONFIRMED_SNAPSHOT → CURRENT_SNAPSHOT`. Nothing
the model returns can change either: `snapshotIdentity` in a report must equal the CLI's values.

If nothing changed, no draft is created and no model is called.

## Report writers

| Context                               | Writer               | How                                                                                                                                                                          |
| ------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inside Claude Code (`CLAUDECODE` set) | the current session  | `git2jira report --json` prints a `generation-request` (instructions, one prompt per diff part, JSON schema). The session writes the JSON and runs `report submit`.          |
| Ordinary terminal                     | headless Claude Code | `claude -p --output-format json --json-schema … --tools "" --strict-mcp-config --disable-slash-commands --no-session-persistence --system-prompt …`, empty working directory |

`--ai auto|session|headless` overrides the detection; `--ai headless` inside a Claude Code session is
refused, so Git2Jira never starts Claude Code from Claude Code.

Headless checks, before any model call (`src/ai/claude-headless.ts`, verified against Claude Code
2.1.294):

1. `claude --version`: installed?
2. `claude auth status --json`: `loggedIn`; `authMethod`, `apiProvider`, `apiKeySource` decide billing.
   Only a first-party subscription sign-in (`claude.ai`) proceeds. An API key (`ANTHROPIC_API_KEY`,
   `apiKeyHelper`) or a third-party provider (Bedrock, Vertex, …) stops with an explanation unless the
   user passes `--allow-api-billing` for that run. Git2Jira never reads Claude Code's files or tokens.
3. The child process gets no tools, no MCP servers, no skills, and runs in an empty temporary
   directory, so the analyzed repository's `CLAUDE.md` or settings are never loaded as instructions.

## Analysis package

`AnalysisPackageSchema` (`src/ai/analysis.ts`): issue key, branch, repository id and name, delivery mode,
language, previous checkpoint, baseline kind, snapshot identity, file list with statistics, test evidence
and derived test status, and an `untrusted` block (issue title/description, user context, commit
subjects, diffs in chunks). It has no field for credentials.

- **Sensitive files** (`.env*`, keys, `.npmrc`, credential and secret files, Terraform state, …) are
  listed by name only; their content never enters the package.
- **Redaction** (`src/ai/redact.ts`) removes private keys, cloud and SaaS tokens, JWTs, URL credentials,
  authorization headers, and literal `password|secret|token|api_key = "…"` values from all untrusted
  text. The preview reports how many were removed (never the values).
- **Prompt injection.** Untrusted text is JSON-encoded (`<`, `>`, `&` escaped) inside a data block fenced
  with a random nonce; the instructions say it is data. A heuristic flags text addressed to an AI in the
  preview. The real defence is validation: the issue, language, files, snapshot, and test status are
  checked against Git, whatever the model says.

### Large diffs

The diff is requested with a 1 MiB budget, split per file, each file cut at 32 KiB (at a line boundary),
and grouped into chunks of up to 64 KiB, at most 8 chunks. Each chunk is one model call; partial results
are validated, then consolidated by one more call (or merged deterministically, without duplicates, if
that fails). `changeCoverage` records analyzed, truncated, omitted (with the reason), and ignored files
(lock files, minified output). Coverage is never reported complete when a relevant file was cut or
skipped, and the report itself says so under Known Limitations.

## Structured report (schema v2)

`src/report/schema.ts`: `reportId`, `issueKey`, `language`, `summary`, `completedWork` (kind, category,
subject, description, files, endpoints), `createdFiles`, `modifiedFiles`, `deletedFiles`, `renamedFiles`
(each with an optional note), `testing` (status, notes, runs), `limitations`, `uncertainties`,
`changeCoverage`, `snapshotIdentity`. The writer produces the content part; the CLI owns `reportId`,
`changeCoverage`, `snapshotIdentity`, and `testing.runs`. v1 reports (Phase 2.5) are still accepted by
`report submit`; their testing lines are shown as "stated by the report author (not verified)".

`finalizeReport` (`src/report/validate.ts`) rejects a report that:

- targets another issue, language, report id, or snapshot;
- names a file outside the change set, or puts a file in the wrong section;
- has a testing status other than the one derived from evidence, or testing notes without tests;
- claims passing tests without evidence, a deployment or release, or QA/stakeholder approval;
- is not written in the requested language (Cyrillic heuristic).

File lists in the finished report always come from Git; the writer only adds notes. The headless engine
gives the model one repair attempt with the list of problems, then fails without saving anything.

## Tests and evidence

- `--test-command "pnpm test"` (repeatable): the CLI runs it (no shell; split on whitespace) in the
  repository root and records outcome, exit code, and a redacted output tail. Source `git2jira`.
- `--test-results <file>`: `{ "schemaVersion": 1, "results": [{ "command", "outcome": "passed" | "failed", "summary"? }] }`,
  shown as reported, not verified.
- No evidence: the report states "No tests were run for this report."

The tests run against the working tree at that moment; the snapshot is captured right after.

## Preview and actions

The preview shows the issue key, Jira site (if known), branch, language, mode, file counts, test status,
snapshot identity, the writer, the digest, warnings (coverage, redactions, possible injection, the
writer's uncertainties), and the full report. Uncertainties are preview-only; they are not posted.

Manual mode (interactive terminal): copy to the clipboard, save to a UTF-8 Markdown file, confirm
publication (asks "Did you paste report #N…?", records a user-attested checkpoint from the prepared
snapshot), regenerate (same snapshot, no checkpoint change), keep pending, cancel (baseline unchanged).
Without a terminal the report is saved as a pending draft and the next steps are printed. Copying and
exporting are never confirmations. Running `git2jira report` again resumes the pending report instead of
creating a new one; later working-tree changes stay for the next report.

MCP mode works only through a Claude Code session (the CLI cannot use the MCP authorization): the
hand-off, `report submit`, `report publish`, the MCP tool call, and `report record-result` (see
[jira-publication.md](jira-publication.md#mcp-mode)). If MCP is unavailable, `report fallback` turns the
already generated report into a manual one. A standalone terminal in MCP mode stops and suggests
`--mode manual`; it never switches by itself.

API-token mode (optional): standalone terminal only; the preview is followed by an interactive choice to
publish this exact digest, regenerate, save the text, or cancel. Without a terminal nothing is sent.

## What has not been verified against real systems

| Item                                                                            | Status                                              |
| ------------------------------------------------------------------------------- | --------------------------------------------------- |
| `claude -p --json-schema` result envelope (`structured_output`)                 | Checked once by hand with Claude Code 2.1.294       |
| `claude auth status --json` fields for API key, Bedrock/Vertex, expired sign-in | API-key case checked by hand; others inferred       |
| Report quality from a real model on large Vue/React repositories                | Not evaluated; tests use a deterministic fake model |
| Session hand-off driven by the `/jira-report` Skill                             | Phase 4                                             |
| Rovo MCP tool schemas and result shapes                                         | Unchanged from Phase 2.5: not verified              |
