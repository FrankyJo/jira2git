# Release notes (Phase 7)

`/jira-release-note` writes a user-facing release note for an issue and delivers it as a new Jira
comment. It complements `/jira-report`; it does not replace it.

|              | `/jira-report`                        | `/jira-release-note`                                      |
| ------------ | ------------------------------------- | --------------------------------------------------------- |
| Audience     | developers, reviewers                 | end users and the business                                |
| Change set   | incremental, from the last checkpoint | the whole issue: merge-base of the branch → `HEAD`        |
| Uncommitted  | included by default                   | never included (committed work only)                      |
| Structure    | summary, completed work, files, tests | goal and objectives, then functional sections             |
| Code details | file paths, endpoints                 | none: UI captions, roles, rules, limits as users see them |
| Checkpoint   | moves on confirmation                 | never touched                                             |
| Language     | `en`, `uk`                            | `uk` by default (`--language en` possible)                |
| Delivery     | manual, MCP, API token                | manual (copy) and MCP comment                             |

## Format

1. Title `Release note: <KEY>`.
2. `Ціль – <statement>`, then the objectives as a list.
3. Fixed lead-in: "В рамках цієї задачі було реалізовано наступний функціонал:".
4. Functional sections (heading + blocks): `paragraph`, `steps` (numbered list), `bullets`,
   `definitions` (term – meaning), `table` (header row + rows), `uiMessage` (info panel: the caption as
   shown and its meaning), `note` (note panel), `screenshot` (placeholder `[Скріншот: …]`).
5. Footer with the marker `Git2Jira release note <uuid> · git2jira <version>`.

Headings and fixed phrases come from `RELEASE_NOTE_LABELS` (`src/localization/catalog.ts`). The writer's
format guide with a fictional example is `skill/jira-release-note/reference/format.md`.

## Sources and honesty

A release note states facts the diff often cannot prove (system address, how access is requested, the
purpose of the feature). Every block carries a `source`, shown in the preview and never rendered:

- `code`: from the change set or files at `HEAD`; requires `evidence` paths from the change set.
- `jira`: from the issue summary or description.
- `user`: given by the user during the run.
- `inferred`: the writer's interpretation; listed under "to verify" in the preview.

`openQuestions` lists what the writer could not establish; it is shown, never published. Confirmed
`/jira-report` reports of the issue (local drafts) are given to the writer as redacted context.

## Where the goal comes from

The goal ("Ціль") must not be guessed. In order:

1. The issue description, read in full. It states the goal only if it says why the work is done; a
   description with only technical steps, links, checklists, or acceptance criteria does not.
2. The parent issue, usually the epic. In MCP mode the issue lookup's `fields.parent` is recorded at
   `prepare` (shown as `issue.parent` in its output); the Skill reads it with the issue tool and passes
   the result to `git2jira release-note parent`, which accepts only that parent's key. Its summary and
   description reach the writer as `parentIssue`, redacted and fenced like the issue text. The goal is
   taken from it, narrowed to what the issue contributes (`source: jira`).
3. The user (`source: user`). In manual mode, or without a parent, the Skill asks for the goal and
   mentions that it is often written in the epic.
4. Only then inferred (`source: inferred`), with a question in `openQuestions`.

Classic "Epic Link" custom fields are not read (their ids differ per site); Jira Cloud exposes epics
as `fields.parent`.

## CLI: `git2jira release-note`

| Command                             | Effect                                                                           | In the Skill |
| ----------------------------------- | -------------------------------------------------------------------------------- | ------------ |
| `prepare`                           | resolve merge-base and `HEAD`, build the redacted analysis package, save a draft | pre-approved |
| `parent`                            | MCP: add the parent issue (epic) named by the issue lookup as context            | pre-approved |
| `request`                           | private request file for the `jira-release-writer` subagent                      | pre-approved |
| `submit`                            | validate the JSON, render Markdown, text, and ADF, compute the digest            | pre-approved |
| `show`, `pending`, `copy`, `export` | read the finished text (`export` writes only to `.git/git2jira/exports`)         | pre-approved |
| `confirm`                           | manual: the user states this exact digest is in Jira (user-attested)             | prompt       |
| `publish`                           | MCP: digest-bound approval, write-ahead attempt, comment payload                 | prompt       |
| `record-result`, `reconcile`        | MCP: record / settle the single comment creation                                 | prompt       |
| `cancel`                            | abandon a release note that is not in Jira                                       | prompt       |

`git2jira skill context --skill jira-release-note --args …` resolves the run for the Skill (issue, mode,
language `uk` unless `--language`, open release notes).

Drafts live in `<git common dir>/git2jira/release-notes/<id>.json` and record the base branch, the
merge-base, `HEAD`, and both trees. No refs are created: the commits are reachable from the branch.

States: manual `DRAFT → READY → CONFIRMED`; MCP `DRAFT → READY → PUBLISHING → PUBLISHED`, with
`FAILED`, `UNCERTAIN`, and `RECOVERED` as for reports; `DRAFT`, `READY`, `FAILED → CANCELLED`. One
open release note per issue and site; a new one after a delivered one becomes another comment (the
CLI and the Skill say so first).

`publish` refuses when `HEAD` moved since `prepare` (new commits would not be described), when the
changed files differ, or when the digest differs. A retry after an attempt needs a complete comment
listing without the release note.

## Validation (`release-note submit`)

- Strict Zod schema `ReleaseNoteContentSchema` (`schemaVersion: 1`) with size limits; tables need one
  cell per column.
- `issueKey` and `language` must equal the draft's.
- `code` blocks need evidence; evidence must be in the change set.
- The rendered text may not contain a changed file's path, `[REDACTED]`, or deployment, release, QA, or
  approval claims (`unsupportedClaims`, shared with reports).
- Prose must be in the release note's language; UI captions, terms, and table cells may be Latin.

## Markers

The release note marker (`Git2Jira release note <uuid>`) and the report marker
(`Git2Jira report <uuid> · #n`) never match each other, so report history and reconciliation never
mistake one for the other (`tests/release-note/render.test.ts`). Release notes use no comment
property.

## Skill package

- `skill/jira-release-note/`: `SKILL.md` (user-invoked only, read-only `allowed-tools`),
  `reference/format.md`, `reference/mcp.md`.
- `skill/agents/jira-release-writer.md`: read-only subagent (`Read, Grep, Glob`).
- `SkillSuiteInstaller` (`src/skill/suite.ts`) installs, checks, upgrades, and removes both Skills as
  one unit; each keeps its own directory, manifest, and subagent. An installation from before Phase 7
  (only `/jira-report`) shows as `outdated` until `git2jira skill install` adds the new Skill.

## What has and has not been verified

Covered by tests with real Git and the real CLI: validation, rendering, the state machine, MCP flows
with simulated tool results, the permission boundary of the shipped `allowed-tools`, installation.
Not yet verified: `/jira-release-note` in a real Claude Code session, and a release note comment
(tables, panels) created through the real Atlassian Rovo MCP server.
