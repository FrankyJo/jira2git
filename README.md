# Git2Jira AI

Turn Git changes into professional, incremental Jira implementation reports, written by Claude Code.

> **Status: Phase 0 (foundation).** The project builds, and configuration and language settings work.
> Reporting, Jira publishing, and the `/jira-report` Skill are not available yet. See
> [docs/roadmap.md](docs/roadmap.md).

## What it will do

Open any Git repository in Claude Code and run:

```
/jira-report
```

Git2Jira AI will:

1. Detect the repository and branch, and extract the Jira issue key (`feature/LSND-1234-user-profile` → `LSND-1234`).
2. Find the last report it published for that issue.
3. Analyze **only the changes since that report**, including uncommitted work.
4. Use your current Claude Code session to write a structured report in your language (English or Ukrainian).
5. Show a preview and wait for your explicit approval.
6. Publish it as a **new** Jira comment. Existing comments are never edited.
7. Save a checkpoint so the next report starts where this one ended.

If nothing changed since the last report, nothing is published.

| Day | Work                                  | `/jira-report` result                |
| --- | ------------------------------------- | ------------------------------------ |
| 1   | Create components A and B             | Report #1: A and B                   |
| 6   | Modify B, implement API integration C | Report #2: only the B changes, and C |
| 7   | No changes                            | No comment                           |

No separate Anthropic API key is needed: in Skill mode the analysis runs in the Claude Code session you
already have open.

## Requirements

- Node.js 22.12 or newer
- Git
- Claude Code
- A Jira Cloud site

## Installation

Not published to npm yet. To try the development build:

```sh
pnpm install
pnpm build
node dist/cli.js --help
```

## Configuration

Report language: `en` (English, default) or `uk` (Ukrainian).

```sh
git2jira config get report.language          # effective value
git2jira config set report.language uk        # global setting
git2jira config set report.language en --repo # this repository only (.git2jira.json)
git2jira config list                          # all settings with their source
git2jira config path                          # where the files live
```

The language is chosen in this order: the `--language` option of a run, then the repository config,
then the global config, then English.

Configuration files never contain credentials. Jira credentials will be kept in your operating system's
credential store (Keychain, Windows Credential Manager, or Secret Service).

## Commands

| Command     | Purpose                                              | Available |
| ----------- | ---------------------------------------------------- | --------- |
| `config`    | Read and change settings                             | Now       |
| `init`      | Interactive setup                                    | Phase 5   |
| `doctor`    | Diagnose the installation                            | Phase 5   |
| `login`     | Connect to Jira                                      | Phase 2   |
| `logout`    | Remove Jira credentials                              | Phase 2   |
| `status`    | Show issue, last report, and pending changes         | Phase 2   |
| `report`    | Generate, preview, and publish a report              | Phase 3   |
| `history`   | List published reports                               | Phase 2   |
| `recover`   | Repair interrupted publications and lost checkpoints | Phase 2   |
| `uninstall` | Remove the Skill, credentials, and configuration     | Phase 5   |

Commands that are not available yet exit with code 3 and say which phase delivers them.

## Security

- Nothing is posted to Jira without your explicit approval of the exact previewed text.
- Jira credentials never reach Claude, logs, configuration files, or your repository.
- Your working files and Git index are never modified during analysis.
- Source code, diffs, and Jira text are treated as untrusted data, never as instructions.

Details: [docs/security.md](docs/security.md).

## Documentation

- [Product requirements](docs/product-requirements.md)
- [Architecture](docs/architecture.md)
- [Git snapshots and incremental diffs](docs/git-snapshots.md)
- [Authentication](docs/authentication.md)
- [Localization](docs/localization.md)
- [Security](docs/security.md)
- [Development](docs/development.md)
- [Roadmap](docs/roadmap.md)

## License

[MIT](LICENSE)
