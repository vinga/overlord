import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Artifact, ArtifactMeta, ArtifactSource, ArtifactStatus, ArtifactKind } from './types.js';
import { parseArtifactFile, serializeArtifactFile } from './frontmatter.js';

function defaultBaseDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  return path.join(home, '.claude', 'overlord');
}

const DEFAULT_DEBOUNCE_MS = 200;

function isValidArtifactId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id) && id.length > 0 && id.length <= 120;
}

function generateArtifactId(): string {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `artifact-${stamp}-${rand}`;
}

export interface ArtifactStoreOptions {
  baseDir?: string;
  debounceMs?: number;
}

export interface CreateInput {
  kind: ArtifactKind;
  overlordId: string;
  cwd: string;
  title: string;
  body: string;
  source: ArtifactSource;
  claudePlanToolUseId?: string;
}

export interface UpsertFromClaudeInput {
  overlordId: string;
  cwd: string;
  claudePlanToolUseId: string;
  body: string;
  status: ArtifactStatus;
  title?: string;
}

export type ArtifactPatch = Partial<Pick<Artifact, 'title' | 'body' | 'status'>>;

/**
 * Durable store for Artifact records. One markdown file per artifactId.
 *
 * Layout:
 *   {baseDir}/artifacts/{artifactId}.md   flat, mirrors overlord-sessions/
 *
 * Secondary indexes maintained on every mutation:
 *   - overlordId  → Set<artifactId>
 *   - cwd         → Set<artifactId>
 *   - claudeToolUseId → artifactId   (dedup key for source='claude')
 */
export class ArtifactStore {
  private artifacts = new Map<string, Artifact>();
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

