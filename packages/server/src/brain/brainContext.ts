import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface BrainIdentityFile {
  path: string;
  firstLine: string;
  lineCount: number;
}

export interface BrainMemoryEntry {
  name: string;
  description: string;
  type: 'user' | 'feedback' | 'project' | 'reference' | 'unknown';
  file: string;
}

export interface BrainMemory {
  indexPath: string | null;
  entries: BrainMemoryEntry[];
}

export interface BrainHook {
  event: string;
  matcher: string | null;
  command: string;
  source: string;
}

export interface BrainSkill {
  name: string;
  description: string;
  source: 'user' | 'project' | 'plugin';
  path: string;
}

export interface BrainAgent {
  name: string;
  description: string;
  source: 'user' | 'project';
  path: string;
}

export interface BrainMcpServer {
  name: string;
  command: string | null;
  args: string[];
  source: string;
  status: 'unknown';
}

export interface BrainPermissionRule {
  rule: string;
  source: string;
}

export type EffortValue = 'low' | 'medium' | 'high' | 'xhigh' | string | null;

export interface BrainEffortTier {
  value: EffortValue;
  source: string | null;
}

export interface BrainEffort {
  global: BrainEffortTier;
  project: BrainEffortTier;
  effective: EffortValue;
}

export interface BrainContext {
  cwd: string;
  identity: BrainIdentityFile[];
  memory: BrainMemory;
  hooks: BrainHook[];
  skills: BrainSkill[];
  agents: BrainAgent[];
  mcpServers: BrainMcpServer[];
  permissions: {
    allow: BrainPermissionRule[];
    deny: BrainPermissionRule[];
  };
  effort: BrainEffort;
}

const SECRET_KEY_RE = /token|key|secret|password/i;
const COMMAND_TRUNCATE = 200;

interface CacheEntry {
  ts: number;
  context: BrainContext;
  sources: Array<{ path: string; mtimeMs: number | null }>;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, CacheEntry>();

function safeStat(p: string): number | null {
  try { return fs.statSync(p).mtimeMs; } catch { return null; }
}

function readFileSafe(p: string): string | null {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return null; }
}

function existsFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function existsDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function firstNonEmptyLine(content: string): string {
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (t) return t.length > 160 ? t.slice(0, 160) + '…' : t;
  }
  return '';
}

function countLines(content: string): number {
  if (!content) return 0;
  return content.split('\n').length;
}

/** Walk from cwd up toward FS root (stopping at parent of $HOME) collecting CLAUDE.md files. */
function collectClaudeMdChain(cwd: string): BrainIdentityFile[] {
  const home = os.homedir();
  const results: BrainIdentityFile[] = [];
  const seen = new Set<string>();

  const userGlobal = path.join(home, '.claude', 'CLAUDE.md');
  if (existsFile(userGlobal)) {
    const content = readFileSafe(userGlobal) ?? '';
    results.push({ path: userGlobal, firstLine: firstNonEmptyLine(content), lineCount: countLines(content) });
    seen.add(userGlobal);
  }

  const ancestors: string[] = [];
  let cur = path.resolve(cwd);
  const root = path.parse(cur).root;
  while (true) {
    ancestors.push(cur);
    if (cur === root || cur === path.dirname(cur)) break;
    cur = path.dirname(cur);
  }
  // Outer-most first (top-down to cwd), so the project CLAUDE.md shows after any parent ones.
  ancestors.reverse();

  for (const dir of ancestors) {
    const p = path.join(dir, 'CLAUDE.md');
    if (seen.has(p)) continue;
    if (existsFile(p)) {
      const content = readFileSafe(p) ?? '';
      results.push({ path: p, firstLine: firstNonEmptyLine(content), lineCount: countLines(content) });
      seen.add(p);
    }
  }

  return results;
}

