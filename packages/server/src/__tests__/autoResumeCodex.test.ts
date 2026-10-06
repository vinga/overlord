import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../session/sessionStore.js', () => ({
  sessionStore: { resolveOverlordId: (sid: string) => sid, getBySessionId: () => undefined },
}));
vi.mock('../session/transcriptReader.js', () => ({
  resolveResumableSessionId: vi.fn(() => ({ sessionId: 'should-not-be-used', transcriptPath: '/x.jsonl' })),
}));
const capture = vi.fn();
vi.mock('../session/codexSession.js', async (orig) => ({
  ...(await orig<typeof import('../session/codexSession.js')>()),
  scheduleCodexTranscriptCapture: (...args: unknown[]) => capture(...args),
}));

import { autoResumePtySessions } from '../session/autoResumeBootstrap.js';
import type { AutoResumeDeps } from '../session/autoResumeBootstrap.js';

const CODEX_SID = 'codex-1790769391217-k6za5l';
const PROVIDER_SID = '01a0f22d-b0b2-7753-893d-8e8835bfe118';

function makeDeps() {
  const spawn = vi.fn();
  const revive = vi.fn();
  const deps = {
    stateManager: {
      getPtySessionsToResume: () => [{ sessionId: CODEX_SID, cwd: '/repo', provider: 'codex', providerSessionId: PROVIDER_SID }],
      reviveManagedProviderSession: revive,
      trackPendingResumeByMarker: vi.fn(),
      reserveOvrIdForMarker: vi.fn(),
    },
    ptyManager: { spawn, getPid: () => 4242, once: vi.fn() },
    ovrToPty: new Map<string, string>(),
    ptyToOvr: new Map<string, string>(),
    linkageTracker: { trackResume: vi.fn() },
    liveAtShutdown: [{ ovrId: CODEX_SID, sessionId: CODEX_SID, pid: 1 }],
  } as unknown as AutoResumeDeps;
  return { deps, spawn, revive };
}

describe('auto-resume of a Codex session', () => {
  beforeEach(() => capture.mockReset());

  it('spawns `codex resume <id>` on the same session, never `claude --resume`', async () => {
    const { deps, spawn, revive } = makeDeps();
    await autoResumePtySessions(deps);

    expect(spawn).toHaveBeenCalledTimes(1);
    const [ptyId, cwd, , , args, provider] = spawn.mock.calls[0];
    expect(ptyId).toBe(CODEX_SID);
    expect(cwd).toBe('/repo');
    expect(provider).toBe('codex');
    expect(args.slice(0, 2)).toEqual(['resume', PROVIDER_SID]);
    expect(args).not.toContain('--name');
    expect(revive).toHaveBeenCalledWith(CODEX_SID, 4242);
    expect(deps.ovrToPty.get(CODEX_SID)).toBe(CODEX_SID);
    expect(capture).toHaveBeenCalledWith(deps.stateManager, CODEX_SID, '/repo', expect.any(Number), { replaceExisting: true });
  });
});
