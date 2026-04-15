import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  shouldUseExtraEnter,
  scheduleInject,
  computeFirstEnterDelay,
} from '../pty/injectScheduler.js';

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
    expect(shouldUseExtraEnter('help me with this @/var/folders/abc/overlord-paste-1234.jpg')).toBe(true);
  });
});

// ── computeFirstEnterDelay ────────────────────────────────────────────────────

describe('computeFirstEnterDelay', () => {
  it('floors at 150 ms for short plain text', () => {
    expect(computeFirstEnterDelay('hi', false)).toBe(150);
  });

  it('scales +1 ms per char between floor and cap', () => {
    const text = 'a'.repeat(300);
    expect(computeFirstEnterDelay(text, false)).toBe(300);
  });

  it('caps at 600 ms for long plain text', () => {
    const text = 'a'.repeat(2000);
    expect(computeFirstEnterDelay(text, false)).toBe(600);
  });

  it('uses fixed autoSelectMs when extraEnter=true', () => {
    expect(computeFirstEnterDelay('anything', true)).toBe(400);
    expect(computeFirstEnterDelay('anything', true, 500)).toBe(500);
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

  // ── plain text (extraEnter=false) ──────────────────────────────────────────

  it('writes text first (no \\r) when extraEnter=false', () => {
    const write = vi.fn().mockReturnValue(true);
    const onFail = vi.fn();
    scheduleInject(write, () => true, onFail, 'hello', false);
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith('hello');
  });

  it('sends deferred \\r after proportional delay for plain text', () => {
    const write = vi.fn().mockReturnValue(true);
    scheduleInject(write, () => true, vi.fn(), 'hello', false);
    // 'hello' is 5 chars → floor kicks in → 150 ms
    vi.advanceTimersByTime(150);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenNthCalledWith(2, '\r');
  });

  it('uses length-proportional delay between 150 and 600 ms', () => {
    const write = vi.fn().mockReturnValue(true);
    const text = 'a'.repeat(300);
    scheduleInject(write, () => true, vi.fn(), text, false);
    vi.advanceTimersByTime(299);
    expect(write).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('does not send a second \\r for plain text', () => {
    const write = vi.fn().mockReturnValue(true);
    scheduleInject(write, () => true, vi.fn(), 'hello', false);
    vi.runAllTimers();
    expect(write).toHaveBeenCalledTimes(2);
  });

  // ── @file (extraEnter=true) ────────────────────────────────────────────────

  it('writes text without \\r immediately when extraEnter=true', () => {
    const write = vi.fn().mockReturnValue(true);
    scheduleInject(write, () => true, vi.fn(), 'msg @/tmp/img.jpg', true);
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith('msg @/tmp/img.jpg');
  });

  it('sends first \\r after 400 ms (select autocomplete)', () => {
    const write = vi.fn().mockReturnValue(true);
    scheduleInject(write, () => true, vi.fn(), 'msg @/tmp/img.jpg', true);
    vi.advanceTimersByTime(400);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenNthCalledWith(2, '\r');
  });

  it('sends second \\r after another 300 ms (submit)', () => {
    const write = vi.fn().mockReturnValue(true);
    scheduleInject(write, () => true, vi.fn(), 'msg @/tmp/img.jpg', true);
    vi.advanceTimersByTime(700);
    expect(write).toHaveBeenCalledTimes(3);
    expect(write).toHaveBeenNthCalledWith(3, '\r');
  });

  // ── isAlive guards ─────────────────────────────────────────────────────────

  it('skips first deferred \\r if target died before delay', () => {
    const write = vi.fn().mockReturnValue(true);
    let alive = true;
    scheduleInject(write, () => alive, vi.fn(), 'msg @/tmp/img.jpg', true);
    alive = false;
    vi.runAllTimers();
    expect(write).toHaveBeenCalledOnce();
  });

  it('skips second deferred \\r if target died between step1 and step2', () => {
    const write = vi.fn().mockReturnValue(true);
    let alive = true;
    scheduleInject(write, () => alive, vi.fn(), 'msg @/tmp/img.jpg', true);
    vi.advanceTimersByTime(400);
    alive = false;
    vi.advanceTimersByTime(300);
    expect(write).toHaveBeenCalledTimes(2);
  });

  // ── onWriteFail hook ───────────────────────────────────────────────────────

  it('calls onWriteFail with initial=true if the text write fails', () => {
    const write = vi.fn().mockReturnValue(false);
    const onFail = vi.fn();
    scheduleInject(write, () => true, onFail, 'hello', false);
    expect(onFail).toHaveBeenCalledOnce();
    expect(onFail).toHaveBeenCalledWith('hello', true);
  });

  it('calls onWriteFail with initial=false if a deferred \\r fails', () => {
    const write = vi.fn()
      .mockReturnValueOnce(true) // text ok
      .mockReturnValueOnce(false); // \r fails
    const onFail = vi.fn();
    scheduleInject(write, () => true, onFail, 'hello', false);
    vi.runAllTimers();
    expect(onFail).toHaveBeenCalledOnce();
    expect(onFail).toHaveBeenCalledWith('\r', false);
  });

  it('does not schedule deferred writes if the initial write failed', () => {
    const write = vi.fn().mockReturnValue(false);
    scheduleInject(write, () => true, vi.fn(), 'hello', false);
    vi.runAllTimers();
    expect(write).toHaveBeenCalledOnce();
  });
});
