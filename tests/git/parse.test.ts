import { describe, expect, it } from 'vitest';
import { parseNumstat, parseRaw } from '../../src/snapshots/diff';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const Z = '0'.repeat(40);

describe('diff-tree -z parsers', () => {
  it('parses raw entries including renames and names with spaces, tabs, and newlines', () => {
    const raw =
      `:000000 100644 ${Z} ${A} A\0new file.txt\0` +
      `:100644 100755 ${A} ${A} M\0tab\there\0` +
      `:100644 100644 ${A} ${B} R087\0old\nname\0new name\0` +
      `:120000 000000 ${A} ${Z} D\0link\0`;
    expect(parseRaw(raw)).toEqual([
      { status: 'added', path: 'new file.txt', oldMode: '000000', newMode: '100644' },
      { status: 'modified', path: 'tab\there', oldMode: '100644', newMode: '100755' },
      {
        status: 'renamed',
        similarity: 87,
        path: 'new name',
        previousPath: 'old\nname',
        oldMode: '100644',
        newMode: '100644',
      },
      { status: 'deleted', path: 'link', oldMode: '120000', newMode: '000000' },
    ]);
  });

  it('parses numstat entries, binary markers, and renames', () => {
    const numstat = '3\t1\tnew file.txt\0-\t-\timage.png\0' + '2\t2\t\0old\nname\0new name\0';
    const stats = parseNumstat(numstat);
    expect(stats.get('new file.txt')).toEqual({ additions: 3, deletions: 1, binary: false });
    expect(stats.get('image.png')).toEqual({ additions: 0, deletions: 0, binary: true });
    expect(stats.get('new name')).toEqual({ additions: 2, deletions: 2, binary: false });
  });
});
