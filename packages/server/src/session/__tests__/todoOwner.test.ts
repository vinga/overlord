import { describe, it, expect } from 'vitest';
import { validatePinInput, upsertPin, setPinOwner, setPinDone, sanitizePins } from '../pins.js';

// TODO pins carry an owner: the user's by default, the agent's only when asked.
describe('TODO owner', () => {
  const todo = (text: string, owner?: unknown) => {
    const v = validatePinInput({ url: '', kind: 'todo', text, owner });
    if ('error' in v) throw new Error(v.error);
    return v;
  };

  it('defaults to the user', () => {
    expect(todo('a').owner).toBe('user');
    const r = upsertPin(undefined, todo('a'), 1);
    if ('error' in r) throw new Error(r.error);
    expect(r.pin.owner).toBeUndefined();
  });

  it('stores agent ownership', () => {
    const r = upsertPin(undefined, todo('a', 'agent'), 1);
    if ('error' in r) throw new Error(r.error);
    expect(r.pin.owner).toBe('agent');
  });

  it('rejects an unknown owner', () => {
    expect(validatePinInput({ url: '', kind: 'todo', text: 'a', owner: 'bob' })).toEqual({ error: 'owner must be user or agent' });
  });

  it('reassigns and keeps the check state', () => {
    const r = upsertPin(undefined, todo('a'), 1);
    if ('error' in r) throw new Error(r.error);
    const d = setPinDone(r.pins, r.pin.id, true, 'user', 2)!;
    const toAgent = setPinOwner(d.pins, r.pin.id, 'agent')!;
    expect(toAgent.pin).toMatchObject({ owner: 'agent', done: true });
    const back = setPinOwner(toAgent.pins, r.pin.id, 'user')!;
    expect(back.pin.owner).toBeUndefined();
    expect(back.pin.done).toBe(true);
  });

  it('only reassigns TODO pins', () => {
    const link = upsertPin(undefined, { url: 'https://x.dev', title: 'x', kind: 'link' }, 1);
    if ('error' in link) throw new Error(link.error);
    expect(setPinOwner(link.pins, link.pin.id, 'agent')).toBeUndefined();
  });

  it('sanitize drops an invalid owner, keeps agent', () => {
    const base = { url: '', title: 't', kind: 'todo', text: 't', createdAt: 1 };
    const out = sanitizePins([{ ...base, id: 'a', owner: 'agent' }, { ...base, id: 'b', owner: 'bob' }])!;
    expect(out[0].owner).toBe('agent');
    expect('owner' in out[1]).toBe(false);
  });
});