  constructor(opts: ArtifactStoreOptions = {}) {
    this.baseDir = opts.baseDir ?? defaultBaseDir();
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  get artifactsDir(): string {
    return path.join(this.baseDir, 'artifacts');
  }

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  private filePath(artifactId: string): string {
    return path.join(this.artifactsDir, `${artifactId}.md`);
  }

  private addToIndexes(artifact: Artifact): void {
    if (!this.byOverlord.has(artifact.overlordId)) this.byOverlord.set(artifact.overlordId, new Set());
    this.byOverlord.get(artifact.overlordId)!.add(artifact.artifactId);
    if (!this.byCwd.has(artifact.cwd)) this.byCwd.set(artifact.cwd, new Set());
    this.byCwd.get(artifact.cwd)!.add(artifact.artifactId);
    if (artifact.claudePlanToolUseId) {
      this.byClaudeToolUseId.set(artifact.claudePlanToolUseId, artifact.artifactId);
    }
  }

  private removeFromIndexes(artifact: Artifact): void {
    this.byOverlord.get(artifact.overlordId)?.delete(artifact.artifactId);
    this.byCwd.get(artifact.cwd)?.delete(artifact.artifactId);
    if (artifact.claudePlanToolUseId) this.byClaudeToolUseId.delete(artifact.claudePlanToolUseId);
  }

  loadAll(): void {
    this.artifacts.clear();
    this.byOverlord.clear();
    this.byCwd.clear();
    this.byClaudeToolUseId.clear();

    this.ensureDir(this.artifactsDir);

    let files: string[];
    try { files = fs.readdirSync(this.artifactsDir); } catch { return; }

    for (const f of files) {
      if (!f.endsWith('.md') || f.endsWith('.tmp')) continue;
      const full = path.join(this.artifactsDir, f);
      try {
        const raw = fs.readFileSync(full, 'utf-8');
        const parsed = parseArtifactFile(raw);
        if (!parsed.ok) {
          console.warn(`[artifactStore] skip ${f}: ${parsed.reason}`);
          continue;
        }
        this.artifacts.set(parsed.artifact.artifactId, parsed.artifact);
        this.addToIndexes(parsed.artifact);
      } catch (err) {
        console.warn(`[artifactStore] skip malformed ${f}: ${(err as Error).message}`);
      }
    }
  }

  // ── lookups ───────────────────────────────────────────────────────────────

  get(artifactId: string): Artifact | undefined {
    return this.artifacts.get(artifactId);
  }

  list(kind?: ArtifactKind): Artifact[] {
    const out = [...this.artifacts.values()];
    return kind ? out.filter(a => a.kind === kind) : out;
  }

  listByOverlord(overlordId: string, kind?: ArtifactKind): Artifact[] {
    const ids = this.byOverlord.get(overlordId);
    if (!ids) return [];
    const out: Artifact[] = [];
    for (const id of ids) {
      const a = this.artifacts.get(id);
      if (!a) continue;
      if (kind && a.kind !== kind) continue;
      out.push(a);
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  listByCwd(cwd: string, kind?: ArtifactKind): Artifact[] {
    const ids = this.byCwd.get(cwd);
    if (!ids) return [];
    const out: Artifact[] = [];
    for (const id of ids) {
      const a = this.artifacts.get(id);
      if (!a) continue;
      if (kind && a.kind !== kind) continue;
      out.push(a);
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getByClaudeToolUseId(toolUseId: string): Artifact | undefined {
    const artifactId = this.byClaudeToolUseId.get(toolUseId);
    if (!artifactId) return undefined;
    return this.artifacts.get(artifactId);
  }

  // ── mutations ─────────────────────────────────────────────────────────────

  create(input: CreateInput): Artifact {
    const now = new Date().toISOString();
    const artifactId = generateArtifactId();
    if (!isValidArtifactId(artifactId)) throw new Error(`invalid artifactId: ${artifactId}`);

    const meta: ArtifactMeta = {
      artifactId,
      kind: input.kind,
      overlordId: input.overlordId,
      cwd: input.cwd,
      createdAt: now,
      updatedAt: now,
      title: input.title.slice(0, 120),
      status: 'draft',
      source: input.source,
      claudePlanToolUseId: input.claudePlanToolUseId,
    };
    const artifact: Artifact = { ...meta, body: input.body };

    this.artifacts.set(artifactId, artifact);
    this.addToIndexes(artifact);
    this.scheduleFlush(artifactId);
    return artifact;
  }

  patch(artifactId: string, partial: ArtifactPatch): Artifact | undefined {
    const existing = this.artifacts.get(artifactId);
    if (!existing) return undefined;

    const merged: Artifact = {
      ...existing,
      ...(partial.title !== undefined ? { title: partial.title.slice(0, 120) } : {}),
      ...(partial.body !== undefined ? { body: partial.body } : {}),
      ...(partial.status !== undefined ? { status: partial.status } : {}),
      updatedAt: new Date().toISOString(),
    };

    this.artifacts.set(artifactId, merged);
    this.scheduleFlush(artifactId);
    return merged;
  }

  remove(artifactId: string): boolean {
    const existing = this.artifacts.get(artifactId);
    if (!existing) return false;

    const timer = this.flushTimers.get(artifactId);
    if (timer) { clearTimeout(timer); this.flushTimers.delete(artifactId); }
    this.dirty.delete(artifactId);

    this.artifacts.delete(artifactId);
    this.removeFromIndexes(existing);

    const target = this.filePath(artifactId);
    this.ownWrites.add(path.basename(target));
    try { fs.unlinkSync(target); } catch { /* not found is fine */ }
    return true;
  }

  /**
   * Create-or-update a plan-kind artifact from a Claude ExitPlanMode tool use.
   * Idempotent by claudePlanToolUseId — second call with same id patches the first.
   * Always `kind='plan'`.
   */
  upsertFromClaude(input: UpsertFromClaudeInput): Artifact {
    const existingId = this.byClaudeToolUseId.get(input.claudePlanToolUseId);
    if (existingId) {
      const existing = this.artifacts.get(existingId);
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
      kind: 'plan',
      overlordId: input.overlordId,
      cwd: input.cwd,
      title: input.title ?? 'Plan',
      body: input.body,
      source: 'claude',
      claudePlanToolUseId: input.claudePlanToolUseId,
    });
    return this.patch(created.artifactId, { status: input.status }) ?? created;
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

  /** Update in-memory state from a file that was edited externally. Returns the new artifact if it differs. */
  refreshFromDisk(artifactId: string): { artifact: Artifact; changed: boolean } | undefined {
    const target = this.filePath(artifactId);
    let raw: string;
    try {
      raw = fs.readFileSync(target, 'utf-8');
    } catch {
      return undefined;
    }
    const parsed = parseArtifactFile(raw);
    if (!parsed.ok) {
      console.warn(`[artifactStore] refresh ${artifactId} skipped: ${parsed.reason}`);
      return undefined;
    }
    const existing = this.artifacts.get(artifactId);
    const same =
      existing &&
      existing.updatedAt === parsed.artifact.updatedAt &&
      existing.body === parsed.artifact.body &&
      existing.title === parsed.artifact.title &&
      existing.status === parsed.artifact.status;
    if (existing) this.removeFromIndexes(existing);
    this.artifacts.set(parsed.artifact.artifactId, parsed.artifact);
    this.addToIndexes(parsed.artifact);
    return { artifact: parsed.artifact, changed: !same };
  }

  // ── private write helpers ─────────────────────────────────────────────────

  private scheduleFlush(artifactId: string): void {
    this.dirty.add(artifactId);
    const existing = this.flushTimers.get(artifactId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.flushTimers.delete(artifactId);
      this.enqueueFlush(artifactId);
    }, this.debounceMs);
    this.flushTimers.set(artifactId, timer);
  }

  private enqueueFlush(artifactId: string): void {
    if (!this.dirty.has(artifactId)) return;
    const prev = this.writeChain.get(artifactId) ?? Promise.resolve();
    const next = prev.then(() => this.writeOnce(artifactId));
    this.writeChain.set(artifactId, next.finally(() => {
      if (this.writeChain.get(artifactId) === next) this.writeChain.delete(artifactId);
    }));
  }

  private async writeOnce(artifactId: string): Promise<void> {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) { this.dirty.delete(artifactId); return; }
    this.dirty.delete(artifactId);
    try {
      this.ensureDir(this.artifactsDir);
      const target = this.filePath(artifactId);
      const tmp = `${target}.tmp`;
      this.ownWrites.add(path.basename(target));
      await fs.promises.writeFile(tmp, serializeArtifactFile(artifact), 'utf-8');
      await fs.promises.rename(tmp, target);
    } catch (err) {
      console.warn(`[artifactStore] write failed for ${artifactId}: ${(err as Error).message}`);
      this.dirty.add(artifactId);
    }
  }
}

export const artifactStore = new ArtifactStore();
