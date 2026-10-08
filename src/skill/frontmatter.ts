/**
 * Reads the YAML frontmatter of a Skill or subagent Markdown file. Only the subset the
 * packaged files use is supported (scalars, quoted scalars, block lists); it exists to
 * verify an installed package, not to be a YAML parser.
 */
export type FrontmatterValue = string | boolean | string[];

export interface ParsedMarkdown {
  frontmatter: Record<string, FrontmatterValue>;
  body: string;
}

export class FrontmatterError extends Error {}

export function parseFrontmatter(markdown: string): ParsedMarkdown {
  const text = markdown.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) throw new FrontmatterError('missing frontmatter');
  const end = text.indexOf('\n---\n', 3);
  if (end < 0) throw new FrontmatterError('unterminated frontmatter');
  const lines = text.slice(4, end).split('\n');
  const body = text.slice(end + 5);

  const frontmatter: Record<string, FrontmatterValue> = {};
  let listKey: string | undefined;
  for (const line of lines) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item) {
      const list = listKey === undefined ? undefined : frontmatter[listKey];
      if (!Array.isArray(list)) throw new FrontmatterError(`list item outside a list: ${line}`);
      list.push(unquote(item[1] ?? ''));
      continue;
    }
    const entry = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s+(.*))?$/.exec(line);
    if (!entry) throw new FrontmatterError(`unsupported line: ${line}`);
    const key = entry[1] ?? '';
    if (key in frontmatter) throw new FrontmatterError(`duplicate key: ${key}`);
    const raw = (entry[2] ?? '').trim();
    if (raw === '') {
      frontmatter[key] = [];
      listKey = key;
      continue;
    }
    listKey = undefined;
    frontmatter[key] = raw === 'true' ? true : raw === 'false' ? false : unquote(raw);
  }
  return { frontmatter, body };
}

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return JSON.parse(value) as string;
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

export function stringList(value: FrontmatterValue | undefined): string[] {
  if (value === undefined || typeof value === 'boolean') return [];
  if (Array.isArray(value)) return value;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}
