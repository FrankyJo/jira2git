# Changelog

All notable changes to Git2Jira AI. The format follows [Keep a Changelog](https://keepachangelog.com/);
versions follow [Semantic Versioning](https://semver.org/). Nothing has been published to npm yet.

## [0.9.1] — 2026-10-08 (release candidate)

First version intended for npm. The package contents are the same as 0.9.0.

### Fixed

- Release workflow: `npm publish` now gets the tarball as `./out/<file>.tgz`. Without `./`, npm read
  `out/<file>.tgz` as the GitHub repository `out/<file>.tgz` and tried to clone it, so the 0.9.0
  publication failed before reaching the registry.
- `.gitattributes` forces LF line endings. Windows checkouts had CRLF, so `pnpm lint` (Prettier) had
  failed on Windows CI since Phase 0 and the Windows tests had never run; they now pass on Node 22 and 24.

## [0.9.0] — tagged, never published to npm

Release candidate from the Phase 6 audit. The tag `v0.9.0` exists, but its npm publication failed
(see 0.9.1); use 0.9.1.

Phase 6: QA, security audit, and release preparation.

### Security

- **High — `report export --output` could overwrite any file without a prompt.** The command is
  pre-approved in `/jira-report`. Inside Claude Code `--output` is now refused (exports go to
  `.git/git2jira/exports`); from a terminal it never overwrites an existing file and only writes `.md` or
  `.txt`.
- **High — unredacted diff in `report prepare --json`.** The `untrusted.patch`, commit subjects, user
  context, and issue summary are now redacted like the generation request, so secret values in diffs no
  longer reach the Claude Code session through this output.
- **Medium — repository `core.fsmonitor` could run a program.** Every Git call now passes
  `-c core.fsmonitor=false`.
- **Medium — MCP publication did not require a verified access check.** `report publish` now refuses
  unless the last access check (`mcp verify`) for the same server was `ready` (comment tool available)
  and is less than 12 hours old; the message offers manual fallback.
- **Low — `report open` opened any site.** It now opens only Atlassian Cloud hosts or the configured
  `jira.site`, and prints other URLs instead.
- `claude mcp list` server names are sanitized before display.
- Tests can no longer touch the developer's real `~/.config/git2jira` or `~/.claude` (`tests/setup.ts`).

### Fixed

- **Rebase or merge of a newer base branch no longer reports upstream work as yours.** Upstream
  changes are applied to the previous snapshot with `git merge-tree`; only the branch's new work is
  reported. Falls back to the previous behavior on conflicts or Git < 2.40.

### Added

- End-to-end scenarios A–O (`tests/e2e`), security regression tests (`tests/security`).
- `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `docs/release-checklist.md`.
- The package test checks that existing Claude Code skills, agents, and settings are preserved.

## [0.5.0] — not published

Phase 5: `git2jira init` wizard (ask, then apply), `doctor` (MCP registered / authorized / read /
write as separate facts), `uninstall`, `report open`, settings `report.includeUncommitted`,
`report.testCommand`, `jira.openAfterPublish`; npm packaging with Skill assets, tarball install test,
release workflow (manual publish only).

## Earlier phases (0.0.x, not published)

- Phase 4: global `/jira-report` Claude Code Skill, installer, read-only `jira-reporter` subagent,
  publication receipts, approval boundary checks.
- Phase 3: AI reporting engine (session hand-off and headless `claude -p`), report schema v2, validation
  against Git, English and Ukrainian.
- Phase 2.5: manual delivery and Atlassian Rovo MCP bridge.
- Phase 2: Jira REST client, API-token authentication, ADF, publication state machine and recovery.
- Phase 1: Git snapshots, incremental diffs, checkpoints.
- Phase 0: foundation.
