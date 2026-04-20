import chokidar, { type FSWatcher } from 'chokidar';
import path from 'node:path';
import type { PlanStore } from './planStore.js';
import type { PlanChangedEvent } from './types.js';

export type PlanChangeListener = (event: PlanChangedEvent) => void;

/**
 * Watches `{baseDir}/plans/*.md` for external edits (user editing files in an
 * editor, migration writes, etc.). Calls `planStore.refreshFromDisk()` on every
 * change event and fires the listener with `plan:changed` when the parsed state
 * differs from what we hold in-memory.
 *
 * Own writes are suppressed via the `planStore.ownWrites` set — each atomic
 * write records the basename, then the first change event with that basename
 * clears the suppression.
 */
export class PlanWatcher {
  private watcher: FSWatcher | null = null;

  constructor(
    private readonly store: PlanStore,
    private readonly listener: PlanChangeListener,
    private readonly debounceMs = 100,
  ) {}

  start(): void {
    if (this.watcher) return;
    const pattern = path.join(this.store.plansDir, '*.md');
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
    const planId = base.replace(/\.md$/, '');
    const result = this.store.refreshFromDisk(planId);
    if (!result || !result.changed) return;
    this.listener({
      type: 'plan:changed',
      planId: result.plan.planId,
      overlordId: result.plan.overlordId,
      cwd: result.plan.cwd,
      op,
    });
  }

  private handleUnlink(full: string): void {
    const base = path.basename(full);
    if (this.store.ownWrites.has(base)) {
      this.store.ownWrites.delete(base);
      return;
    }
    const planId = base.replace(/\.md$/, '');
    const existing = this.store.get(planId);
    if (!existing) return;
    // External deletion: drop from memory without re-deleting the file.
    this.store.remove(planId);
    this.listener({
      type: 'plan:changed',
      planId: existing.planId,
      overlordId: existing.overlordId,
      cwd: existing.cwd,
      op: 'delete',
    });
  }
}
