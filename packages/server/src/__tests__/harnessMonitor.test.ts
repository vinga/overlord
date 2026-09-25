import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readTranscriptState, parseMonitorNotification, _resetCachesForTest } from '../session/transcriptReader.js';

// Harness Monitor (Claude Code ≥ 2.1.27x). Unlike the streaming Monitor, the
// tool_result lands immediately ("Monitor started (task X, expires in 30m …)")
// and the watch then lives on as a task: every event is a <task-notification>
// with <task-id> + <event>, the end is a "stream ended" or "[Monitor expired"
// notification on the same id. The old `!toolResults.has(id)` gate hid these
// monitors entirely. Sticky across parses like background tasks.

const BASE = new Date('2026-09-22T13:26:00Z').getTime();
const PIN = new Date(BASE - 60_000);

function monitorCall(id: string, tsMs: number, description: string, timeoutMs?: number): string {
  const input: Record<string, unknown> = { command: 'for i in $(seq 1 40); do gh run list; sleep 45; done', description };
  if (timeoutMs !== undefined) input.timeout_ms = timeoutMs;
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(tsMs).toISOString(),
    message: { model: 'claude-opus-5', usage: { input_tokens: 10 }, content: [{ type: 'tool_use', id, name: 'Monitor', input }] },
  });
}

function launchResult(id: string, tsMs: number, taskId: string, minutes = 30): string {
  const text = `Monitor started (task ${taskId}, expires in ${minutes}m unless the source ends first; you get one notice at expiry — re-arm if you still need the watch). You will be notified on each event. Keep working — do not poll or sleep.`;
  return JSON.stringify({
    type: 'user',
    timestamp: new Date(tsMs).toISOString(),
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  });
}

function eventXml(taskId: string, description: string, event: string): string {
  return [
    '<task-notification>',
    `<task-id>${taskId}</task-id>`,
    `<summary>Monitor event: "${description}"</summary>`,
    `<event>${event}</event>`,
    'If this event is something the user would act on now, send a PushNotification.',
    '</task-notification>',
  ].join('\n');
}

function endedXml(taskId: string, description: string): string {
  return [
    '<task-notification>',
    `<task-id>${taskId}</task-id>`,
    '<tool-use-id>toolu_x</tool-use-id>',
    '<status>completed</status>',
    `<summary>Monitor "${description}" stream ended</summary>`,
    '</task-notification>',
  ].join('\n');
}

/** The harness-injected user turn carrying a notification (string content). */
function notifUser(xml: string, tsMs: number): string {
  return JSON.stringify({
    type: 'user',
    timestamp: new Date(tsMs).toISOString(),
    origin: { kind: 'task-notification' },
    promptSource: 'system',
    message: { role: 'user', content: xml },
  });
}

function queueOp(xml: string, tsMs: number): string {
  return JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date(tsMs).toISOString(), content: xml });
}

