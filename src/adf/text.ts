const BLOCK_NODES = new Set([
  'paragraph',
  'heading',
  'listItem',
  'blockquote',
  'codeBlock',
  'rule',
  'panel',
  'tableRow',
  'mediaSingle',
]);

/**
 * Plain-text projection of any ADF value (issue descriptions, comments).
 * Accepts untrusted input of any shape; unknown nodes contribute their text
 * children. Bounded in depth and length.
 */
export function adfToPlainText(value: unknown, maxLength = 100_000): string {
  const parts: string[] = [];
  let length = 0;
  const visit = (node: unknown, depth: number): void => {
    if (length >= maxLength || depth > 50 || typeof node !== 'object' || node === null) return;
    const { type, text, content } = node as { type?: unknown; text?: unknown; content?: unknown };
    if (type === 'text' && typeof text === 'string') {
      parts.push(text);
      length += text.length;
    } else if (type === 'hardBreak') {
      parts.push('\n');
    }
    if (Array.isArray(content)) for (const child of content) visit(child, depth + 1);
    if (typeof type === 'string' && BLOCK_NODES.has(type)) parts.push('\n');
  };
  visit(value, 0);
  const text = parts
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}
