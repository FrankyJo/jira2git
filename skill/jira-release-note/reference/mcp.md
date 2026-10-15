# MCP delivery of a release note (Atlassian Rovo MCP)

The Atlassian Rovo MCP server is authorized with OAuth inside Claude Code. You call its tools; the CLI
never sees the authorization. You hand every tool result to the CLI **verbatim** and the CLI decides
what it proves.

Tool names come from `mcp.tools` in the `skill context` output. Use a tool only if a tool with exactly
that name is available in this session, and read each tool's own input schema for its parameters.

### Reading the issue's comments

- If `mcp.tools.listComments` is available: call it for the issue, every page.
- Otherwise: call the issue tool for the issue and ask for the comment field (for example
  `fields: ["comment"]`, per its input schema). Pass the raw issue result as the listing.
- If neither returns comments, pass what you got anyway: the CLI treats the listing as incomplete,
  which keeps the release note from being published twice.

## Access check

1. Collect the names of **all** tools in this session that start with `mcp__`.
2. Call the sites tool. Keep the raw result or the error message (and HTTP status, if shown).
3. Call the account tool. Keep the raw result or the error.
4. Choose the site: with `site.placeholder: false`, the resource whose URL equals `site.url` (none:
   stop). Otherwise ask the user with `AskUserQuestion` to confirm the only Jira site, or to choose
   one. Never pick one silently.
5. Call the issue tool for `issue.key` on that site's cloud id. Keep the raw result or the error.
6. Run (omit a probe you could not run):

   ```bash
   git2jira mcp verify --json --input - <<'<heredocDelimiter>'
   {
     "schemaVersion": 1,
     "server": "<mcp.server>",
     "tools": ["<every mcp__ tool name from step 1>"],
     "probes": {
       "resources": { "ok": true, "result": <raw result> },
       "userInfo": { "ok": true, "result": <raw result> },
       "issue": { "ok": true, "result": <raw result> }
     }
   }
   <heredocDelimiter>
   ```

7. `state` other than `ready`: show the CLI's `messages`, say "Atlassian MCP is unavailable. You can
   generate and copy the release note using Manual mode.", and ask with `AskUserQuestion`:
   "Continue in manual mode" / "Stop".

If a tool call needs the user to sign in, never ask for credentials; tell them to use `/mcp`.

## Prepare

```bash
git2jira release-note prepare --json --mode mcp --language <language.value> [--issue <issue.key>] \
  --site <site URL> --cloud-id <cloudId> --server <mcp.server> --issue-lookup - <<'<heredocDelimiter>'
<raw issue tool result>
<heredocDelimiter>
```

The CLI checks that the lookup is exactly the branch's issue. The issue's summary and description
reach the writer as data (`generation.parts`), for the goal of the release note. `issue.parent` in the
output names the parent issue (usually the epic) when Jira returned one; read it with
`release-note parent` when the issue does not state its goal (SKILL.md step 5).

## Publication

1. Ask with `AskUserQuestion`: "Publish the release note to <issueKey> as a new Jira comment?"
   - "Publish to Jira"
   - "Keep it open"
   - "Cancel it"

2. **Publish** (only on that option):

   ```bash
   git2jira release-note publish --note <noteId> --digest <noteDigest>
   ```

   Claude Code asks the user to approve it. The output is the payload: `cloudId`, `issueKey`, `tool`,
   `body.markdown`, `body.adf`, `marker`. If the CLI refuses (digest mismatch, new commits since the
   release note was prepared, a publication in flight), show the message and stop.

3. Call the comment tool **once**, with the payload's `cloudId` and `issueKey` and the body exactly as
   given: `body.markdown` if the tool takes Markdown or a string, `body.adf` if it takes an Atlassian
   document. **Never pass a comment id**: that would edit an existing comment. Do not shorten,
   translate, or reformat the body; it carries the marker line the CLI looks for.

4. Record what happened, whatever it was:

   ```bash
   git2jira release-note record-result --note <noteId> --json --input - <<'<heredocDelimiter>'
   <envelope>
   <heredocDelimiter>
   ```

   with exactly one envelope:
   - `{ "outcome": "tool-returned", "toolResult": <raw result> }`
   - `{ "outcome": "tool-error", "error": { "message": "<text>", "status": <code if known> } }`
   - `{ "outcome": "not-called", "reason": "permission-denied" }` (the user denied the prompt)
   - `{ "outcome": "not-called", "reason": "tool-unavailable" }`

   Never write `"published": true` or similar: the CLI reads only the tool result.

5. Act on `state`: `PUBLISHED` → show `publication.commentUrl`. `UNCERTAIN` → do **not** publish
   again; see below. `FAILED` → show the reason; it can be retried
   (`release-note publish … --comments <listing>`) or cancelled and prepared in manual mode.

## Uncertain outcome

The comment may or may not exist. Never call the comment tool again for this release note.

1. Get the comment listing (see above) and call the account tool.
2. Run `git2jira release-note reconcile --note <noteId> --json --input -` with
   `{ "comments": <one page or an array of raw pages>, "account": <raw account result> }`.
3. `RECOVERED`: it is in Jira. `FAILED`: it is not (retry or cancel). Still `UNCERTAIN`: tell the user
   that Jira may still be processing it and to run `/jira-release-note` again in a few minutes.
