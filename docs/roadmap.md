# Roadmap

| Phase | Scope                                                   | Status  |
| ----- | ------------------------------------------------------- | ------- |
| 0     | Foundation and architecture                             | Done    |
| 1     | Git snapshots and incremental checkpoints               | Done    |
| 2     | Jira integration, authentication, ADF, and publication  | Done    |
| 2.5   | Manual reports and Atlassian MCP integration            | Done    |
| 3     | AI reporting engine and multilingual reports            | Planned |
| 4     | Claude Code Skill `/jira-report`                        | Planned |
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
- Not done here: the Skill that drives the bridge (Phase 4), AI report generation (Phase 3), and any test
  against a real Rovo MCP server. See [jira-publication.md](jira-publication.md#what-has-and-has-not-been-verified).

## Phase 3: AI reporting

- `ReportGenerator` for Skill and headless modes.
- Prompt design that treats repository content as untrusted data.
- End-to-end `git2jira report` (generation), and API-token reports through the `report` bridge on top of
  `JiraPublicationService`.
- Localized labels and language guidance for `en` and `uk`.
- Headless billing and authentication verification.

## Phase 4: Claude Code Skill

- `SKILL.md` for `/jira-report` with `--language`, supporting manual and MCP modes through the Phase 2.5
  bridge (`report …`, `mcp verify`); MCP tools used only from the main session, never from the
  read-only analysis subagent.
- Approval gate through Claude Code permissions plus plan digest; only the read-only subcommands listed in
  jira-publication.md are pre-approved.
- Skill installer and status.

## Phase 5: Installer and packaging

- `init` wizard running the Phase 2.5 steps (language, "How do you want to use Jira?": Atlassian MCP or
  manual), then the Skill; `doctor`, `uninstall`.
- npm package, provenance, install docs.

## Phase 6: Release

- End-to-end tests against a Jira test site, security review, documentation pass, 1.0.0.
