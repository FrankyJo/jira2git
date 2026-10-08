# Git2Jira AI

Turn Git changes into professional, incremental Jira implementation reports, written by Claude Code.

> **Status: Phase 4 (Claude Code Skill).** `/jira-report` works in any Git repository after a one-time
> `git2jira skill install`: your Claude Code session writes the report, the CLI validates it against Git,
> and you deliver it by copy and paste (manual) or through Atlassian Rovo MCP. `git2jira report` does the
> same from a terminal. Missing: the setup wizard and npm package (Phase 5). See
> [docs/roadmap.md](docs/roadmap.md).

## What it does

Open any Git repository in Claude Code and run:

```
/jira-report
```

Git2Jira AI:

1. Detect the repository and branch, and extract the Jira issue key (`feature/LSND-1234-user-profile` → `LSND-1234`).
2. Find the last report it published for that issue.
3. Analyze **only the changes since that report**, including uncommitted work.
4. Use your current Claude Code session to write a structured report in your language (English or Ukrainian).
5. Show a preview and wait for your explicit approval.
6. Deliver it, in the mode you chose:
   - **Manual**: you copy the report, paste it into the Jira issue, and confirm that you did.
   - **Atlassian MCP**: Claude Code publishes it as a **new** comment through the official Atlassian
     Rovo MCP server, signed in with OAuth in your browser. Existing comments are never edited.
7. Save a checkpoint so the next report starts where this one ended, only after the report is
   confirmed in Jira (MCP) or by you (manual).

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
- A Jira Cloud site. Manual mode needs no Jira access at all from Git2Jira.

## Installation

Not published to npm yet. To try the development build:

```sh
pnpm install
pnpm build
pnpm link --global        # puts `git2jira` on your PATH
git2jira skill install    # once: installs /jira-report for your user (all repositories)
```

Then, in any Git repository:

```
claude
/jira-report                      # or: --language en|uk, --issue KEY-123, --mode manual|mcp
```

`git2jira skill status | verify | uninstall` manage the installation; it never overwrites a Skill or
agent it did not install. See [docs/skill.md](docs/skill.md).

## Configuration

Report language: `en` (English, default) or `uk` (Ukrainian).

```sh
git2jira config get report.language          # effective value
git2jira config set report.language uk        # global setting
git2jira config set report.language en --repo # this repository only (.git2jira.json)
git2jira config list                          # all settings with their source
git2jira config path                          # where the files live
```

Base branch for the first report of an issue (repository only; otherwise detected, and you are asked
when it is ambiguous):

```sh
git2jira config set base.branch develop --repo
```

The language is chosen in this order: the `--language` option of a run, then the repository config,
then the global config, then English.

Configuration files never contain credentials. Jira credentials are kept in your operating system's
credential store (Keychain, Windows Credential Manager, or Secret Service).

## Choose how reports reach Jira

| Mode        | What you need                                          | Who writes to Jira                          | Checkpoint moves when…                           |
| ----------- | ------------------------------------------------------ | ------------------------------------------- | ------------------------------------------------ |
| `manual`    | Nothing (default)                                      | You, by pasting                             | you confirm you pasted it (user-attested)        |
| `mcp`       | Claude Code + Atlassian Rovo MCP, OAuth in Claude Code | your Claude Code session, after you approve | the MCP result shows the comment with its marker |
| `api-token` | A personal API token (optional, legacy/personal)       | `git2jira` itself                           | Jira's API returns the comment                   |

```sh
git2jira config set jira.mode manual          # or: mcp, api-token
git2jira config set jira.site https://example.atlassian.net   # optional for manual mode
```

Git2Jira never switches modes on its own: if MCP is unavailable, it stops and offers manual mode.

### Manual mode

```sh
git2jira report                               # analyze, write, preview; then copy / save / confirm
git2jira report --language uk                 # Ukrainian report
git2jira report --dry-run                     # preview only: nothing saved, no checkpoint moved
git2jira report --test-command "pnpm test"    # run tests and cite the verified result
git2jira report pending                       # unfinished reports; "git2jira report" resumes one
```

Step by step (what the Skill uses): `report prepare --json` → write the JSON → `report submit --report
<id> --input report.json` → `report copy` / `export` → paste into Jira → `report confirm --report <id>
--digest <sha256>`.

`report pending`, `report cancel`, `report recover`, and `report revoke` (withdraw a confirmation made by
mistake) manage unfinished reports. Copying or exporting never moves the checkpoint; only `confirm` does,
and it is recorded as **user-attested**: Git2Jira has not seen the comment in Jira. Changes you make after
the report was prepared stay for the next report.

