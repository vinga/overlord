import { useEffect, useRef, useState } from 'react';
import type { Plan, PlanStatus } from '../types';
import { usePlansByCwd } from '../hooks/usePlansByCwd';
import styles from './RoomDetailsTab.module.css';

interface Props {
  cwd: string;
}

const AUTOSAVE_DELAY_MS = 800;

export function RoomDetailsTab({ cwd }: Props) {
  const [description, setDescription] = useState('');
  const [descriptionInitial, setDescriptionInitial] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const savedRef = useRef('');
  const inFlightRef = useRef(false);
  const pendingRef = useRef<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    fetch(`/api/room-config?cwd=${encodeURIComponent(cwd)}`)
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ prefix: string; description: string }>;
      })
      .then(cfg => {
        if (cancelled) return;
        const initial = cfg.description ?? '';
        setDescription(initial);
        setDescriptionInitial(initial);
        savedRef.current = initial;
        setLoaded(true);
      })
      .catch(err => { if (!cancelled) { setError(String(err)); setLoaded(true); } });
    return () => { cancelled = true; };
  }, [cwd]);

  const persist = async (value: string) => {
    if (inFlightRef.current) {
      pendingRef.current = value;
      return;
    }
    if (value === savedRef.current) return;
    inFlightRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch('/api/room-config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd, description: value }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      savedRef.current = value;
      setDescriptionInitial(value);
      setSavedAt(Date.now());
    } catch (err) {
      setError(String(err));
    } finally {
      inFlightRef.current = false;
      setSaving(false);
      const next = pendingRef.current;
      if (next !== null && next !== savedRef.current) {
        pendingRef.current = null;
        void persist(next);
      } else {
        pendingRef.current = null;
      }
    }
  };

  const flushNow = () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (description !== savedRef.current) void persist(description);
  };

  useEffect(() => {
    if (!loaded) return;
    if (description === savedRef.current) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      void persist(description);
    }, AUTOSAVE_DELAY_MS);
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [description, loaded]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
        if (description !== savedRef.current) void persist(description);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = description !== descriptionInitial;
  const status = saving
    ? 'Saving…'
    : dirty
      ? 'Unsaved'
      : savedAt
        ? 'Saved'
        : '';

  return (
    <div className={styles.panel}>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="room-description">Description</label>
        <textarea
          id="room-description"
          ref={descriptionRef}
          className={styles.textarea}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={flushNow}
          placeholder="What is this room for?"
          disabled={!loaded}
          spellCheck={false}
        />
        <span className={styles.hint}>
          The first line is shown as a subtitle under the room name. If empty, nothing is shown.
        </span>
      </div>
      <div className={styles.actions}>
        {error
          ? <span className={styles.error}>{error}</span>
          : <span className={dirty || saving ? styles.statusMuted : styles.saved}>{status}</span>}
      </div>
      <RoomPlansSection cwd={cwd} />
    </div>
  );
}

function statusClass(s: PlanStatus): string {
  switch (s) {
    case 'draft': return styles.planStatusDraft;
    case 'active': return styles.planStatusActive;
    case 'done': return styles.planStatusDone;
    case 'archived': return styles.planStatusArchived;
  }
}

function formatRel(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const diffMs = Date.now() - d.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return d.toLocaleDateString();
}

function RoomPlansSection({ cwd }: { cwd: string }) {
  const { plans, isLoading } = usePlansByCwd(cwd);
  const [open, setOpen] = useState(true);

  const visible: Plan[] = plans.filter(p => p.status !== 'archived');

  return (
    <div className={styles.plansSection}>
      <div className={styles.plansHeader} onClick={() => setOpen(v => !v)}>
        <span className={styles.plansHeaderLabel}>Plans in this room</span>
        <span className={styles.plansHeaderCount}>{isLoading ? '…' : visible.length}</span>
        <span className={`${styles.plansChevron} ${open ? styles.plansChevronOpen : ''}`}>▶</span>
      </div>
      {open && (
        <div className={styles.plansList}>
          {visible.length === 0 ? (
            <div className={styles.plansEmpty}>
              {isLoading ? 'Loading…' : 'No plans for this room yet.'}
            </div>
          ) : visible.map(p => (
            <div key={p.planId} className={styles.planRow}>
              <span className={`${styles.planStatusBadge} ${statusClass(p.status)}`}>{p.status}</span>
              <span className={styles.planRowTitle} title={p.title}>{p.title || 'Untitled'}</span>
              <span className={styles.planRowTime}>{formatRel(p.updatedAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
