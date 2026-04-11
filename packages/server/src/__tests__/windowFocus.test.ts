import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Minimal EventEmitter stub that satisfies child_process.ChildProcess contract */
function makeChild() {
  const emitter = new EventEmitter();
  return emitter as unknown as ReturnType<typeof import('child_process').spawn>;
}

// ── module-level mock for child_process ───────────────────────────────────────

const spawnMock = vi.fn();

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

// ── import after mocking ──────────────────────────────────────────────────────

const { focusBridgeWindow } = await import('../pty/windowFocus.js');

// ── tests ─────────────────────────────────────────────────────────────────────

describe('focusBridgeWindow', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    // restore platform descriptor if we changed it
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  function setPlatform(p: string) {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
  }

  // ── platform guard ──────────────────────────────────────────────────────────

  it('is a no-op on non-darwin platforms', async () => {
    setPlatform('linux');
    await focusBridgeWindow('/dev/ttys003');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('is a no-op on windows', async () => {
    setPlatform('win32');
    await focusBridgeWindow('/dev/ttys003');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  // ── empty / missing tty ─────────────────────────────────────────────────────

  it('is a no-op when tty is empty string', async () => {
    setPlatform('darwin');
    await focusBridgeWindow('');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  // ── darwin: activate ────────────────────────────────────────────────────────

  it('calls osascript on darwin', async () => {
    setPlatform('darwin');
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const p = focusBridgeWindow('/dev/ttys003');
    (child as EventEmitter).emit('close', 0);
    await p;

    expect(spawnMock).toHaveBeenCalledWith('osascript', ['-e', expect.any(String)], { stdio: 'ignore' });
  });

  it('script contains `activate` so Terminal.app comes to the OS foreground', async () => {
    setPlatform('darwin');
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const p = focusBridgeWindow('/dev/ttys003');
    (child as EventEmitter).emit('close', 0);
    await p;

    const script: string = spawnMock.mock.calls[0][1][1];
    expect(script).toContain('activate');
  });

  it('script targets Terminal application', async () => {
    setPlatform('darwin');
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const p = focusBridgeWindow('/dev/ttys003');
    (child as EventEmitter).emit('close', 0);
    await p;

    const script: string = spawnMock.mock.calls[0][1][1];
    expect(script).toContain('tell application "Terminal"');
  });

  it('script matches the correct tty in Terminal tabs', async () => {
    setPlatform('darwin');
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const p = focusBridgeWindow('/dev/ttys007');
    (child as EventEmitter).emit('close', 0);
    await p;

    const script: string = spawnMock.mock.calls[0][1][1];
    expect(script).toContain('/dev/ttys007');
  });

  it('script sets selected tab and raises window index', async () => {
    setPlatform('darwin');
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const p = focusBridgeWindow('/dev/ttys003');
    (child as EventEmitter).emit('close', 0);
    await p;

    const script: string = spawnMock.mock.calls[0][1][1];
    expect(script).toContain('set selected of t to true');
    expect(script).toContain('set index of w to 1');
  });

  // ── tty sanitisation ────────────────────────────────────────────────────────

  it('strips double-quotes from tty to prevent AppleScript injection', async () => {
    setPlatform('darwin');
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const p = focusBridgeWindow('/dev/tty"s003');
    (child as EventEmitter).emit('close', 0);
    await p;

    const script: string = spawnMock.mock.calls[0][1][1];
    // The raw quote must not appear inside the AppleScript string literal
    expect(script).not.toContain('"/dev/tty"s003"');
    expect(script).toContain('/dev/ttys003');
  });

  // ── error resilience ────────────────────────────────────────────────────────

  it('resolves (does not reject) when osascript emits an error', async () => {
    setPlatform('darwin');
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const p = focusBridgeWindow('/dev/ttys003');
    (child as EventEmitter).emit('error', new Error('osascript not found'));
    await expect(p).resolves.toBeUndefined();
  });

  it('resolves when osascript exits with non-zero code', async () => {
    setPlatform('darwin');
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const p = focusBridgeWindow('/dev/ttys003');
    (child as EventEmitter).emit('close', 1);
    await expect(p).resolves.toBeUndefined();
  });
});
