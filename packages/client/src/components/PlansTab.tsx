import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Plan, PlanStatus } from '../types';
import { usePlans } from '../hooks/usePlans';
import { renderMarkdown } from '../lib/markdown';
import styles from './PlansTab.module.css';

const STATUS_OPTIONS: PlanStatus[] = ['draft', 'active', 'done', 'archived'];

function statusClass(s: PlanStatus): string {
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

export function PlansTab({ overlordId }: { overlordId: string | undefined }) {
  const { plans, isLoading, error, createPlan, updatePlan, deletePlan } = usePlans(overlordId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [titleDraft, setTitleDraft] = useState('');
  const [bodyDraft, setBodyDraft] = useState('');
  const [statusDraft, setStatusDraft] = useState<PlanStatus>('draft');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selected = useMemo(
    () => plans.find(p => p.planId === selectedId) ?? null,
    [plans, selectedId],
  );

  useEffect(() => {
    if (!selectedId && plans.length > 0) {
      setSelectedId(plans[0].planId);
    } else if (selectedId && !plans.find(p => p.planId === selectedId)) {
      setSelectedId(plans[0]?.planId ?? null);
    }
  }, [plans, selectedId]);

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
    async (planId: string, patch: { title?: string; body?: string; status?: PlanStatus }) => {
      setSaving(true);
      setSaveError(null);
      const result = await updatePlan(planId, patch);
      setSaving(false);
      if (result) {
        setDirty(false);
      } else {
        setSaveError('Failed to save');
      }
    },
    [updatePlan],
  );

  const scheduleSave = useCallback(
    (planId: string, patch: { title?: string; body?: string; status?: PlanStatus }) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void commitSave(planId, patch);
      }, 600);
    },
    [commitSave],
  );

  const handleTitleChange = (value: string) => {
    setTitleDraft(value);
    setDirty(true);
    if (selected) scheduleSave(selected.planId, { title: value, body: bodyDraft, status: statusDraft });
  };

  const handleBodyChange = (value: string) => {
    setBodyDraft(value);
    setDirty(true);
    if (selected) scheduleSave(selected.planId, { title: titleDraft, body: value, status: statusDraft });
  };

  const handleStatusChange = (value: PlanStatus) => {
    setStatusDraft(value);
    setDirty(true);
    if (selected) void commitSave(selected.planId, { title: titleDraft, body: bodyDraft, status: value });
  };

  const handleCreate = async () => {
    const plan = await createPlan({ title: 'Untitled plan', body: '', status: 'draft' });
    if (plan) {
      setSelectedId(plan.planId);
      setMode('edit');
    }
  };

  const handleDelete = async () => {
    if (!selected) return;
    if (!confirm(`Delete "${selected.title}"? This cannot be undone.`)) return;
    const ok = await deletePlan(selected.planId);
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
        <div className={styles.emptyState}>Plans are not available for this session.</div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <span className={styles.sidebarTitle}>Plans</span>
          <span className={styles.sidebarCount}>{plans.length}</span>
          <button className={styles.newBtn} onClick={() => void handleCreate()} disabled={isLoading}>
            + New
          </button>
        </div>
        <div className={styles.sidebarList}>
          {error && <div className={styles.errorBanner}>Error: {error}</div>}
          {plans.length === 0 && !isLoading && (
            <div className={styles.empty}>No plans yet. Create one to get started.</div>
          )}
          {plans.map(p => (
            <div
              key={p.planId}
              className={`${styles.planRow} ${p.planId === selectedId ? styles.planRowActive : ''}`}
              onClick={() => setSelectedId(p.planId)}
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
            {plans.length === 0
              ? 'No plan selected. Click "+ New" to create one.'
              : 'Select a plan from the sidebar.'}
          </div>
        ) : (
          <>
            <div className={styles.editorHeader}>
              <input
                className={styles.titleInput}
                value={titleDraft}
                onChange={e => handleTitleChange(e.target.value)}
                placeholder="Plan title"
              />
              <select
                className={styles.statusSelect}
                value={statusDraft}
                onChange={e => handleStatusChange(e.target.value as PlanStatus)}
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
                  placeholder="Write your plan in markdown…"
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
