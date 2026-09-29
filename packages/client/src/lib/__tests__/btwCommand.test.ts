import { describe, it, expect } from 'vitest';
import { parseBtwCommand, isBtwDraft } from '../btwCommand';

describe('parseBtwCommand', () => {
  it('extracts the question after /btw', () => {
    expect(parseBtwCommand('/btw what is a monad')).toBe('what is a monad');
    expect(parseBtwCommand('  /BTW  trims  ')).toBe('trims');
  });
  it('returns null for plain searches and bare /btw', () => {
    expect(parseBtwCommand('BACKEND-123')).toBeNull();
    expect(parseBtwCommand('/btw')).toBeNull();
    expect(parseBtwCommand('/btw   ')).toBeNull();
    expect(parseBtwCommand('/btwx foo')).toBeNull();
  });
});

describe('isBtwDraft', () => {
  it('flags a command in progress so the grid stays unfiltered', () => {
    expect(isBtwDraft('/btw')).toBe(true);
    expect(isBtwDraft('/btw hel')).toBe(true);
    expect(isBtwDraft('/btwx')).toBe(false);
    expect(isBtwDraft('search me')).toBe(false);
  });
  it('treats a partial prefix as a draft so typing /btw never filters', () => {
    expect(isBtwDraft('/')).toBe(true);
    expect(isBtwDraft('/b')).toBe(true);
    expect(isBtwDraft('/bt')).toBe(true);
    expect(isBtwDraft('/BT')).toBe(true);
    expect(isBtwDraft('/x')).toBe(false);
    expect(isBtwDraft('b')).toBe(false);
    expect(isBtwDraft('')).toBe(false);
  });
});
