import { describe, expect, it } from 'vitest';
import { findReportMarkers } from '../../src/adf/footer';
import { adfToPlainText } from '../../src/adf/text';
import { validateAdfDocument } from '../../src/adf/validate';
import { markerLine } from '../../src/delivery/render';
import { RELEASE_NOTE_LABELS } from '../../src/localization/catalog';
import {
  findReleaseNoteMarkers,
  releaseNoteMarker,
  renderReleaseNote,
} from '../../src/release-note/render';
import { finalizeReleaseNote, parseReleaseNoteInput } from '../../src/release-note/validate';
import { FILES, ISSUE, NOTE_ID, sampleNote } from './fixtures';

function render(input: unknown = sampleNote()) {
  const note = finalizeReleaseNote(parseReleaseNoteInput(input), {
    noteId: NOTE_ID,
    issueKey: ISSUE,
    language: 'uk',
    files: FILES,
  });
  return renderReleaseNote({ note, labels: RELEASE_NOTE_LABELS.uk, toolVersion: '0.0.0-test' });
}

describe('release note rendering', () => {
  it('renders the release note format in Markdown, deterministically', () => {
    const { markdown } = render();
    expect(markdown).toBe(render().markdown);
    expect(markdown).toContain('## Release note: LSND-1234');
    expect(markdown).toContain('**Ціль –** Автоматизація бронювання переговорних кімнат.');
    expect(markdown).toContain('- **Менше конфліктів** – зайняту кімнату забронювати неможливо.');
    expect(markdown).toContain('В рамках цієї задачі було реалізовано наступний функціонал:');
    expect(markdown).toContain('### Створення бронювання');
    expect(markdown).toContain('1. Натиснути “+НОВЕ БРОНЮВАННЯ”.\n2. Обрати кімнату та час.');
    expect(markdown).toContain('_\\[Скріншот: форма нового бронювання\\]_');
    expect(markdown).toContain(
      '| Тип кімнати | Максимальна тривалість |\n| --- | --- |\n| Мала | 2 години |',
    );
    expect(markdown).toContain('> **«Немає доступу»**\n>\n> У вас немає ролі в системі.');
    expect(markdown).toContain('> **Примітка:** Бронювання можна створити');
    expect(markdown.trimEnd().endsWith(releaseNoteMarker(NOTE_ID))).toBe(true);
    // Sources, evidence, and open questions are for the preview only.
    expect(markdown).not.toMatch(/src\/|inferred|Яка адреса/);
  });

  it('produces valid ADF with ordered lists, tables, and panels', () => {
    const { adf } = render();
    expect(validateAdfDocument(adf)).toEqual(adf);
    const types = adf.content.map((b) => b.type);
    expect(types).toEqual(
      expect.arrayContaining(['heading', 'orderedList', 'table', 'panel', 'bulletList', 'rule']),
    );
    expect(adfToPlainText(adf)).toContain(releaseNoteMarker(NOTE_ID));
  });

  it('escapes writer text so it cannot become links or headings', () => {
    const { markdown, adf } = render(
      sampleNote({
        sections: [
          {
            title: 'Розділ',
            blocks: [
              {
                type: 'paragraph',
                text: '# Увага [натисніть](https://evil.example) <img src=x>',
                source: 'inferred',
              },
            ],
          },
        ],
      }),
    );
    expect(markdown).toContain('\\# Увага \\[натисніть\\](https://evil.example) \\<img src=x\\>');
    expect(JSON.stringify(adf)).not.toContain('"link"');
  });

  it('uses a marker that report history never mistakes for a report, and vice versa', () => {
    const { markdown, adf } = render();
    expect(findReportMarkers(markdown)).toEqual([]);
    expect(findReportMarkers(adfToPlainText(adf))).toEqual([]);
    expect(findReleaseNoteMarkers(markdown)).toEqual([NOTE_ID]);
    expect(findReleaseNoteMarkers(markerLine({ reportId: NOTE_ID, sequence: 1 }))).toEqual([]);
  });
});
