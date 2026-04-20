import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Plan, PlanMeta, PlanSource, PlanStatus } from './types.js';
import { parsePlanFile, serializePlanFile } from './frontmatter.js';

function defaultBaseDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  return path.join(home, '.claude', 'overlord');
}

const DEFAULT_DEBOUNCE_MS = 200;

function isValidPlanId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id) && id.length > 0 && id.length <= 120;
}

function generatePlanId(): string {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `plan-${stamp}-${rand}`;
}

export interface PlanStoreOptions {
  baseDir?: string;
  debounceMs?: number;
}

export interface CreateInput {
  overlordId: string;
  cwd: string;
  title: string;
  body: string;
  source: PlanSource;
  claudePlanToolUseId?: string;
}

export interface UpsertFromClaudeInput {
  overlordId: string;
  cwd: string;
  claudePlanToolUseId: string;
  body: string;
  status: PlanStatus;
  title?: string;
}

export type PlanPatch = Partial<Pick<Plan, 'title' | 'body' | 'status'>>;

/**
 * Durable store for Plan records. One markdown file per planId.
 *
 * Layout:
 *   {baseDir}/plans/{planId}.md   flat, mirrors overlord-sessions/
 *
 * Secondary indexes maintained on every mutation:
 *   - overlordId  → Set<planId>
 *   - cwd         → Set<planId>
 *   - claudeToolUseId → planId   (dedup key for source='claude')
 *
 * Writes:
 *   - Patches merge into in-memory Map immediately.
 *   - Each planId has a Promise chain serializing writes.
 *   - A per-planId debounce timer coalesces rapid patches into one flush.
 *   - Flush is atomic: tmp + rename.
 *   - Removal is synchronous.
 */
export class PlanStore {
  private plans = new Map<string, Plan>();
  private byOverlord = new Map<string, Set<string>>();
  private byCwd = new Map<string, Set<string>>();
  private byClaudeToolUseId = new Map<string, string>();

  private flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private writeChain = new Map<string, Promise<void>>();
  private dirty = new Set<string>();

  private readonly baseDir: string;
  private readonly debounceMs: number;

  /** Set of basenames we just wrote ourselves — used to suppress chokidar echo. */
  readonly ownWrites = new Set<string>();

