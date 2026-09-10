import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import styles from './SkillPickerPopup.module.css';
import { renderMarkdown, stripFrontmatter } from '../lib/markdown';

interface Skill {
  name: string;
  description: string;
  source?: 'user' | 'project' | 'plugin';
  path?: string;
}

interface SkillPickerPopupProps {
  cwd: string;
  onPick: (command: string) => void;
  onClose: () => void;
  /** Open straight into this skill's detail view (e.g. from a clicked chip).
   *  Falls back to pre-filling the filter when the name isn't in the list. */
  initialSkill?: string;
  /** `insert` (default) is the composer flow: args input + Insert. `view` is a
   *  read/edit browser opened from a chip — no args input, Insert is secondary. */
  mode?: 'insert' | 'view';
}

// Trim the redundant `/<name>/SKILL.md` (or trailing filename) tail — the skill
// name and "SKILL.md" label are already shown, so only the location dir is useful.
function locationOf(path: string, name: string): string {
  let p = path.replace(/\/[^/]+\.md$/, '');
  if (name && p.endsWith('/' + name)) p = p.slice(0, -(name.length + 1));
  return p;
}

// Group headers and per-source badge labels. "project" = local to this repo.
function sourceLabel(s?: string): string {
  return s === 'project' ? 'This repo' : s === 'user' ? 'Global' : 'Plugin';
}
function sourceBadge(s?: string): string {
  return s === 'project' ? 'local' : s === 'user' ? 'global' : 'plugin';
}
function badgeClass(s?: string): string {
  return s === 'project' ? styles.badgeProject : styles.badgeUser;
}

