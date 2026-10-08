import type { ChangeKind, TestStatus, TestRun } from '../report/schema';
import type { Language } from './languages';

/**
 * Localized presentation strings for rendered reports. Structured report data
 * stays language-independent; only headings and fixed phrases come from here.
 * File names, issue keys, branch names, identifiers, and API endpoints are
 * never translated.
 */
export interface ReportLabels {
  title: string;
  summary: string;
  completedWork: string;
  createdFiles: string;
  modifiedFiles: string;
  deletedOrRenamedFiles: string;
  testing: string;
  knownLimitations: string;
  changeKinds: Readonly<Record<ChangeKind, string>>;
  /** `{count}` is replaced with the number of omitted entries. */
  moreItems: string;
  /** `{path}` is replaced with the source path of a copy. */
  copiedFrom: string;
  /** Marks a file whose type changed (e.g. file to symlink). */
  typeChanged: string;
  /** First line of the testing section, decided by evidence. */
  testStatus: Readonly<Record<TestStatus, string>>;
  testOutcomes: Readonly<Record<TestRun['outcome'], string>>;
  testSources: Readonly<Record<TestRun['source'], string>>;
  /** `{analyzed}` and `{total}` are replaced with file counts. */
  coverageIncomplete: string;
}

export interface LabelCatalog {
  labels(language: Language): ReportLabels;
}

export const REPORT_LABELS: Readonly<Record<Language, ReportLabels>> = {
  en: {
    title: 'Implementation Report',
    summary: 'Summary',
    completedWork: 'Completed Work',
    createdFiles: 'Created Files',
    modifiedFiles: 'Modified Files',
    deletedOrRenamedFiles: 'Deleted or Renamed Files',
    testing: 'Testing and Validation',
    knownLimitations: 'Known Limitations',
    changeKinds: {
      added: 'Added',
      modified: 'Changed',
      removed: 'Removed',
      refactored: 'Refactored',
      fixed: 'Fixed',
    },
    moreItems: '… and {count} more',
    copiedFrom: 'copied from {path}',
    typeChanged: 'type changed',
    testStatus: {
      passed: 'All recorded test runs passed.',
      failed: 'The recorded test runs failed.',
      partial: 'Some recorded test runs failed.',
      'not-run': 'No tests were run for this report.',
      reported: 'Testing as stated by the report author (not verified by Git2Jira):',
    },
    testOutcomes: {
      passed: 'passed',
      failed: 'failed',
      error: 'could not be run',
      'timed-out': 'timed out',
    },
    testSources: { git2jira: 'run by Git2Jira', reported: 'reported' },
    coverageIncomplete:
      'Only {analyzed} of {total} changed files were analyzed in full; the others are listed but may not be described.',
  },
  uk: {
    title: 'Звіт про реалізацію',
    summary: 'Підсумок',
    completedWork: 'Виконані роботи',
    createdFiles: 'Створені файли',
    modifiedFiles: 'Змінені файли',
    deletedOrRenamedFiles: 'Видалені або перейменовані файли',
    testing: 'Тестування та перевірки',
    knownLimitations: 'Відомі обмеження',
    changeKinds: {
      added: 'Додано',
      modified: 'Змінено',
      removed: 'Видалено',
      refactored: 'Рефакторинг',
      fixed: 'Виправлено',
    },
    moreItems: '… та ще {count}',
    copiedFrom: 'скопійовано з {path}',
    typeChanged: 'змінено тип',
    testStatus: {
      passed: 'Усі зафіксовані запуски тестів пройшли успішно.',
      failed: 'Зафіксовані запуски тестів завершилися з помилками.',
      partial: 'Частина зафіксованих запусків тестів завершилася з помилками.',
      'not-run': 'Для цього звіту тести не запускалися.',
      reported: 'Тестування за словами автора звіту (Git2Jira не перевіряв):',
    },
    testOutcomes: {
      passed: 'пройдено',
      failed: 'не пройдено',
      error: 'не вдалося запустити',
      'timed-out': 'перевищено час очікування',
    },
    testSources: { git2jira: 'запущено Git2Jira', reported: 'повідомлено' },
    coverageIncomplete:
      'Повністю проаналізовано лише {analyzed} з {total} змінених файлів; решта перелічена, але може бути не описана.',
  },
};

export class StaticLabelCatalog implements LabelCatalog {
  labels(language: Language): ReportLabels {
    return REPORT_LABELS[language];
  }
}
