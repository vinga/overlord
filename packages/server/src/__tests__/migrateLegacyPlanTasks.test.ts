import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PlanStore } from '../plans/planStore.js';
import { migrateLegacyPlanTasks } from '../plans/migrateLegacyPlanTasks.js';

describe('migrateLegacyPlanTasks', () => {
  let baseDir: string;
  let sessionsDir: string;
  let plansDir: string;
  let store: PlanStore;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'planMig-'));
    sessionsDir = path.join(baseDir, 'overlord-sessions');
    plansDir = path.join(baseDir, 'plans');
    fs.mkdirSync(sessionsDir, { recursive: true });
    store = new PlanStore({ baseDir, debounceMs: 20 });
  });

  afterEach(async () => {
    await store.flushAll();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  function writeSession(filename: string, data: Record<string, unknown>): string {
    const full = path.join(sessionsDir, filename);
    fs.writeFileSync(full, JSON.stringify(data, null, 2), 'utf-8');
    return full;
  }

  it('converts two legacy planTasks entries into plan files and strips the field', async () => {
    const sessionPath = writeSession('ovr-1.json', {
      overlordId: 'ovr-1',
      cwd: '/tmp/room-one',
      planTasks: [
        {
          planToolUseId: 'toolu_A',
          planContent: '# Plan A\n\nfirst',
          planStatus: 'approved',
          title: 'Plan A',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
          planToolUseId: 'toolu_B',
          planContent: '# Plan B\n\nsecond',
          planStatus: 'rejected',
          summary: 'Plan B',
          createdAt: '2026-01-02T00:00:00.000Z',
        },
      ],
    });

    const result = migrateLegacyPlanTasks(store, { baseDir });
    await store.flushAll();

    expect(result.migrated).toBe(2);
    expect(result.errors).toEqual([]);
    expect(result.markerWritten).toBe(true);

    const planFiles = fs.readdirSync(plansDir).filter(f => f.endsWith('.md'));
    expect(planFiles).toHaveLength(2);

    const plans = store.listByOverlord('ovr-1');
    expect(plans).toHaveLength(2);

    const byTool = new Map(plans.map(p => [p.claudePlanToolUseId, p]));
    const a = byTool.get('toolu_A');
    const b = byTool.get('toolu_B');
    expect(a?.source).toBe('claude');
    expect(a?.status).toBe('active');
    expect(a?.body).toBe('# Plan A\n\nfirst');
    expect(a?.cwd).toBe('/tmp/room-one');
    expect(b?.source).toBe('claude');
    expect(b?.status).toBe('archived');
    expect(b?.body).toBe('# Plan B\n\nsecond');

    const rewritten = JSON.parse(fs.readFileSync(sessionPath, 'utf-8')) as Record<string, unknown>;
    expect(rewritten.planTasks).toBeUndefined();
    expect(rewritten.overlordId).toBe('ovr-1');

    const marker = path.join(baseDir, '.plans-migration-v1-done');
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('maps legacy statuses: approved→active, rejected→archived, other→draft', async () => {
    writeSession('ovr-map.json', {
      overlordId: 'ovr-map',
      cwd: '/tmp/map',
      planTasks: [
        { planToolUseId: 't_app', planContent: '', planStatus: 'approved' },
        { planToolUseId: 't_rej', planContent: '', planStatus: 'rejected' },
        { planToolUseId: 't_pend', planContent: '', planStatus: 'pending' },
      ],
    });

    migrateLegacyPlanTasks(store, { baseDir });
    await store.flushAll();

    const plans = store.listByOverlord('ovr-map');
    const byTool = new Map(plans.map(p => [p.claudePlanToolUseId, p]));
    expect(byTool.get('t_app')?.status).toBe('active');
    expect(byTool.get('t_rej')?.status).toBe('archived');
    expect(byTool.get('t_pend')?.status).toBe('draft');
  });

  it('is a no-op on second run (marker present)', async () => {
    writeSession('ovr-once.json', {
      overlordId: 'ovr-once',
      cwd: '/tmp/once',
      planTasks: [
        { planToolUseId: 'tu_once', planContent: 'x', planStatus: 'approved' },
      ],
    });

    const first = migrateLegacyPlanTasks(store, { baseDir });
    expect(first.migrated).toBe(1);

    const second = migrateLegacyPlanTasks(store, { baseDir });
    expect(second.attempted).toBe(0);
    expect(second.migrated).toBe(0);
  });

  it('skips tasks without planToolUseId', async () => {
    writeSession('ovr-skip.json', {
      overlordId: 'ovr-skip',
      cwd: '/tmp/skip',
      planTasks: [
        { planContent: 'no id', planStatus: 'approved' },
        { planToolUseId: 'tu_ok', planContent: 'ok', planStatus: 'approved' },
      ],
    });

    const result = migrateLegacyPlanTasks(store, { baseDir });
    expect(result.skipped).toBe(1);
    expect(result.migrated).toBe(1);
  });

  it('ignores files without planTasks or overlordId', async () => {
    writeSession('empty.json', { overlordId: 'ovr-e', cwd: '/tmp/e' });
    writeSession('no-id.json', { cwd: '/tmp/x', planTasks: [{ planToolUseId: 'z' }] });

    const result = migrateLegacyPlanTasks(store, { baseDir });
    expect(result.migrated).toBe(0);
    expect(result.errors).toEqual([]);
  });
});
