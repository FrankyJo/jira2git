# Roadmap

| Phase | Scope                                                   | Status |
| ----- | ------------------------------------------------------- | ------ |
| 0     | Foundation and architecture                             | Done   |
| 1     | Git snapshots and incremental checkpoints               | Done   |
| 2     | Jira integration, authentication, ADF, and publication  | Done   |
| 2.5   | Manual reports and Atlassian MCP integration            | Done   |
| 3     | AI reporting engine and multilingual reports            | Done   |
| 4     | Claude Code Skill `/jira-report`                        | Done   |
| 5     | Interactive installer, configuration, and npm packaging | Done   |
| 6     | Final QA, security audit, and release preparation       | Done   |

## Phase 0: Foundation (done)

- pnpm, TypeScript strict, tsup, ESLint, Prettier, Vitest, GitHub Actions.
- Commander CLI with `--help`, `--version`, and all planned commands registered.
- Typed DI container and interfaces for every module.
- Zod schemas: global/repository config, issue key, snapshot, checkpoint, structured report.
- Working `config get|set|unset|list|path` and language resolution (`en`, `uk`).

## Phase 1: Git snapshots and checkpoints (done)

- Safe `SpawnGitRunner`, repository locator (worktrees, unborn, detached, bare), issue key detection,
  `--issue` override.
- Base branch resolution (`--base`, `base.branch`, Git metadata, ambiguity requires a choice).
- Snapshot engine: temporary index copy, stability check, create-only private refs.
- Incremental diff engine: NUL-delimited parsing, renames, modes, binaries, patch budget, secret and
  lock-file exclusions.
- Lineage journal, repository identity, cross-process locks, checkpoint refs.
- `PublicationLifecycle`: analyze, prepare, cancel, begin, confirm/promote, resolve pending, recover.
- `git2jira status` (read-only preview).
- See [git-snapshots.md](git-snapshots.md).

## Phase 2: Jira (done)

- OS credential store adapters (macOS Keychain, Windows Credential Manager, Linux Secret Service);
  secrets passed over stdin, no plaintext fallback.
- API-token `JiraAuthProvider` with classic/scoped token detection; named connections with
  deterministic selection.
- Jira REST v3 client (native fetch): current user, issue, comments (paginated, with properties),
  create comment, comment properties; typed errors with delivery classification; bounded retries for
  reads; no automatic retry of comment creation.
- Deterministic ADF renderer (English and Ukrainian headings) and ADF validation.
- Publication state machine (`DRAFT` … `RECOVERED`), approval bound to a digest, duplicate prevention,
  reconciliation, and recovery (`JiraPublicationService`).
- Commands: `login`, `logout`, `connections`, `history`, `recover`, `status --jira`.
- OAuth designed as interfaces; evaluation in [authentication.md](authentication.md).
- See [jira-publication.md](jira-publication.md).

## Phase 2.5: Manual reports and Atlassian MCP (done)

- Delivery modes `manual` (default), `mcp`, `api-token` (`jira.mode`, `report prepare --mode`); no
  automatic fallback between modes. Global `jira.site`; placeholder lineage for manual reports without a site.
- Report drafts with manual states (`DRAFT` … `MANUALLY_CONFIRMED`, `CANCELLED`, `RECOVERY_REQUIRED`) and
  MCP states (Phase 2 machine); one open draft per lineage; digest over Markdown, text, and ADF.
- Deterministic Markdown/plain-text renderer (en, uk) with escaping and a compact report marker.
- Manual workflow: prepare, submit, show, copy, export, confirm (user-attested, digest-bound), cancel,
  recover, revoke (withdraw an accidental confirmation of the latest checkpoint).
- Checkpoint records carry `confirmedBy` (`jira-api`, `mcp-tool`, `user-attested`) and an optional
  comment id; new `revoked` record state; open drafts' candidate refs survive recovery.
- MCP: documented Rovo tool table, Skill-to-CLI bridge schemas, access assessment (`mcp verify`),
  publish/record-result/reconcile/fallback with write-ahead journal and conservative outcome handling.
- `git2jira mcp setup|status|verify` via `claude mcp` (never overwrites existing servers).
- Installer steps for the Phase 5 wizard: report language, "How do you want to use Jira?" with manual
  fallback.
