# Pending reports and recovery

A report stays pending until it is confirmed (manual), published (MCP), or cancelled. Its candidate
snapshot is kept however long it waits, so continuing later reports exactly the changes it was
prepared with. Changes made since then go into the next report.

`skill context` lists pending reports for the current issue in `pending`. For each one, show its
number, mode, status, and `updatedAt`, then act by status.

## Manual reports

| Status                         | What to do                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| `DRAFT`                        | No text yet: `git2jira report request --report <id> --json`, write the report (SKILL.md 5) |
| `READY_TO_COPY`                | Show it: `git2jira report show --report <id> --format markdown`, then manual.md step 2     |
| `AWAITING_MANUAL_CONFIRMATION` | Show it, then ask whether it is in Jira (manual.md step 3)                                 |
| `RECOVERY_REQUIRED`            | Show `recovery`; offer `git2jira report recover` (approval prompt) or cancel               |

## MCP reports

| Status                         | What to do                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `DRAFT`                        | Run the access check (mcp.md), then write the report from `report request`           |
| `READY_FOR_REVIEW`, `APPROVED` | Run the access check, show the report, then mcp.md "Publication"                     |
| `PUBLISHING`, `UNCERTAIN`      | **Never publish again.** Access check, then mcp.md "Uncertain outcome"               |
| `FAILED`                       | Show `failure`; offer a retry (`publish … --comments <listing>`) or switch to manual |

If MCP is unavailable now, an MCP report that is definitely not in Jira (`DRAFT`, `READY_FOR_REVIEW`,
`APPROVED`, `FAILED`) can switch to manual with `git2jira report fallback --report <id>` without
regenerating anything. `PUBLISHING` and `UNCERTAIN` reports must be reconciled first.

## Options to offer

Ask with `AskUserQuestion`:

- "Continue this report" → the row above.
- "Cancel it and start a new report" → `git2jira report cancel --report <id>` (approval prompt), then
  run SKILL.md from step 4. Not available for `PUBLISHING`/`UNCERTAIN`.
- "Leave it for now" → stop.

`git2jira report recover` settles interrupted local operations (a confirmation interrupted after the
user confirmed, a lost snapshot). It never contacts Jira, but it may finish an interrupted confirmation,
so it is never pre-approved.