describe('harness Monitor detection', () => {
  let tmpDir: string;
  let fp: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlord-harness-monitor-'));
    fp = path.join(tmpDir, 'session.jsonl');
    _resetCachesForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(lines: string[]): void {
    fs.writeFileSync(fp, lines.join('\n') + '\n');
    fs.utimesSync(fp, PIN, PIN);
  }

  it('surfaces a launched monitor with its description, task id and expiry', () => {
    const callTs = BASE - 30_000;
    write([
      monitorCall('tu-1', callTs, 'CI on the rebased head', 1_800_000),
      launchResult('tu-1', callTs + 100, 'bcm2qj8g5'),
    ]);
    const r = readTranscriptState(fp);
    expect(r.activeMonitors).toHaveLength(1);
    expect(r.activeMonitors![0]).toMatchObject({
      toolUseId: 'tu-1',
      taskId: 'bcm2qj8g5',
      target: 'CI on the rebased head',
      expiresAt: callTs + 1_800_000,
    });
  });

  it('falls back to the "expires in Nm" of the launch result when timeout_ms is absent', () => {
    const callTs = BASE - 30_000;
    write([monitorCall('tu-1', callTs, 'dev redeploy'), launchResult('tu-1', callTs + 100, 'task1', 15)]);
    expect(readTranscriptState(fp).activeMonitors![0].expiresAt).toBe(callTs + 15 * 60_000);
  });

  it('pins the newest event onto the monitor', () => {
    const callTs = BASE - 30_000;
    write([
      monitorCall('tu-1', callTs, 'CI on the rebased head', 1_800_000),
      launchResult('tu-1', callTs + 100, 'bcm2qj8g5'),
      queueOp(eventXml('bcm2qj8g5', 'CI on the rebased head', 'static-analysis[2c51f0a:in_progress:]'), callTs + 5_000),
      notifUser(eventXml('bcm2qj8g5', 'CI on the rebased head', 'static-analysis[2c51f0a:in_progress:]'), callTs + 5_500),
      queueOp(eventXml('bcm2qj8g5', 'CI on the rebased head', 'static-analysis[2c51f0a:completed:success]'), callTs + 20_000),
      notifUser(eventXml('bcm2qj8g5', 'CI on the rebased head', 'static-analysis[2c51f0a:completed:success]'), callTs + 20_500),
    ]);
    const mon = readTranscriptState(fp).activeMonitors![0];
    expect(mon.lastEvent).toBe('static-analysis[2c51f0a:completed:success]');
    expect(mon.lastEventAt).toBe(new Date(callTs + 20_500).toISOString());
  });

  it('clears the monitor on its stream-ended notification', () => {
    const callTs = BASE - 30_000;
    write([
      monitorCall('tu-1', callTs, 'dev redeploy', 1_800_000),
      launchResult('tu-1', callTs + 100, 'b00nx95ba'),
      notifUser(endedXml('b00nx95ba', 'dev redeploy'), callTs + 10_000),
    ]);
    expect(readTranscriptState(fp).activeMonitors).toBeUndefined();
  });

  it('clears the monitor on the expiry notice', () => {
    const callTs = BASE - 30_000;
    write([
      monitorCall('tu-1', callTs, 'dev redeploy', 1_800_000),
      launchResult('tu-1', callTs + 100, 'b00nx95ba'),
      notifUser(eventXml('b00nx95ba', 'dev redeploy', '[Monitor expired after 30m with 4 events delivered. Re-arm it if you still need the watch.]'), callTs + 10_000),
    ]);
    expect(readTranscriptState(fp).activeMonitors).toBeUndefined();
  });

  it('stays sticky once the launch scrolls out of the tail window, and expires by clock', () => {
    const callTs = BASE - 30_000;
    write([monitorCall('tu-1', callTs, 'CI watch', 120_000), launchResult('tu-1', callTs + 100, 'tk1')]);
    expect(readTranscriptState(fp).activeMonitors).toHaveLength(1);

    // Replace the whole file with a large tail of unrelated turns — the launch
    // is gone from the window but the watch is carried forward.
    const filler: string[] = [monitorCall('tu-1', callTs, 'CI watch', 120_000), launchResult('tu-1', callTs + 100, 'tk1')];
    for (let i = 0; i < 1200; i++) {
      filler.push(JSON.stringify({ type: 'user', timestamp: new Date(callTs + 1000 + i).toISOString(), message: { content: `msg ${i}` } }));
    }
    fs.writeFileSync(fp, filler.join('\n') + '\n');
    fs.utimesSync(fp, new Date(BASE - 30_000), new Date(BASE - 30_000));
    vi.advanceTimersByTime(5_000);
    expect(readTranscriptState(fp).activeMonitors).toHaveLength(1);

    // Past expiresAt + grace with no notification → dropped.
    vi.advanceTimersByTime(200_000);
    fs.utimesSync(fp, new Date(BASE - 20_000), new Date(BASE - 20_000));
    expect(readTranscriptState(fp).activeMonitors).toBeUndefined();
  });

  it('ignores a monitor whose launch errored', () => {
    const callTs = BASE - 30_000;
    write([
      monitorCall('tu-1', callTs, 'bad', 1_800_000),
      JSON.stringify({ type: 'user', timestamp: new Date(callTs + 100).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'Monitor failed: no such task', is_error: true }] } }),
    ]);
    expect(readTranscriptState(fp).activeMonitors).toBeUndefined();
  });
});

describe('parseMonitorNotification', () => {
  it('classifies event / ended / expired and tolerates the escaped-quote variant', () => {
    expect(parseMonitorNotification(eventXml('t1', 'CI', 'a[b:c]'), 'ts')).toEqual({ taskId: 't1', kind: 'event', description: 'CI', event: 'a[b:c]', timestamp: 'ts' });
    expect(parseMonitorNotification(endedXml('t1', 'CI'))).toMatchObject({ taskId: 't1', kind: 'ended', description: 'CI' });
    expect(parseMonitorNotification(eventXml('t1', 'CI', '[Monitor expired after 15m]'))).toMatchObject({ kind: 'expired' });
    expect(parseMonitorNotification('<task-notification>\n<task-id>t2</task-id>\n<summary>Monitor event: \\"x\\"</summary>\n<event>e</event>\n</task-notification>')).toMatchObject({ taskId: 't2', kind: 'event', description: 'x' });
  });

  it('returns undefined for a background-command notification', () => {
    const xml = '<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>tu</tool-use-id>\n<status>completed</status>\n<summary>Background command "x" completed (exit code 0)</summary>\n</task-notification>';
    expect(parseMonitorNotification(xml)).toBeUndefined();
  });
});
