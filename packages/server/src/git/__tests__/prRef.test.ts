import { describe, it, expect } from 'vitest';
import { parsePrUrl, splitPrRef, prRefKey, prRefUrl, prRefLabel } from '../prRef.js';

describe('parsePrUrl', () => {
  it.each([
    ['https://github.com/hypatos/prompting-service/pull/819', 'hypatos/prompting-service#819'],
    ['https://github.com/o/r/pull/1', 'o/r#1'],
    ['http://github.com/o/r/pull/12', 'o/r#12'],
    ['https://github.com/o/r/pull/12/files', 'o/r#12'],
    ['https://github.com/o/r/pull/12/commits/abc123', 'o/r#12'],
    ['https://github.com/o/r/pull/12#discussion_r1234567', 'o/r#12'],
    ['https://github.com/o/r/pull/12?w=1', 'o/r#12'],
    ['https://github.com/o/r/pull/12/', 'o/r#12'],
    // GitHub Enterprise — private host, same path shape.
    ['https://github.acme-corp.internal/team/svc/pull/44', 'team/svc#44'],
    // Names with dots, dashes, underscores.
    ['https://github.com/my-org/some.repo_v2/pull/7', 'my-org/some.repo_v2#7'],
  ])('parses %s', (url, expected) => {
    expect(parsePrUrl(url)).toBe(expected);
  });

  it('strips trailing prose punctuation', () => {
    expect(parsePrUrl('https://github.com/o/r/pull/12.')).toBe('o/r#12');
    expect(parsePrUrl('(https://github.com/o/r/pull/12)')).toBe(null); // leading paren isn't stripped
    expect(parsePrUrl('https://github.com/o/r/pull/12),')).toBe('o/r#12');
  });

  it.each([
    ['https://github.com/o/r/pulls', 'PR list page'],
    ['https://github.com/o/r/pull/', 'no number'],
    ['https://github.com/o/r/pull/abc', 'non-numeric'],
    ['https://github.com/o/r/pull/0', 'zero'],
    ['https://github.com/o/r/tree/BACKEND-2278-fix', 'branch URL'],
    ['https://github.com/o/r/issues/12', 'issue, not PR'],
    ['https://github.com/o/pull/12', 'missing repo segment'],
    ['ftp://github.com/o/r/pull/12', 'non-http scheme'],
    ['github.com/o/r/pull/12', 'no scheme'],
    ['', 'empty'],
  ])('rejects %s (%s)', (url) => {
    expect(parsePrUrl(url)).toBe(null);
  });

  it('anchors at the start — a PR URL embedded mid-string is not matched', () => {
    expect(parsePrUrl('see https://github.com/o/r/pull/12')).toBe(null);
  });
});

describe('splitPrRef', () => {
  it('splits a canonical ref', () => {
    expect(splitPrRef('hypatos/prompting-service#819')).toEqual({
      owner: 'hypatos',
      repo: 'prompting-service',
      number: 819,
    });
  });

  it.each([
    ['o/r#0'],
    ['o/r#'],
    ['o/r'],
    ['#12'],
    ['o/r#12/extra'],
    ['o r#12'],
    ['../../etc/passwd#1'],
    ['o/r#12; rm -rf /'],
    [''],
  ])('rejects %s', (ref) => {
    expect(splitPrRef(ref)).toBe(null);
  });
});

describe('helpers', () => {
  it('prRefKey lowercases for case-insensitive dedupe', () => {
    expect(prRefKey('Hypatos/Prompting-Service#819')).toBe('hypatos/prompting-service#819');
  });

  it('prRefUrl falls back to github.com', () => {
    expect(prRefUrl('o/r#12')).toBe('https://github.com/o/r/pull/12');
    expect(prRefUrl('garbage')).toBe('');
  });

  it('prRefLabel is the short number form', () => {
    expect(prRefLabel('o/r#12')).toBe('#12');
    expect(prRefLabel('garbage')).toBe('garbage');
  });

  it('round-trips a parsed URL through splitPrRef', () => {
    const ref = parsePrUrl('https://github.com/o/r/pull/12/files');
    expect(ref).not.toBe(null);
    expect(splitPrRef(ref!)).toEqual({ owner: 'o', repo: 'r', number: 12 });
  });
});
