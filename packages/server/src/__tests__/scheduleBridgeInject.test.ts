import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { scheduleBridgeInject } from '../pty/injectScheduler.js';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Build mock functions and run scheduleBridgeInject, advancing timers. */
async function run(opts: {
  pipeResults: boolean[];   // pipeSend return values in call order
  text: string;
  extraEnter: boolean;
  autoSelectMs?: number;
  submitMs?: number;
}) {
  let pipeCallIdx = 0;
  const pipeSend = vi.fn(async (): Promise<boolean> => opts.pipeResults[pipeCallIdx++] ?? false);
  const fallback = vi.fn(async () => {});
  const enterFallback = vi.fn(async () => {});

  const promise = scheduleBridgeInject(
    pipeSend,
    fallback,
    enterFallback,
    opts.text,
    opts.extraEnter,
    opts.autoSelectMs ?? 400,
    opts.submitMs ?? 300,
  );

  // Flush all timers so the deferred writes run
  await vi.runAllTimersAsync();
  await promise;

  return { pipeSend, fallback, enterFallback };
}

// ── test suite ────────────────────────────────────────────────────────────────

describe('scheduleBridgeInject', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── extraEnter=false (plain text) ─────────────────────────────────────────

  it('plain text: sends text then deferred \\r as two pipe writes', async () => {
    const { pipeSend, fallback, enterFallback } = await run({
      pipeResults: [true, true],
      text: 'hello world',
      extraEnter: false,
    });
    expect(pipeSend).toHaveBeenCalledTimes(2);
    expect(pipeSend).toHaveBeenNthCalledWith(1, 'hello world');
    expect(pipeSend).toHaveBeenNthCalledWith(2, '\r');
    expect(fallback).not.toHaveBeenCalled();
    expect(enterFallback).not.toHaveBeenCalled();
  });

  it('plain text: calls fallback when initial pipe write fails', async () => {
    const { pipeSend, fallback, enterFallback } = await run({
      pipeResults: [false],
      text: 'hello',
      extraEnter: false,
    });
    expect(pipeSend).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledWith('hello', false);
    expect(enterFallback).not.toHaveBeenCalled();
  });

  it('plain text: calls enterFallback when deferred \\r fails', async () => {
    const { pipeSend, fallback, enterFallback } = await run({
      pipeResults: [true, false],
      text: 'hello',
      extraEnter: false,
    });
    expect(pipeSend).toHaveBeenCalledTimes(2);
    expect(fallback).not.toHaveBeenCalled();
    expect(enterFallback).toHaveBeenCalledOnce();
  });

  it('plain text: no third pipe write after success', async () => {
    const { pipeSend } = await run({
      pipeResults: [true, true],
      text: 'no extra writes',
      extraEnter: false,
    });
    expect(pipeSend).toHaveBeenCalledTimes(2);
  });

  it('bare \\r: sends exactly \\r (no double-enter)', async () => {
    // Bare Enter injected from Conversation panel to confirm TUI menus.
    // Bug: was sending '\r\r' because the function unconditionally appended '\r'.
    const { pipeSend, fallback, enterFallback } = await run({
      pipeResults: [true],
      text: '\r',
      extraEnter: false,
    });
    expect(pipeSend).toHaveBeenCalledOnce();
    expect(pipeSend).toHaveBeenCalledWith('\r');  // not '\r\r'
    expect(fallback).not.toHaveBeenCalled();
    expect(enterFallback).not.toHaveBeenCalled();
  });

  // ── extraEnter=true (@file autocomplete) ──────────────────────────────────

  it('@file: sends text without \\r first, then two deferred \\r presses', async () => {
    const { pipeSend, fallback, enterFallback } = await run({
      pipeResults: [true, true, true],
      text: 'check @/tmp/img.jpg',
      extraEnter: true,
    });
    expect(pipeSend).toHaveBeenCalledTimes(3);
    expect(pipeSend).toHaveBeenNthCalledWith(1, 'check @/tmp/img.jpg');  // no \r
    expect(pipeSend).toHaveBeenNthCalledWith(2, '\r');                   // select autocomplete
    expect(pipeSend).toHaveBeenNthCalledWith(3, '\r');                   // submit
    expect(fallback).not.toHaveBeenCalled();
    expect(enterFallback).not.toHaveBeenCalled();
  });

  it('@file: calls fallback (not enterFallback) when initial pipe write fails', async () => {
    const { pipeSend, fallback, enterFallback } = await run({
      pipeResults: [false],
      text: 'check @/tmp/img.jpg',
      extraEnter: true,
    });
    expect(pipeSend).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledWith('check @/tmp/img.jpg', true);
    expect(enterFallback).not.toHaveBeenCalled();
  });

  it('@file: calls enterFallback when deferred step1 \\r pipe write fails (BUG: was silently dropped)', async () => {
    // Text was successfully delivered but pipe disconnected before 400ms select
    const { pipeSend, fallback, enterFallback } = await run({
      pipeResults: [true, false],   // text ok, first \r fails
      text: 'check @/tmp/img.jpg',
      extraEnter: true,
    });
    expect(pipeSend).toHaveBeenCalledTimes(2);
    expect(fallback).not.toHaveBeenCalled();
    expect(enterFallback).toHaveBeenCalledOnce();  // Enter recovered via fallback
  });

  it('@file: calls enterFallback when deferred step2 \\r pipe write fails (BUG: was silently dropped)', async () => {
    // Text ok, step1 ok, pipe drops before 300ms submit
    const { pipeSend, fallback, enterFallback } = await run({
      pipeResults: [true, true, false],  // text ok, step1 ok, step2 fails
      text: 'check @/tmp/img.jpg',
      extraEnter: true,
    });
    expect(pipeSend).toHaveBeenCalledTimes(3);
    expect(fallback).not.toHaveBeenCalled();
    expect(enterFallback).toHaveBeenCalledOnce();  // final submit recovered
  });

  it('@file: does NOT call enterFallback when both deferred \\r succeed', async () => {
    const { fallback, enterFallback } = await run({
      pipeResults: [true, true, true],
      text: 'check @/tmp/img.jpg',
      extraEnter: true,
    });
    expect(fallback).not.toHaveBeenCalled();
    expect(enterFallback).not.toHaveBeenCalled();
  });

  // ── timing ────────────────────────────────────────────────────────────────

  it('respects custom autoSelectMs and submitMs', async () => {
    let pipeCallIdx = 0;
    const pipeResults = [true, true, true];
    const pipeSend = vi.fn(async (): Promise<boolean> => pipeResults[pipeCallIdx++] ?? false);
    const fallback = vi.fn(async () => {});
    const enterFallback = vi.fn(async () => {});

    const p = scheduleBridgeInject(pipeSend, fallback, enterFallback, 'x @y', true, 100, 50);

    // Only initial text sent immediately
    expect(pipeSend).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(pipeSend).toHaveBeenCalledTimes(2);  // step1 \r

    await vi.advanceTimersByTimeAsync(50);
    expect(pipeSend).toHaveBeenCalledTimes(3);  // step2 \r

    await p;
  });

  it('deferred \\r not sent before autoSelectMs elapses', async () => {
    let pipeCallIdx = 0;
    const pipeResults = [true, true, true];
    const pipeSend = vi.fn(async (): Promise<boolean> => pipeResults[pipeCallIdx++] ?? false);
    const fallback = vi.fn(async () => {});
    const enterFallback = vi.fn(async () => {});

    const p = scheduleBridgeInject(pipeSend, fallback, enterFallback, 'x @y', true, 400, 300);

    expect(pipeSend).toHaveBeenCalledTimes(1);  // text only

    await vi.advanceTimersByTimeAsync(399);
    expect(pipeSend).toHaveBeenCalledTimes(1);  // still just text

    await vi.advanceTimersByTimeAsync(1);
    expect(pipeSend).toHaveBeenCalledTimes(2);  // now step1 fires

    await vi.runAllTimersAsync();
    await p;
  });
});