/** Encode a cwd path the way Claude Code encodes project memory directories. */
function encodeProjectSlug(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

function parseFrontmatterType(raw: string): BrainMemoryEntry['type'] {
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return 'unknown';
  const typeMatch = fmMatch[1].match(/^type:\s*(.+?)\s*$/m);
  if (!typeMatch) return 'unknown';
  const v = typeMatch[1].trim().toLowerCase();
  if (v === 'user' || v === 'feedback' || v === 'project' || v === 'reference') return v;
  return 'unknown';
}

function readMemory(cwd: string): BrainMemory {
  const home = os.homedir();
  const slug = encodeProjectSlug(cwd);
  const memDir = path.join(home, '.claude', 'projects', slug, 'memory');
  const indexPath = path.join(memDir, 'MEMORY.md');

  if (!existsDir(memDir)) return { indexPath: null, entries: [] };

  const indexRaw = readFileSafe(indexPath);
  if (!indexRaw) return { indexPath, entries: [] };

  const entries: BrainMemoryEntry[] = [];
  const lineRe = /^-\s*\[([^\]]+)\]\(([^)]+)\)\s*(?:[—–-]\s*(.+))?$/;
  for (const line of indexRaw.split('\n')) {
    const m = line.match(lineRe);
    if (!m) continue;
    const name = m[1].trim();
    const filename = m[2].trim();
    const description = (m[3] ?? '').trim();
    const filePath = path.join(memDir, filename);
    const raw = readFileSafe(filePath) ?? '';
    const type = parseFrontmatterType(raw);
    entries.push({ name, description, type, file: filePath });
  }

  return { indexPath, entries };
}

function readJsonSafe(p: string): Record<string, unknown> | null {
  try {
    if (!existsFile(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch { return null; }
}

interface SettingsWithSource {
  data: Record<string, unknown>;
  source: string;
}

function collectSettings(cwd: string): SettingsWithSource[] {
  const home = os.homedir();
  const results: SettingsWithSource[] = [];
  const candidates = [
    path.join(home, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.local.json'),
  ];
  for (const c of candidates) {
    const data = readJsonSafe(c);
    if (data) results.push({ data, source: c });
  }
  return results;
}

function redactSecrets(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(redactSecrets);
  if (typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k) && typeof v === 'string') {
        out[k] = '***';
      } else {
        out[k] = redactSecrets(v);
      }
    }
    return out;
  }
  return obj;
}

function extractHooks(settings: SettingsWithSource[]): BrainHook[] {
  const out: BrainHook[] = [];
  for (const { data, source } of settings) {
    const hooks = data.hooks as Record<string, unknown> | undefined;
    if (!hooks || typeof hooks !== 'object') continue;
    for (const [event, value] of Object.entries(hooks)) {
      const arr = Array.isArray(value) ? value : [];
      for (const entry of arr) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        const matcher = typeof e.matcher === 'string' ? e.matcher : null;
        const inner = Array.isArray(e.hooks) ? e.hooks : [];
        for (const h of inner) {
          if (!h || typeof h !== 'object') continue;
          const hr = h as Record<string, unknown>;
          const command = typeof hr.command === 'string' ? hr.command : JSON.stringify(hr);
          const truncated = command.length > COMMAND_TRUNCATE
            ? command.slice(0, COMMAND_TRUNCATE) + '…'
            : command;
          out.push({ event, matcher, command: truncated, source });
        }
      }
    }
  }
  return out;
}

function extractPermissions(settings: SettingsWithSource[]): BrainContext['permissions'] {
  const allow: BrainPermissionRule[] = [];
  const deny: BrainPermissionRule[] = [];
  for (const { data, source } of settings) {
    const perms = data.permissions as Record<string, unknown> | undefined;
    if (!perms || typeof perms !== 'object') continue;
    const a = Array.isArray(perms.allow) ? perms.allow : [];
    const d = Array.isArray(perms.deny) ? perms.deny : [];
    for (const rule of a) if (typeof rule === 'string') allow.push({ rule, source });
    for (const rule of d) if (typeof rule === 'string') deny.push({ rule, source });
  }
  return { allow, deny };
}

function extractEffort(settings: SettingsWithSource[], home: string, cwd: string): BrainEffort {
  const globalPath = path.join(home, '.claude', 'settings.json');
  const projectPath = path.join(cwd, '.claude', 'settings.json');
  const projectLocalPath = path.join(cwd, '.claude', 'settings.local.json');

  const global: BrainEffortTier = { value: null, source: null };
  const project: BrainEffortTier = { value: null, source: null };
  let projectFromLocal = false;

  for (const { data, source } of settings) {
    const v = typeof data.effortLevel === 'string' ? data.effortLevel : null;
    if (!v) continue;
    if (source === globalPath) {
      global.value = v;
      global.source = source;
    } else if (source === projectLocalPath) {
      project.value = v;
      project.source = source;
      projectFromLocal = true;
    } else if (source === projectPath && !projectFromLocal) {
      project.value = v;
      project.source = source;
    }
  }

  const effective: EffortValue = project.value ?? global.value ?? null;
  return { global, project, effective };
}

