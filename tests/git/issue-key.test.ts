import { describe, expect, it } from 'vitest';
import { InvalidIssueKeyError } from '../../src/git/errors';
import { BranchIssueKeyDetector, parseIssueKey } from '../../src/git/issue-key';

const detector = new BranchIssueKeyDetector();

describe('BranchIssueKeyDetector', () => {
  it.each([
    ['LSND-1234', 'LSND-1234'],
    ['feature/LSND-1234', 'LSND-1234'],
    ['feature/LSND-1234-profile', 'LSND-1234'],
    ['bugfix/LSND-5678-navigation', 'LSND-5678'],
    ['hotfix/PROJ-999', 'PROJ-999'],
    ['feature/AB2-7_fix', 'AB2-7'],
    ['MY_PROJ-12-thing', 'MY_PROJ-12'],
    ['users/dev/LSND-1/LSND-1-again', 'LSND-1'],
  ])('%s → %s', (branch, key) => {
    expect(detector.detect(branch)).toEqual({ status: 'found', issueKey: key });
  });

  it.each([
    'main',
    'feature/user-profile',
    'feature/lsnd-1234-profile', // lowercase: never guessed
    'release/2.0.1',
    'feature/xLSND-12', // glued to a preceding letter
    'feature/LSND-0', // issue numbers start at 1
    'feature/LSND-',
    'feature/-123',
  ])('%s → not found', (branch) => {
    expect(detector.detect(branch)).toEqual({ status: 'not-found' });
  });

  it('rejects branches that mention several different issues', () => {
    expect(detector.detect('feature/LSND-1-and-PROJ-2')).toEqual({
      status: 'ambiguous',
      candidates: ['LSND-1', 'PROJ-2'],
    });
  });

  it('restricts detection to configured projects, which can resolve ambiguity', () => {
    expect(detector.detect('feature/LSND-1-and-PROJ-2', { projectKeys: ['PROJ'] })).toEqual({
      status: 'found',
      issueKey: 'PROJ-2',
    });
    expect(detector.detect('feature/OTHER-1', { projectKeys: ['PROJ'] })).toEqual({
      status: 'not-found',
    });
  });
});

describe('parseIssueKey (--issue)', () => {
  it('accepts valid keys', () => {
    expect(parseIssueKey(' LSND-1234 ')).toBe('LSND-1234');
  });

  it.each(['lsnd-1234', 'LSND', 'LSND-', '1234', 'LSND-12a', 'LSND-0', '--upload-pack=x'])(
    'rejects %j without correcting it',
    (value) => {
      expect(() => parseIssueKey(value)).toThrow(InvalidIssueKeyError);
    },
  );
});
