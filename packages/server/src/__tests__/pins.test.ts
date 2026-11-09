import { describe, it, expect } from 'vitest';
import { classifyPinUrl, validatePinInput, upsertPin, removePin, sanitizePins, jiraKeyOfPin, prRefOfPin, pinnedJiraKeys, pinnedPrRefs, withoutPinsFor, frontPin, MAX_PINS } from '../session/pins.js';
import type { Pin } from '../types.js';

describe('classifyPinUrl', () => {
  it('Jira browse → ticket', () => {
    expect(classifyPinUrl('https://hypatos.atlassian.net/browse/BACKEND-1234')).toEqual({ kind: 'ticket', title: 'BACKEND-1234' });
  });
  it('Jira board selectedIssue → ticket', () => {
    expect(classifyPinUrl('https://x.atlassian.net/jira/software/projects/B/boards/1?selectedIssue=B-7')).toEqual({ kind: 'ticket', title: 'B-7' });
  });
  it('GitHub PR → pr', () => {
    expect(classifyPinUrl('https://github.com/hypatos/knowledge-service/pull/30/files')).toEqual({ kind: 'pr', title: 'knowledge-service#30' });
  });
  it('GitHub tree → branch, keeps slashes', () => {
    expect(classifyPinUrl('https://github.com/o/r/tree/feat/BACKEND-1-x')).toEqual({ kind: 'branch', title: 'feat/BACKEND-1-x' });
  });
  it('GitHub issue → ticket', () => {
    expect(classifyPinUrl('https://github.com/o/r/issues/5')).toEqual({ kind: 'ticket', title: 'r#5' });
  });
  it('anything else → link with host + tail', () => {
    expect(classifyPinUrl('https://www.example.com/a/b/c')).toEqual({ kind: 'link', title: 'example.com/b/c' });
    expect(classifyPinUrl('https://example.com')).toEqual({ kind: 'link', title: 'example.com' });
  });
});

describe('validatePinInput', () => {
  it('rejects missing, non-http and junk urls', () => {
    expect(validatePinInput({ url: '' })).toHaveProperty('error');
    expect(validatePinInput({ url: 'javascript:alert(1)' })).toHaveProperty('error');
    expect(validatePinInput({ url: 'not a url' })).toHaveProperty('error');
    expect(validatePinInput({ url: `https://a.b/${'x'.repeat(2100)}` })).toHaveProperty('error');
  });
  it('rejects a bad kind or title type', () => {
    expect(validatePinInput({ url: 'https://a.b', kind: 'nope' })).toHaveProperty('error');
    expect(validatePinInput({ url: 'https://a.b', title: 5 })).toHaveProperty('error');
  });
  it('explicit title and kind win over derived ones', () => {
    expect(validatePinInput({ url: 'https://github.com/o/r/pull/1', title: ' My PR ', kind: 'link' }))
      .toEqual({ url: 'https://github.com/o/r/pull/1', title: 'My PR', kind: 'link' });
  });
  it('derives title and kind when absent', () => {
    expect(validatePinInput({ url: 'https://github.com/o/r/pull/1' })).toEqual({ url: 'https://github.com/o/r/pull/1', title: 'r#1', kind: 'pr' });
  });
});

describe('upsertPin / removePin', () => {
  const base = { url: 'https://a.b/1', title: 'one', kind: 'link' as const };

  it('adds a new pin', () => {
    const r = upsertPin(undefined, base, 1000);
    if ('error' in r) throw new Error(r.error);
    expect(r.pins).toHaveLength(1);
    expect(r.pin).toMatchObject({ ...base, createdAt: 1000 });
    expect(r.pin.id).toMatch(/^pin-/);
  });

  it('same url updates in place, keeps id', () => {
    const a = upsertPin(undefined, base);
    if ('error' in a) throw new Error(a.error);
    const b = upsertPin(a.pins, { ...base, title: 'renamed', kind: 'pr' });
    if ('error' in b) throw new Error(b.error);
    expect(b.pins).toHaveLength(1);
    expect(b.pin.id).toBe(a.pin.id);
    expect(b.pin.title).toBe('renamed');
  });

  it(`caps at ${MAX_PINS}`, () => {
    let pins: Pin[] = [];
    for (let i = 0; i < MAX_PINS; i++) {
      const r = upsertPin(pins, { ...base, url: `https://a.b/${i}` });
      if ('error' in r) throw new Error(r.error);
      pins = r.pins;
    }
    expect(upsertPin(pins, { ...base, url: 'https://a.b/new' })).toHaveProperty('error');
    // update of an existing one still works at the cap
    expect(upsertPin(pins, { ...base, url: 'https://a.b/0', title: 'x' })).not.toHaveProperty('error');
  });

  it('remove returns undefined for an unknown id', () => {
    const r = upsertPin(undefined, base);
    if ('error' in r) throw new Error(r.error);
    expect(removePin(r.pins, 'pin-nope')).toBeUndefined();
    expect(removePin(r.pins, r.pin.id)).toEqual([]);
  });
});

describe('sanitizePins', () => {
  it('drops malformed entries, undefined when empty', () => {
    const good: Pin = { id: 'pin-1', url: 'https://a.b', title: 't', kind: 'pr', createdAt: 1 };
    expect(sanitizePins([good, { id: 'x' }, null, { ...good, kind: 'bad' }])).toEqual([good]);
    expect(sanitizePins('nope')).toBeUndefined();
    expect(sanitizePins([])).toBeUndefined();
  });
});

