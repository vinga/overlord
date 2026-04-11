import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { shouldUseExtraEnter, scheduleInject } from '../pty/injectScheduler.js';

// ── shouldUseExtraEnter ───────────────────────────────────────────────────────

describe('shouldUseExtraEnter', () => {
  it('returns false for plain text', () => {
    expect(shouldUseExtraEnter('hello world')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(shouldUseExtraEnter('')).toBe(false);
  });

  it('returns true when text contains @', () => {
    expect(shouldUseExtraEnter('look at this @/tmp/overlord-paste-123.jpg')).toBe(true);
  });

  it('returns true for bare @ character', () => {
    expect(shouldUseExtraEnter('@')).toBe(true);
  });

  it('returns true for @file at start', () => {
    expect(shouldUseExtraEnter('@/docs/image.png')).toBe(true);
  });

  it('returns true for message with image appended after text', () => {
    // Matches the DetailPanel format: `${text} @${pastedImage.path}`
    expect(shouldUseExtraEnter('help me with this @/var/folders/abc/overlord-paste-1234.jpg')).toBe(true);
  });
});

// ── scheduleInject ────────────────────────────────────────────────────────────

describe('scheduleInject', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── plain text (extraEnter=false) ───────────────────────────────────────────

  it('writes text + \\r atomically when extraEnter=false', () => {
    const write = vi.fn();
    scheduleInject(write, () => true, 'hello', false);
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith('hello\r');
  });

  it('does not schedule any deferred writes when extraEnter=false', () => {
    const write = vi.fn();
    scheduleInject(write, () => true, 'hello', false);
    vi.runAllTimers();
    expect(write).toHaveBeenCalledOnce();
  });

  // ── image / @file (extraEnter=true) ────────────────────────────────────────

  it('writes text without \\r immediately when extraEnter=true', () => {
    const write = vi.fn();
    scheduleInject(write, () => true, 'msg @/tmp/img.jpg', true);
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith('msg @/tmp/img.jpg');
  });

  it('sends first \\r after 400 ms (select autocomplete)', () => {
    const write = vi.fn();
    scheduleInject(write, () => true, 'msg @/tmp/img.jpg', true);
    vi.advanceTimersByTime(400);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenNthCalledWith(2, '\r');
  });

  it('sends second \\r after another 300 ms (submit)', () => {
    const write = vi.fn();
    scheduleInject(write, () => true, 'msg @/tmp/img.jpg', true);
    vi.advanceTimersByTime(700);
    expect(write).toHaveBeenCalledTimes(3);
    expect(write).toHaveBeenNthCalledWith(3, '\r');
  });

  it('skips first deferred \\r if PTY died before 400 ms', () => {
    const write = vi.fn();
    let alive = true;
    scheduleInject(write, () => alive, 'msg @/tmp/img.jpg', true);
    alive = false;
    vi.runAllTimers();
    // Only the initial text write; both \r skipped
    expect(write).toHaveBeenCalledOnce();
  });

  it('skips second deferred \\r if PTY died between step1 and step2', () => {
    const write = vi.fn();
    let alive = true;
    scheduleInject(write, () => alive, 'msg @/tmp/img.jpg', true);
    vi.advanceTimersByTime(400); // fires step1 → write '\r'
    alive = false;
    vi.advanceTimersByTime(300); // step2 should be skipped
    expect(write).toHaveBeenCalledTimes(2); // text + step1 only
  });

  // ── timing does not apply to extraEnter=false ───────────────────────────────

  it('extraEnter=false: no extra writes after full timer advance', () => {
    const write = vi.fn();
    scheduleInject(write, () => true, 'plain text', false);
    vi.runAllTimers();
    expect(write).toHaveBeenCalledOnce();
  });
});
