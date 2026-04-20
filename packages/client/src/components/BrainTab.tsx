import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { renderMarkdown, stripFrontmatter } from '../lib/markdown';
import styles from './BrainTab.module.css';

type MemoryType = 'user' | 'feedback' | 'project' | 'reference' | 'unknown';

interface BrainIdentityFile {
  path: string;
  firstLine: string;
  lineCount: number;
}

interface BrainMemoryEntry {
  name: string;
  description: string;
  type: MemoryType;
  file: string;
}

interface BrainHook {
  event: string;
  matcher: string | null;
  command: string;
  source: string;
}

interface BrainSkill {
  name: string;
  description: string;
  source: 'user' | 'project' | 'plugin';
  path: string;
}

interface BrainAgent {
  name: string;
  description: string;
  source: 'user' | 'project';
  path: string;
}

interface BrainMcpServer {
  name: string;
  command: string | null;
  args: string[];
  source: string;
  status: 'unknown';
}

interface BrainPermissionRule {
  rule: string;
  source: string;
}

interface BrainEffortTier {
  value: string | null;
  source: string | null;
}

interface BrainEffort {
  global: BrainEffortTier;
  project: BrainEffortTier;
  effective: string | null;
}

export interface BrainContext {
  cwd: string;
  identity: BrainIdentityFile[];
  memory: {
    indexPath: string | null;
    entries: BrainMemoryEntry[];
  };
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

type CardKey = 'identity' | 'memory' | 'effort' | 'hooks' | 'skills' | 'agents' | 'mcp' | 'permissions';

const DEFAULT_OPEN: Record<CardKey, boolean> = {
  identity: true,
  memory: true,
  effort: true,
  hooks: true,
  skills: false,
  agents: false,
  mcp: false,
  permissions: false,
};

function useBrainContext(cwd: string | null) {
  const [data, setData] = useState<BrainContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchCtx = useCallback(async () => {
    if (!cwd) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/brain?cwd=${encodeURIComponent(cwd)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const json = (await res.json()) as BrainContext;
      setData(json);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    if (cwd) void fetchCtx();
  }, [cwd, fetchCtx]);

  return { data, loading, error, refresh: fetchCtx };
}

function useCardState(cwd: string | null) {
  const storageKey = cwd ? `brainTab:${cwd}:cards` : null;
  const [state, setState] = useState<Record<CardKey, boolean>>(() => {
    if (!storageKey) return DEFAULT_OPEN;
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) return { ...DEFAULT_OPEN, ...(JSON.parse(raw) as Record<CardKey, boolean>) };
    } catch {}
    return DEFAULT_OPEN;
  });
  const toggle = useCallback((key: CardKey) => {
    setState(prev => {
      const next = { ...prev, [key]: !prev[key] };
      if (storageKey) {
        try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch {}
      }
      return next;
    });
  }, [storageKey]);
  const setOpen = useCallback((key: CardKey, open: boolean) => {
    setState(prev => {
      if (prev[key] === open) return prev;
      const next = { ...prev, [key]: open };
      if (storageKey) {
        try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch {}
      }
      return next;
    });
  }, [storageKey]);
  return { state, toggle, setOpen };
}

function matchesSearch(q: string, ...fields: (string | undefined | null)[]): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return fields.some(f => (f ?? '').toLowerCase().includes(needle));
}

interface FileViewState {
  loading: boolean;
  content: string | null;
  error: string | null;
  truncated: boolean;
  totalLines: number;
}

