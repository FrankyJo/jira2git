# Security

## Threat model

| Asset                    | Threat                                                         | Control                                                                                                      |
| ------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Jira credentials         | Leak via repository, config, logs, prompts, crash reports      | OS credential store only; strict config schemas reject secret fields; credentials only reach the HTTP layer  |
| Jira issue               | Unwanted or manipulated comment                                | Publication requires explicit approval bound to the report digest; no edit/delete API exists in the client   |
| Developer's working tree | Modification during analysis                                   | Snapshots use a temporary index; no checkout, stash, reset, or write to tracked files                        |
| Developer's machine      | Command injection through branch names, paths, or diff content | `execFile` with argument arrays only; `exec`/`execSync` banned by lint rule                                  |
| Report integrity         | Prompt injection from code, README, or Jira text               | Untrusted content is quoted data; model output is schema-validated, size-bounded, rendered as plain ADF text |
| Billing                  | Silent switch from subscription to API-key billing             | Headless mode checks for API-key configuration and stops to ask                                              |
| Claude Code credentials  | Extraction or reuse                                            | Never read; Skill mode runs in the existing session                                                          |

## Rules

1. **No credentials in Git.** Repository config (`.git2jira.json`) is strictly validated and has no
   credential fields. `.env*` files are ignored.
2. **No secrets to Claude.** `ReportGenerationRequest` has no field that can hold credentials.
   Environment variables are not forwarded to model context.
3. **No Jira writes without explicit approval.** Approval is a human action bound to a plan id and
   SHA-256 digest of the exact previewed report. In Skill mode the publish command is never
   pre-approved, so Claude Code's own permission prompt applies. Standalone mode needs an interactive TTY
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
    `--frozen-lockfile`.

## File permissions

The global config directory is created with mode `0700` and files with `0600` (POSIX). Writes are atomic
(temp file + rename).

## Reporting vulnerabilities

Until a dedicated policy is published, report vulnerabilities privately to the maintainers through
GitHub Security Advisories rather than public issues.
