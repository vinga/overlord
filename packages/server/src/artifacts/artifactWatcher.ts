import chokidar, { type FSWatcher } from 'chokidar';
import path from 'node:path';
import type { ArtifactStore } from './artifactStore.js';
import type { ArtifactChangedEvent } from './types.js';

export type ArtifactChangeListener = (event: ArtifactChangedEvent) => void;

/**
 * Watches `{baseDir}/artifacts/*.md` for external edits (user editing files in an
 * editor, etc.). Calls `artifactStore.refreshFromDisk()` on every change event and
 * fires the listener with `artifact:changed` when the parsed state differs from
 * what we hold in-memory.
 *
 * Own writes are suppressed via the `artifactStore.ownWrites` set — each atomic
 * write records the basename, then the first change event with that basename
 * clears the suppression.
 */
export class ArtifactWatcher {
  private watcher: FSWatcher | null = null;

  constructor(
    private readonly store: ArtifactStore,
    private readonly listener: ArtifactChangeListener,
    private readonly debounceMs = 100,
  ) {}

  start(): void {
    if (this.watcher) return;
    const pattern = path.join(this.store.artifactsDir, '*.md');
    this.watcher = chokidar.watch(pattern, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: this.debounceMs, pollInterval: 30 },
    });
    this.watcher.on('add', (full) => this.handle(full, 'create'));
    this.watcher.on('change', (full) => this.handle(full, 'update'));
    this.watcher.on('unlink', (full) => this.handleUnlink(full));
    this.watcher.on('error', () => { /* ignore */ });
  }

  async stop(): Promise<void> {
    if (!this.watcher) return;
    await this.watcher.close().catch(() => {});
    this.watcher = null;
  }

  private handle(full: string, op: 'create' | 'update'): void {
    const base = path.basename(full);
    if (this.store.ownWrites.has(base)) {
      this.store.ownWrites.delete(base);
      return;
    }
    const artifactId = base.replace(/\.md$/, '');
    const result = this.store.refreshFromDisk(artifactId);
    if (!result || !result.changed) return;
    this.listener({
      type: 'artifact:changed',
      artifactId: result.artifact.artifactId,
      kind: result.artifact.kind,
      overlordId: result.artifact.overlordId,
      cwd: result.artifact.cwd,
      op,
    });
  }

  private handleUnlink(full: string): void {
    const base = path.basename(full);
    if (this.store.ownWrites.has(base)) {
      this.store.ownWrites.delete(base);
      return;
    }
    const artifactId = base.replace(/\.md$/, '');
    const existing = this.store.get(artifactId);
    if (!existing) return;
    // External deletion: drop from memory without re-deleting the file.
    this.store.remove(artifactId);
    this.listener({
      type: 'artifact:changed',
      artifactId: existing.artifactId,
      kind: existing.kind,
      overlordId: existing.overlordId,
      cwd: existing.cwd,
      op: 'delete',
    });
  }
}
