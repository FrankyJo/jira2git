import type { ReportFile } from '../../src/adf/types';

export const NOTE_ID = '11111111-2222-4333-8444-555555555555';
export const ISSUE = 'LSND-1234';

export const FILES: ReportFile[] = [
  { status: 'added', path: 'src/booking/limits.ts' },
  { status: 'modified', path: 'src/i18n/uk.json' },
];

/** A valid Ukrainian release note for FILES; `overrides` replace top-level fields. */
export function sampleNote(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    issueKey: ISSUE,
    language: 'uk',
    goal: {
      statement: 'Автоматизація бронювання переговорних кімнат.',
      source: 'jira',
      objectives: [
        { title: 'Менше конфліктів', description: 'зайняту кімнату забронювати неможливо.' },
        { title: 'Прозорість' },
      ],
    },
    sections: [
      {
        title: 'Створення бронювання',
        blocks: [
          {
            type: 'steps',
            items: ['Натиснути “+НОВЕ БРОНЮВАННЯ”.', 'Обрати кімнату та час.'],
            source: 'code',
            evidence: ['src/i18n/uk.json'],
          },
          { type: 'screenshot', description: 'форма нового бронювання' },
          {
            type: 'table',
            columns: ['Тип кімнати', 'Максимальна тривалість'],
            rows: [
              ['Мала', '2 години'],
              ['Велика', '4 години'],
            ],
            source: 'code',
            evidence: ['src/booking/limits.ts'],
          },
          {
            type: 'definitions',
            items: [{ term: 'Адміністратор', description: 'редагування будь-яких бронювань' }],
            source: 'user',
          },
          {
            type: 'uiMessage',
            text: 'Немає доступу',
            meaning: 'У вас немає ролі в системі.',
            source: 'code',
            evidence: ['src/i18n/uk.json'],
          },
          {
            type: 'note',
            text: 'Бронювання можна створити не більше ніж на 14 днів наперед.',
            source: 'inferred',
          },
          {
            type: 'paragraph',
            text: 'Список бронювань оновлюється автоматично.',
            source: 'inferred',
          },
          { type: 'bullets', items: ['Фільтр за датою.', 'Пошук за назвою.'], source: 'inferred' },
        ],
      },
    ],
    openQuestions: ['Яка адреса системи?'],
    ...overrides,
  };
}