  constructor(opts: PlanStoreOptions = {}) {
    this.baseDir = opts.baseDir ?? defaultBaseDir();
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  get plansDir(): string {
    return path.join(this.baseDir, 'plans');
  }

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  private filePath(planId: string): string {
    return path.join(this.plansDir, `${planId}.md`);
  }

  private addToIndexes(plan: Plan): void {
    if (!this.byOverlord.has(plan.overlordId)) this.byOverlord.set(plan.overlordId, new Set());
    this.byOverlord.get(plan.overlordId)!.add(plan.planId);
    if (!this.byCwd.has(plan.cwd)) this.byCwd.set(plan.cwd, new Set());
    this.byCwd.get(plan.cwd)!.add(plan.planId);
    if (plan.claudePlanToolUseId) {
      this.byClaudeToolUseId.set(plan.claudePlanToolUseId, plan.planId);
    }
  }

  private removeFromIndexes(plan: Plan): void {
    this.byOverlord.get(plan.overlordId)?.delete(plan.planId);
    this.byCwd.get(plan.cwd)?.delete(plan.planId);
    if (plan.claudePlanToolUseId) this.byClaudeToolUseId.delete(plan.claudePlanToolUseId);
  }

  loadAll(): void {
    this.plans.clear();
    this.byOverlord.clear();
    this.byCwd.clear();
    this.byClaudeToolUseId.clear();

    this.ensureDir(this.plansDir);

    let files: string[];
    try { files = fs.readdirSync(this.plansDir); } catch { return; }

    for (const f of files) {
      if (!f.endsWith('.md') || f.endsWith('.tmp')) continue;
      const full = path.join(this.plansDir, f);
      try {
        const raw = fs.readFileSync(full, 'utf-8');
        const parsed = parsePlanFile(raw);
        if (!parsed.ok) {
          console.warn(`[planStore] skip ${f}: ${parsed.reason}`);
          continue;
        }
        this.plans.set(parsed.plan.planId, parsed.plan);
        this.addToIndexes(parsed.plan);
      } catch (err) {
        console.warn(`[planStore] skip malformed ${f}: ${(err as Error).message}`);
      }
    }
  }

  // ── lookups ───────────────────────────────────────────────────────────────

  get(planId: string): Plan | undefined {
    return this.plans.get(planId);
  }

  list(): Plan[] {
    return [...this.plans.values()];
  }

  listByOverlord(overlordId: string): Plan[] {
    const ids = this.byOverlord.get(overlordId);
    if (!ids) return [];
    const out: Plan[] = [];
    for (const id of ids) {
      const p = this.plans.get(id);
      if (p) out.push(p);
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  listByCwd(cwd: string): Plan[] {
    const ids = this.byCwd.get(cwd);
    if (!ids) return [];
    const out: Plan[] = [];
    for (const id of ids) {
      const p = this.plans.get(id);
      if (p) out.push(p);
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getByClaudeToolUseId(toolUseId: string): Plan | undefined {
    const planId = this.byClaudeToolUseId.get(toolUseId);
    if (!planId) return undefined;
    return this.plans.get(planId);
  }

  // ── mutations ─────────────────────────────────────────────────────────────

  create(input: CreateInput): Plan {
    const now = new Date().toISOString();
    const planId = generatePlanId();
    if (!isValidPlanId(planId)) throw new Error(`invalid planId: ${planId}`);

    const meta: PlanMeta = {
      planId,
      overlordId: input.overlordId,
      cwd: input.cwd,
      createdAt: now,
      updatedAt: now,
      title: input.title.slice(0, 120),
      status: 'draft',
      source: input.source,
      claudePlanToolUseId: input.claudePlanToolUseId,
    };
    const plan: Plan = { ...meta, body: input.body };

    this.plans.set(planId, plan);
    this.addToIndexes(plan);
    this.scheduleFlush(planId);
    return plan;
  }

  patch(planId: string, partial: PlanPatch): Plan | undefined {
    const existing = this.plans.get(planId);
    if (!existing) return undefined;

    const merged: Plan = {
      ...existing,
      ...(partial.title !== undefined ? { title: partial.title.slice(0, 120) } : {}),
      ...(partial.body !== undefined ? { body: partial.body } : {}),
      ...(partial.status !== undefined ? { status: partial.status } : {}),
      updatedAt: new Date().toISOString(),
    };

    this.plans.set(planId, merged);
    this.scheduleFlush(planId);
    return merged;
  }

  remove(planId: string): boolean {
    const existing = this.plans.get(planId);
    if (!existing) return false;

    const timer = this.flushTimers.get(planId);
    if (timer) { clearTimeout(timer); this.flushTimers.delete(planId); }
    this.dirty.delete(planId);

    this.plans.delete(planId);
    this.removeFromIndexes(existing);

    const target = this.filePath(planId);
    this.ownWrites.add(path.basename(target));
    try { fs.unlinkSync(target); } catch { /* not found is fine */ }
    return true;
  }

  /**
   * Create-or-update a plan from a Claude ExitPlanMode tool use. Idempotent by
   * claudePlanToolUseId — second call with same id patches the first.
   */
  upsertFromClaude(input: UpsertFromClaudeInput): Plan {
    const existingId = this.byClaudeToolUseId.get(input.claudePlanToolUseId);
    if (existingId) {
      const existing = this.plans.get(existingId);
      if (existing) {
        const patched = this.patch(existingId, {
          body: input.body,
          status: input.status,
          ...(input.title ? { title: input.title } : {}),
        });
        return patched ?? existing;
      }
    }
    const created = this.create({
      overlordId: input.overlordId,
      cwd: input.cwd,
      title: input.title ?? 'Plan',
      body: input.body,
      source: 'claude',
      claudePlanToolUseId: input.claudePlanToolUseId,
    });
    return this.patch(created.planId, { status: input.status }) ?? created;
  }

  async flushAll(): Promise<void> {
    const ids = [...this.flushTimers.keys()];
    for (const id of ids) {
      const timer = this.flushTimers.get(id);
      if (timer) { clearTimeout(timer); this.flushTimers.delete(id); }
      this.enqueueFlush(id);
    }
    await Promise.all([...this.writeChain.values()]);
  }

  /** Update in-memory state from a file that was edited externally. Returns the new plan if it differs. */
  refreshFromDisk(planId: string): { plan: Plan; changed: boolean } | undefined {
    const target = this.filePath(planId);
    let raw: string;
    try {
      raw = fs.readFileSync(target, 'utf-8');
    } catch {
      return undefined;
    }
    const parsed = parsePlanFile(raw);
    if (!parsed.ok) {
      console.warn(`[planStore] refresh ${planId} skipped: ${parsed.reason}`);
      return undefined;
    }
    const existing = this.plans.get(planId);
    const same =
      existing &&
      existing.updatedAt === parsed.plan.updatedAt &&
      existing.body === parsed.plan.body &&
      existing.title === parsed.plan.title &&
      existing.status === parsed.plan.status;
    if (existing) this.removeFromIndexes(existing);
    this.plans.set(parsed.plan.planId, parsed.plan);
    this.addToIndexes(parsed.plan);
    return { plan: parsed.plan, changed: !same };
  }

  // ── private write helpers ─────────────────────────────────────────────────

  private scheduleFlush(planId: string): void {
    this.dirty.add(planId);
    const existing = this.flushTimers.get(planId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.flushTimers.delete(planId);
      this.enqueueFlush(planId);
    }, this.debounceMs);
    this.flushTimers.set(planId, timer);
  }

  private enqueueFlush(planId: string): void {
    if (!this.dirty.has(planId)) return;
    const prev = this.writeChain.get(planId) ?? Promise.resolve();
    const next = prev.then(() => this.writeOnce(planId));
    this.writeChain.set(planId, next.finally(() => {
      if (this.writeChain.get(planId) === next) this.writeChain.delete(planId);
    }));
  }

  private async writeOnce(planId: string): Promise<void> {
    const plan = this.plans.get(planId);
    if (!plan) { this.dirty.delete(planId); return; }
    this.dirty.delete(planId);
    try {
      this.ensureDir(this.plansDir);
      const target = this.filePath(planId);
      const tmp = `${target}.tmp`;
      this.ownWrites.add(path.basename(target));
      await fs.promises.writeFile(tmp, serializePlanFile(plan), 'utf-8');
      await fs.promises.rename(tmp, target);
    } catch (err) {
      console.warn(`[planStore] write failed for ${planId}: ${(err as Error).message}`);
      this.dirty.add(planId);
    }
  }
}

export const planStore = new PlanStore();
