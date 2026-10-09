import React, { useEffect, useRef, useState } from 'react';
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
  onToggleCapture, onToggleMute, onRequestPermission, onOpenSettings,
}: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
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
        title="Voice control — click for shortcuts"
      >
        <span className={`${styles.dot} ${listening || speaking ? styles.pulsing : ''}`} />
        <span>{label}</span>
        {push && !blocked && !muted && !errored && !listening && !speaking && (
          <span className={styles.keys}><kbd>Alt</kbd><kbd>V</kbd></span>
        )}
      </button>

      {open && (
        <div className={styles.popover} role="dialog" aria-label="Voice control">
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
            <button className={styles.ghost} onClick={onToggleMute}>{muted ? 'Unmute' : 'Mute'}</button>
            <button className={styles.ghost} onClick={() => { setOpen(false); onOpenSettings(); }}>Settings</button>
          </div>
        </div>
      )}
    </div>
  );
}
