import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readTranscriptState, _resetCachesForTest } from '../session/transcriptReader.js';

// Background-task detection: a session that launched `Bash(run_in_background: true)`
// and ended its turn is not "waiting for input" — the harness re-invokes it when the
// command exits. readTranscriptState surfaces the pending commands so the UI can show
// "running" instead of "waiting".
//
// Start  = Bash tool_use with run_in_background, CONFIRMED by the tool_result text
//          ("Command running in background with ID: …") — that text is the only
//          source of the shell id and output path.
// End    = a <task-notification> carrying the same <tool-use-id>, written on three
//          separate lines (queue-operation enqueue + remove, attachment/queued_command).
//
// Unlike scheduledWakeupAt this state is STICKY: a background command routinely
// outlives the tail window, so pending entries are carried on the transcript cache
// and dropped only by a notification, /clear, or the 6h TTL.

const BASE = new Date('2026-07-27T12:00:00Z').getTime();
// Pin mtime 60s in the past so derived state is a stable 'waiting'.
const PIN = new Date(BASE - 60_000);

function userMsg(text: string, tsMs: number): string {
  return JSON.stringify({ type: 'user', timestamp: new Date(tsMs).toISOString(), message: { content: text } });
}

function bashCall(id: string, tsMs: number, opts: { background?: boolean; description?: string } = {}): string {
  const input: Record<string, unknown> = { command: 'sleep 600', description: opts.description ?? 'Watch dev deploy' };
  if (opts.background !== false) input.run_in_background = true;
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(tsMs).toISOString(),
    message: {
      model: 'claude-opus-5',
      usage: { input_tokens: 10 },
      content: [{ type: 'tool_use', id, name: 'Bash', input }],
    },
  });
}

function launchResult(id: string, tsMs: number, taskId: string, opts: { isError?: boolean; text?: string } = {}): string {
  const text = opts.text ?? `Command running in background with ID: ${taskId}. Output is being written to: /tmp/tasks/${taskId}.output. You will be notified when it completes.`;
  return JSON.stringify({
    type: 'user',
    timestamp: new Date(tsMs).toISOString(),
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: opts.isError === true }] },
  });
}

function notificationXml(toolUseId: string, taskId: string, status: string): string {
  return [
    '<task-notification>',
    `<task-id>${taskId}</task-id>`,
    `<tool-use-id>${toolUseId}</tool-use-id>`,
    `<output-file>/tmp/tasks/${taskId}.output</output-file>`,
    `<status>${status}</status>`,
    `<summary>Background command "Watch dev deploy" ${status} (exit code 0)</summary>`,
    '</task-notification>',
  ].join('\n');
}

function queueOp(operation: 'enqueue' | 'remove', toolUseId: string, taskId: string, tsMs: number, status = 'completed'): string {
  return JSON.stringify({
    type: 'queue-operation',
    operation,
    timestamp: new Date(tsMs).toISOString(),
    content: notificationXml(toolUseId, taskId, status),
  });
}

function notificationAttachment(toolUseId: string, taskId: string, tsMs: number, status = 'completed'): string {
  return JSON.stringify({
    type: 'attachment',
    timestamp: new Date(tsMs).toISOString(),
    attachment: {
      type: 'queued_command',
      commandMode: 'task-notification',
      prompt: notificationXml(toolUseId, taskId, status),
      timestamp: new Date(tsMs).toISOString(),
    },
  });
}

