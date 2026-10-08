# Product requirements

## Mission

Git2Jira AI turns Git changes into professional, incremental Jira implementation reports using Claude
Code. It is a standalone open-source tool for independent GitHub distribution and npm publication.

## Primary flow

`/jira-report` inside a Claude Code session in any Git repository:

1. Detect the repository and branch.
2. Extract the Jira issue key from the branch name.
3. Find the last successfully published report.
4. Analyze only the changes since that report.
5. Use Claude Code to understand the implementation.
6. Generate a report in the configured language.
7. Show a preview and require explicit approval.
8. Publish a new Jira comment.
9. Save a checkpoint after successful publication.

## Functional requirements

| ID    | Requirement                                                                                                     |
| ----- | --------------------------------------------------------------------------------------------------------------- |
| FR-1  | Each run with new work creates a **new** comment. Existing comments are never edited.                           |
| FR-2  | A run with no changes since the last checkpoint publishes nothing and says so.                                  |
| FR-3  | The first report for an issue covers the branch since it diverged from the base branch.                         |
| FR-4  | A checkpoint is written only after Jira confirms the comment was created.                                       |
| FR-5  | Interrupted publications can be reconciled without duplicate comments (`recover`).                              |
| FR-6  | Reports are available in English (`en`, default) and Ukrainian (`uk`).                                          |
| FR-7  | Language precedence: `--language` → repository config → global config → `en`.                                   |
| FR-8  | File names, issue keys, branch names, identifiers, and endpoints are never translated.                          |
| FR-9  | Structured report data is language-independent; only free text and headings are localized.                      |
| FR-10 | `/jira-report` runs in the current Claude Code session and needs no separate Anthropic API key.                 |
| FR-11 | The standalone CLI never switches to API-key billing silently.                                                  |
| FR-12 | Setup (`init`) asks for the preferred report language and stores it globally.                                   |
| FR-13 | Commands: `init`, `doctor`, `login`, `logout`, `config`, `status`, `report`, `history`, `recover`, `uninstall`. |

## Non-functional requirements

- Node.js 22.12+, TypeScript strict mode, ESM, minimal runtime dependencies (Commander, @clack/prompts, Zod).
- macOS, Linux, and Windows.
- All Jira writes require explicit approval of the exact previewed content.
- Credentials only in OS-native secure storage; never in repositories, config files, logs, or prompts.
- Working files and the user's Git index are never modified during analysis.
- No shell interpolation of untrusted arguments.
- Clear, honest errors: unimplemented features say so and exit non-zero.

## Example

Branch `feature/LSND-1234-user-profile`:

| Day | Work                                | Result                                      |
| --- | ----------------------------------- | ------------------------------------------- |
| 1   | Components A and B created          | Comment #1 describes A and B                |
| 6   | B modified, API integration C added | Comment #2 describes only B's changes and C |
| 7   | Nothing new                         | No comment                                  |

## Out of scope (for now)

- Jira Server / Data Center (Cloud only at first).
- Editing or deleting comments.
- Transitioning issues, logging work, or changing fields.
- Hosting a backend service (may be revisited for OAuth; see [authentication.md](authentication.md)).
