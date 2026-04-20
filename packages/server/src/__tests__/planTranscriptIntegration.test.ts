import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readTranscriptState } from '../session/transcriptReader.js';
import { PlanStore } from '../plans/planStore.js';
import type { PlanStatus } from '../plans/types.js';

function planStatusFromClaude(s: 'approved' | 'rejected' | 'pending'): PlanStatus {
  if (s === 'approved') return 'active';
  if (s === 'rejected') return 'archived';
  return 'draft';
}

function deriveTitle(body: string): string {
  const firstLine = body.split('\n').find(l => l.trim().length > 0) ?? 'Untitled plan';
  return firstLine.replace(/^#+\s*/, '').slice(0, 80);
}

function writeTranscript(dir: string, entries: unknown[]): string {
  const filePath = path.join(dir, `transcript-${Date.now()}.jsonl`);
  const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(filePath, lines, 'utf-8');
  return filePath;
}

describe('transcript → planStore integration', () => {
  let baseDir: string;
  let transcriptDir: string;
  let store: PlanStore;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'planTx-'));
    transcriptDir = path.join(baseDir, 'transcripts');
    fs.mkdirSync(transcriptDir, { recursive: true });
    store = new PlanStore({ baseDir, debounceMs: 20 });
  });

  afterEach(async () => {
    await store.flushAll();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  function applyDetected(overlordId: string, cwd: string, filePath: string) {
    const state = readTranscriptState(filePath);
    const detected = state.detectedPlans ?? [];
    for (const p of detected) {
      store.upsertFromClaude({
        overlordId,
        cwd,
        claudePlanToolUseId: p.planToolUseId,
        body: p.plan,
        status: planStatusFromClaude(p.planStatus),
        title: deriveTitle(p.plan),
      });
    }
    return detected;
  }

  it('one ExitPlanMode entry → one plan file', async () => {
    const transcript = writeTranscript(transcriptDir, [
      {
        type: 'assistant',
        timestamp: '2026-04-20T10:00:00.000Z',
        message: {},
        uuid: 'u1',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_plan_1',
            name: 'ExitPlanMode',
            input: { plan: '# My Plan\n\nbody text' },
          },
        ],
      },
      {
        type: 'user',
        timestamp: '2026-04-20T10:00:01.000Z',
        uuid: 'u2',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_plan_1',
            content: 'User approved the plan',
          },
        ],
      },
    ]);

    const detected = applyDetected('ovr-tx1', '/tmp/room-tx', transcript);
    expect(detected).toHaveLength(1);
    expect(detected[0].planStatus).toBe('approved');

    await store.flushAll();
    const plans = store.listByOverlord('ovr-tx1');
    expect(plans).toHaveLength(1);
    expect(plans[0].claudePlanToolUseId).toBe('toolu_plan_1');
    expect(plans[0].status).toBe('active');
    expect(plans[0].body).toBe('# My Plan\n\nbody text');

    const plansDir = path.join(baseDir, 'plans');
    const files = fs.readdirSync(plansDir).filter(f => f.endsWith('.md'));
    expect(files).toHaveLength(1);
  });

  it('processing the same transcript twice yields only one file (dedup by toolUseId)', async () => {
    const transcript = writeTranscript(transcriptDir, [
      {
        type: 'assistant',
        timestamp: '2026-04-20T11:00:00.000Z',
        uuid: 'u1',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_plan_dup',
            name: 'ExitPlanMode',
            input: { plan: '# Dup Plan\n\nonce' },
          },
        ],
      },
      {
        type: 'user',
        timestamp: '2026-04-20T11:00:01.000Z',
        uuid: 'u2',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_plan_dup',
            content: 'User approved the plan',
          },
        ],
      },
    ]);

    applyDetected('ovr-txd', '/tmp/room-d', transcript);
    applyDetected('ovr-txd', '/tmp/room-d', transcript);
    await store.flushAll();

    const plans = store.listByOverlord('ovr-txd');
    expect(plans).toHaveLength(1);

    const plansDir = path.join(baseDir, 'plans');
    const files = fs.readdirSync(plansDir).filter(f => f.endsWith('.md'));
    expect(files).toHaveLength(1);
  });

  it('rejected plan maps to archived status', async () => {
    const transcript = writeTranscript(transcriptDir, [
      {
        type: 'assistant',
        timestamp: '2026-04-20T12:00:00.000Z',
        uuid: 'u1',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_plan_rej',
            name: 'ExitPlanMode',
            input: { plan: '# Rejected\n\nbody' },
          },
        ],
      },
      {
        type: 'user',
        timestamp: '2026-04-20T12:00:01.000Z',
        uuid: 'u2',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_plan_rej',
            content: 'User denied the plan with feedback',
          },
        ],
      },
    ]);

    applyDetected('ovr-txr', '/tmp/room-r', transcript);
    await store.flushAll();

    const plans = store.listByOverlord('ovr-txr');
    expect(plans).toHaveLength(1);
    expect(plans[0].status).toBe('archived');
  });
});
