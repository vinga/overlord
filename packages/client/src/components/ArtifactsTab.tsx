import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Artifact, ArtifactKind, ArtifactStatus } from '../types';
import { useArtifacts } from '../hooks/useArtifacts';
import { renderMarkdown } from '../lib/markdown';
import styles from './ArtifactsTab.module.css';

const STATUS_OPTIONS: ArtifactStatus[] = ['draft', 'active', 'done', 'archived'];

const KIND_TABS: Array<{ kind: ArtifactKind; label: string; empty: string }> = [
  { kind: 'plan', label: 'Plans', empty: 'No plans yet. Create one to get started.' },
  { kind: 'summary', label: 'Summaries', empty: 'No summaries yet.' },
  { kind: 'compact', label: 'Compacts', empty: 'No compacts yet.' },
];

function statusClass(s: ArtifactStatus): string {
  switch (s) {
    case 'draft': return styles.statusDraft;
    case 'active': return styles.statusActive;
    case 'done': return styles.statusDone;
    case 'archived': return styles.statusArchived;
  }
}

function formatUpdatedAt(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const now = Date.now();
  const diffMs = now - d.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}

export function ArtifactsTab({ overlordId }: { overlordId: string | undefined }) {
  const [activeKind, setActiveKind] = useState<ArtifactKind>('plan');
  const { artifacts, isLoading, error, createArtifact, updateArtifact, deleteArtifact } = useArtifacts(overlordId, activeKind);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [titleDraft, setTitleDraft] = useState('');
  const [bodyDraft, setBodyDraft] = useState('');
  const [statusDraft, setStatusDraft] = useState<ArtifactStatus>('draft');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selected = useMemo(
    () => artifacts.find(p => p.artifactId === selectedId) ?? null,
    [artifacts, selectedId],
  );

  useEffect(() => {
    if (!selectedId && artifacts.length > 0) {
      setSelectedId(artifacts[0].artifactId);
    } else if (selectedId && !artifacts.find(p => p.artifactId === selectedId)) {
      setSelectedId(artifacts[0]?.artifactId ?? null);
    }
  }, [artifacts, selectedId]);

  // Reset selection when switching kind tabs — the list is different.
  useEffect(() => {
    setSelectedId(null);
    setDirty(false);
    setSaveError(null);
  }, [activeKind]);

  useEffect(() => {
    if (!selected) {
      setTitleDraft('');
      setBodyDraft('');
      setStatusDraft('draft');
      setDirty(false);
      setSaveError(null);
      return;
    }
    if (!dirty) {
      setTitleDraft(selected.title);
      setBodyDraft(selected.body);
      setStatusDraft(selected.status);
    }
  }, [selected, dirty]);

  useEffect(() => {
    setDirty(false);
    setSaveError(null);
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
  }, [selectedId]);

  const commitSave = useCallback(
    async (artifactId: string, patch: { title?: string; body?: string; status?: ArtifactStatus }) => {
      setSaving(true);
      setSaveError(null);
      const result = await updateArtifact(artifactId, patch);
      setSaving(false);
      if (result) {
        setDirty(false);
      } else {
        setSaveError('Failed to save');
      }
    },
    [updateArtifact],
  );

  const scheduleSave = useCallback(
    (artifactId: string, patch: { title?: string; body?: string; status?: ArtifactStatus }) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void commitSave(artifactId, patch);
      }, 600);
    },
    [commitSave],
  );

  const handleTitleChange = (value: string) => {
    setTitleDraft(value);
    setDirty(true);
    if (selected) scheduleSave(selected.artifactId, { title: value, body: bodyDraft, status: statusDraft });
  };

  const handleBodyChange = (value: string) => {
    setBodyDraft(value);
    setDirty(true);
    if (selected) scheduleSave(selected.artifactId, { title: titleDraft, body: value, status: statusDraft });
  };

  const handleStatusChange = (value: ArtifactStatus) => {
    setStatusDraft(value);
    setDirty(true);
    if (selected) void commitSave(selected.artifactId, { title: titleDraft, body: bodyDraft, status: value });
  };

  const handleCreate = async () => {
    const defaultTitle = activeKind === 'plan' ? 'Untitled plan'
      : activeKind === 'summary' ? 'Untitled summary'
      : 'Untitled compact';
    const artifact = await createArtifact({ title: defaultTitle, body: '', status: 'draft', kind: activeKind });
    if (artifact) {
      setSelectedId(artifact.artifactId);
      setMode('edit');
    }
  };

  const handleDelete = async () => {
    if (!selected) return;
    if (!confirm(`Delete "${selected.title}"? This cannot be undone.`)) return;
    const ok = await deleteArtifact(selected.artifactId);
    if (ok) setSelectedId(null);
  };

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  if (!overlordId) {
    return (
      <div className={styles.root}>
        <div className={styles.emptyState}>Artifacts are not available for this session.</div>
      </div>
    );
  }

  const activeTab = KIND_TABS.find(t => t.kind === activeKind)!;
  const canCreate = activeKind === 'plan';

  return (
    <div className={styles.root}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <div className={styles.kindTabs} role="tablist">
            {KIND_TABS.map(t => (
              <button
                key={t.kind}
                role="tab"
                aria-selected={t.kind === activeKind}
                className={`${styles.kindTab} ${t.kind === activeKind ? styles.kindTabActive : ''}`}
                onClick={() => setActiveKind(t.kind)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className={styles.sidebarHeaderRow}>
            <span className={styles.sidebarCount}>{artifacts.length} {activeKind}s</span>
            {canCreate && (
              <button className={styles.newBtn} onClick={() => void handleCreate()} disabled={isLoading}>
                + New
              </button>
            )}
          </div>
        </div>
        <div className={styles.sidebarList}>
          {error && <div className={styles.errorBanner}>Error: {error}</div>}
          {artifacts.length === 0 && !isLoading && (
            <div className={styles.empty}>{activeTab.empty}</div>
          )}
          {artifacts.map(p => (
            <div
              key={p.artifactId}
              className={`${styles.planRow} ${p.artifactId === selectedId ? styles.planRowActive : ''}`}
              onClick={() => setSelectedId(p.artifactId)}
            >
              <div className={styles.planRowTitle}>{p.title || 'Untitled'}</div>
              <div className={styles.planRowMeta}>
                <span className={`${styles.statusBadge} ${statusClass(p.status)}`}>{p.status}</span>
                <span className={styles.sourceBadge}>{p.source}</span>
                <span>·</span>
                <span>{formatUpdatedAt(p.updatedAt)}</span>
              </div>
            </div>
          ))}
        </div>
      </aside>

      <main className={styles.editor}>
        {!selected ? (
          <div className={styles.emptyState}>
            {artifacts.length === 0
              ? canCreate
                ? 'No artifact selected. Click "+ New" to create one.'
                : activeTab.empty
              : 'Select an item from the sidebar.'}
          </div>
        ) : (
          <>
            <div className={styles.editorHeader}>
              <input
                className={styles.titleInput}
                value={titleDraft}
                onChange={e => handleTitleChange(e.target.value)}
                placeholder={`${activeTab.label.replace(/s$/, '')} title`}
              />
              <select
                className={styles.statusSelect}
                value={statusDraft}
                onChange={e => handleStatusChange(e.target.value as ArtifactStatus)}
              >
                {STATUS_OPTIONS.map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <button
                className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                onClick={() => void handleDelete()}
              >
                Delete
              </button>
            </div>
            <div className={styles.editorBody}>
              <div className={styles.modeRow}>
                <button
                  className={`${styles.modeBtn} ${mode === 'edit' ? styles.modeBtnActive : ''}`}
                  onClick={() => setMode('edit')}
                >
                  Edit
                </button>
                <button
                  className={`${styles.modeBtn} ${mode === 'preview' ? styles.modeBtnActive : ''}`}
                  onClick={() => setMode('preview')}
                >
                  Preview
                </button>
                <span className={`${styles.savedIndicator} ${dirty || saving ? styles.savedIndicatorDirty : ''}`}>
                  {saveError
                    ? `Error: ${saveError}`
                    : saving
                      ? 'Saving…'
                      : dirty
                        ? 'Unsaved'
                        : `Saved ${formatUpdatedAt(selected.updatedAt)}`}
                </span>
              </div>
              {mode === 'edit' ? (
                <textarea
                  className={styles.bodyTextarea}
                  value={bodyDraft}
                  onChange={e => handleBodyChange(e.target.value)}
                  placeholder="Write in markdown…"
                  spellCheck={false}
                />
              ) : (
                <div
                  className={styles.preview}
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(bodyDraft) }}
                />
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