describe('jiraKeyOfPin', () => {
  const pin = (url: string, kind: Pin['kind'] = 'ticket'): Pin => ({ id: 'p', url, title: 't', kind, createdAt: 1 });
  it('reads the key from /browse and selectedIssue', () => {
    expect(jiraKeyOfPin(pin('https://x.atlassian.net/browse/BACKEND-12'))).toBe('BACKEND-12');
    expect(jiraKeyOfPin(pin('https://x.atlassian.net/jira/boards/1?selectedIssue=AB-3'))).toBe('AB-3');
  });
  it('ignores non-ticket pins and GitHub issues', () => {
    expect(jiraKeyOfPin(pin('https://x.atlassian.net/browse/BACKEND-12', 'link'))).toBeUndefined();
    expect(jiraKeyOfPin(pin('https://github.com/o/r/issues/5'))).toBeUndefined();
  });
});

describe('pins as the session\'s hand-picked tickets and PRs', () => {
  let n = 0;
  const mk = (url: string, kind: Pin['kind']): Pin => ({ id: `p${++n}`, url, title: 't', kind, createdAt: n });
  const t1 = mk('https://x.atlassian.net/browse/BACKEND-1', 'ticket');
  const t2 = mk('https://x.atlassian.net/browse/BACKEND-2', 'ticket');
  const pr = mk('https://github.com/Hypatos/Repo/pull/42', 'pr');
  const link = mk('https://example.com/a', 'link');

  it('prRefOfPin reads owner/repo#N from PR pins only', () => {
    expect(prRefOfPin(pr)).toBe('Hypatos/Repo#42');
    expect(prRefOfPin(link)).toBeUndefined();
    expect(prRefOfPin(mk('https://github.com/o/r/pull/7', 'link'))).toBeUndefined();
  });

  it('pinnedJiraKeys: ticket pins first, then legacy keys, deduped', () => {
    expect(pinnedJiraKeys({ pins: [link, t2, t1], jiraKeysPinned: ['BACKEND-1', 'BACKEND-9'] }))
      .toEqual(['BACKEND-2', 'BACKEND-1', 'BACKEND-9']);
    expect(pinnedJiraKeys({ pins: [link] })).toBeUndefined();
    expect(pinnedJiraKeys(undefined)).toBeUndefined();
  });

  it('pinnedPrRefs dedupes case-insensitively against legacy refs', () => {
    expect(pinnedPrRefs({ pins: [pr], prRefsPinned: ['hypatos/repo#42', 'o/r#1'] })).toEqual(['Hypatos/Repo#42', 'o/r#1']);
  });

  it('withoutPinsFor drops matching ticket / PR pins, undefined when none match', () => {
    expect(withoutPinsFor([t1, t2, link], { jiraKey: 'BACKEND-1' })).toEqual([t2, link]);
    expect(withoutPinsFor([pr, link], { prRef: 'hypatos/repo#42' })).toEqual([link]);
    expect(withoutPinsFor([t1, link], { jiraKey: 'BACKEND-7' })).toBeUndefined();
  });

  it('frontPin moves an existing pin to the front or adds a new one there', () => {
    expect(frontPin([t1, t2], { url: t2.url, title: 'x', kind: 'ticket' }).map(p => p.id)).toEqual([t2.id, t1.id]);
    const added = frontPin([t1], { url: 'https://x.atlassian.net/browse/BACKEND-3', title: 'BACKEND-3', kind: 'ticket' }, 5);
    expect(added).toHaveLength(2);
    expect(added[0]).toMatchObject({ url: 'https://x.atlassian.net/browse/BACKEND-3', kind: 'ticket', createdAt: 5 });
  });
});

describe('text pins', () => {
  it('validate: text becomes the pin, first line the title, url empty', () => {
    expect(validatePinInput({ url: undefined, kind: 'text', text: '  \n First line \nsecond  ' }))
      .toEqual({ url: '', title: 'First line', kind: 'text', text: 'First line \nsecond' });
  });

  it('validate: rejects empty, too long and NUL text', () => {
    expect(validatePinInput({ url: undefined, kind: 'text', text: '   ' })).toEqual({ error: 'text required' });
    expect(validatePinInput({ url: undefined, kind: 'text', text: 'x'.repeat(2001) })).toHaveProperty('error');
    expect(validatePinInput({ url: undefined, kind: 'text', text: 'a\0b' })).toHaveProperty('error');
  });

  it('upsert: the same text is one pin; text pins never match link pins', () => {
    const link = upsertPin(undefined, { url: 'https://x.dev', title: 'x', kind: 'link' });
    if ('error' in link) throw new Error(link.error);
    const a = upsertPin(link.pins, { url: '', title: 'note', kind: 'text', text: 'note' });
    if ('error' in a) throw new Error(a.error);
    expect(a.pins).toHaveLength(2);
    expect(a.pin.text).toBe('note');
    const b = upsertPin(a.pins, { url: '', title: 'note', kind: 'text', text: 'note' });
    if ('error' in b) throw new Error(b.error);
    expect(b.pins).toHaveLength(2);
    const c = upsertPin(b.pins, { url: '', title: 'other', kind: 'text', text: 'other' });
    if ('error' in c) throw new Error(c.error);
    expect(c.pins).toHaveLength(3);
  });

  it('sanitize: keeps text pins with text, drops ones without', () => {
    const ok: Pin = { id: 'p1', url: '', title: 't', kind: 'text', text: 't', createdAt: 1 };
    const bad = { id: 'p2', url: '', title: 't', kind: 'text', createdAt: 1 };
    expect(sanitizePins([ok, bad])).toEqual([ok]);
  });
});
