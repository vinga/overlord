import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MicPermission } from '../hooks/useVoiceAgent';
import type { VoiceState } from '../lib/voiceAgent';
import type { VoiceInputConfig } from '../lib/voiceConfig';
import styles from './VoiceStatusChip.module.css';

interface Props {
  state: VoiceState;
  muted: boolean;
  permission: MicPermission;
  error: string | null;
  cfg: VoiceInputConfig;
  /** Worker whose reply is being read aloud, or null. */
  speaking: string | null;
  onStopSpeaking: () => void;
  onToggleCapture: () => void;
  onToggleMute: () => void;
  onRequestPermission: () => void;
  onOpenSettings: () => void;
  /** Flips "Stay on after send" (push mode). */
  onToggleStayOn: () => void;
}

function MicIcon({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
      <rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      {muted && <path d="M2 2l12 12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />}
    </svg>
  );
}

/** First alternative of a comma-separated word setting. */
function firstWord(raw: string): string {
  return raw.split(',')[0].trim() || raw;
}

/**
 * Persistent microphone status, docked in the office status bar so it never
 * covers content. Clicking it opens a cheat sheet with the shortcuts for the
 * current mode, and — when Chrome blocked the microphone — how to unblock it.
 */
export function VoiceStatusChip({
  state, muted, permission, error, cfg, speaking, onStopSpeaking,
  onToggleCapture, onToggleMute, onRequestPermission, onOpenSettings, onToggleStayOn,
}: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // The popover is portalled to <body>: the office pane clips its overflow, and
  // in a narrow pane the cheat sheet is wider than the room left of the chip.
  useLayoutEffect(() => {
    if (!open || !ref.current) { setPos(null); return; }
    const place = () => {
      const r = ref.current!.getBoundingClientRect();
      const width = popRef.current?.offsetWidth ?? 344;
      setPos({ top: r.bottom + 8, left: Math.max(16, Math.min(r.left, window.innerWidth - width - 16)) });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const push = cfg.activation === 'push';
  const blocked = permission === 'denied';
  const listening = state === 'listening';
  const errored = state === 'error';

  const tone = blocked || errored ? styles.bad
    : muted ? styles.off
    : listening || speaking ? styles.live
    : styles.ready;

  const idle = !blocked && !errored && !listening && !speaking;

  const label = blocked ? 'Mic blocked'
    : muted ? 'Mic off'
    : errored ? 'Mic error'
    : listening ? 'Listening'
    : speaking ? 'Speaking — click to stop'
    : push ? 'Voice' : `Say “${firstWord(cfg.startWord)}”`;

  return (
    <div className={styles.root} ref={ref}>
      <button
        className={`${styles.chip} ${tone}`}
        // While a reply is read aloud the chip is a stop button.
        onClick={() => { if (speaking) onStopSpeaking(); else setOpen(o => !o); }}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={idle
          ? `${muted ? 'Microphone off' : push ? 'Voice: Alt+V to dictate' : `Voice: say “${firstWord(cfg.startWord)}”`} — click for shortcuts`
          : 'Voice control — click for shortcuts'}
        aria-label={idle ? (muted ? 'Microphone off' : 'Voice control') : undefined}
      >
        {/* Idle, it is a bare mic icon — the header is tight and the cheat
            sheet holds the details. States that need attention get a label. */}
        {idle ? <MicIcon muted={muted} /> : <>
          <span className={`${styles.dot} ${listening || speaking ? styles.pulsing : ''}`} />
          <span>{label}</span>
        </>}
      </button>

      {open && createPortal(
        <div
          ref={popRef}
          className={styles.popover}
          role="dialog"
          aria-label="Voice control"
          style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden' }}
        >
          {blocked && (
            <div className={styles.alert}>
              <div className={styles.alertTitle}>Chrome blocked the microphone</div>
              <ol className={styles.steps}>
                <li>Click the site-settings icon left of the address bar.</li>
                <li>Set <b>Microphone</b> to <b>Allow</b>.</li>
                <li>Reload the page.</li>
              </ol>
              <button className={styles.action} onClick={onRequestPermission}>Try again</button>
            </div>
          )}

          {!blocked && errored && error && (
            <div className={styles.alert}>
              <div className={styles.alertTitle}>Speech recognition failed</div>
              <div className={styles.muted}>{error}</div>
            </div>
          )}

          <div className={styles.sectionTitle}>{push ? 'Push to talk' : 'Wake word'}</div>
          <dl className={styles.table}>
            {push ? (
              <>
                <dt><kbd>Alt</kbd><kbd>V</kbd> or 🎙</dt><dd>Start dictating</dd>
                <dt><kbd>Enter</kbd> or “{firstWord(cfg.stopWord)}” + pause</dt><dd>Send</dd>
                {cfg.stayOnAfterSend && <><dt>Stay on</dt><dd>Mic reopens after each send; <kbd>Esc</kbd> stops</dd></>}
              </>
            ) : (
              <>
                <dt>“{firstWord(cfg.startWord)}”</dt><dd>Start</dd>
                <dt>“{firstWord(cfg.stopWord)}” + pause</dt><dd>Send</dd>
                <dt><kbd>Alt</kbd><kbd>V</kbd></dt><dd>Start / send without words</dd>
              </>
            )}
            <dt><kbd>Esc</kbd> or “{firstWord(cfg.cancelWord)}”</dt><dd>Cancel</dd>
            <dt><kbd>Alt</kbd><kbd>M</kbd></dt><dd>{muted ? 'Unmute' : 'Mute'} microphone</dd>
            {cfg.speakReplies && <><dt><kbd>Esc</kbd></dt><dd>Stop reading a reply</dd></>}
          </dl>
          <div className={styles.note}>
            Dictation goes to the open worker. Say a worker’s name first to address another one.
          </div>

          <div className={styles.footer}>
            {!blocked && !muted && (
              <button className={styles.action} onClick={() => { onToggleCapture(); setOpen(false); }}>
                {listening ? 'Send' : 'Start dictating'}
              </button>
            )}
            {push && (
              <button className={styles.ghost} onClick={onToggleStayOn} aria-pressed={cfg.stayOnAfterSend}
                title="After sending, dictation reopens for the next message">
                {cfg.stayOnAfterSend ? 'Stay on ✓' : 'Stay on'}
              </button>
            )}
            <button className={styles.ghost} onClick={onToggleMute}>{muted ? 'Unmute' : 'Mute'}</button>
            <button className={styles.ghost} onClick={() => { setOpen(false); onOpenSettings(); }}>Settings</button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
