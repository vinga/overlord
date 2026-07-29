import { describe, it, expect } from 'vitest';
import { filterTerminalInput } from '../terminalInput';

const ESC = '\x1b';

describe('filterTerminalInput', () => {
  it('passes ordinary typing through untouched', () => {
    expect(filterTerminalInput('it is still too slow')).toBe('it is still too slow');
    expect(filterTerminalInput('\r')).toBe('\r');
    expect(filterTerminalInput(`${ESC}[A`)).toBe(`${ESC}[A`); // arrow up
  });

  it('strips the motion report that leaked into a real message', () => {
    // Captured verbatim from a user message: button 35 = 32|3 (motion, no
    // button held), with the ESC[< prefix intact as xterm emits it.
    expect(filterTerminalInput(`${ESC}[<35;96;40Mit is still too slow`))
      .toBe('it is still too slow');
  });

  it('strips a burst of motion reports around typed text', () => {
    const burst = `${ESC}[<35;10;5M${ESC}[<35;11;5M${ESC}[<35;12;6Mhello${ESC}[<35;13;6M`;
    expect(filterTerminalInput(burst)).toBe('hello');
  });

  it('keeps plain button press and release so TUI menus stay clickable', () => {
    expect(filterTerminalInput(`${ESC}[<0;10;5M`)).toBe(`${ESC}[<0;10;5M`);   // left press
    expect(filterTerminalInput(`${ESC}[<0;10;5m`)).toBe(`${ESC}[<0;10;5m`);   // left release
    expect(filterTerminalInput(`${ESC}[<2;10;5M`)).toBe(`${ESC}[<2;10;5M`);   // right press
    expect(filterTerminalInput(`${ESC}[<16;10;5M`)).toBe(`${ESC}[<16;10;5M`); // ctrl+left
  });

  it('strips drag (motion with a button held), which is motion too', () => {
    // button 32 = motion|left-held
    expect(filterTerminalInput(`${ESC}[<32;10;5M`)).toBe('');
  });

  it('KEEPS wheel reports so scrolling inside the terminal works', () => {
    // With mouse tracking on, xterm forwards wheel to the app instead of
    // scrolling its own buffer — filtering these would kill scrolling.
    expect(filterTerminalInput(`${ESC}[<64;72;46M`)).toBe(`${ESC}[<64;72;46M`); // up
    expect(filterTerminalInput(`${ESC}[<65;10;5M`)).toBe(`${ESC}[<65;10;5M`);   // down
    // Wheel while the pointer is also moving must still scroll, not be dropped
    // as motion (bit 32 + bit 64 both set).
    expect(filterTerminalInput(`${ESC}[<96;10;5M`)).toBe(`${ESC}[<96;10;5M`);
  });

  it('still strips motion interleaved with a scroll', () => {
    const mixed = `${ESC}[<35;10;5M${ESC}[<64;10;5M${ESC}[<35;11;5M`;
    expect(filterTerminalInput(mixed)).toBe(`${ESC}[<64;10;5M`);
  });

  it('still strips focus reports (the pre-existing behaviour)', () => {
    expect(filterTerminalInput(`${ESC}[Ihi${ESC}[O`)).toBe('hi');
  });

  it('strips legacy X10 mouse reports', () => {
    // ESC[M is followed by exactly three raw bytes (button, col, row) — here
    // ' ', 'a', 'b' — so only 'c' survives.
    expect(filterTerminalInput(`${ESC}[M abc`)).toBe('c');
  });

  it('leaves a bare CSI that merely looks like a mouse report', () => {
    // Not a mouse report — no `<`, so it must survive.
    expect(filterTerminalInput(`${ESC}[35;96;40M`)).toBe(`${ESC}[35;96;40M`);
  });
});
