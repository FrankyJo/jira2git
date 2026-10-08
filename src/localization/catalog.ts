import type { ChangeKind } from '../report/schema';
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
  },
};

export class StaticLabelCatalog implements LabelCatalog {
  labels(language: Language): ReportLabels {
    return REPORT_LABELS[language];
  }
}
