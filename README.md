# Git2Jira AI

Generate incremental, professional Jira implementation reports from your Git changes with Claude Code.

> **Status: 0.9.2, release candidate.** Manual mode is ready for use. Atlassian MCP mode has published
> a report on a real corporate Jira Cloud site (2026-10-09) after two fixes for the real Rovo MCP server;
> treat it as early: error formats and policy blocks are still unverified. The optional API-token mode
> is tested against a local mock of Jira. See [docs/release-checklist.md](docs/release-checklist.md#readiness).

## What it does

```
cd my-project
claude
/jira-report
```

1. Detects the repository and branch, and extracts the Jira issue key (`feature/LSND-1234-user-profile`
   → `LSND-1234`).
2. Finds the last report you confirmed for that issue.
3. Analyzes **only the changes since that report**, including uncommitted work (configurable).
4. Your current Claude Code session writes a structured report in English or Ukrainian. No separate
   Anthropic API key is needed.
5. Git2Jira validates it against Git (no invented files, tests, or approvals) and shows it in full.
6. You deliver it:
   - **Manual**: copy it into the Jira issue and confirm that you did. No Jira access needed.
   - **Atlassian MCP**: after your explicit approval, Claude Code adds it as a **new** comment through
     the official Atlassian Rovo MCP server (OAuth in your browser). Existing comments are never edited.
7. Saves a checkpoint only after the report is confirmed (by you, or by the Jira response).

| Day | Work                                  | `/jira-report` result                       |
| --- | ------------------------------------- | ------------------------------------------- |
| 1   | Create components A and B             | Report #1: A and B                          |
| 6   | Modify B, implement API integration C | Report #2: only the B changes, and C        |
| 7   | No changes                            | "No new changes since the previous report." |

## Installation

Requirements: Node.js 22.12+, Git, [Claude Code](https://docs.anthropic.com/en/docs/claude-code/setup)
(signed in), and a Jira Cloud site.

Once the package is published, the intended commands are:

```sh
npm install -g git2jira-ai     # /jira-report calls "git2jira" from your PATH
git2jira init
```

`npx git2jira-ai init` also runs the wizard, but `/jira-report` needs `git2jira` on your PATH, so the
wizard and `git2jira doctor` tell you to install it globally.

Until then, build and install the tarball:

```sh
pnpm install && pnpm pack                    # → git2jira-ai-0.9.2.tgz
npm install -g ./git2jira-ai-0.9.2.tgz
git2jira init
```

### The setup wizard (`git2jira init`)

1. **Welcome**, then an **environment check**: operating system, Node.js, Git, Claude Code, whether
   Claude Code is signed in (`claude auth status`; its files are never read), an `ANTHROPIC_API_KEY`
   that could switch billing to an API account, `git2jira` on PATH, and an existing installation.
2. **"How would you like to work with Jira?"**
   - **Atlassian MCP**: browser authorization and automatic publishing after approval. Needs an
     authorized Atlassian Rovo MCP connection and your company's approval.
   - **Manual**: generate and copy reports without Jira access. No API tokens or Jira authorization.
   - _Personal API token (advanced)_: only for personal use where your company allows API tokens.

   Manual is preselected when MCP is unavailable (no Claude Code, or a previous check found Rovo MCP
   blocked by your organization).

3. **MCP setup** (if chosen): reuses an existing Atlassian server (any name, left unchanged) or, with
   your consent, runs
   `claude mcp add --transport http --scope user atlassian https://mcp.atlassian.com/v2/mcp` (syntax
   checked against Claude Code 2.1.294). It never changes other MCP servers and never signs in for you;
   it explains the `/mcp` → Authenticate step.
4. **"Which language should Git2Jira AI use for Jira reports?"** English (default) or Ukrainian.
5. Optional settings: uncommitted changes, a test command, opening Jira after publishing.
6. A **summary**. Nothing is changed before you confirm it; cancelling at any point changes nothing.
7. Applies the settings, installs `/jira-report`, runs `git2jira doctor`, and shows the next steps.

Non-interactive: `git2jira init --yes --mode manual --language uk`. See
[docs/installation.md](docs/installation.md).

## Using `/jira-report`

```
/jira-report                    # mode and language from your settings
/jira-report --language en      # English report
/jira-report --language uk      # Ukrainian report
/jira-report --issue LSND-1234  # when the branch name has no issue key
/jira-report --mode manual      # copy and paste this time
/jira-report --mode mcp         # publish through Atlassian MCP this time
```

Arguments override your configuration for that run. The Skill shows the complete report first, asks you
with Claude Code's question dialog, and every confirmation or publication goes through Claude Code's
permission prompt. See [docs/skill.md](docs/skill.md).

### Example (English)

```
## Implementation Report #2

### Summary

Implemented the user profile page and connected it to the profile API.

### Completed Work

- **UserProfileView** (Added): Added a component that shows the user's profile.
- **GET /api/profile** (Changed): Loaded the profile data with error handling.

### Testing and Validation

No tests were run for this report.

---

Git2Jira report 3f6c… · #2
```

### Приклад (українською)

```
## Звіт про реалізацію #2

### Підсумок

Реалізовано сторінку профілю користувача та підключено її до API профілю.

### Виконані роботи

- **UserProfileView** (Додано): Додано компонент для перегляду профілю.
- **GET /api/profile** (Змінено): Завантаження даних профілю з обробкою помилок.

### Тестування та перевірки

Для цього звіту тести не запускалися.

---

Git2Jira report 3f6c… · #2
```

Code identifiers, paths, endpoints, and issue keys stay unchanged in both languages.

## Manual mode

No Jira credentials, API token, or MCP connection. `/jira-report` (or `git2jira report` in a terminal)
writes the report; you copy it (`report copy`), save it (`report export`), or open the issue
(`report open`), paste it as a comment, and confirm.

**Publication confirmation.** Copying, exporting, or showing never moves the checkpoint. Only your
explicit confirmation does (`report confirm --report <id> --digest <sha256>`, which Claude Code asks you
to approve). It is recorded as **user-attested**: Git2Jira has not seen the comment in Jira. If you have
not published it yet, the report stays pending and `/jira-report` offers it again. A mistaken
confirmation can be withdrawn with `git2jira report revoke`.

```sh
git2jira report                             # terminal: analyze, write (claude -p), preview, deliver
git2jira report --dry-run                   # preview only: nothing saved, no checkpoint moved
git2jira report --mode manual --language uk
git2jira report --language en
git2jira report pending                     # unfinished reports
```

## Atlassian MCP mode

```sh
git2jira mcp setup                  # or let "git2jira init" do it
# in Claude Code: /mcp → select the Atlassian server → Authenticate (browser)
git2jira doctor                     # registration, authorization, read access, write access
```

The OAuth authorization belongs to Claude Code. Git2Jira never reads, stores, or passes on OAuth tokens,
and there is no `git2jira login` for MCP. `/jira-report` checks access with read-only tool calls before
it offers to publish, asks for your approval of the exact report, calls the comment tool once, and saves
the checkpoint only when the result carries the report's marker. Unclear results stay `UNCERTAIN` and
are settled from a comment listing; nothing is sent twice.

`git2jira doctor` reports four separate facts: **registered** (from `claude mcp list`), **authorized**
(Claude Code's own health status), **Jira read access verified** (from the last `/jira-report` access
check), and **comment creation available** (the write tool was visible; writing itself is proven only by
the first publication).

### MCP troubleshooting

| Symptom                                         | What to do                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| doctor: "no Atlassian MCP server is registered" | `git2jira mcp setup`                                                         |
| doctor: "needs authentication"                  | Claude Code → `/mcp` → Atlassian → Authenticate                              |
| `/jira-report`: `no-tools`                      | Restart Claude Code after registering; check `/mcp`                          |
| `/jira-report`: `not-authenticated`             | Authenticate again in `/mcp`; the sign-in may have expired                   |
| `/jira-report`: `read-only`                     | Write access is not granted; use manual mode or ask your administrator       |
| `/jira-report`: `blocked-by-policy`             | Your organization blocks Rovo MCP; use manual mode                           |
| The configured site is not listed               | `jira.site` must be a site your Atlassian account can see                    |
| Read tools ask for permission every time        | Your server is not named `atlassian`; that is safe, the prompts are expected |

### Corporate authorization restrictions

Atlassian administrators can block Rovo MCP or its write access, and organizations may forbid personal
API tokens. Git2Jira does not work around these controls: it reports the restriction and offers manual
mode, which needs no Jira access at all. Use the API-token mode only where your company allows it.

## Supported authentication methods

| Mode        | Jira authorization                                 | Stored by Git2Jira                    |
| ----------- | -------------------------------------------------- | ------------------------------------- |
| `manual`    | none                                               | nothing                               |
| `mcp`       | OAuth in your browser, inside Claude Code (`/mcp`) | the MCP server name only              |
| `api-token` | personal Atlassian API token (optional)            | token in the OS credential store only |

```sh
git2jira login            # API-token mode only: site, email, masked token, verified before storing
git2jira connections --check
git2jira logout
```

See [docs/authentication.md](docs/authentication.md).

## Configuration

```sh
git2jira config list                              # all settings, effective value and source
git2jira config get report.language
git2jira config set report.language en            # English (default)
git2jira config set report.language uk            # Ukrainian
git2jira config set report.language uk --repo     # this repository only (.git2jira.json)
git2jira config set jira.mode manual              # manual | mcp | api-token
git2jira config set jira.site https://example.atlassian.net
git2jira config set report.includeUncommitted false
git2jira config set report.testCommand "pnpm test"    # global only; run without a shell
git2jira config set jira.openAfterPublish true
git2jira config set base.branch develop --repo
git2jira config path
```

Precedence: the `/jira-report` or `--language`/`--mode` argument, then the repository configuration,
then the global configuration, then the default. The report language applies to manual and MCP reports
alike. Configuration files never contain tokens, and no setting turns off the approval before
publishing.

## Incremental checkpoints

Each report is bound to a snapshot of your working tree (a private Git object under `refs/git2jira/`,
never pushed; your index and files are untouched). The next report compares against the last
**confirmed** snapshot. Work you do while a report is under review is not included in it and appears in
the next report. With `report.includeUncommitted false`, only committed work is reported; uncommitted
work waits until it is committed. See [docs/git-snapshots.md](docs/git-snapshots.md).

## History and recovery

```sh
git2jira status                   # what the next report would contain (read-only)
git2jira history                  # confirmed reports (cross-checked with Jira in API-token mode)
git2jira report pending           # unfinished reports
git2jira report recover           # settle interrupted local operations
git2jira recover                  # API-token mode: interrupted publications
```

## Commands

| Command       | Purpose                                                                                 |
| ------------- | --------------------------------------------------------------------------------------- |
| `init`        | Setup wizard                                                                            |
| `doctor`      | Diagnose the installation (`--json`)                                                    |
| `config`      | `list`, `get`, `set`, `unset`, `path`                                                   |
| `status`      | Preview the issue, baseline, and changes for the next report                            |
| `report`      | Write, preview, and deliver the next report (`--dry-run`, `--mode`, `--language`, …)    |
| `report …`    | `prepare`, `submit`, `show`, `copy`, `export`, `open`, `confirm`, `publish`, `receipt`… |
| `skill`       | `install`, `status`, `verify`, `uninstall` for `/jira-report`                           |
| `mcp`         | `setup`, `status`, `verify` for the Atlassian MCP connection                            |
| `login`       | API-token mode: connect a Jira site                                                     |
| `logout`      | Remove a stored API token                                                               |
| `connections` | List Jira connections and check their tokens                                            |
| `history`     | List confirmed reports                                                                  |
| `recover`     | Repair interrupted API-token publications                                               |
| `uninstall`   | Remove `/jira-report`, stored tokens, and the global configuration                      |

## Upgrade and uninstall

```sh
npm install -g git2jira-ai@latest     # once published; or a newer tarball
git2jira skill install                # upgrades /jira-report in place; keeps files you added
git2jira doctor

git2jira uninstall                    # /jira-report, API tokens, global configuration
npm uninstall -g git2jira-ai
```

`uninstall` never removes MCP servers from Claude Code (it prints the `claude mcp remove` command) and
does not touch repositories: report history stays in `.git/git2jira/` and `refs/git2jira/` there.

## Security

- Nothing is posted to Jira without your explicit approval of the exact report, and the Skill cannot
  approve for you: confirmations and publications always go through Claude Code's permission prompt.
- A checkpoint never moves because a report was generated, shown, or copied.
- Jira credentials never reach Claude, logs, configuration files, or repositories. OAuth for MCP stays
  inside Claude Code.
- Your working files and Git index are never modified during analysis.
- Source code, diffs, and Jira text are untrusted data, never instructions.
- `git2jira skill verify` warns about Claude Code permission rules that would skip approval prompts.

Details: [docs/security.md](docs/security.md).

## Documentation

- [Product requirements](docs/product-requirements.md)
- [Architecture](docs/architecture.md)
- [Installation and setup](docs/installation.md)
- [The /jira-report Skill](docs/skill.md) and
  [manual verification in Claude Code](docs/skill-verification.md)
- [Git snapshots and incremental diffs](docs/git-snapshots.md)
- [Jira publication](docs/jira-publication.md)
- [AI reporting](docs/ai-reporting.md)
- [Authentication](docs/authentication.md)
- [Localization](docs/localization.md)
- [Security](docs/security.md)
- [Development and releases](docs/development.md)
- [Roadmap](docs/roadmap.md)

## License

[MIT](LICENSE)
