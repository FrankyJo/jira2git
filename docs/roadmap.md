# Roadmap

| Phase | Scope                                                   | Status  |
| ----- | ------------------------------------------------------- | ------- |
| 0     | Foundation and architecture                             | Done    |
| 1     | Git snapshots and incremental checkpoints               | Done    |
| 2     | Jira integration, authentication, ADF, and publication  | Done    |
| 2.5   | Manual reports and Atlassian MCP integration            | Done    |
| 3     | AI reporting engine and multilingual reports            | Done    |
| 4     | Claude Code Skill `/jira-report`                        | Done    |
| 5     | Interactive installer, configuration, and npm packaging | Planned |
| 6     | Final QA, security audit, and release preparation       | Planned |

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

## Phase 5: Installer and packaging

- `init` wizard running the Phase 2.5 steps (language, "How do you want to use Jira?": Atlassian MCP or
  manual), then the Skill; `doctor`, `uninstall`.
- npm package, provenance, install docs.

## Phase 6: Release

- End-to-end tests against a Jira test site, security review, documentation pass, 1.0.0.