function extractMcpServers(settings: SettingsWithSource[]): BrainMcpServer[] {
  const out: BrainMcpServer[] = [];
  const seen = new Set<string>();
  for (const { data, source } of settings) {
    const servers = data.mcpServers as Record<string, unknown> | undefined;
    if (!servers || typeof servers !== 'object') continue;
    for (const [name, value] of Object.entries(servers)) {
      if (seen.has(name)) continue;
      seen.add(name);
      const v = redactSecrets(value) as Record<string, unknown> | null;
      const command = v && typeof v.command === 'string' ? v.command : null;
      const args = v && Array.isArray(v.args) ? v.args.filter(a => typeof a === 'string') as string[] : [];
      out.push({ name, command, args, source, status: 'unknown' });
    }
  }
  return out;
}

function extractDescription(raw: string): string {
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch) {
    const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m);
    if (descMatch) return descMatch[1].trim().slice(0, 200);
  }
  const body = raw.replace(/^---[\s\S]*?---\r?\n?/, '');
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t || /^#/.test(t)) continue;
    return t.slice(0, 200);
  }
  return '';
}

function readSkillsFrom(root: string, source: BrainSkill['source']): BrainSkill[] {
  if (!existsDir(root)) return [];
  const out: BrainSkill[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch { return []; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const skillMd = path.join(root, entry.name, 'SKILL.md');
    if (!existsFile(skillMd)) continue;
    const raw = readFileSafe(skillMd) ?? '';
    out.push({
      name: entry.name,
      description: extractDescription(raw),
      source,
      path: skillMd,
    });
  }
  return out;
}

function collectSkills(cwd: string): BrainSkill[] {
  const home = os.homedir();
  const project = readSkillsFrom(path.join(cwd, '.claude', 'skills'), 'project');
  const user = readSkillsFrom(path.join(home, '.claude', 'skills'), 'user');
  return [...project, ...user];
}

const AGENT_CANDIDATES = ['AGENT.md', 'SKILL.md', 'README.md'];

function readAgentsFrom(root: string, source: BrainAgent['source']): BrainAgent[] {
  if (!existsDir(root)) return [];
  const out: BrainAgent[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch { return []; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      for (const candidate of AGENT_CANDIDATES) {
        const mdPath = path.join(root, entry.name, candidate);
        if (existsFile(mdPath)) {
          const raw = readFileSafe(mdPath) ?? '';
          out.push({ name: entry.name, description: extractDescription(raw), source, path: mdPath });
          break;
        }
      }
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const mdPath = path.join(root, entry.name);
      const raw = readFileSafe(mdPath) ?? '';
      out.push({ name: entry.name.replace(/\.md$/, ''), description: extractDescription(raw), source, path: mdPath });
    }
  }
  return out;
}

function collectAgents(cwd: string): BrainAgent[] {
  const home = os.homedir();
  const project = readAgentsFrom(path.join(cwd, '.claude', 'agents'), 'project');
  const user = readAgentsFrom(path.join(home, '.claude', 'agents'), 'user');
  return [...project, ...user];
}

/** Returns the list of source files whose mtimes we track for cache invalidation. */
function sourceFiles(cwd: string, ctx: BrainContext): string[] {
  const home = os.homedir();
  const base = [
    path.join(home, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.local.json'),
    path.join(home, '.claude', 'CLAUDE.md'),
    path.join(cwd, 'CLAUDE.md'),
  ];
  if (ctx.memory.indexPath) base.push(ctx.memory.indexPath);
  for (const ident of ctx.identity) base.push(ident.path);
  return [...new Set(base)];
}

function buildContext(cwd: string): BrainContext {
  const home = os.homedir();
  const identity = collectClaudeMdChain(cwd);
  const memory = readMemory(cwd);
  const settings = collectSettings(cwd);
  const hooks = extractHooks(settings);
  const permissions = extractPermissions(settings);
  const mcpServers = extractMcpServers(settings);
  const effort = extractEffort(settings, home, cwd);
  const skills = collectSkills(cwd);
  const agents = collectAgents(cwd);
  return { cwd, identity, memory, hooks, skills, agents, mcpServers, permissions, effort };
}

export function getBrainContext(cwd: string): BrainContext {
  const cacheKey = cwd;
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && now - cached.ts < CACHE_TTL_MS) {
    const changed = cached.sources.some(s => safeStat(s.path) !== s.mtimeMs);
    if (!changed) return cached.context;
  }
  const context = buildContext(cwd);
  const sources = sourceFiles(cwd, context).map(p => ({ path: p, mtimeMs: safeStat(p) }));
  cache.set(cacheKey, { ts: now, context, sources });
  return context;
}

export function invalidateBrainCache(cwd: string): void {
  cache.delete(cwd);
}
