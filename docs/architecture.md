# Architecture

Git2Jira AI is a TypeScript CLI (`git2jira`) and, from Phase 4, a Claude Code Skill (`/jira-report`)
that drives it. Everything deterministic (Git, checkpoints, credentials, Jira, approval, publication)
lives in the CLI. The language model only turns a change set into a structured report, which the CLI
validates before using it.

## Principles

- **Deterministic control, generative content.** The model writes report text. Code decides what is
  analyzed, whether anything is published, where, and when.
- **Ports and adapters.** Each module exposes an interface (`src/<module>/types.ts`). Adapters for Git,
  the OS keychain, Jira, and Claude Code implement them. Commands depend only on interfaces.
- **Dependency injection.** `ServiceContainer` (`src/app/container.ts`) holds a typed registry of every
  service. `createDefaultContainer()` (`src/app/bootstrap.ts`) is the only composition root. Tests
  register fakes. Resolving a service that is not delivered yet throws `NotImplementedError`, never a stub.
- **Validated boundaries.** Configuration files, model output, checkpoints, and Jira responses are parsed
  with Zod. Strict objects reject unknown keys.
- **Untrusted content stays data.** Diffs, file contents, READMEs, and Jira descriptions are passed to the
  model as quoted data with explicit instructions not to follow them, and they cannot change control flow.

## Modules

| Module                 | Path               | Responsibility                                                         | Phase |
| ---------------------- | ------------------ | ---------------------------------------------------------------------- | ----- |
| CLI                    | `src/cli`          | Commander program, commands, exit codes, output                        | 0     |
| Application            | `src/app`          | Service registry, DI container, composition root                       | 0     |
| Core                   | `src/core`         | Errors, exit codes, phases, version                                    | 0     |
| Configuration          | `src/config`       | Global and repository config schemas, paths, file store, settable keys | 0     |
| Localization           | `src/localization` | Supported languages, language resolution, report label catalog         | 0 / 3 |
| Git analysis           | `src/git`          | Safe `git` runner, repository discovery, issue key detection           | 1     |
| Git snapshots and diff | `src/snapshots`    | Working-tree snapshots, incremental change sets                        | 1     |
| Checkpoints            | `src/checkpoints`  | Checkpoint schema and store                                            | 1     |
| Credential storage     | `src/credentials`  | OS-native secret storage                                               | 2     |
| Jira authentication    | `src/jira/auth`    | `JiraAuthProvider` (API token now, OAuth later)                        | 2     |
| Jira REST client       | `src/jira/client`  | Issue lookup, comment listing, comment creation (no edits)             | 2     |
| ADF rendering          | `src/adf`          | Structured report → Atlassian Document Format                          | 2     |
| Publication lifecycle  | `src/publication`  | Plan, approval, publish journal, history, recovery                     | 2     |
| Report schema          | `src/report`       | Language-independent structured report contract                        | 3     |
| AI reporting           | `src/ai`           | `ReportGenerator` for Skill and headless modes                         | 3     |
| Claude Code Skill      | `src/skill`        | Installing and checking the `/jira-report` Skill                       | 4     |
| Installer              | `src/installer`    | `Prompter` port, @clack/prompts adapter, setup steps                   | 5     |
| Diagnostics            | `src/diagnostics`  | `doctor` checks                                                        | 5     |

Dependency direction: `cli → app → (module interfaces) ← adapters`. Modules import each other's
_types_ only. No module imports `src/cli`.

## Report flow (target design)

```
/jira-report (Skill, inside the user's Claude Code session)
  │
  ├─ git2jira report prepare --json            [CLI, deterministic]
  │    locate repo → detect issue key → load latest checkpoint
  │    → capture snapshot → diff against checkpoint snapshot (PublicationLifecycle.prepare)
  │    → empty?  exit "nothing to report"
  │    → write analysis request (change set, issue context, language) to a private temp file
  │
  ├─ Claude reads the request and writes a StructuredReport JSON   [model]
  │
  ├─ git2jira report preview --input <file>    [CLI]
  │    validate schema → render ADF → print preview → plan id + digest
  │
  ├─ user approves                              [human]
  │
  └─ git2jira report publish --plan <id> --digest <sha256>   [CLI]
       beginPublication → POST new comment → confirmPublication (checkpoint promoted)
```

Command names in this diagram are the intended design; they will be finalized in Phases 2 to 4.

### Approval in Skill mode

The Skill must not be able to approve on the user's behalf. The planned gate:

1. The Skill's `allowed-tools` pre-approves only read-only subcommands (`prepare`, `preview`). The
   `publish` subcommand is never pre-approved, so Claude Code's own permission prompt asks the user to
   approve the exact command, which is outside the model's control.
2. `publish` requires the plan id and the SHA-256 digest of the previewed report. Any change to the
   report after preview invalidates the approval.

Standalone `git2jira report` (headless mode) uses an interactive `@clack/prompts` confirmation on a TTY
and refuses to publish without one.

### AI modes

- **Skill mode** (primary): the analysis is done by the Claude Code session the user is already in. No
  API key, no nested `claude` process, no access to Claude Code credentials.
- **Headless mode** (standalone CLI): uses Claude Code's supported non-interactive interface. Before
  Phase 3 ships it, it must be verified how that interface authenticates and bills. If an
  `ANTHROPIC_API_KEY` (or another setting that switches to API billing) is present, the CLI must stop and
  ask rather than continue silently.

## Data locations

| Data                            | Location                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| Global config                   | `$GIT2JIRA_CONFIG_DIR` or `~/.config/git2jira/config.json` (`%APPDATA%\git2jira` on Windows) |
| Repository config (shareable)   | `<repo>/.git2jira.json`                                                                      |
| Checkpoints, publish journal    | `<git common dir>/git2jira/` (never in the working tree)                                     |
| Snapshot and checkpoint commits | `refs/git2jira/<siteId>/<ISSUE>/{candidates,checkpoints}/…` (not pushed by default refspecs) |
| Credentials                     | OS credential store, service `git2jira-ai`                                                   |
| Skill                           | `~/.claude/skills/jira-report/`                                                              |

## Exit codes

| Code | Meaning                                 |
| ---- | --------------------------------------- |
| 0    | Success (including "nothing to report") |
| 1    | Failure                                 |
| 2    | Usage error (bad arguments or values)   |
| 3    | Feature belongs to a later phase        |
