# Git2Jira AI

Turn your Git changes into Jira comments with Claude Code: incremental **implementation reports** for
the team, and a user-facing **release note** when the issue is done.

> **Status.** Manual mode is ready for use. Atlassian MCP mode has published
> a report on a real corporate Jira Cloud site (2026-10-09) after two fixes for the real Rovo MCP server;
> treat it as early: error formats and policy blocks are still unverified. The optional API-token mode
> is tested against a local mock of Jira. `/jira-release-note` is new: it is covered by tests with real
> Git and the real CLI, but has not yet been run in a real Claude Code session or published through the
> real Rovo MCP server. See [docs/release-checklist.md](docs/release-checklist.md#readiness).

## What it does

Two Claude Code commands, both run inside your existing Claude Code session (no separate Anthropic API
key):

|             | `/jira-report`                              | `/jira-release-note`                                                  |
| ----------- | ------------------------------------------- | --------------------------------------------------------------------- |
| For         | developers and reviewers                    | users and the business                                                |
| Covers      | changes **since the last confirmed report** | the **whole issue**: from where the branch started to the last commit |
| Uncommitted | included (configurable)                     | never included                                                        |
| Content     | summary, completed work, files, testing     | goal, then each function: steps, roles, statuses, limits, messages    |
| Language    | English or Ukrainian (setting)              | Ukrainian by default, `--language en` possible                        |
| Delivery    | manual, Atlassian MCP, or API token         | manual or Atlassian MCP                                               |
| Checkpoint  | moves after you confirm                     | never touched                                                         |

Both are added to the issue as a **new** Jira comment; existing comments are never edited. Nothing is
posted without your explicit approval of the exact text.

### `/jira-report` in short

```
cd my-project
claude
/jira-report
```

1. Detects the repository and branch, and extracts the Jira issue key (`feature/LSND-1234-user-profile`
   → `LSND-1234`).
2. Finds the last report you confirmed for that issue.
3. Analyzes **only the changes since that report**, including uncommitted work (configurable).
4. Your Claude Code session writes a structured report in English or Ukrainian.
5. Git2Jira validates it against Git (no invented files, tests, or approvals) and shows it in full.
6. You deliver it:
   - **Manual**: copy it into the Jira issue and confirm that you did. No Jira access needed.
   - **Atlassian MCP**: after your explicit approval, Claude Code adds it as a new comment through the
     official Atlassian Rovo MCP server (OAuth in your browser).
7. Saves a checkpoint only after the report is confirmed (by you, or by the Jira response).

| Day | Work                                  | `/jira-report` result                       |
| --- | ------------------------------------- | ------------------------------------------- |
| 1   | Create components A and B             | Report #1: A and B                          |
| 6   | Modify B, implement API integration C | Report #2: only the B changes, and C        |
| 7   | No changes                            | "No new changes since the previous report." |

### `/jira-release-note` in short

```
/jira-release-note
```

1. Takes every commit of the issue branch since it left its base branch.
2. Reads the code for what users see: button and menu captions, messages, roles and permissions,
   statuses, durations and limits, export formats.
3. Takes the goal from the Jira issue (MCP mode) and asks you for what the code cannot show, such as the
   system's address or how users get access.
4. Writes the release note, shows it in full, and lists the statements it **inferred** so you can check
   them.
5. You deliver it as a new comment (copy and paste, or Atlassian MCP), then add the screenshots marked
   `[Скріншот: …]`.

## Installation

Requirements: Node.js 22.12+, Git, [Claude Code](https://docs.anthropic.com/en/docs/claude-code/setup)
(signed in), and a Jira Cloud site.

Once the package is published, the intended commands are:

```sh
npm install -g git2jira-ai     # the Skills call "git2jira" from your PATH
git2jira init
```

`npx git2jira-ai init` also runs the wizard, but the Skills need `git2jira` on your PATH, so the wizard
and `git2jira doctor` tell you to install it globally.

Until then, build the tarball and install it:

```sh
pnpm install
pnpm pack:tgz                                # runs all checks, then → git2jira-ai-<version>.tgz
npm install -g ./git2jira-ai-<version>.tgz
git2jira init                                # or: git2jira skill install
```

`git2jira init` and `git2jira skill install` install both `/jira-report` and `/jira-release-note`
(with their read-only subagents) for your user, in every repository.

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
4. **"Which language should Git2Jira AI use for Jira reports?"** English (default) or Ukrainian. Release
   notes are Ukrainian unless you pass `--language en`.
5. Optional settings: uncommitted changes, a test command, opening Jira after publishing.
6. A **summary**. Nothing is changed before you confirm it; cancelling at any point changes nothing.
7. Applies the settings, installs the Skills, runs `git2jira doctor`, and shows the next steps.

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

## Using `/jira-release-note`

Run it when the issue's work is committed, typically before handing the feature over:

```
/jira-release-note                    # Ukrainian, mode from your settings
/jira-release-note --mode manual      # copy and paste this time
/jira-release-note --mode mcp         # publish through Atlassian MCP this time
/jira-release-note --issue LSND-1234  # when the branch name has no issue key
/jira-release-note --language en      # English
```

### What you get

The release note follows a fixed structure:

1. **Ціль** – the purpose of the feature, then its expected effects as a list.
2. "В рамках цієї задачі було реалізовано наступний функціонал:"
3. One section per function, in the order users meet them (access and roles, the main process,
   search and editing, exports, settings), built from:
   - numbered steps ("Натиснути “+НОВЕ БРОНЮВАННЯ”"),
   - roles and statuses with their meaning,
   - tables (for example reason → duration),
   - messages and badges quoted exactly as the user sees them, with what they mean,
   - notes for exceptions and limits,
   - screenshot placeholders: `[Скріншот: форма нового бронювання]`.

It never contains file paths, class names, endpoints, or other implementation details.

```
## Release note: ROOM-42

**Ціль –** Автоматизація бронювання переговорних кімнат.

- **Менше конфліктів** – система не дозволяє забронювати зайняту кімнату.

В рамках цієї задачі було реалізовано наступний функціонал:

### Створення бронювання

1. Натиснути “+НОВЕ БРОНЮВАННЯ”.
2. Обрати кімнату та час.

[Скріншот: форма нового бронювання]

| Тип кімнати | Максимальна тривалість |
| ----------- | ---------------------- |
| Мала        | 2 години               |
| Велика      | 4 години               |

> **Примітка:** Бронювання можна створити не більше ніж на 14 днів наперед.

---

Git2Jira release note 4458…
```

(A fictional example. In Jira, tables, notes, and messages appear as tables and highlighted panels.)

### How facts are checked

- Every part of the release note records where it comes from: **code** (it must cite changed files),
  **Jira** (the issue text), **you** (your answers in this run), or **inferred**. Inferred statements
  are listed under "Please check" before delivery; sources are never published.
- Git2Jira rejects a release note that names files outside the issue's changes, puts file paths in the
  text, contains secrets, claims a deployment or QA approval, or is not written in the requested
  language.
- What the writer could not establish is shown as open questions, not guessed.
- You can ask for changes before delivering; each new text gets a new digest.

### Delivery

- **Manual**: copy (`git2jira release-note copy`) or save to a file (`release-note export`), paste it as
  a new comment, then confirm (`release-note confirm`, user-attested).
- **Atlassian MCP**: the same access check as `/jira-report`, then publication after your approval of
  the exact digest. It is refused if new commits appeared after the release note was prepared: prepare
  it again so they are described.

One release note per issue can be open at a time; `/jira-release-note` resumes it. If a release note of
the issue is already in Jira, a new one is added as another comment, and the Skill asks first. Release
notes never affect `/jira-report` checkpoints. See [docs/release-notes.md](docs/release-notes.md).

### From a terminal

The Skill drives these commands; you can also run them yourself:

```sh
git2jira release-note pending                 # open release notes
git2jira release-note show [--note <id>]      # markdown, text, adf, or json (--format)
git2jira release-note copy [--note <id>]
git2jira release-note export [--note <id>]    # into .git/git2jira/exports/
git2jira release-note confirm --note <id> --digest <sha256>
git2jira release-note cancel --note <id>
```

## Manual mode

No Jira credentials, API token, or MCP connection. `/jira-report` (or `git2jira report` in a terminal)
writes the report; you copy it (`report copy`), save it (`report export`), or open the issue
(`report open`), paste it as a comment, and confirm. `/jira-release-note` works the same way with the
`release-note` commands.

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
and there is no `git2jira login` for MCP. Both Skills check access with read-only tool calls before they
offer to publish, ask for your approval of the exact text, call the comment tool once, and record the
publication only when the result carries the comment's marker. Unclear results stay `UNCERTAIN` and are
settled from a comment listing; nothing is sent twice.

`git2jira doctor` reports four separate facts: **registered** (from `claude mcp list`), **authorized**
(Claude Code's own health status), **Jira read access verified** (from the last access check), and
**comment creation available** (the write tool was visible; writing itself is proven only by the first
publication).

### MCP troubleshooting

| Symptom                                         | What to do                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| doctor: "no Atlassian MCP server is registered" | `git2jira mcp setup`                                                         |
| doctor: "needs authentication"                  | Claude Code → `/mcp` → Atlassian → Authenticate                              |
| Skill: `no-tools`                               | Restart Claude Code after registering; check `/mcp`                          |
| Skill: `not-authenticated`                      | Authenticate again in `/mcp`; the sign-in may have expired                   |
| Skill: `read-only`                              | Write access is not granted; use manual mode or ask your administrator       |
| Skill: `blocked-by-policy`                      | Your organization blocks Rovo MCP; use manual mode                           |
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

Release notes use `manual` or `mcp`; with `jira.mode api-token` they default to manual.

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
git2jira config set base.branch develop --repo    # where issue branches start (reports and release notes)
git2jira config path
```

Precedence: the Skill or `--language`/`--mode` argument, then the repository configuration, then the
global configuration, then the default. `report.language` applies to reports; release notes are
Ukrainian unless `--language en` is passed. Configuration files never contain tokens, and no setting
turns off the approval before publishing.

## Incremental checkpoints

Each report is bound to a snapshot of your working tree (a private Git object under `refs/git2jira/`,
never pushed; your index and files are untouched). The next report compares against the last
**confirmed** snapshot. Work you do while a report is under review is not included in it and appears in
the next report. With `report.includeUncommitted false`, only committed work is reported; uncommitted
work waits until it is committed. See [docs/git-snapshots.md](docs/git-snapshots.md).

Release notes need no snapshot: they describe committed work from the merge-base to `HEAD` and are stored
in `.git/git2jira/release-notes/`.

## History and recovery

```sh
git2jira status                   # what the next report would contain (read-only)
git2jira history                  # confirmed reports (cross-checked with Jira in API-token mode)
git2jira report pending           # unfinished reports
git2jira report recover           # settle interrupted local operations
git2jira recover                  # API-token mode: interrupted publications
git2jira release-note pending     # open release notes (--all for every one)
```

## Commands

| Command          | Purpose                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `init`           | Setup wizard                                                                              |
| `doctor`         | Diagnose the installation (`--json`)                                                      |
| `config`         | `list`, `get`, `set`, `unset`, `path`                                                     |
| `status`         | Preview the issue, baseline, and changes for the next report                              |
| `report`         | Write, preview, and deliver the next report (`--dry-run`, `--mode`, `--language`, …)      |
| `report …`       | `prepare`, `submit`, `show`, `copy`, `export`, `open`, `confirm`, `publish`, `receipt`…   |
| `release-note …` | `prepare`, `submit`, `show`, `pending`, `copy`, `export`, `confirm`, `publish`, `cancel`… |
| `skill`          | `install`, `status`, `verify`, `uninstall` for `/jira-report` and `/jira-release-note`    |
| `mcp`            | `setup`, `status`, `verify` for the Atlassian MCP connection                              |
| `login`          | API-token mode: connect a Jira site                                                       |
| `logout`         | Remove a stored API token                                                                 |
| `connections`    | List Jira connections and check their tokens                                              |
| `history`        | List confirmed reports                                                                    |
| `recover`        | Repair interrupted API-token publications                                                 |
| `uninstall`      | Remove both Skills, stored tokens, and the global configuration                           |

## Upgrade and uninstall

```sh
npm install -g git2jira-ai@latest     # once published; or a newer tarball (pnpm pack:tgz)
git2jira skill install                # upgrades the Skills in place; adds /jira-release-note
git2jira doctor

git2jira uninstall                    # both Skills, API tokens, global configuration
npm uninstall -g git2jira-ai
```

After upgrading from 0.9.2, `git2jira skill status` shows the installation as outdated until
`git2jira skill install` adds `/jira-release-note`. Files you added to a Skill directory are kept.

`uninstall` never removes MCP servers from Claude Code (it prints the `claude mcp remove` command) and
does not touch repositories: report and release note history stays in `.git/git2jira/` and
`refs/git2jira/` there.

## Security

- Nothing is posted to Jira without your explicit approval of the exact text, and the Skills cannot
  approve for you: confirmations and publications always go through Claude Code's permission prompt.
- A checkpoint never moves because a report was generated, shown, or copied. Release notes never move
  one.
- Jira credentials never reach Claude, logs, configuration files, or repositories. OAuth for MCP stays
  inside Claude Code.
- Your working files and Git index are never modified during analysis.
- Source code, diffs, and Jira text are untrusted data, never instructions; secret-looking values are
  redacted before the model sees them.
- `git2jira skill verify` warns about Claude Code permission rules that would skip approval prompts.

Details: [docs/security.md](docs/security.md).

## Documentation

- [Product requirements](docs/product-requirements.md)
- [Architecture](docs/architecture.md)
- [Installation and setup](docs/installation.md)
- [The /jira-report Skill](docs/skill.md) and
  [manual verification in Claude Code](docs/skill-verification.md)
- [Release notes: /jira-release-note](docs/release-notes.md)
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
