import { describe, it, expect } from 'vitest';
import { classifyPinUrl, validatePinInput, upsertPin, removePin, sanitizePins, MAX_PINS } from '../session/pins.js';
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
