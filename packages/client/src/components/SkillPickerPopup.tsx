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

export function SkillPickerPopup({ cwd, onPick, onClose }: SkillPickerPopupProps) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [picked, setPicked] = useState<Skill | null>(null);
  const [args, setArgs] = useState('');
  const [content, setContent] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const argsRef = useRef<HTMLInputElement>(null);

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
      .then(json => setSkills(Array.isArray(json.skills) ? json.skills : []))
      .catch(err => {
        if ((err as { name?: string }).name !== 'AbortError') setError((err as Error).message);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [cwd]);

  // Focus the right control for the current stage.
  useEffect(() => {
    const t = setTimeout(() => {
      if (picked) argsRef.current?.focus();
      else searchRef.current?.focus();
    }, 20);
    return () => clearTimeout(t);
  }, [picked]);

  // Lazily load the picked skill's SKILL.md body.
  useEffect(() => {
    if (!picked?.path) { setContent(null); setContentError(null); setTruncated(false); return; }
    const controller = new AbortController();
    setContent(null);
    setContentError(null);
    setTruncated(false);
    setContentLoading(true);
    fetch(`/api/brain/file?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(picked.path)}`, {
      signal: controller.signal,
    })
      .then(async res => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        return res.json() as Promise<{ content?: string; truncated?: boolean }>;
      })
      .then(json => { setContent(json.content ?? ''); setTruncated(!!json.truncated); })
      .catch(err => {
        if ((err as { name?: string }).name !== 'AbortError') setContentError((err as Error).message);
      })
      .finally(() => setContentLoading(false));
    return () => controller.abort();
  }, [picked, cwd]);

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
    setPicked(null);
  }, []);

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
        if (picked) back();
        else onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, picked, back]);

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
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div className={styles.backdrop} onClick={handleBackdrop}>
      <div className={styles.modal} role="dialog" aria-label="Insert a skill">
        <div className={styles.header}>
          {picked && (
            <button className={styles.backBtn} onClick={back} title="Back (Esc)">←</button>
          )}
          <h2 className={styles.title}>{picked ? 'Insert skill' : 'Insert a skill'}</h2>
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
            <div className={styles.detail}>
              <div className={styles.detailTop}>
                <span className={styles.detailName}>/{picked.name}</span>
                <span className={`${styles.badge} ${badgeClass(picked.source)}`}>
                  {sourceBadge(picked.source)}
                </span>
              </div>
              {picked.path && <div className={styles.detailPath}>{locationOf(picked.path, picked.name)}</div>}
              {picked.description && <p className={styles.detailDesc}>{picked.description}</p>}

              <div className={styles.contentLabel}>SKILL.md</div>
              {contentLoading && <div className={styles.contentNote}>Loading content…</div>}
              {!contentLoading && contentError && (
                <div className={styles.contentError}>Failed to load content: {contentError}</div>
              )}
              {!contentLoading && !contentError && content !== null && (
                <>
                  <div
                    className={styles.markdownContent}
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(stripFrontmatter(content)) }}
                  />
                  {truncated && <div className={styles.contentNote}>Content truncated (first 500 lines).</div>}
                </>
              )}
            </div>

            <div className={styles.footer}>
              <input
                ref={argsRef}
                type="text"
                className={styles.argsInput}
                placeholder="arguments (optional)"
                value={args}
                onChange={e => setArgs(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); insert(); } }}
              />
              <div className={styles.footerBtns}>
                <button className={styles.cancelBtn} onClick={back}>Back</button>
                <button className={styles.insertBtn} onClick={insert}>Insert</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
