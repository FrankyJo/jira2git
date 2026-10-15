import { describe, expect, it } from 'vitest';
import {
  ReleaseNoteValidationError,
  factsToVerify,
  finalizeReleaseNote,
  parseReleaseNoteInput,
} from '../../src/release-note/validate';
import { FILES, ISSUE, NOTE_ID, sampleNote } from './fixtures';

const FACTS = { noteId: NOTE_ID, issueKey: ISSUE, language: 'uk' as const, files: FILES };

function finalize(input: unknown) {
  return finalizeReleaseNote(parseReleaseNoteInput(input), FACTS);
}

function withBlock(block: Record<string, unknown>) {
  return sampleNote({ sections: [{ title: 'Розділ', blocks: [block] }] });
}

describe('release note validation', () => {
  it('accepts a valid release note and adds the note id', () => {
    const note = finalize(sampleNote());
    expect(note.noteId).toBe(NOTE_ID);
    expect(note.sections[0]?.blocks).toHaveLength(8);
  });

  it('rejects unknown fields and malformed tables at the schema level', () => {
    expect(() => parseReleaseNoteInput({ ...sampleNote(), extra: 1 })).toThrow(
      ReleaseNoteValidationError,
    );
    expect(() =>
      parseReleaseNoteInput(
        withBlock({
          type: 'table',
          columns: ['A', 'B'],
          rows: [['only one', 'two', 'three']],
          source: 'inferred',
        }),
      ),
    ).toThrow(/one cell per column/);
  });

  it('never lets the writer change the issue or the language', () => {
    expect(() => finalize(sampleNote({ issueKey: 'OTHER-1' }))).toThrow(/prepared for LSND-1234/);
    expect(() => finalize(sampleNote({ language: 'en' }))).toThrow(/expected "uk"/);
  });

  it('requires evidence from the change set for facts attributed to code', () => {
    expect(() =>
      finalize(withBlock({ type: 'paragraph', text: 'Додано ліміти бронювання.', source: 'code' })),
    ).toThrow(/source "code" but no evidence/);
    expect(() =>
      finalize(
        withBlock({
          type: 'paragraph',
          text: 'Додано ліміти бронювання.',
          source: 'code',
          evidence: ['src/elsewhere.ts'],
        }),
      ),
    ).toThrow(/not in this change set: src\/elsewhere.ts/);
  });

  it('keeps file paths, secrets, and unsupported claims out of the text', () => {
    expect(() =>
      finalize(
        withBlock({
          type: 'paragraph',
          text: 'Ліміти задано у src/booking/limits.ts.',
          source: 'inferred',
        }),
      ),
    ).toThrow(/names file paths \(src\/booking\/limits.ts\)/);
    expect(() =>
      finalize(withBlock({ type: 'note', text: 'Пароль: [REDACTED].', source: 'inferred' })),
    ).toThrow(/REDACTED/);
    expect(() =>
      finalize(
        withBlock({ type: 'note', text: 'Функцію розгорнуто на продакшн.', source: 'inferred' }),
      ),
    ).toThrow(/deployment or release/);
  });

  it('requires Ukrainian prose but allows Latin UI captions and table cells', () => {
    expect(() =>
      finalize(
        withBlock({
          type: 'paragraph',
          text: 'Users can now book rooms online.',
          source: 'inferred',
        }),
      ),
    ).toThrow(/not written in Ukrainian/);
    expect(() =>
      finalize(
        withBlock({
          type: 'uiMessage',
          text: 'EXPORT TO .xls',
          meaning: 'Кнопка формує файл журналу.',
          source: 'inferred',
        }),
      ),
    ).not.toThrow();
  });

  it('lists inferred statements for the user to verify, and never user or code facts', () => {
    const lines = factsToVerify(
      parseReleaseNoteInput(sampleNote({ goal: { statement: 'Мета.', source: 'inferred' } })),
    );
    expect(lines[0]).toBe('Ціль: Мета.');
    expect(lines.join('\n')).toContain('14 днів');
    expect(lines.join('\n')).not.toContain('Адміністратор');
    expect(lines.join('\n')).not.toContain('НОВЕ БРОНЮВАННЯ');
  });
});
