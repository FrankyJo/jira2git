# Release note format

The CLI renders the release note; you write one JSON object (`schemaVersion: 1`) that matches
`generation.schema`. No prose and no Markdown fence around it when you pass it to
`release-note submit`.

## Structure

| Field                  | What goes in it                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `issueKey`, `language` | exactly as given in `contract` (the CLI rejects anything else)                            |
| `goal.statement`       | the purpose of the feature, one or two sentences; rendered as "Ціль – …"                  |
| `goal.source`          | `jira` from the issue or its parent (epic), `user` when the user said it, else `inferred` |
| `goal.objectives`      | 2–6 expected effects: a short `title` and an optional one-sentence `description`          |
| `sections`             | one per functional area, in the order a user meets them; title = short noun phrase        |
| `sections[].blocks`    | the content, see below                                                                    |
| `openQuestions`        | what you could not establish; shown to the user, never published                          |

After the goal the CLI adds the fixed line "В рамках цієї задачі було реалізовано наступний
функціонал:", then the sections. You never write headings, the title, or that line yourself.

### Blocks

| `type`        | Fields                         | Use for                                                         |
| ------------- | ------------------------------ | --------------------------------------------------------------- |
| `paragraph`   | `text`                         | explanations                                                    |
| `steps`       | `items[]`                      | what the user does, in order (rendered as a numbered list)      |
| `bullets`     | `items[]`                      | unordered facts and options                                     |
| `definitions` | `items[{ term, description }]` | roles and their rights, statuses and their meaning              |
| `table`       | `columns[]`, `rows[][]`        | mappings: reason → duration, role → rights; one cell per column |
| `uiMessage`   | `text`, `meaning`              | a message, badge, or label exactly as shown, and what it means  |
| `note`        | `text`                         | exceptions, limits, important conditions                        |
| `screenshot`  | `description`                  | placeholder: what the screenshot should show                    |

Every block except `screenshot` has `source` (`code`, `jira`, `user`, `inferred`) and `evidence`
(changed file paths that show the fact; **required** for `code`, never rendered).

## Writing rules

- The goal comes from the issue description; if it does not state one, from the parent issue (epic,
  `parentIssue`), narrowed to this issue's part; then from the user. Infer it only as a last resort,
  with a question in `openQuestions`.

- Audience: users and the business. Explain what they can do, what they see, and which rules apply.
- Quote UI captions exactly as the code shows them, in quotation marks: “+НОВЕ БРОНЮВАННЯ”.
- State the concrete rules and limits the code defines (durations, periods, maximum ranges,
  conditions). Never invent or round numbers.
- No file paths, class or function names, endpoints, HTTP methods, or database names in the text.
  The CLI rejects a release note whose text contains a changed file's path.
- Facts the code cannot show (system address, how to request access, organisational rules) need the
  user or the Jira issue as their source. Without one, leave the fact out and ask in `openQuestions`.
- Add a `screenshot` placeholder for each new screen, dialog, or status badge worth showing.
- Ukrainian: plain professional language, past tense for what was implemented, present tense for
  how the system works. No Russian, no transliteration.
- Never claim deployment, release dates, QA, or approvals.

## Example (fictional)

The project, its address, and its rules below are invented to show the format.

```json
{
  "schemaVersion": 1,
  "issueKey": "ROOM-42",
  "language": "uk",
  "goal": {
    "statement": "Автоматизація бронювання переговорних кімнат і контроль їх використання.",
    "source": "jira",
    "objectives": [
      {
        "title": "Менше конфліктів",
        "description": "система не дозволяє забронювати зайняту кімнату."
      },
      {
        "title": "Прозорість",
        "description": "статус кімнати видно одразу в застосунку та на табло."
      }
    ]
  },
  "sections": [
    {
      "title": "Вхід у систему та ролі",
      "blocks": [
        {
          "type": "paragraph",
          "text": "Бронювання ведеться в системі https://rooms.example.com (надалі «Бронювання»).",
          "source": "user",
          "evidence": []
        },
        {
          "type": "definitions",
          "items": [
            { "term": "Співробітник", "description": "створення та перегляд власних бронювань" },
            {
              "term": "Адміністратор",
              "description": "редагування будь-яких бронювань та експорт журналу"
            }
          ],
          "source": "code",
          "evidence": ["src/auth/roles.ts"]
        },
        {
          "type": "uiMessage",
          "text": "Немає доступу",
          "meaning": "У вас немає ролі в системі; зверніться до служби підтримки.",
          "source": "code",
          "evidence": ["src/i18n/uk.json"]
        }
      ]
    },
    {
      "title": "Створення бронювання",
      "blocks": [
        {
          "type": "steps",
          "items": [
            "Натиснути “+НОВЕ БРОНЮВАННЯ”.",
            "Обрати кімнату та час.",
            "Натиснути “ЗБЕРЕГТИ”."
          ],
          "source": "code",
          "evidence": ["src/booking/BookingForm.tsx"]
        },
        { "type": "screenshot", "description": "форма нового бронювання з обраною кімнатою" },
        {
          "type": "table",
          "columns": ["Тип кімнати", "Максимальна тривалість"],
          "rows": [
            ["Мала (до 4 осіб)", "2 години"],
            ["Велика (до 12 осіб)", "4 години"]
          ],
          "source": "code",
          "evidence": ["src/booking/limits.ts"]
        },
        {
          "type": "note",
          "text": "Бронювання можна створити не більше ніж на 14 днів наперед.",
          "source": "code",
          "evidence": ["src/booking/limits.ts"]
        }
      ]
    }
  ],
  "openQuestions": ["Як співробітник отримує роль «Адміністратор»?"]
}
```

Rendered (Markdown, shortened):

```markdown
## Release note: ROOM-42

**Ціль –** Автоматизація бронювання переговорних кімнат і контроль їх використання.

- **Менше конфліктів** – система не дозволяє забронювати зайняту кімнату.

В рамках цієї задачі було реалізовано наступний функціонал:

### Створення бронювання

1. Натиснути “+НОВЕ БРОНЮВАННЯ”.

_\[Скріншот: форма нового бронювання з обраною кімнатою\]_

| Тип кімнати      | Максимальна тривалість |
| ---------------- | ---------------------- |
| Мала (до 4 осіб) | 2 години               |
```
