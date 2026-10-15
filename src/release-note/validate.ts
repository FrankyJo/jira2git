import { z } from 'zod';
import type { ReportFile } from '../adf/types';
import { Git2JiraError, ExitCode } from '../core/errors';
import { RELEASE_NOTE_LABELS } from '../localization/catalog';
import type { Language } from '../localization/languages';
import { unsupportedClaims } from '../report/validate';
import {
  ReleaseNoteContentSchema,
  ReleaseNoteSchema,
  type ReleaseNote,
  type ReleaseNoteBlock,
  type ReleaseNoteContent,
} from './schema';

export class ReleaseNoteValidationError extends Git2JiraError {
  constructor(detail: string) {
    super(`The release note is not valid: ${detail}`, ExitCode.Usage);
  }
}

/** Facts the CLI owns; a release note is checked against them. */
export interface ReleaseNoteFacts {
  noteId: string;
  issueKey: string;
  language: Language;
  /** Git's change list from the merge-base to HEAD. The only valid evidence. */
  files: readonly ReportFile[];
}

export function parseReleaseNoteInput(input: unknown): ReleaseNoteContent {
  const parsed = ReleaseNoteContentSchema.safeParse(input);
  if (!parsed.success) {
    throw new ReleaseNoteValidationError(
      z.prettifyError(parsed.error).split('\n').slice(0, 6).join(' '),
    );
  }
  return parsed.data;
}

/** Everything wrong with `content` relative to the facts, as short sentences. */
export function releaseNoteProblems(
  content: ReleaseNoteContent,
  facts: ReleaseNoteFacts,
): string[] {
  const problems: string[] = [];
  if (content.issueKey !== facts.issueKey)
    problems.push(`it is for ${content.issueKey}, but was prepared for ${facts.issueKey}`);
  if (content.language !== facts.language)
    problems.push(`it is written in "${content.language}", expected "${facts.language}"`);

  const known = new Set(
    facts.files.flatMap((f) => [f.path, ...(f.previousPath ? [f.previousPath] : [])]),
  );
  const unknown = new Set<string>();
  let unsupported = 0;
  for (const block of blocks(content)) {
    if (block.type === 'screenshot') continue;
    if (block.source === 'code' && block.evidence.length === 0) unsupported += 1;
    for (const path of block.evidence) if (!known.has(path)) unknown.add(path);
  }
  if (unsupported > 0) {
    problems.push(
      `${String(unsupported)} block(s) have source "code" but no evidence paths; cite the changed files, or use another source`,
    );
  }
  if (unknown.size > 0) {
    const list = [...unknown].sort();
    problems.push(
      `its evidence names files that are not in this change set: ${list.slice(0, 10).join(', ')}${list.length > 10 ? ', …' : ''}`,
    );
  }

  const texts = renderedTexts(content);
  // Release notes are for users: file paths belong in evidence, never in the text.
  const paths = [...known].filter((p) => p.length >= 5 && /[/.]/.test(p));
  const leaked = new Set<string>();
  for (const text of texts) for (const path of paths) if (text.includes(path)) leaked.add(path);
  if (leaked.size > 0) {
    problems.push(
      `its text names file paths (${[...leaked].slice(0, 5).join(', ')}); describe the function instead and keep paths in evidence`,
    );
  }
  if (texts.some((t) => t.includes('[REDACTED]')))
    problems.push('it contains a [REDACTED] value; leave secrets out entirely');
  const claims = new Set(texts.flatMap(unsupportedClaims));
  problems.push(...claims);
  problems.push(...languageProblems(content, facts.language));
  return problems;
}

/** Validates `content` and returns the finished release note. Throws listing the problems. */
export function finalizeReleaseNote(
  content: ReleaseNoteContent,
  facts: ReleaseNoteFacts,
): ReleaseNote {
  const problems = releaseNoteProblems(content, facts);
  if (problems.length > 0) {
    const shown = problems.slice(0, 8).join('; ');
    const more = problems.length > 8 ? ` (and ${String(problems.length - 8)} more)` : '';
    throw new ReleaseNoteValidationError(`${shown}${more}.`);
  }
  return ReleaseNoteSchema.parse({ ...content, noteId: facts.noteId });
}

/** Statements the preview should ask the user to check: inferred or user-given facts. */
export function factsToVerify(note: ReleaseNoteContent): string[] {
  const lines: string[] = [];
  if (note.goal.source === 'inferred')
    lines.push(RELEASE_NOTE_LABELS[note.language].goal + `: ${note.goal.statement}`);
  for (const section of note.sections) {
    for (const block of section.blocks) {
      if (block.type === 'screenshot' || block.source !== 'inferred') continue;
      lines.push(`${section.title}: ${summary(block)}`);
    }
  }
  return lines.slice(0, 50);
}

function* blocks(content: ReleaseNoteContent): Generator<ReleaseNoteBlock> {
  for (const section of content.sections) yield* section.blocks;
}

/** Every string that ends up in Jira. */
function renderedTexts(content: ReleaseNoteContent): string[] {
  const texts = [
    content.goal.statement,
    ...content.goal.objectives.flatMap((o) => [o.title, ...(o.description ? [o.description] : [])]),
  ];
  for (const section of content.sections) {
    texts.push(section.title);
    for (const block of section.blocks) texts.push(...blockTexts(block));
  }
  return texts;
}

function blockTexts(block: ReleaseNoteBlock): string[] {
  switch (block.type) {
    case 'paragraph':
    case 'note':
      return [block.text];
    case 'steps':
    case 'bullets':
      return block.items;
    case 'definitions':
      return block.items.flatMap((i) => [i.term, i.description]);
    case 'table':
      return [...block.columns, ...block.rows.flat()];
    case 'uiMessage':
      return [block.text, block.meaning];
    case 'screenshot':
      return [block.description];
  }
}

/**
 * Prose must be in the release note's language. UI labels, table cells, and terms may be
 * quoted in Latin script (button captions, file formats), so only prose is checked.
 */
function languageProblems(content: ReleaseNoteContent, language: Language): string[] {
  const prose = [content.goal.statement];
  for (const section of content.sections) {
    for (const block of section.blocks) {
      if (block.type === 'paragraph' || block.type === 'note') prose.push(block.text);
      if (block.type === 'uiMessage') prose.push(block.meaning);
      if (block.type === 'definitions') prose.push(...block.items.map((i) => i.description));
    }
  }
  const cyrillic = (t: string) => (t.match(/[Ѐ-ӿ]/g) ?? []).length;
  const letters = (t: string) => (t.match(/\p{L}/gu) ?? []).length;
  if (language === 'uk') {
    return prose.some((t) => letters(t) >= 12 && cyrillic(t) === 0)
      ? ['parts of it are not written in Ukrainian']
      : [];
  }
  return prose.some((t) => cyrillic(t) > letters(t) * 0.2)
    ? ['parts of it are not written in English']
    : [];
}

function summary(block: Exclude<ReleaseNoteBlock, { type: 'screenshot' }>): string {
  const text = blockTexts(block).join(' · ');
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}
