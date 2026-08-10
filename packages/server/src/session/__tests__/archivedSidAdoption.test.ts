import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionStore } from '../sessionStore.js';
import { shouldAdoptArchived, ADOPT_COOLDOWN_MS } from '../stateManager.js';
import type { OverlordSession } from '../../types.js';

const NOW = 1_800_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();

describe('shouldAdoptArchived', () => {
  const archived = (archivedAt: string) => ({ archive: { archivedAt } });

  it('adopts when a live pid reports a long-archived sid', () => {
    expect(shouldAdoptArchived(archived(iso(NOW - 10 * 60_000)), 4321, NOW)).toBe(true);
  });

  // Transcript-scan paths carry no pid. Reviving from a file on disk would
  // resurrect rooms the user archived on purpose.
  it('never adopts without a live pid', () => {
    const rec = archived(iso(NOW - 10 * 60_000));
    expect(shouldAdoptArchived(rec, 0, NOW)).toBe(false);
    expect(shouldAdoptArchived(rec, -1, NOW)).toBe(false);
  });

  // Archive defers its process kill to a setImmediate while SessionWatcher keeps
  // polling — the dying process must not undo the archive it just triggered.
  it('does not adopt inside the cooldown', () => {
    expect(shouldAdoptArchived(archived(iso(NOW - 1_000)), 4321, NOW)).toBe(false);
    expect(shouldAdoptArchived(archived(iso(NOW - (ADOPT_COOLDOWN_MS - 1))), 4321, NOW)).toBe(false);
  });

  it('adopts exactly at the cooldown boundary', () => {
    expect(shouldAdoptArchived(archived(iso(NOW - ADOPT_COOLDOWN_MS)), 4321, NOW)).toBe(true);
  });

  it('outlives the 60s deleted-sid blocklist so the windows overlap', () => {
    expect(ADOPT_COOLDOWN_MS).toBeGreaterThan(60_000);
  });

  it('is a no-op for a missing record or a record with no archive block', () => {
    expect(shouldAdoptArchived(undefined, 4321, NOW)).toBe(false);
    expect(shouldAdoptArchived({}, 4321, NOW)).toBe(false);
  });

  // Records predating the field are far older than any cooldown would cover.
  it('fails open on an unparseable archivedAt', () => {
    expect(shouldAdoptArchived(archived('not-a-date'), 4321, NOW)).toBe(true);
  });
});

describe('archived sid ownership', () => {
  let baseDir: string;
  let store: SessionStore;

  const record = (ovrId: string, sid: string): OverlordSession => ({
    overlordId: ovrId,
    cwd: '/tmp/test',
    startedAt: 1000,
    color: '#abcdef',
    sessionType: 'plain',
    proposedName: 'BACKEND-1 Real title',
    lineage: { currentSessionId: sid, history: [{ sessionId: sid, attachedAt: 1000 }] },
  });

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivedSid-'));
    store = new SessionStore({ baseDir, debounceMs: 20 });
  });

  afterEach(async () => {
    await store.flushAll();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  // The bug this guards: resolveOverlordId is active-tier only, so an archived
  // owner is invisible and the sid mints a twin ovrId.
  it('an archived sid is invisible to resolveOverlordId but findable by the archive lookup', () => {
    store.upsertActive(record('ovr-a', 'sid-1'));
    store.archive('ovr-a', {
      roomId: 'room',
      name: 'BACKEND-1 Real title',
      transcripts: [],
    });

    expect(store.resolveOverlordId('sid-1')).toBeUndefined();
    expect(store.getArchivedBySessionId('sid-1')?.overlordId).toBe('ovr-a');
  });

  it('unarchive returns the sid to the SAME ovrId — no second record', () => {
    store.upsertActive(record('ovr-a', 'sid-1'));
    store.archive('ovr-a', {
      roomId: 'room',
      name: 'BACKEND-1 Real title',
      transcripts: [],
    });
    store.unarchive('ovr-a');

    expect(store.resolveOverlordId('sid-1')).toBe('ovr-a');
    expect(store.listActive()).toHaveLength(1);
    expect(store.listArchived()).toHaveLength(0);
    // The whole point of adopting: the accumulated name survives.
    expect(store.getBySessionId('sid-1')?.proposedName).toBe('BACKEND-1 Real title');
  });

  // Active-wins indexing is what hides the archived record once a twin exists.
  it('a minted twin shadows the archived owner via getBySessionId', () => {
    store.upsertActive(record('ovr-a', 'sid-1'));
    store.archive('ovr-a', {
      roomId: 'room',
      name: 'BACKEND-1 Real title',
      transcripts: [],
    });
    const twin = record('ovr-twin', 'sid-1');
    twin.proposedName = 'Simone';
    store.upsertActive(twin);

    expect(store.getBySessionId('sid-1')?.overlordId).toBe('ovr-twin');
    expect(store.getBySessionId('sid-1')?.proposedName).toBe('Simone');
    // Only the archive-tier scan can still reach the real record.
    expect(store.getArchivedBySessionId('sid-1')?.overlordId).toBe('ovr-a');
  });
});