In a terminal the report is written by Claude Code in non-interactive mode with your own Claude sign-in;
Git2Jira stops instead of using API-key billing unless you pass `--allow-api-billing`. Inside Claude Code
the current session writes it; no second Claude Code is started. Every report is checked against Git: it
cannot name files outside the change set, and it cannot claim tests, deployments, or approvals that did
not happen. See [docs/ai-reporting.md](docs/ai-reporting.md).

### Atlassian MCP mode

```sh
git2jira mcp setup        # registers https://mcp.atlassian.com/v2/mcp in Claude Code (user scope)
# in Claude Code: /mcp → select the Atlassian server → Authenticate (browser)
git2jira mcp status       # registration and the last access check
```

The OAuth sign-in belongs to Claude Code; Git2Jira never sees or copies it, and cannot tell from the
outside whether it succeeded. Access is verified only by read-only tool calls made inside Claude Code
(`git2jira mcp verify`). If your organization blocks Rovo MCP or its write tools, use manual mode. The
MCP workflow is driven by the `/jira-report` Skill; see [docs/skill.md](docs/skill.md#mcp-mode) and
[docs/jira-publication.md](docs/jira-publication.md#mcp-mode).

## Connect to Jira with an API token (optional)

Create an API token at <https://id.atlassian.com/manage-profile/security/api-tokens>, then:

```sh
git2jira login                       # asks for site, email, and token (the token is masked)
git2jira connections --check         # verify the stored credentials (read-only)
git2jira status --jira               # also check the issue exists and show its title
git2jira logout                      # remove the token from the credential store
```

The token is checked against Jira before it is stored, and only ever stored in the OS credential store.
Classic and scoped API tokens both work. Several sites or accounts can be configured as named connections
(`--connection`); see [docs/authentication.md](docs/authentication.md).

## Preview the next report

```sh
git2jira status                       # issue from the branch name
git2jira status --issue LSND-1234     # explicit issue
git2jira status --base develop        # explicit base for the first report
git2jira status --json
```

`status` is read-only: it does not change your files, index, HEAD, or refs.

## Commands

| Command       | Purpose                                                      | Available |
| ------------- | ------------------------------------------------------------ | --------- |
| `config`      | Read and change settings                                     | Now       |
| `init`        | Interactive setup                                            | Phase 5   |
| `doctor`      | Diagnose the installation                                    | Phase 5   |
| `login`       | Connect to Jira (API token in the OS credential store)       | Now       |
| `logout`      | Remove Jira credentials                                      | Now       |
| `connections` | List Jira connections and check their credentials            | Now       |
| `status`      | Preview the issue, baseline, and changes for the next report | Now       |
| `report`      | Write, preview, and deliver the next report (all modes)      | Now       |
| `report …`    | Prepare, submit, copy, confirm, publish (manual and MCP)     | Now       |
| `mcp`         | Register and check the Atlassian MCP connection              | Now       |
| `skill`       | Install, upgrade, check, and remove `/jira-report`           | Now       |
| `history`     | List published reports, cross-checked with Jira              | Now       |
| `recover`     | Repair interrupted publications and lost checkpoints         | Now       |
| `uninstall`   | Remove the Skill, credentials, and configuration             | Phase 5   |

Commands that are not available yet exit with code 3 and say which phase delivers them.

## Security

- Nothing is posted to Jira without your explicit approval of the exact previewed text, and a
  checkpoint never moves because a report was merely generated, shown, or copied.
- A comment request whose outcome is unknown is never repeated blindly; it is looked up in Jira first.
  (Jira offers no idempotency key, so exactly-once delivery cannot be guaranteed; see
  [docs/jira-publication.md](docs/jira-publication.md).)
- Jira credentials never reach Claude, logs, configuration files, or your repository.
- Your working files and Git index are never modified during analysis.
- Source code, diffs, and Jira text are treated as untrusted data, never as instructions.

Details: [docs/security.md](docs/security.md).

## Documentation

- [Product requirements](docs/product-requirements.md)
- [Architecture](docs/architecture.md)
- [Git snapshots and incremental diffs](docs/git-snapshots.md)
- [Jira publication](docs/jira-publication.md)
- [The /jira-report Skill](docs/skill.md) and [manual verification in Claude Code](docs/skill-verification.md)
- [Authentication](docs/authentication.md)
- [Localization](docs/localization.md)
- [Security](docs/security.md)
- [Development](docs/development.md)
- [Roadmap](docs/roadmap.md)

## License

[MIT](LICENSE)
