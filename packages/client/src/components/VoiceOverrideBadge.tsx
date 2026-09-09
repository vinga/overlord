import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { resolveVoiceConfig, type VoiceInputConfig } from '../lib/voiceConfig';
import styles from './VoiceOverrideBadge.module.css';

interface Props {
  sessionId: string;
  /** Global voiceInput settings — the baseline this override sits on top of. */
  global?: Partial<VoiceInputConfig>;
  /** This session's stored override, straight off the snapshot. */
  override?: Partial<VoiceInputConfig>;
}

/**
 * Per-session voice override. Only two knobs are worth overriding per worker:
 * whether it can be addressed by voice at all, and the recognizer language —
 * a worker you dictate to in Polish next to one you dictate to in English.
 *
 * Nothing here is stored unless the user changes it: an empty override clears
 * the record, so the worker follows the global settings again.
 */
export function VoiceOverrideBadge({ sessionId, global, override }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLSpanElement | null>(null);
  // The panel header sits in its own stacking context (z-index: 1), which
  // would trap an absolutely-positioned popup underneath the sticky message
  // bar. Fixed positioning against the button's measured rect escapes it.
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);

  const effective = resolveVoiceConfig(global, override);
  const globalOnly = resolveVoiceConfig(global);
  const hasOverride = override != null && Object.keys(override).length > 0;

  // Measured before paint, so the popup never shows for a frame at a stale
  // position; re-measured while open in case the panel scrolls or resizes.
  useLayoutEffect(() => {
    if (!open) { setAnchor(null); return; }
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (r) setAnchor({ top: Math.round(r.bottom + 6), left: Math.round(r.left) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      // The popup lives in a portal, so it is not inside wrapRef any more.
      if (wrapRef.current?.contains(t) || popupRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const put = (next: Partial<VoiceInputConfig>) => {
    void fetch(`/api/sessions/${sessionId}/voice-override`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ override: next }),
    }).catch(e => console.warn('[voice-override] PUT error', e));
  };

  /** Drops a key from the override, so the field follows the global again. */
  const clearKey = (key: keyof VoiceInputConfig) => {
    const next = { ...override };
    delete next[key];
    put(next);
  };

  const label = !effective.enabled ? 'voice off' : effective.lang;

  return (
    <span className={styles.wrap} ref={wrapRef}>
      <button
        ref={btnRef}
        className={`${styles.badge} ${hasOverride ? styles.overridden : ''}`}
        onClick={() => setOpen(o => !o)}
        title={hasOverride
          ? 'Voice settings overridden for this worker'
          : 'Voice settings for this worker (following global)'}
      >
        <MicGlyph muted={!effective.enabled} />
        <span>{label}</span>
      </button>

      {open && anchor && createPortal(
        <span
          className={styles.popup}
          style={{ top: anchor.top, left: anchor.left }}
          // Clicks inside must not reach the outside-click handler's target test
          // by way of the badge wrapper, which is no longer an ancestor.
          ref={(el) => { popupRef.current = el; }}
        >
          <span className={styles.popupTitle}>Voice — this worker</span>

          <label className={styles.row}>
            <input
              type="checkbox"
              checked={effective.enabled}
              onChange={(e) => {
                // Matching the global again means dropping the key, not
                // pinning the same value — otherwise a later global change
                // would not reach this worker.
                if (e.target.checked === globalOnly.enabled) clearKey('enabled');
                else put({ ...override, enabled: e.target.checked });
              }}
            />
            <span>Addressable by voice</span>
          </label>

          <label className={styles.row}>
            <span className={styles.rowLabel}>Language</span>
            <input
              className={styles.input}
              type="text"
              defaultValue={effective.lang}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v === '' || v === globalOnly.lang) clearKey('lang');
                else if (v !== effective.lang) put({ ...override, lang: v });
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            />
          </label>

          {hasOverride && (
            <button className={styles.reset} onClick={() => put({})}>
              Follow global settings
            </button>
          )}
        </span>,
        document.body,
      )}
    </span>
  );
}

function MicGlyph({ muted }: { muted: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <rect x="9" y="2" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
      {muted && <path d="M3 3l18 18" />}
    </svg>
  );
}