function useFileContents(cwd: string) {
  const [files, setFiles] = useState<Record<string, FileViewState>>({});

  const load = useCallback(async (filePath: string) => {
    setFiles(prev => ({ ...prev, [filePath]: { loading: true, content: null, error: null, truncated: false, totalLines: 0 } }));
    try {
      const res = await fetch(`/api/brain/file?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(filePath)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const json = await res.json() as { content: string; truncated: boolean; totalLines: number };
      setFiles(prev => ({ ...prev, [filePath]: { loading: false, content: json.content, error: null, truncated: json.truncated, totalLines: json.totalLines } }));
    } catch (err) {
      setFiles(prev => ({ ...prev, [filePath]: { loading: false, content: null, error: (err as Error).message, truncated: false, totalLines: 0 } }));
    }
  }, [cwd]);

  const save = useCallback(async (filePath: string, content: string): Promise<void> => {
    const res = await fetch('/api/brain/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, path: filePath, content }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    const json = await res.json() as { totalLines: number };
    setFiles(prev => ({
      ...prev,
      [filePath]: {
        loading: false,
        content,
        error: null,
        truncated: false,
        totalLines: json.totalLines,
      },
    }));
  }, [cwd]);

  return { files, load, save };
}

export function BrainTab({ cwd }: { cwd: string }) {
  const { data, loading, error, refresh } = useBrainContext(cwd);
  const { state: cardOpen, toggle } = useCardState(cwd);
  const { files, load: loadFile, save: saveFile } = useFileContents(cwd);
  const [expandedFile, setExpandedFile] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');

  const toggleFile = useCallback((filePath: string) => {
    setExpandedFile(prev => {
      const next = { ...prev, [filePath]: !prev[filePath] };
      if (next[filePath] && !files[filePath]) {
        void loadFile(filePath);
      }
      return next;
    });
  }, [files, loadFile]);

  const counts = useMemo(() => {
    if (!data) return { identity: 0, memory: 0, hooks: 0, skills: 0, agents: 0, mcp: 0, perm: 0 };
    return {
      identity: data.identity.length,
      memory: data.memory.entries.length,
      hooks: data.hooks.length,
      skills: data.skills.length,
      agents: data.agents.length,
      mcp: data.mcpServers.length,
      perm: data.permissions.allow.length + data.permissions.deny.length,
    };
  }, [data]);

  if (loading && !data) {
    return <div className={styles.root}><div className={styles.loading}>Loading brain…</div></div>;
  }
  if (error && !data) {
    return (
      <div className={styles.root}>
        <div className={styles.errorCard}>
          Failed to load: {error}
          <div style={{ marginTop: 10 }}>
            <button className={styles.refreshBtn} onClick={() => void refresh()}>Retry</button>
          </div>
        </div>
      </div>
    );
  }
  if (!data) return null;

  const hooksByEvent: Record<string, BrainHook[]> = {};
  for (const h of data.hooks) {
    if (!hooksByEvent[h.event]) hooksByEvent[h.event] = [];
    if (matchesSearch(query, h.event, h.matcher, h.command, h.source)) hooksByEvent[h.event].push(h);
  }

  const filteredIdentity = data.identity.filter(f => matchesSearch(query, f.path, f.firstLine));
  const filteredMemory = data.memory.entries.filter(e => matchesSearch(query, e.name, e.description, e.type, e.file));
  const filteredSkills = data.skills.filter(s => matchesSearch(query, s.name, s.description, s.source, s.path));
  const filteredAgents = data.agents.filter(s => matchesSearch(query, s.name, s.description, s.source, s.path));
  const filteredMcp = data.mcpServers.filter(s => matchesSearch(query, s.name, s.command, s.args.join(' '), s.source));
  const filteredAllow = data.permissions.allow.filter(p => matchesSearch(query, p.rule, p.source));
  const filteredDeny = data.permissions.deny.filter(p => matchesSearch(query, p.rule, p.source));

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <div className={styles.counters}>
          <span className={styles.counter}><span className={styles.counterKey}>identity</span><span className={styles.counterVal}>{counts.identity}</span></span>
          <span className={styles.counter}><span className={styles.counterKey}>mem</span><span className={styles.counterVal}>{counts.memory}</span></span>
          <span className={styles.counter}><span className={styles.counterKey}>hooks</span><span className={styles.counterVal}>{counts.hooks}</span></span>
          <span className={styles.counter}><span className={styles.counterKey}>skills</span><span className={styles.counterVal}>{counts.skills}</span></span>
          <span className={styles.counter}><span className={styles.counterKey}>agents</span><span className={styles.counterVal}>{counts.agents}</span></span>
          <span className={styles.counter}><span className={styles.counterKey}>mcp</span><span className={styles.counterVal}>{counts.mcp}</span></span>
          <span className={styles.counter}><span className={styles.counterKey}>perm</span><span className={styles.counterVal}>{counts.perm}</span></span>
        </div>
        <input
          className={styles.search}
          type="text"
          placeholder="Search brain…"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        <button className={styles.refreshBtn} onClick={() => void refresh()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      <div className={styles.body}>
        <Card
          title="Identity"
          count={filteredIdentity.length}
          open={cardOpen.identity}
          onToggle={() => toggle('identity')}
        >
          {filteredIdentity.length === 0 ? (
            <div className={styles.empty}>No CLAUDE.md files found.</div>
          ) : filteredIdentity.map(f => (
            <FileRow
              key={f.path}
              path={f.path}
              secondary={f.firstLine}
              metaRight={<span className={styles.linePill}>{f.lineCount} lines</span>}
              expanded={!!expandedFile[f.path]}
              onToggle={() => toggleFile(f.path)}
              fileState={files[f.path]}
              editable
              asMarkdown
              onSave={content => saveFile(f.path, content)}
            />
          ))}
        </Card>

        <Card
          title="Memory"
          count={filteredMemory.length}
          open={cardOpen.memory}
          onToggle={() => toggle('memory')}
        >
          {filteredMemory.length === 0 ? (
            <div className={styles.empty}>
              {data.memory.indexPath ? 'No memory entries.' : 'No memory directory for this project yet.'}
            </div>
          ) : filteredMemory.map(e => (
            <FileRow
              key={e.file}
              path={e.file}
              name={e.name}
              secondary={e.description}
              metaLeft={<span className={`${styles.typeBadge} ${typeBadgeClass(e.type)}`}>{e.type}</span>}
              expanded={!!expandedFile[e.file]}
              onToggle={() => toggleFile(e.file)}
              fileState={files[e.file]}
              editable
              asMarkdown
              onSave={content => saveFile(e.file, content)}
            />
          ))}
        </Card>

        <EffortCard
          effort={data.effort}
          open={cardOpen.effort}
          onToggle={() => toggle('effort')}
        />

        <Card
          title="Hooks"
          count={Object.values(hooksByEvent).reduce((n, arr) => n + arr.length, 0)}
          open={cardOpen.hooks}
          onToggle={() => toggle('hooks')}
        >
          {Object.keys(hooksByEvent).length === 0 ? (
            <div className={styles.empty}>No hooks configured.</div>
          ) : Object.entries(hooksByEvent).map(([event, arr]) => (
            arr.length === 0 ? null : (
              <div key={event}>
                <div className={styles.groupHeader}>{event}</div>
                {arr.map((h, i) => (
                  <div key={`${event}-${i}`} className={styles.row}>
                    <span className={styles.eventBadge}>{event}</span>
                    {h.matcher ? <span className={styles.matcherText}>{h.matcher}</span> : <span className={styles.matcherText}>*</span>}
                    <span className={styles.rowCmd} title={h.command}>{h.command}</span>
                  </div>
                ))}
              </div>
            )
          ))}
        </Card>

        <Card
          title="Skills"
          count={filteredSkills.length}
          open={cardOpen.skills}
          onToggle={() => toggle('skills')}
        >
          {filteredSkills.length === 0 ? (
            <div className={styles.empty}>No skills found.</div>
          ) : filteredSkills.map(s => (
            <DefinitionRow
              key={s.path}
              source={s.source}
              name={s.name}
              description={s.description}
              path={s.path}
              expanded={!!expandedFile[s.path]}
              onToggle={() => toggleFile(s.path)}
              fileState={files[s.path]}
              copyText={`/${s.name}`}
            />
          ))}
        </Card>

        <Card
          title="Agents"
          count={filteredAgents.length}
          open={cardOpen.agents}
          onToggle={() => toggle('agents')}
        >
          {filteredAgents.length === 0 ? (
            <div className={styles.empty}>No agents found.</div>
          ) : filteredAgents.map(a => (
            <DefinitionRow
              key={a.path}
              source={a.source}
              name={a.name}
              description={a.description}
              path={a.path}
              expanded={!!expandedFile[a.path]}
              onToggle={() => toggleFile(a.path)}
              fileState={files[a.path]}
            />
          ))}
        </Card>

        <Card
          title="MCP servers"
          count={filteredMcp.length}
          open={cardOpen.mcp}
          onToggle={() => toggle('mcp')}
        >
          {filteredMcp.length === 0 ? (
            <div className={styles.empty}>No MCP servers configured.</div>
          ) : filteredMcp.map(s => (
            <div key={s.name} className={styles.row}>
              <span className={styles.rowName}>{s.name}</span>
              <span className={styles.rowCmd} title={`${s.command ?? ''} ${s.args.join(' ')}`}>
                {s.command ?? ''} {s.args.join(' ')}
              </span>
            </div>
          ))}
        </Card>

        <Card
          title="Permissions"
          count={filteredAllow.length + filteredDeny.length}
          open={cardOpen.permissions}
          onToggle={() => toggle('permissions')}
        >
          {(filteredAllow.length + filteredDeny.length) === 0 ? (
            <div className={styles.empty}>No permission rules.</div>
          ) : (
            <>
              {filteredAllow.length > 0 && (
                <>
                  <div className={`${styles.permSectionHeader} ${styles.permAllow}`}>Allow ({filteredAllow.length})</div>
                  {filteredAllow.map((p, i) => (
                    <div key={`a-${i}`} className={styles.row}>
                      <span className={styles.rowCmd} style={{ color: '#bfe8bf' }}>{p.rule}</span>
                      <span className={styles.rowPath} title={p.source}>{p.source}</span>
                    </div>
                  ))}
                </>
              )}
              {filteredDeny.length > 0 && (
                <>
                  <div className={`${styles.permSectionHeader} ${styles.permDeny}`}>Deny ({filteredDeny.length})</div>
                  {filteredDeny.map((p, i) => (
                    <div key={`d-${i}`} className={styles.row}>
                      <span className={styles.rowCmd} style={{ color: '#f0bfbf' }}>{p.rule}</span>
                      <span className={styles.rowPath} title={p.source}>{p.source}</span>
                    </div>
                  ))}
                </>
              )}
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

function Card({ title, count, open, onToggle, children }: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={`${styles.card} ${open ? styles.cardOpen : ''}`}>
      <div className={styles.cardHeader} onClick={onToggle}>
        <span className={styles.cardTitle}>{title}</span>
        <span className={styles.cardCount}>{count}</span>
        <span className={styles.chevron}>▶</span>
      </div>
      {open && <div className={styles.cardBody}>{children}</div>}
    </div>
  );
}

function EffortCard({ effort, open, onToggle }: {
  effort: BrainEffort;
  open: boolean;
  onToggle: () => void;
}) {
  const hasProjectOverride = effort.project.value !== null;
  const effective = effort.effective;
  return (
    <div className={`${styles.card} ${open ? styles.cardOpen : ''}`}>
      <div className={styles.cardHeader} onClick={onToggle}>
        <span className={styles.cardTitle}>Effort</span>
        <span className={styles.cardCount}>{effective ?? '—'}</span>
        <span className={styles.chevron}>▶</span>
      </div>
      {open && (
        <div className={styles.cardBody}>
          <div className={styles.effortEffective}>
            <span className={styles.effortEffectiveLabel}>Effective</span>
            <span className={`${styles.effortChip} ${effective ? '' : styles.effortChipEmpty}`}>
              {effective ?? '—'}
            </span>
          </div>
          <div className={`${styles.effortRow} ${hasProjectOverride ? styles.effortRowDim : ''}`}>
            <span className={styles.effortRowLabel}>Global</span>
            <span className={`${styles.effortValue} ${effort.global.value ? '' : styles.effortValueEmpty}`}>
              {effort.global.value ?? '—'}
            </span>
            <span className={styles.effortSource} title={effort.global.source ?? ''}>
              {effort.global.source ?? ''}
            </span>
          </div>
          <div className={styles.effortRow}>
            <span className={styles.effortRowLabel}>Project</span>
            <span className={`${styles.effortValue} ${effort.project.value ? '' : styles.effortValueEmpty}`}>
              {effort.project.value ?? '—'}
            </span>
            <span className={styles.effortSource} title={effort.project.source ?? ''}>
              {effort.project.source ?? ''}
            </span>
          </div>
          {effective === null && (
            <div className={styles.effortCaption}>No effort level configured.</div>
          )}
        </div>
      )}
    </div>
  );
}

function FileRow({ path, name, secondary, metaLeft, metaRight, expanded, onToggle, fileState, editable, onSave, asMarkdown }: {
  path: string;
  name?: string;
  secondary?: string;
  metaLeft?: React.ReactNode;
  metaRight?: React.ReactNode;
  expanded: boolean;
  onToggle: () => void;
  fileState: FileViewState | undefined;
  editable?: boolean;
  onSave?: (content: string) => Promise<void>;
  asMarkdown?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!expanded) {
      setEditing(false);
      setSaveError(null);
    }
  }, [expanded]);

  const content = fileState?.content ?? null;
  const canEdit = !!editable && !!onSave && !fileState?.loading && !fileState?.error && content !== null && !fileState?.truncated;

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDraft(content ?? '');
    setSaveError(null);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setSaveError(null);
  };

  const commitSave = async () => {
    if (!onSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(draft);
      setEditing(false);
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className={`${styles.row} ${styles.rowClickable}`} onClick={onToggle}>
        {metaLeft}
        {name && <span className={styles.rowName}>{name}</span>}
        {secondary && <span className={styles.rowDesc}>{secondary}</span>}
        {!name && !secondary && <span className={styles.rowPath} title={path}>{path}</span>}
        {name && <span className={styles.rowPath} title={path}>{path}</span>}
        {metaRight}
      </div>
      {expanded && (
        <div className={styles.fileExpansion}>
          {fileState?.loading && <div className={styles.empty}>Loading…</div>}
          {fileState?.error && <div className={styles.empty} style={{ color: '#ff8888' }}>Error: {fileState.error}</div>}
          {content !== null && !editing && (
            <>
              {canEdit && (
                <div className={styles.editActions}>
                  <button className={styles.refreshBtn} onClick={startEdit}>Edit</button>
                </div>
              )}
              {asMarkdown ? (
                <div
                  className={styles.markdownContent}
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(stripFrontmatter(content)) }}
                />
              ) : (
                <pre className={styles.fileContent}>{content}</pre>
              )}
              {fileState?.truncated && (
                <div className={styles.truncNote}>
                  Showing first 500 of {fileState.totalLines} lines. Editing disabled while truncated.
                </div>
              )}
            </>
          )}
          {content !== null && editing && (
            <>
              <textarea
                className={styles.editTextarea}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                spellCheck={false}
                disabled={saving}
              />
              <div className={styles.editActions}>
                {saveError && <span className={styles.editError}>Error: {saveError}</span>}
                <button className={styles.refreshBtn} onClick={cancelEdit} disabled={saving}>Cancel</button>
                <button className={styles.refreshBtn} onClick={() => void commitSave()} disabled={saving}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

function DefinitionRow({ source, name, description, path, expanded, onToggle, fileState, copyText }: {
  source: string;
  name: string;
  description: string;
  path: string;
  expanded: boolean;
  onToggle: () => void;
  fileState: FileViewState | undefined;
  copyText?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <div className={`${styles.row} ${styles.rowClickable}`} onClick={onToggle}>
        <span className={styles.chevron} style={{ transform: expanded ? 'rotate(90deg)' : undefined }}>▶</span>
        <span className={styles.sourceBadge}>{source}</span>
        <span className={styles.rowName}>{name}</span>
        <span className={styles.rowDesc}>{description}</span>
        {copyText && (
          <button
            className={styles.refreshBtn}
            style={{ padding: '2px 8px', fontSize: 11 }}
            title={`Copy ${copyText}`}
            onClick={e => {
              e.stopPropagation();
              navigator.clipboard.writeText(copyText).catch(() => {});
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </div>
      {expanded && (
        <div className={styles.fileExpansion}>
          {fileState?.loading && <div className={styles.empty}>Loading…</div>}
          {fileState?.error && <div className={styles.empty} style={{ color: '#ff8888' }}>Error: {fileState.error}</div>}
          {fileState?.content !== undefined && fileState?.content !== null && (
            <>
              <div
                className={styles.markdownContent}
                dangerouslySetInnerHTML={{ __html: renderMarkdown(stripFrontmatter(fileState.content)) }}
              />
              <div className={styles.truncNote} style={{ fontFamily: 'ui-monospace, monospace', color: '#666' }}>{path}</div>
              {fileState.truncated && (
                <div className={styles.truncNote}>
                  Showing first 500 of {fileState.totalLines} lines.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}

function typeBadgeClass(type: MemoryType): string {
  switch (type) {
    case 'user': return styles.typeUser;
    case 'feedback': return styles.typeFeedback;
    case 'project': return styles.typeProject;
    case 'reference': return styles.typeReference;
    default: return styles.typeUnknown;
  }
}
