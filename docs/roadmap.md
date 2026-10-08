# Roadmap

| Phase | Scope                                                   | Status  |
| ----- | ------------------------------------------------------- | ------- |
| 0     | Foundation and architecture                             | Done    |
| 1     | Git snapshots and incremental checkpoints               | Planned |
| 2     | Jira integration, authentication, ADF, and publication  | Planned |
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

## Phase 2: Jira

- OS credential store adapters (macOS, Windows, Linux Secret Service).
- API-token `JiraAuthProvider`; verify Atlassian token types and scopes.
- Jira REST v3 client (native fetch): issue, comments, create comment; retries and rate limits.
- ADF renderer and comment footer.
- Jira publication on top of `PublicationLifecycle`; `login`, `logout`, `history`, `recover` (including Jira lookup for unresolved publications).
- OAuth evaluation per [authentication.md](authentication.md).

## Phase 3: AI reporting

- `ReportGenerator` for Skill and headless modes.
- Prompt design that treats repository content as untrusted data.
- Localized labels and language guidance for `en` and `uk`.
- Headless billing and authentication verification.

## Phase 4: Claude Code Skill

- `SKILL.md` for `/jira-report` with `--language`.
- Approval gate through Claude Code permissions plus plan digest.
- Skill installer and status.

## Phase 5: Installer and packaging

- `init` wizard (language, Jira, Skill), `doctor`, `uninstall`.
- npm package, provenance, install docs.

## Phase 6: Release

- End-to-end tests against a Jira test site, security review, documentation pass, 1.0.0.
