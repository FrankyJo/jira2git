/**
 * Makes untrusted text (Jira error messages, issue summaries, comment text)
 * safe to print to a terminal: control characters, including ANSI escape
 * sequences, are replaced so remote content cannot rewrite the user's screen.
 */
export function terminalSafe(text: string, maxLength = 500): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '�');
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned;
}

/** Single-line variant for table cells and log lines. */
export function terminalSafeLine(text: string, maxLength = 200): string {
  return terminalSafe(text.replace(/[\r\n\t]+/g, ' '), maxLength);
}
