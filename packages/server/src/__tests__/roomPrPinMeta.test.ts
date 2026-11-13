import { describe, it, expect, vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import { join } from 'path';

// sessionStore resolves its baseDir from $HOME — stub it so no real records are written.
const TMP = fs.mkdtempSync(join(os.tmpdir(), 'ovr-roompr-'));
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;

const { StateManager } = await import('../session/stateManager.js');

describe('room PR pins in prMeta', () => {
  it('looks up and returns meta for a PR pinned only to the room', () => {
    const sm = new StateManager(() => {});
    const cwd = join(TMP, 'room');
    sm.addOrUpdate({ pid: 0, sessionId: 'sid-r', cwd, startedAt: Date.now() });
    sm.setRoomPins(cwd, [{ id: 'p1', url: 'https://github.com/o/r/pull/855', kind: 'pr', title: 'o/r#855', createdAt: Date.now() }]);
    const cache = (sm as unknown as { prMetaCache: { get: (ref: string, cwd?: string) => unknown } }).prMetaCache;
    const get = vi.spyOn(cache, 'get').mockImplementation(ref => ref === 'o/r#855' ? { title: 'Pinned PR', state: 'OPEN' } : undefined);
    const snap = sm.getSnapshot();
    expect(get).toHaveBeenCalledWith('o/r#855', cwd);
    expect(snap.prMeta?.['o/r#855']?.title).toBe('Pinned PR');
  });
});