describe('backgroundTasks detection', () => {
  let tmpDir: string;
  let fp: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlord-bgtask-'));
    fp = path.join(tmpDir, 'sess.jsonl');
    _resetCachesForTest();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BASE));
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(lines: string[], mtime: Date = PIN): void {
    fs.writeFileSync(fp, lines.join('\n') + '\n');
    fs.utimesSync(fp, mtime, mtime);
  }

  it('surfaces a launched background command', () => {
    const callTs = BASE - 30_000;
    write([
      userMsg('watch the deploy', BASE - 120_000),
      bashCall('tu-1', callTs, { description: 'Run dev-deploy watcher' }),
      launchResult('tu-1', callTs + 500, 'bw5hy60h4'),
    ]);
    const r = readTranscriptState(fp);
    expect(r.state).toBe('waiting');
    expect(r.backgroundTasks).toHaveLength(1);
    expect(r.backgroundTasks![0]).toMatchObject({
      toolUseId: 'tu-1',
      taskId: 'bw5hy60h4',
      description: 'Run dev-deploy watcher',
      outputFile: '/tmp/tasks/bw5hy60h4.output',
      startedAt: new Date(callTs).toISOString(),
    });
  });

  it('ignores run_in_background with no confirming tool_result', () => {
    write([bashCall('tu-1', BASE - 30_000)]);
    expect(readTranscriptState(fp).backgroundTasks).toBeUndefined();
  });

  it('ignores a launch whose tool_result is an error', () => {
    const callTs = BASE - 30_000;
    write([
      bashCall('tu-1', callTs),
      launchResult('tu-1', callTs + 500, 'bw5hy60h4', { isError: true }),
    ]);
    expect(readTranscriptState(fp).backgroundTasks).toBeUndefined();
  });

  it('ignores a foreground Bash call', () => {
    const callTs = BASE - 30_000;
    write([
      bashCall('tu-1', callTs, { background: false }),
      launchResult('tu-1', callTs + 500, 'bw5hy60h4'),
    ]);
    expect(readTranscriptState(fp).backgroundTasks).toBeUndefined();
  });

  it('clears the task on a queue-operation notification', () => {
    const callTs = BASE - 30_000;
    write([
      bashCall('tu-1', callTs),
      launchResult('tu-1', callTs + 500, 'bw5hy60h4'),
      queueOp('enqueue', 'tu-1', 'bw5hy60h4', BASE - 5_000),
    ]);
    expect(readTranscriptState(fp).backgroundTasks).toBeUndefined();
  });

  it('clears the task on an attachment task-notification', () => {
    const callTs = BASE - 30_000;
    write([
      bashCall('tu-1', callTs),
      launchResult('tu-1', callTs + 500, 'bw5hy60h4'),
      notificationAttachment('tu-1', 'bw5hy60h4', BASE - 5_000),
    ]);
    expect(readTranscriptState(fp).backgroundTasks).toBeUndefined();
  });

  it('handles all three notification lines for one task without underflow', () => {
    const callTs = BASE - 30_000;
    write([
      bashCall('tu-1', callTs),
      launchResult('tu-1', callTs + 500, 'bw5hy60h4'),
      bashCall('tu-2', callTs + 1_000, { description: 'Second watcher' }),
      launchResult('tu-2', callTs + 1_500, 'bq3jrgjop'),
      queueOp('enqueue', 'tu-1', 'bw5hy60h4', BASE - 6_000),
      queueOp('remove', 'tu-1', 'bw5hy60h4', BASE - 5_500),
      notificationAttachment('tu-1', 'bw5hy60h4', BASE - 5_000),
    ]);
    const r = readTranscriptState(fp);
    expect(r.backgroundTasks).toHaveLength(1);
    expect(r.backgroundTasks![0].toolUseId).toBe('tu-2');
  });

  it.each(['completed', 'failed', 'stopped', 'some_future_status'])(
    'treats status %s as terminal',
    (status) => {
      const callTs = BASE - 30_000;
      write([
        bashCall('tu-1', callTs),
        launchResult('tu-1', callTs + 500, 'bw5hy60h4'),
        queueOp('enqueue', 'tu-1', 'bw5hy60h4', BASE - 5_000, status),
      ]);
      expect(readTranscriptState(fp).backgroundTasks).toBeUndefined();
    },
  );

  it('ignores a notification for an unrelated tool-use-id', () => {
    const callTs = BASE - 30_000;
    write([
      bashCall('tu-1', callTs),
      launchResult('tu-1', callTs + 500, 'bw5hy60h4'),
      queueOp('enqueue', 'tu-other', 'bother', BASE - 5_000),
    ]);
    expect(readTranscriptState(fp).backgroundTasks).toHaveLength(1);
  });

  it('reports lastOutputAt from the output file mtime', () => {
    const outFile = path.join(tmpDir, 'bw5hy60h4.output');
    fs.writeFileSync(outFile, 'partial output\n');
    const outMtime = new Date(BASE - 3_000);
    fs.utimesSync(outFile, outMtime, outMtime);
    const callTs = BASE - 30_000;
    write([
      bashCall('tu-1', callTs),
      launchResult('tu-1', callTs + 500, 'bw5hy60h4', {
        text: `Command running in background with ID: bw5hy60h4. Output is being written to: ${outFile}. You will be notified when it completes.`,
      }),
    ]);
    expect(readTranscriptState(fp).backgroundTasks![0].lastOutputAt).toBe(outMtime.getTime());
  });

  it('stays pending after the launch scrolls out of the tail window', () => {
    const callTs = BASE - 30_000;
    const head = [
      bashCall('tu-1', callTs),
      launchResult('tu-1', callTs + 500, 'bw5hy60h4'),
    ];
    write(head);
    expect(readTranscriptState(fp).backgroundTasks).toHaveLength(1);

    // The window keeps the last 2000 lines; push the launch well past that.
    const filler = Array.from({ length: 2_500 }, (_, i) => userMsg(`filler ${i}`, BASE - 20_000 + i));
    const later = new Date(BASE - 5_000);
    write([...head, ...filler], later);
    vi.setSystemTime(new Date(BASE + 2_000));

    const r = readTranscriptState(fp);
    // Proof the launch really is out of the window: a fresh reader finds nothing.
    _resetCachesForTest();
    expect(readTranscriptState(fp).backgroundTasks).toBeUndefined();
    // …but the cached reader carried it.
    expect(r.backgroundTasks).toHaveLength(1);
    expect(r.backgroundTasks![0].toolUseId).toBe('tu-1');
  });

  it('drops a pending task older than the 6h TTL', () => {
    const callTs = BASE - 7 * 60 * 60 * 1000;
    write([
      bashCall('tu-1', callTs),
      launchResult('tu-1', callTs + 500, 'bw5hy60h4'),
    ]);
    expect(readTranscriptState(fp).backgroundTasks).toBeUndefined();
  });

  it('clears pending tasks when the transcript is truncated (/clear)', () => {
    const callTs = BASE - 30_000;
    write([
      bashCall('tu-1', callTs),
      launchResult('tu-1', callTs + 500, 'bw5hy60h4'),
      ...Array.from({ length: 50 }, (_, i) => userMsg(`padding ${i}`, BASE - 25_000 + i)),
    ]);
    expect(readTranscriptState(fp).backgroundTasks).toHaveLength(1);

    // /clear rewrites the file in place — smaller, and without the launch lines.
    const later = new Date(BASE - 5_000);
    write([userMsg('fresh start', BASE - 6_000)], later);
    vi.setSystemTime(new Date(BASE + 2_000));

    const r = readTranscriptState(fp);
    expect(r.transcriptTruncated).toBe(true);
    expect(r.backgroundTasks).toBeUndefined();
  });
});
