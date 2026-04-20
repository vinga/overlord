import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PlanStore } from '../plans/planStore.js';

describe('PlanStore', () => {
  let baseDir: string;
  let plansDir: string;
  let store: PlanStore;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'planStore-'));
    plansDir = path.join(baseDir, 'plans');
    store = new PlanStore({ baseDir, debounceMs: 20 });
  });

  afterEach(async () => {
    await store.flushAll();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('create writes a *.md file and loadAll recovers it', async () => {
    const plan = store.create({
      overlordId: 'ovr-a',
      cwd: '/tmp/room',
      title: 'First plan',
      body: '# Hello\n\nbody',
      source: 'user',
    });
    await store.flushAll();

    const filePath = path.join(plansDir, `${plan.planId}.md`);
    expect(fs.existsSync(filePath)).toBe(true);

    const fresh = new PlanStore({ baseDir });
    fresh.loadAll();
    const reloaded = fresh.get(plan.planId);
    expect(reloaded).toBeDefined();
    expect(reloaded?.title).toBe('First plan');
    expect(reloaded?.body).toBe('# Hello\n\nbody');
    expect(reloaded?.source).toBe('user');
    expect(reloaded?.overlordId).toBe('ovr-a');
  });

  it('malformed file is skipped without throwing', () => {
    fs.mkdirSync(plansDir, { recursive: true });
    fs.writeFileSync(path.join(plansDir, 'bad.md'), 'not a plan file', 'utf-8');
    fs.writeFileSync(
      path.join(plansDir, 'good.md'),
      '---\nplanId: good\noverlordId: ovr-x\ncwd: /tmp\ncreatedAt: 2026-01-01T00:00:00.000Z\nupdatedAt: 2026-01-01T00:00:00.000Z\ntitle: t\nstatus: draft\nsource: user\n---\n\nbody\n',
      'utf-8',
    );
    const fresh = new PlanStore({ baseDir });
    expect(() => fresh.loadAll()).not.toThrow();
    expect(fresh.list()).toHaveLength(1);
    expect(fresh.get('good')?.title).toBe('t');
  });

  it('patch updates updatedAt and merges fields', async () => {
    const plan = store.create({
      overlordId: 'ovr-p',
      cwd: '/tmp/room',
      title: 'T',
      body: 'b',
      source: 'user',
    });
    const before = plan.updatedAt;
    await new Promise(r => setTimeout(r, 5));
    const updated = store.patch(plan.planId, { title: 'T2', status: 'active' });
    expect(updated?.title).toBe('T2');
    expect(updated?.status).toBe('active');
    expect(updated?.updatedAt).not.toBe(before);
  });

  it('concurrent patches end up merged on disk', async () => {
    const plan = store.create({
      overlordId: 'ovr-c',
      cwd: '/tmp/room',
      title: 'T',
      body: '',
      source: 'user',
    });
    store.patch(plan.planId, { title: 'A' });
    store.patch(plan.planId, { body: 'B' });
    await store.flushAll();

    const fresh = new PlanStore({ baseDir });
    fresh.loadAll();
    const reloaded = fresh.get(plan.planId);
    expect(reloaded?.title).toBe('A');
    expect(reloaded?.body).toBe('B');
  });

  it('remove deletes the file and the in-memory entry', async () => {
    const plan = store.create({
      overlordId: 'ovr-r',
      cwd: '/tmp/room',
      title: 'T',
      body: '',
      source: 'user',
    });
    await store.flushAll();
    const filePath = path.join(plansDir, `${plan.planId}.md`);
    expect(fs.existsSync(filePath)).toBe(true);

    expect(store.remove(plan.planId)).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(store.get(plan.planId)).toBeUndefined();
  });

  it('upsertFromClaude dedupes by claudePlanToolUseId', () => {
    const a = store.upsertFromClaude({
      overlordId: 'ovr-u',
      cwd: '/tmp/room',
      claudePlanToolUseId: 'toolu_X',
      body: 'one',
      status: 'draft',
    });
    const b = store.upsertFromClaude({
      overlordId: 'ovr-u',
      cwd: '/tmp/room',
      claudePlanToolUseId: 'toolu_X',
      body: 'two',
      status: 'active',
    });
    expect(a.planId).toBe(b.planId);
    expect(store.listByOverlord('ovr-u')).toHaveLength(1);
    expect(store.get(a.planId)?.body).toBe('two');
    expect(store.get(a.planId)?.status).toBe('active');
  });

  it('listByOverlord and listByCwd return correct subsets', () => {
    store.create({ overlordId: 'ovr-1', cwd: '/tmp/A', title: 'x', body: '', source: 'user' });
    store.create({ overlordId: 'ovr-1', cwd: '/tmp/A', title: 'y', body: '', source: 'user' });
    store.create({ overlordId: 'ovr-2', cwd: '/tmp/B', title: 'z', body: '', source: 'user' });
    expect(store.listByOverlord('ovr-1')).toHaveLength(2);
    expect(store.listByOverlord('ovr-2')).toHaveLength(1);
    expect(store.listByCwd('/tmp/A')).toHaveLength(2);
    expect(store.listByCwd('/tmp/B')).toHaveLength(1);
  });
});
