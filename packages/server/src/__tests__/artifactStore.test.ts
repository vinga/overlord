import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ArtifactStore } from '../artifacts/artifactStore.js';

describe('ArtifactStore', () => {
  let baseDir: string;
  let artifactsDir: string;
  let store: ArtifactStore;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifactStore-'));
    artifactsDir = path.join(baseDir, 'artifacts');
    store = new ArtifactStore({ baseDir, debounceMs: 20 });
  });

  afterEach(async () => {
    await store.flushAll();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('create writes a *.md file and loadAll recovers it', async () => {
    const artifact = store.create({
      kind: 'plan',
      overlordId: 'ovr-a',
      cwd: '/tmp/room',
      title: 'First plan',
      body: '# Hello\n\nbody',
      source: 'user',
    });
    await store.flushAll();

    const filePath = path.join(artifactsDir, `${artifact.artifactId}.md`);
    expect(fs.existsSync(filePath)).toBe(true);

    const fresh = new ArtifactStore({ baseDir });
    fresh.loadAll();
    const reloaded = fresh.get(artifact.artifactId);
    expect(reloaded).toBeDefined();
    expect(reloaded?.title).toBe('First plan');
    expect(reloaded?.body).toBe('# Hello\n\nbody');
    expect(reloaded?.source).toBe('user');
    expect(reloaded?.overlordId).toBe('ovr-a');
    expect(reloaded?.kind).toBe('plan');
  });

  it('malformed file is skipped without throwing', () => {
    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.writeFileSync(path.join(artifactsDir, 'bad.md'), 'not an artifact file', 'utf-8');
    fs.writeFileSync(
      path.join(artifactsDir, 'good.md'),
      '---\nartifactId: good\nkind: plan\noverlordId: ovr-x\ncwd: /tmp\ncreatedAt: 2026-01-01T00:00:00.000Z\nupdatedAt: 2026-01-01T00:00:00.000Z\ntitle: t\nstatus: draft\nsource: user\n---\n\nbody\n',
      'utf-8',
    );
    const fresh = new ArtifactStore({ baseDir });
    expect(() => fresh.loadAll()).not.toThrow();
    expect(fresh.list()).toHaveLength(1);
    expect(fresh.get('good')?.title).toBe('t');
  });

  it('patch updates updatedAt and merges fields', async () => {
    const artifact = store.create({
      kind: 'plan',
      overlordId: 'ovr-p',
      cwd: '/tmp/room',
      title: 'T',
      body: 'b',
      source: 'user',
    });
    const before = artifact.updatedAt;
    await new Promise(r => setTimeout(r, 5));
    const updated = store.patch(artifact.artifactId, { title: 'T2', status: 'active' });
    expect(updated?.title).toBe('T2');
    expect(updated?.status).toBe('active');
    expect(updated?.updatedAt).not.toBe(before);
  });

  it('concurrent patches end up merged on disk', async () => {
    const artifact = store.create({
      kind: 'plan',
      overlordId: 'ovr-c',
      cwd: '/tmp/room',
      title: 'T',
      body: '',
      source: 'user',
    });
    store.patch(artifact.artifactId, { title: 'A' });
    store.patch(artifact.artifactId, { body: 'B' });
    await store.flushAll();

    const fresh = new ArtifactStore({ baseDir });
    fresh.loadAll();
    const reloaded = fresh.get(artifact.artifactId);
    expect(reloaded?.title).toBe('A');
    expect(reloaded?.body).toBe('B');
  });

  it('remove deletes the file and the in-memory entry', async () => {
    const artifact = store.create({
      kind: 'plan',
      overlordId: 'ovr-r',
      cwd: '/tmp/room',
      title: 'T',
      body: '',
      source: 'user',
    });
    await store.flushAll();
    const filePath = path.join(artifactsDir, `${artifact.artifactId}.md`);
    expect(fs.existsSync(filePath)).toBe(true);

    expect(store.remove(artifact.artifactId)).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(store.get(artifact.artifactId)).toBeUndefined();
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
    expect(a.artifactId).toBe(b.artifactId);
    expect(store.listByOverlord('ovr-u')).toHaveLength(1);
    expect(store.get(a.artifactId)?.body).toBe('two');
    expect(store.get(a.artifactId)?.status).toBe('active');
    expect(store.get(a.artifactId)?.kind).toBe('plan');
  });

  it('listByOverlord and listByCwd return correct subsets', () => {
    store.create({ kind: 'plan', overlordId: 'ovr-1', cwd: '/tmp/A', title: 'x', body: '', source: 'user' });
    store.create({ kind: 'plan', overlordId: 'ovr-1', cwd: '/tmp/A', title: 'y', body: '', source: 'user' });
    store.create({ kind: 'plan', overlordId: 'ovr-2', cwd: '/tmp/B', title: 'z', body: '', source: 'user' });
    expect(store.listByOverlord('ovr-1')).toHaveLength(2);
    expect(store.listByOverlord('ovr-2')).toHaveLength(1);
    expect(store.listByCwd('/tmp/A')).toHaveLength(2);
    expect(store.listByCwd('/tmp/B')).toHaveLength(1);
  });

  it('kind filter narrows list results', () => {
    store.create({ kind: 'plan', overlordId: 'ovr-k', cwd: '/tmp/K', title: 'p', body: '', source: 'user' });
    store.create({ kind: 'summary', overlordId: 'ovr-k', cwd: '/tmp/K', title: 's', body: '', source: 'user' });
    expect(store.list('plan')).toHaveLength(1);
    expect(store.list('summary')).toHaveLength(1);
    expect(store.list('compact')).toHaveLength(0);
    expect(store.listByOverlord('ovr-k', 'plan')).toHaveLength(1);
    expect(store.listByCwd('/tmp/K', 'summary')).toHaveLength(1);
  });
});