- Not done here: the Skill that drives the bridge (Phase 4), AI report generation (done in Phase 3), and any test
  against a real Rovo MCP server. See [jira-publication.md](jira-publication.md#what-has-and-has-not-been-verified).

## Phase 3: AI reporting (done)

- Report schema v2 (`completedWork`, file sections with notes, evidence-based `testing`, `limitations`,
  `uncertainties`, `changeCoverage`, `snapshotIdentity`); v1 still accepted.
- Validated analysis package: incremental diff of the prepared snapshot, secret-file exclusion and value
  redaction, nonce-fenced untrusted data, injection warnings, chunking with coverage tracking.
- `AIReportProvider` with two contexts: the current Claude Code session (hand-off, no nested process) and
  headless `claude -p` with sign-in and billing checks (`--allow-api-billing` to opt in).
- `ReportEngine`: per-chunk generation, one repair attempt, consolidation, deterministic merge fallback.
- `finalizeReport`: rejects foreign files, issue/language/snapshot changes, invented tests, deployments,
  approvals, and wrong-language text; file lists from Git.
- Renderers (Markdown, plain text, ADF) for v2 with localized testing and coverage lines; terminal preview.
- `git2jira report` end to end: `--dry-run`, `--language`, `--issue`, `--mode`, `--test-command`,
  `--test-results`, `--issue-title`, `--issue-description`, `--ai`; manual actions (copy, export, confirm,
  regenerate, keep, cancel), pending report resume; MCP through the session; API-token interactive publish.
- See [ai-reporting.md](ai-reporting.md).

## Phase 4: Claude Code Skill (done)

- Skill package `skill/`: `SKILL.md` (`disable-model-invocation`, `argument-hint`, read-only
  `allowed-tools`), reference instructions (manual, MCP, report contract, recovery), and the read-only
  `jira-reporter` subagent (`tools: Read, Grep, Glob`).
- `/jira-report [--language en|uk] [--mode manual|mcp] [--issue KEY]`, validated by the CLI
  (`skill context --args`); explicit arguments win over configuration.
- `git2jira skill install|uninstall|status|verify`: user-level installation with a hash manifest,
  conflict and modification detection, in-place upgrade, own-files-only uninstall, package and
  permission-rule checks.
- Bridge additions: `skill context`, `report request` (private request file for the subagent),
  `report receipt` (publication receipt derived from CLI state), `report verify-comment` (read-back
  after an MCP publication); JSON on stdin through quoted heredocs.
- Tests: a simulated Claude Code session drives the CLI with the shipped permission rules (manual and
  MCP lifecycles, ambiguity, forged evidence, fallback, snapshot integrity, worktrees).
- Manual guide for real Claude Code and Atlassian MCP: [skill-verification.md](skill-verification.md).
- See [skill.md](skill.md).

## Phase 5: Installer and packaging (done)

- `git2jira init`: ask-then-apply wizard (welcome, environment check, Jira delivery mode with MCP and
  manual first and API token optional, MCP registration through `claude mcp add`, report language,
  additional settings, summary, `/jira-report` install, diagnostics, next steps); `--yes` for
  non-interactive use; cancellation changes nothing.
- `git2jira doctor`: CLI on PATH, Node.js, OS, Git, Claude Code and its sign-in (billing warning), Skill,
  configuration, language, mode, credential store (API token), and MCP as four separate facts
  (registered, authorized, read verified, write available).
- `git2jira uninstall`: Skill, tokens, configuration; leaves MCP servers and repositories alone.
- Settings `report.includeUncommitted` (snapshot of HEAD only when false), `report.testCommand` (global
  only), `jira.openAfterPublish`; `report open`; `login` explains that MCP OAuth happens in Claude Code.
- npm package `git2jira-ai` 0.5.0 (`git2jira` and `git2jira-ai` executables, Skill assets included),
  `pnpm test:package` (tarball installed outside the repository), CI package job, release workflow
  (draft GitHub release; npm publish only by hand, with provenance). Not published.
- See [installation.md](installation.md).

## Phase 6: QA, security audit, and release preparation (done)

- Independent audit; seven findings fixed with regression tests (`docs/security.md`, "Phase 6 audit"):
  pre-approved `report export` could overwrite files (high), `report prepare --json` leaked unredacted
  diffs (high), repository `core.fsmonitor` could run a program (medium), MCP publish did not require a
  verified access check (medium), `report open` opened any host (low), unsanitized MCP server names
  (low), and test isolation from real home directories.
- Git: rebases onto or merges of a newer base branch no longer report upstream work (three-way
  baseline with `git merge-tree`, with safe fallback).
- End-to-end scenarios A–O through the CLI with the shipped Skill permission rules (`tests/e2e`).
- `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, [release-checklist.md](release-checklist.md) with
  readiness per delivery mode; version 0.9.0 (release candidate, not published).
- Still open, needs real environments: Atlassian Rovo MCP against a real (corporate) Jira site, the
  API-token mode against real Jira Cloud, interactive checks in real Claude Code
  ([skill-verification.md](skill-verification.md)). 1.0.0 follows those.
