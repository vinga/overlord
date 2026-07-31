import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionStore } from '../session/sessionStore.js';
import type { OverlordSession } from '../types.js';

function baseRecord(ovrId: string, currentSid = `${ovrId}-sid`): OverlordSession {
  return {
    overlordId: ovrId,
    cwd: '/tmp/test',
    startedAt: 1000,
    color: '#abcdef',
    sessionType: 'plain',
    lineage: {
      currentSessionId: currentSid,
      history: [{ sessionId: currentSid, attachedAt: 1000 }],
    },
  };
}

describe('SessionStore', () => {
  let baseDir: string;
  let store: SessionStore;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionStore-'));
    store = new SessionStore({ baseDir, debounceMs: 20 });
  });

  afterEach(async () => {
    await store.flushAll();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('upsertActive writes to overlord-sessions/ and loadAll recovers it', () => {
    store.upsertActive(baseRecord('ovr-a'));
    const filePath = path.join(baseDir, 'overlord-sessions', 'ovr-a.json');
    expect(fs.existsSync(filePath)).toBe(true);

    const fresh = new SessionStore({ baseDir });
    fresh.loadAll();
    expect(fresh.listActive()).toHaveLength(1);
    expect(fresh.getByOverlordId('ovr-a')?.overlordId).toBe('ovr-a');
  });

  it('sessionId secondary index resolves to overlord record', () => {
    store.upsertActive(baseRecord('ovr-b', 'sid-b1'));
    expect(store.getBySessionId('sid-b1')?.overlordId).toBe('ovr-b');
    expect(store.resolveOverlordId('sid-b1')).toBe('ovr-b');
  });

  it('icon persists through patch and survives reload; explicit undefined clears it', async () => {
    store.upsertActive(baseRecord('ovr-icon', 'sid-icon'));
    store.patch('ovr-icon', { icon: 'investigate' });
    expect(store.getByOverlordId('ovr-icon')?.icon).toBe('investigate');

    await store.flushAll();
    const fresh = new SessionStore({ baseDir });
    fresh.loadAll();
    expect(fresh.getByOverlordId('ovr-icon')?.icon).toBe('investigate');

    // Reset to default: setSessionIcon('user') patches icon: undefined.
    store.patch('ovr-icon', { icon: undefined });
    expect(store.getByOverlordId('ovr-icon')?.icon).toBeUndefined();
    await store.flushAll();
    const fresh2 = new SessionStore({ baseDir });
    fresh2.loadAll();
    expect(fresh2.getByOverlordId('ovr-icon')?.icon).toBeUndefined();
  });

  it('attachSession appends to lineage and swaps currentSessionId', () => {
    store.upsertActive(baseRecord('ovr-c', 'sid-c1'));
    const updated = store.attachSession('ovr-c', { sessionId: 'sid-c2', attachedAt: 2000, reason: 'clear' });
    expect(updated?.lineage.currentSessionId).toBe('sid-c2');
    expect(updated?.lineage.history).toHaveLength(2);
    // Both sessionIds resolve via index.
    expect(store.getBySessionId('sid-c1')?.overlordId).toBe('ovr-c');
    expect(store.getBySessionId('sid-c2')?.overlordId).toBe('ovr-c');
  });

  it('patch merges fields in memory immediately', () => {
    store.upsertActive(baseRecord('ovr-p'));
    const updated = store.patch('ovr-p', { intent: 'refactoring', notes: 'hi' });
    expect(updated?.intent).toBe('refactoring');
    expect(store.getByOverlordId('ovr-p')?.notes).toBe('hi');
  });

  it('concurrent patches in the same tick all land in the final file', async () => {
    store.upsertActive(baseRecord('ovr-conc'));
    store.patch('ovr-conc', { intent: 'a' });
    store.patch('ovr-conc', { notes: 'b' });
    store.patch('ovr-conc', { lastMessage: 'c' });

    await store.flushAll();

    const onDisk = JSON.parse(fs.readFileSync(path.join(baseDir, 'overlord-sessions', 'ovr-conc.json'), 'utf-8')) as OverlordSession;
    expect(onDisk.intent).toBe('a');
    expect(onDisk.notes).toBe('b');
    expect(onDisk.lastMessage).toBe('c');
  });

  it('archive moves file from overlord-sessions to overlord-sessions-archive', async () => {
    store.upsertActive(baseRecord('ovr-arch', 'sid-arch'));
    const activePath = path.join(baseDir, 'overlord-sessions', 'ovr-arch.json');
    const archivedPath = path.join(baseDir, 'overlord-sessions-archive', 'ovr-arch.json');
    expect(fs.existsSync(activePath)).toBe(true);

    store.archive('ovr-arch', {
      roomId: 'tmp-test',
      name: 'Archived worker',
      transcripts: [{ sessionId: 'sid-arch', path: '/tmp/archive/sid-arch.jsonl' }],
    });

    expect(fs.existsSync(activePath)).toBe(false);
    expect(fs.existsSync(archivedPath)).toBe(true);
    expect(store.listActive()).toHaveLength(0);
    expect(store.listArchived()).toHaveLength(1);
    expect(store.getByOverlordId('ovr-arch')?.archive?.roomId).toBe('tmp-test');
  });

  it('getArchivedBySessionId finds the archive entry even when a live dupe claims the sid', () => {
    // Archive a record, then mint a fresh ACTIVE record reusing the same sid
    // (what a failed resume-from-archive does). Active-wins index shadows the
    // archived mapping — the dedicated archived-tier lookup must still hit.
    store.upsertActive(baseRecord('ovr-old', 'sid-shared'));
    store.archive('ovr-old', { roomId: 'r', name: 'n', transcripts: [{ sessionId: 'sid-shared', path: '/x' }] });
    store.upsertActive(baseRecord('ovr-dupe', 'sid-shared'));

    expect(store.getBySessionId('sid-shared')?.overlordId).toBe('ovr-dupe');
    expect(store.getArchivedBySessionId('sid-shared')?.overlordId).toBe('ovr-old');

    // Survives reload (active dir loads first, archived sids get skipped in the index).
    const fresh = new SessionStore({ baseDir });
    fresh.loadAll();
    expect(fresh.getArchivedBySessionId('sid-shared')?.overlordId).toBe('ovr-old');
  });

  it('unarchive moves file back and clears archive block', () => {
    store.upsertActive(baseRecord('ovr-un', 'sid-un'));
    store.archive('ovr-un', { roomId: 'r', name: 'n', transcripts: [{ sessionId: 'sid-un', path: '/x' }] });
    expect(fs.existsSync(path.join(baseDir, 'overlord-sessions-archive', 'ovr-un.json'))).toBe(true);

    const restored = store.unarchive('ovr-un');
    expect(restored?.archive).toBeUndefined();
    expect(fs.existsSync(path.join(baseDir, 'overlord-sessions', 'ovr-un.json'))).toBe(true);
    expect(fs.existsSync(path.join(baseDir, 'overlord-sessions-archive', 'ovr-un.json'))).toBe(false);
  });

  it('remove deletes the file and clears cache + index', () => {
    store.upsertActive(baseRecord('ovr-r', 'sid-r'));
    store.remove('ovr-r');
    expect(fs.existsSync(path.join(baseDir, 'overlord-sessions', 'ovr-r.json'))).toBe(false);
    expect(store.getByOverlordId('ovr-r')).toBeUndefined();
    expect(store.getBySessionId('sid-r')).toBeUndefined();
  });

  it('removeBySessionId resolves to overlordId and removes', () => {
    store.upsertActive(baseRecord('ovr-rbs', 'sid-rbs'));
    store.removeBySessionId('sid-rbs');
    expect(store.getByOverlordId('ovr-rbs')).toBeUndefined();
  });

  // Two records claiming the same sid: the index only resolves one, so the
  // other used to survive a delete and rehydrate on the next boot.
  it('removeActiveBySessionIds removes every duplicate record for the sid', () => {
    store.upsertActive(baseRecord('ovr-dup1', 'sid-dup'));
    store.upsertActive(baseRecord('ovr-dup2', 'sid-dup'));

    const removed = store.removeActiveBySessionIds(['sid-dup']);

    expect(removed.sort()).toEqual(['ovr-dup1', 'ovr-dup2']);
    expect(store.listActive()).toHaveLength(0);
    expect(fs.existsSync(path.join(baseDir, 'overlord-sessions', 'ovr-dup1.json'))).toBe(false);
    expect(fs.existsSync(path.join(baseDir, 'overlord-sessions', 'ovr-dup2.json'))).toBe(false);
  });

  it('removeActiveBySessionIds leaves archived records alone', () => {
    store.upsertActive(baseRecord('ovr-arch', 'sid-shared'));
    store.archive('ovr-arch', { roomId: '/tmp/test', name: 'archived', transcripts: [] });
    store.upsertActive(baseRecord('ovr-live', 'sid-shared'));

    const removed = store.removeActiveBySessionIds(['sid-shared']);

    expect(removed).toEqual(['ovr-live']);
    expect(store.getByOverlordId('ovr-arch')).toBeDefined();
    expect(store.listArchived()).toHaveLength(1);
  });

  it('patch on missing overlordId is a no-op returning undefined', () => {
    const result = store.patch('ghost', { intent: 'x' });
    expect(result).toBeUndefined();
  });

  it('upsertActive rejects invalid overlordId', () => {
    expect(() => store.upsertActive({ ...baseRecord('ok'), overlordId: '../etc/passwd' })).toThrow();
  });

  it('loadAll skips malformed JSON without throwing', () => {
    store.upsertActive(baseRecord('ok'));
    fs.writeFileSync(path.join(baseDir, 'overlord-sessions', 'broken.json'), '{not json');

    const fresh = new SessionStore({ baseDir });
    fresh.loadAll();
    expect(fresh.listActive()).toHaveLength(1);
    expect(fresh.getByOverlordId('ok')).toBeDefined();
  });

  it('flushAll completes all pending debounced writes', async () => {
    store.upsertActive(baseRecord('ovr-f1'));
    store.upsertActive(baseRecord('ovr-f2'));
    store.patch('ovr-f1', { intent: 'flushed' });
    store.patch('ovr-f2', { notes: 'flushed' });

    await store.flushAll();

    const f1 = JSON.parse(fs.readFileSync(path.join(baseDir, 'overlord-sessions', 'ovr-f1.json'), 'utf-8')) as OverlordSession;
    const f2 = JSON.parse(fs.readFileSync(path.join(baseDir, 'overlord-sessions', 'ovr-f2.json'), 'utf-8')) as OverlordSession;
    expect(f1.intent).toBe('flushed');
    expect(f2.notes).toBe('flushed');
  });
});
