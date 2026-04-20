import { describe, it, expect } from 'vitest';
import { detectModeFromText, detectModeFromStatusLine } from '../session/modeDetect.js';

describe('detectModeFromText — status bar sentinel', () => {
  it('returns sentinelFound: false when no status bar present', () => {
    expect(detectModeFromText('just some output')).toEqual({ sentinelFound: false });
    expect(detectModeFromText('')).toEqual({ sentinelFound: false });
  });

  it('returns default when sentinel present without mode keyword', () => {
    expect(detectModeFromText('(shift+tab to cycle)')).toEqual({ sentinelFound: true, mode: 'default' });
    expect(detectModeFromText('  (shift+tab to cycle)')).toEqual({ sentinelFound: true, mode: 'default' });
  });

  it('detects plan mode', () => {
    expect(detectModeFromText('⏸ plan mode on (shift+tab to cycle)').mode).toBe('plan');
    expect(detectModeFromText('plan mode on (shift+tab to cycle)').mode).toBe('plan');
  });

  it('detects acceptEdits', () => {
    expect(detectModeFromText('accept edits on (shift+tab to cycle)').mode).toBe('acceptEdits');
  });

  it('detects bypassPermissions', () => {
    expect(detectModeFromText('bypass permissions on (shift+tab to cycle)').mode).toBe('bypassPermissions');
  });

  it('uses the LAST sentinel when multiple are present', () => {
    const text = 'plan mode on (shift+tab to cycle)\nsome later output\n  (shift+tab to cycle)';
    expect(detectModeFromText(text).mode).toBe('default');
  });

  it('uses the LAST sentinel — later mode wins', () => {
    const text = '  (shift+tab to cycle)\nlater line\naccept edits on (shift+tab to cycle)';
    expect(detectModeFromText(text).mode).toBe('acceptEdits');
  });

  // Regression: the 200-char window before the sentinel previously swallowed
  // multi-line conversation content. When conversation text ending in
  // "... <word> mode on" was followed by a newline and the default status bar,
  // matchModeAtEnd would strip trailing whitespace and match the conversation
  // word as a spurious mode ("auto", "safe", etc.).
  it('does NOT false-match a mode keyword from a PRIOR line', () => {
    const text = 'Auto mode on is when Claude skips prompts.\n\n(shift+tab to cycle)';
    expect(detectModeFromText(text).mode).toBe('default');
  });

  it('does NOT false-match when prior line ENDS with "<word> mode on" + newline', () => {
    // This is the real-world case: rolling PTY buffer has conversation text that
    // happens to end with "... auto mode on" followed by the default status bar.
    // The regex was anchoring on the whole 200-char window, so trailing whitespace
    // (\n) was stripped and "auto mode on" became the tail, false-matching "auto".
    const text = 'when user says auto mode on\n\n  (shift+tab to cycle)';
    expect(detectModeFromText(text).mode).toBe('default');
  });

  it('does NOT false-match when conversation spans many newlines', () => {
    const text = 'Line 1\nsome random plan mode on\n\n\n  (shift+tab to cycle)';
    expect(detectModeFromText(text).mode).toBe('default');
  });

  it('preserves Unicode whitespace converted to ASCII space', () => {
    // NBSP (U+00A0) is what Claude CLI uses — caller pre-strips it to space.
    const text = '⏸ plan mode on (shift+tab to cycle)'.replace(/\u00a0/g, ' ');
    expect(detectModeFromText(text).mode).toBe('plan');
  });

  it('tolerates trailing punctuation after "on"', () => {
    expect(detectModeFromText('plan mode on? (shift+tab to cycle)').mode).toBe('plan');
    expect(detectModeFromText('plan mode on. (shift+tab to cycle)').mode).toBe('plan');
  });

  it('ignores prior status bar with different mode when new one is default', () => {
    // Two status bar redraws in the rolling buffer. Second is default.
    const text = 'plan mode on (shift+tab to cycle)\r\n  (shift+tab to cycle)';
    expect(detectModeFromText(text).mode).toBe('default');
  });
});

describe('detectModeFromStatusLine — single-line helper', () => {
  it('returns undefined when sentinel absent', () => {
    expect(detectModeFromStatusLine('no sentinel here')).toBeUndefined();
  });

  it('returns known modes', () => {
    expect(detectModeFromStatusLine('plan mode on (shift+tab to cycle)')).toBe('plan');
    expect(detectModeFromStatusLine('accept edits on (shift+tab to cycle)')).toBe('acceptEdits');
    expect(detectModeFromStatusLine('bypass permissions on (shift+tab to cycle)')).toBe('bypassPermissions');
  });

  it('returns undefined for default (caller maps to default)', () => {
    expect(detectModeFromStatusLine('  (shift+tab to cycle)')).toBeUndefined();
  });
});
