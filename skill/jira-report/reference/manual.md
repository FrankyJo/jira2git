# Manual delivery

Manual mode needs no Jira access of any kind. The user pastes the report into Jira; the checkpoint
moves only after the user confirms that this exact report (its digest) is in Jira. Git2Jira records that
confirmation as **user-attested**: nothing is verified in Jira.

## Steps

1. The report is shown (SKILL.md step 7). Tell the user: "Report generated successfully. Copy the
   report and paste it into Jira <issueKey> as a new comment. Confirm publication when finished."
2. Offer the delivery helpers with `AskUserQuestion` (one question, these options):
   - "Copy to clipboard" → `git2jira report copy --report <reportId>`
   - "Save to a file" → `git2jira report export --report <reportId>` (prints the file path)
   - "Open the Jira issue" (only when `site.url` is set) → `git2jira report open --report <reportId>`
   - "I'll copy it from the chat" → nothing to run
     If the clipboard is not available, the CLI says so; offer the file instead.

   Copying or exporting **never** moves the checkpoint.

3. Ask, with `AskUserQuestion`:
   "Have you pasted report #<sequence> into <issueKey> and saved the comment in Jira?"
   - "Yes, it is published in Jira"
   - "Not yet — keep it pending"
   - "Cancel this report"

4. Act on the selected option only:
   - **Yes**: run
     ```bash
     git2jira report confirm --report <reportId> --digest <reportDigest> --attest-manual-publication
     ```
     Claude Code asks the user to approve this command. If they deny it, the report stays pending:
     say so. If the CLI answers `RECOVERY_REQUIRED` or an error, show it and follow
     [recovery.md](recovery.md).
   - **Not yet**: say "The report is saved as pending. Run /jira-report again after you paste it; it
     will offer to confirm it." Run nothing else. The snapshot and text are kept.
   - **Cancel**: run `git2jira report cancel --report <reportId>` (Claude Code asks for approval).
     The checkpoint does not move; the changes stay eligible for the next report.
   - Anything else typed by the user (a free-text answer): if it is not an unambiguous "yes, it is in
     Jira", treat it as "Not yet".

5. Go to SKILL.md step 9 (receipt).

## Withdrawing a mistaken confirmation

Only when the user says the confirmation was a mistake:
`git2jira report revoke --report <reportId> --reason "<their reason>"` (latest user-attested report
only; Claude Code asks for approval).