export function SkillPickerPopup({ cwd, onPick, onClose, initialSkill, mode = 'insert' }: SkillPickerPopupProps) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState(initialSkill ?? '');
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [picked, setPicked] = useState<Skill | null>(null);
  const [args, setArgs] = useState('');
  const [content, setContent] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const [writable, setWritable] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveFlash, setSaveFlash] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const initialApplied = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const argsRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  // Load skills (project + user-global) from the brain endpoint.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/brain?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal })
      .then(async res => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        return res.json() as Promise<{ skills?: Skill[] }>;
      })
      .then(json => {
        const list = Array.isArray(json.skills) ? json.skills : [];
        setSkills(list);
        // Jump straight to the requested skill once; a miss leaves the filter pre-filled.
        if (initialSkill && !initialApplied.current) {
          initialApplied.current = true;
          const match = list.find(s => s.name === initialSkill)
            ?? list.find(s => s.name.toLowerCase() === initialSkill.toLowerCase());
          if (match) { setPicked(match); setQuery(''); }
        }
      })
      .catch(err => {
        if ((err as { name?: string }).name !== 'AbortError') setError((err as Error).message);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [cwd, initialSkill]);

  // Focus the right control for the current stage.
  useEffect(() => {
    const t = setTimeout(() => {
      if (editing) editorRef.current?.focus();
      else if (picked && mode === 'insert') argsRef.current?.focus();
      else if (!picked) searchRef.current?.focus();
    }, 20);
    return () => clearTimeout(t);
  }, [picked, editing, mode]);

  // Lazily load the picked skill's SKILL.md body. `/api/file` returns the whole
  // file (no 500-line cap) plus a writable flag, so the same payload backs editing.
  useEffect(() => {
    setEditing(false);
    setSaveError(null);
    if (!picked?.path) { setContent(null); setContentError(null); setWritable(false); return; }
    const controller = new AbortController();
    setContent(null);
    setContentError(null);
    setWritable(false);
    setContentLoading(true);
    // A symlinked skill can resolve outside the guarded roots; fall back to the
    // brain read (scoped on the unresolved path) so the body still shows, read-only.
    const readBrain = async (): Promise<{ content: string; writable: boolean }> => {
      const res = await fetch(
        `/api/brain/file?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(picked.path!)}`,
        { signal: controller.signal },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const json = await res.json() as { content?: string; truncated?: boolean };
      return { content: (json.content ?? '') + (json.truncated ? '\n\n_…truncated (first 500 lines)_' : ''), writable: false };
    };
    fetch(`/api/file?path=${encodeURIComponent(picked.path)}`, { signal: controller.signal })
      .then(async res => {
        if (!res.ok) return readBrain();
        const json = await res.json() as { content?: string; writable?: boolean };
        return { content: json.content ?? '', writable: !!json.writable };
      })
      .then(r => { setContent(r.content); setWritable(r.writable); })
      .catch(err => {
        if ((err as { name?: string }).name !== 'AbortError') setContentError((err as Error).message);
      })
      .finally(() => setContentLoading(false));
    return () => controller.abort();
  }, [picked, cwd]);

  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  const isDirty = editing && draft !== (content ?? '');

  const startEdit = useCallback(() => {
    if (content === null) return;
    setDraft(content);
    setSaveError(null);
    setEditing(true);
  }, [content]);

  const cancelEdit = useCallback(() => {
    if (isDirty && !window.confirm('Discard unsaved changes?')) return;
    setEditing(false);
    setSaveError(null);
  }, [isDirty]);

  const save = useCallback(async () => {
    if (!picked?.path || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch('/api/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: picked.path, content: draft }),
      });
      if (res.status === 403) throw new Error('file is read-only');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setContent(draft);
      setEditing(false);
      setSaveFlash(true);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setSaveFlash(false), 2000);
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [picked, draft, saving]);

  // Project (local, this repo) skills rank first, then user (global), then plugins.
  const sourceRank = (s?: string) => (s === 'project' ? 0 : s === 'user' ? 1 : 2);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = [...skills].sort(
      (a, b) => sourceRank(a.source) - sourceRank(b.source) || a.name.localeCompare(b.name),
    );
    if (!q) return sorted;
    return sorted.filter(
      s => s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q),
    );
  }, [skills, query]);

  // Keep a valid selection: default to the first visible row.
  useEffect(() => {
    if (filtered.length === 0) {
      setSelectedName(null);
      return;
    }
    setSelectedName(prev => (prev && filtered.some(s => s.name === prev) ? prev : filtered[0].name));
  }, [filtered]);

  const insert = useCallback(() => {
    if (!picked) return;
    const a = args.trim();
    onPick(a ? `/${picked.name} ${a}` : `/${picked.name}`);
  }, [args, onPick, picked]);

  const pick = useCallback((skill: Skill) => {
    setPicked(skill);
    setArgs('');
  }, []);

  const back = useCallback(() => {
    if (editing && isDirty && !window.confirm('Discard unsaved changes?')) return;
    setEditing(false);
    setPicked(null);
  }, [editing, isDirty]);

  const moveSelection = useCallback(
    (dir: 1 | -1) => {
      if (filtered.length === 0) return;
      const idx = filtered.findIndex(s => s.name === selectedName);
      const next = idx < 0 ? 0 : (idx + dir + filtered.length) % filtered.length;
      const name = filtered[next].name;
      setSelectedName(name);
      // Scroll the newly selected row into view.
      requestAnimationFrame(() => {
        listRef.current?.querySelector(`[data-skill="${CSS.escape(name)}"]`)
          ?.scrollIntoView({ block: 'nearest' });
      });
    },
    [filtered, selectedName],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (editing) cancelEdit();
        else if (picked) back();
        else onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, picked, back, editing, cancelEdit]);

  const onSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const s = filtered.find(s => s.name === selectedName);
      if (s) pick(s);
    }
  };

  const handleBackdrop = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    if (isDirty && !window.confirm('Discard unsaved changes?')) return;
    onClose();
  };

  const onEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); void save(); }
  };

  const title = mode === 'view'
    ? (picked ? (editing ? 'Edit skill' : 'Skill') : 'Skills')
    : (picked ? 'Insert skill' : 'Insert a skill');

  return (
    <div className={styles.backdrop} onClick={handleBackdrop}>
      <div className={styles.modal} role="dialog" aria-label={title}>
        <div className={styles.header}>
          {picked && (
            <button className={styles.backBtn} onClick={back} title="Back (Esc)">←</button>
          )}
          <h2 className={styles.title}>{title}</h2>
          {picked && saveFlash && <span className={styles.savedFlash}>Saved</span>}
          <button className={styles.closeBtn} onClick={onClose} title="Close">✕</button>
        </div>

        {!picked && (
          <>
            <div className={styles.searchWrap}>
              <svg className={styles.searchIcon} viewBox="0 0 16 16" fill="none">
                <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.5" />
                <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <input
                ref={searchRef}
                type="text"
                className={styles.search}
                placeholder="Filter by name or description…"
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={onSearchKeyDown}
              />
              {query && (
                <button
                  className={styles.searchClear}
                  onClick={() => { setQuery(''); searchRef.current?.focus(); }}
                  title="Clear"
                >✕</button>
              )}
            </div>

            <div className={styles.list} ref={listRef}>
              {loading && <div className={styles.empty}>Loading skills…</div>}
              {!loading && error && <div className={styles.error}>Failed to load skills: {error}</div>}
              {!loading && !error && filtered.length === 0 && (
                <div className={styles.empty}>
                  {skills.length === 0 ? 'No skills found.' : `No skills match «${query.trim()}»`}
                </div>
              )}
              {!loading && !error && filtered.map((skill, i) => {
                const showHeader = i === 0 || filtered[i - 1].source !== skill.source;
                return (
                  <React.Fragment key={skill.name}>
                    {showHeader && (
                      <div className={styles.groupHeader}>{sourceLabel(skill.source)}</div>
                    )}
                    <button
                      type="button"
                      data-skill={skill.name}
                      className={`${styles.row} ${skill.name === selectedName ? styles.rowSelected : ''}`}
                      onMouseEnter={() => setSelectedName(skill.name)}
                      onClick={() => pick(skill)}
                    >
                      <div className={styles.rowTop}>
                        <span className={styles.rowName}>/{skill.name}</span>
                        <span className={`${styles.badge} ${badgeClass(skill.source)}`}>
                          {sourceBadge(skill.source)}
                        </span>
                      </div>
                      {skill.description && <div className={styles.rowDesc}>{skill.description}</div>}
                      {skill.path && <div className={styles.rowPath}>{locationOf(skill.path, skill.name)}</div>}
                    </button>
                  </React.Fragment>
                );
              })}
            </div>
          </>
        )}

        {picked && (
          <>
            <div className={`${styles.detail} ${editing ? styles.detailEditing : ''}`}>
              <div className={styles.detailTop}>
                <span className={styles.detailName}>/{picked.name}</span>
                <span className={`${styles.badge} ${badgeClass(picked.source)}`}>
                  {sourceBadge(picked.source)}
                </span>
              </div>
              {picked.path && <div className={styles.detailPath}>{locationOf(picked.path, picked.name)}</div>}
              {picked.description && <p className={styles.detailDesc}>{picked.description}</p>}

              <div className={styles.contentLabel}>
                SKILL.md
                {!editing && content !== null && !writable && <span className={styles.readOnly}>read-only</span>}
              </div>
              {contentLoading && <div className={styles.contentNote}>Loading content…</div>}
              {!contentLoading && contentError && (
                <div className={styles.contentError}>Failed to load content: {contentError}</div>
              )}
              {!contentLoading && !contentError && content !== null && !editing && (
                <div
                  className={styles.markdownContent}
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(stripFrontmatter(content)) }}
                />
              )}
              {editing && (
                <textarea
                  ref={editorRef}
                  className={styles.editor}
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={onEditorKeyDown}
                  spellCheck={false}
                />
              )}
              {saveError && <div className={styles.contentError}>Save failed: {saveError}</div>}
            </div>

            <div className={styles.footer}>
              {editing ? (
                <div className={styles.footerBtns}>
                  <span className={styles.footerHint}>⌘S to save</span>
                  <button className={styles.cancelBtn} onClick={cancelEdit}>Cancel</button>
                  <button className={styles.insertBtn} onClick={() => void save()} disabled={!isDirty || saving}>
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              ) : (
                <>
                  {mode === 'insert' && (
                    <input
                      ref={argsRef}
                      type="text"
                      className={styles.argsInput}
                      placeholder="arguments (optional)"
                      value={args}
                      onChange={e => setArgs(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); insert(); } }}
                    />
                  )}
                  <div className={styles.footerBtns}>
                    <button className={styles.cancelBtn} onClick={back}>Back</button>
                    <span className={styles.footerSpacer} />
                    {mode === 'view' && (
                      <button className={styles.cancelBtn} onClick={insert} title="Insert /skill into the prompt">
                        Insert into prompt
                      </button>
                    )}
                    {content !== null && !contentError && (
                      <button
                        className={mode === 'view' ? styles.insertBtn : styles.cancelBtn}
                        onClick={startEdit}
                        disabled={!writable}
                        title={writable ? 'Edit SKILL.md' : 'File is read-only'}
                      >
                        Edit
                      </button>
                    )}
                    {mode === 'insert' && <button className={styles.insertBtn} onClick={insert}>Insert</button>}
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
