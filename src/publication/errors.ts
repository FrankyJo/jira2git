import { ExitCode, Git2JiraError } from '../core/errors';

export class ReportValidationError extends Git2JiraError {
  constructor(detail: string) {
    super(`The structured report is not valid: ${detail}`, ExitCode.Usage);
  }
}

export class NotApprovedError extends Git2JiraError {
  constructor(reportId: string, status: string) {
    super(
      `Report ${reportId} is ${status} and has not been approved for publication. ` +
        'Nothing was sent to Jira.',
    );
  }
}

export class ApprovalMismatchError extends Git2JiraError {
  constructor() {
    super(
      'The approval does not match the previewed report (digest differs). The report changed ' +
        'after it was approved; review and approve it again. Nothing was sent to Jira.',
    );
  }
}

export class PublicationMismatchError extends Git2JiraError {
  constructor(what: string) {
    super(`Refusing to publish: ${what}. Nothing was sent to Jira.`);
  }
}

export class PublicationInProgressError extends Git2JiraError {
  constructor(reportId: string, status: string) {
    super(
      `Report ${reportId} is ${status}: its outcome in Jira is not settled. ` +
        'Run "git2jira recover" instead of publishing again.',
    );
  }
}

export class IssueNotFoundError extends Git2JiraError {
  constructor(issueKey: string, siteUrl: string) {
    super(
      `Issue ${issueKey} was not found on ${siteUrl}, or this account cannot see it. ` +
        'Git2Jira does not switch to another issue; check the key or pass --issue.',
    );
  }
}
