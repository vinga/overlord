import { describe, it, expect } from 'vitest';
import { validatePinInput, upsertPin, setPinDone, sanitizePins, MAX_PINS, MAX_TODOS } from '../session/pins.js';
import type { Pin } from '../types.js';

const todo = (text: string) => {
  const v = validatePinInput({ url: '', kind: 'todo', text });
  if ('error' in v) throw new Error(v.error);
  return v;
};

describe('TODO pins', () => {
  it('validates text, flattens newlines, caps length', () => {
    expect(todo('  Write  docs\n now ')).toEqual({ url: '', title: 'Write  docs now', kind: 'todo', text: 'Write  docs now', owner: 'user' });
    expect(validatePinInput({ url: '', kind: 'todo', text: ' ' })).toHaveProperty('error');
    expect(validatePinInput({ url: '', kind: 'todo', text: 'x'.repeat(301) })).toHaveProperty('error');
  });

  it('keeps several TODOs apart (all have url ""), dedupes by text', () => {
    let pins: Pin[] = [];
    for (const t of ['a', 'b', 'a']) {
      const r = upsertPin(pins, todo(t));
      if ('error' in r) throw new Error(r.error);
      pins = r.pins;
    }
    expect(pins.map(p => p.text)).toEqual(['a', 'b']);
  });

  it('has its own cap, apart from link pins', () => {
    let pins: Pin[] = [];
    for (let i = 0; i < MAX_PINS; i++) {
      const r = upsertPin(pins, { url: `https://a.b/${i}`, title: `${i}`, kind: 'link' });
      if ('error' in r) throw new Error(r.error);
      pins = r.pins;
    }
    for (let i = 0; i < MAX_TODOS; i++) {
      const r = upsertPin(pins, todo(`t${i}`));
      if ('error' in r) throw new Error(r.error);
      pins = r.pins;
    }
    expect(upsertPin(pins, todo('one more'))).toHaveProperty('error');
  });

  it('checks off with who and when; unchecking clears both', () => {
    const r = upsertPin(undefined, todo('ship it'));
    if ('error' in r) throw new Error(r.error);
    const done = setPinDone(r.pins, r.pin.id, true, 'agent', 5000)!;
    expect(done.pin).toMatchObject({ done: true, doneAt: 5000, doneBy: 'agent' });
    const undone = setPinDone(done.pins, r.pin.id, false)!;
    expect(undone.pin.done).toBeUndefined();
    expect(undone.pin.doneBy).toBeUndefined();
  });

  it('only TODO pins can be checked', () => {
    const r = upsertPin(undefined, { url: 'https://a.b', title: 'a', kind: 'link' });
    if ('error' in r) throw new Error(r.error);
    expect(setPinDone(r.pins, r.pin.id, true)).toBeUndefined();
    expect(setPinDone(r.pins, 'missing', true)).toBeUndefined();
  });

  it('survives the load-time sanitizer only with its text', () => {
    const ok: Pin = { id: 'p1', url: '', title: 'x', kind: 'todo', text: 'x', done: true, createdAt: 1 };
    const bad = { id: 'p2', url: '', title: 'y', kind: 'todo', createdAt: 1 };
    expect(sanitizePins([ok, bad])).toEqual([ok]);
  });
});
