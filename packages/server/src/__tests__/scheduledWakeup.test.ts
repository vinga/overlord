import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readTranscriptState, readScheduledWakeups, _resetCachesForTest } from '../session/transcriptReader.js';

// ScheduleWakeup detection: a session idling on a self-scheduled wakeup is not
// "waiting for input" — readTranscriptState surfaces scheduledWakeupAt (epoch ms
// of the fire time) so the UI can show "scheduled" instead of "waiting". Active
// iff: most recent ScheduleWakeup call, stop !== true, confirmed by a non-error
// tool_result, fire time (+30s grace) still ahead. User messages after the call
// do NOT invalidate — the pending wakeup fires regardless of interjections.

const BASE = new Date('2026-07-23T12:00:00Z').getTime();
// Pin mtime 60s in the past so derived state is a stable 'waiting'.
const PIN = new Date(BASE - 60_000);

function userMsg(text: string, tsMs: number): string {
  return JSON.stringify({
    type: 'user',
    timestamp: new Date(tsMs).toISOString(),
    message: { content: text },
  });
}

function scheduleCall(id: string, tsMs: number, input: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(tsMs).toISOString(),
    message: {
      model: 'claude-fable-5',
      usage: { input_tokens: 10 },
      content: [{ type: 'tool_use', id, name: 'ScheduleWakeup', input }],
    },
  });
}

function scheduleResult(id: string, tsMs: number, isError = false): string {
  return JSON.stringify({
    type: 'user',
    timestamp: new Date(tsMs).toISOString(),
    message: {
      content: [{ type: 'tool_result', tool_use_id: id, content: 'Next wakeup scheduled for 12:10:00 (in 600s).', is_error: isError }],
    },
  });
}

describe('scheduledWakeupAt detection', () => {
  let tmpDir: string;
  let fp: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlord-schedwake-'));
    fp = path.join(tmpDir, 'sess.jsonl');
    _resetCachesForTest();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BASE));
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(lines: string[]): void {
    fs.writeFileSync(fp, lines.join('\n') + '\n');
    fs.utimesSync(fp, PIN, PIN);
  }

  it('surfaces the fire time for a confirmed pending wakeup', () => {
    const callTs = BASE - 30_000;
    write([
      userMsg('please babysit the PR', BASE - 120_000),
      scheduleCall('tu-1', callTs, { delaySeconds: 600, prompt: '/loop x', reason: 'waiting for CI' }),
      scheduleResult('tu-1', callTs + 1000),
    ]);
    const r = readTranscriptState(fp);
    expect(r.state).toBe('waiting');
    expect(r.scheduledWakeupAt).toBe(callTs + 600_000);
  });

  it('ignores stop:true calls', () => {
    write([
      scheduleCall('tu-1', BASE - 30_000, { stop: true }),
      scheduleResult('tu-1', BASE - 29_000),
    ]);
    expect(readTranscriptState(fp).scheduledWakeupAt).toBeUndefined();
  });

  it('keeps the schedule active across a user interjection (wakeup still pending)', () => {
    const callTs = BASE - 30_000;
    write([
      scheduleCall('tu-1', callTs, { delaySeconds: 600 }),
      scheduleResult('tu-1', callTs + 1000),
      userMsg('quick question while you idle', BASE - 10_000),
    ]);
    expect(readTranscriptState(fp).scheduledWakeupAt).toBe(callTs + 600_000);
  });

  it('ignores an expired schedule (fire time + grace passed)', () => {
    const callTs = BASE - 700_000; // delay 600s → fired 100s ago, past 30s grace
    write([
      scheduleCall('tu-1', callTs, { delaySeconds: 600 }),
      scheduleResult('tu-1', callTs + 1000),
    ]);
    expect(readTranscriptState(fp).scheduledWakeupAt).toBeUndefined();
  });

  it('ignores unconfirmed or errored calls', () => {
    write([scheduleCall('tu-1', BASE - 30_000, { delaySeconds: 600 })]);
    expect(readTranscriptState(fp).scheduledWakeupAt).toBeUndefined();

    _resetCachesForTest();
    write([
      scheduleCall('tu-2', BASE - 30_000, { delaySeconds: 600 }),
      scheduleResult('tu-2', BASE - 29_000, true),
    ]);
    expect(readTranscriptState(fp).scheduledWakeupAt).toBeUndefined();
  });

  it('only the most recent call counts — a newer stop supersedes an older schedule', () => {
    write([
      scheduleCall('tu-1', BASE - 60_000, { delaySeconds: 600 }),
      scheduleResult('tu-1', BASE - 59_000),
      scheduleCall('tu-2', BASE - 30_000, { stop: true }),
      scheduleResult('tu-2', BASE - 29_000),
    ]);
    expect(readTranscriptState(fp).scheduledWakeupAt).toBeUndefined();
  });

  it('clamps delaySeconds to the runtime range [60, 3600]', () => {
    const callTs = BASE - 30_000;
    write([
      scheduleCall('tu-1', callTs, { delaySeconds: 10 }),
      scheduleResult('tu-1', callTs + 1000),
    ]);
    expect(readTranscriptState(fp).scheduledWakeupAt).toBe(callTs + 60_000);
  });

  it('readScheduledWakeups: newest-first history with statuses', () => {
    write([
      scheduleCall('tu-1', BASE - 900_000, { delaySeconds: 600, reason: 'first wait' }),
      scheduleResult('tu-1', BASE - 899_000),
      scheduleCall('tu-2', BASE - 30_000, { delaySeconds: 600, reason: 'second wait', prompt: '/loop x' }),
      scheduleResult('tu-2', BASE - 29_000),
    ]);
    const w = readScheduledWakeups(fp);
    expect(w).toHaveLength(2);
    expect(w[0]).toMatchObject({ status: 'pending', reason: 'second wait', prompt: '/loop x', fireAt: BASE - 30_000 + 600_000 });
    expect(w[1]).toMatchObject({ status: 'superseded', reason: 'first wait' });
  });

  it('readScheduledWakeups: newest stop call reports stopped', () => {
    write([
      scheduleCall('tu-1', BASE - 60_000, { delaySeconds: 600, reason: 'wait' }),
      scheduleResult('tu-1', BASE - 59_000),
      scheduleCall('tu-2', BASE - 30_000, { stop: true }),
      scheduleResult('tu-2', BASE - 29_000),
    ]);
    const w = readScheduledWakeups(fp);
    expect(w[0].status).toBe('stopped');
    expect(w[1].status).toBe('superseded');
  });

  it('expires from the cached fast path without any file change', () => {
    const callTs = BASE - 30_000; // delay 150s → fires at BASE + 120s
    write([
      scheduleCall('tu-1', callTs, { delaySeconds: 150 }),
      scheduleResult('tu-1', callTs + 1000),
    ]);
    expect(readTranscriptState(fp).scheduledWakeupAt).toBe(callTs + 150_000);

    // Still pending shortly before the fire time.
    vi.advanceTimersByTime(60_000);
    expect(readTranscriptState(fp).scheduledWakeupAt).toBe(callTs + 150_000);

    // Past fire time + 30s grace, file untouched → cleared by re-eval.
    vi.advanceTimersByTime(120_000);
    expect(readTranscriptState(fp).scheduledWakeupAt).toBeUndefined();
  });
});
