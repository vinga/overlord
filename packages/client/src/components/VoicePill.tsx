import React from 'react';
import type { UseVoiceAgentResult } from '../hooks/useVoiceAgent';
import styles from './VoicePill.module.css';

interface Props {
  voice: UseVoiceAgentResult;
  /** Transient message from the last dispatch — a refusal, or an unwired verb. */
  notice: string | null;
  /** Words the user says to open and to commit — shown as the idle hint. */
  startWord: string;
  stopWord: string;
  maxUtteranceMs: number;
  /**
   * Distance from the viewport bottom. The default gutter (44px) assumes a
   * right-docked panel; a bottom-docked panel covers the whole lower edge, so
   * the pill must sit above its top edge or it lands on the composer.
   */
  bottomOffset?: number;
}

/**
 * The only always-visible sign that the microphone is on. It deliberately shows
 * three things at once while capturing — what was heard, who will receive it,
 * and how much of the utterance cap is used — so a wrong target is obvious
 * before the stop word is said rather than after.
 */
export function VoicePill({ voice, notice, startWord, stopWord, maxUtteranceMs, bottomOffset }: Props) {
  // The settings may list several alternatives; the hint shows the first.
  const startLabel = startWord.split(',')[0].trim() || startWord;
  const stopLabel = stopWord.split(',')[0].trim() || stopWord;
  // A missing microphone grant is the one state that must always be visible:
  // without it the recognizer runs but hears nothing, so the start word would
  // silently do nothing.
  const needsPermission = voice.permission === 'denied';
  if (voice.state === 'off' && !voice.muted && !notice && !needsPermission) return null;

  const listening = voice.state === 'listening';
  const errored = voice.state === 'error';

  const tone = needsPermission ? styles.errored
    : voice.muted ? styles.muted
    : errored ? styles.errored
    : listening ? styles.listening
    : styles.idle;

  const preview = voice.preview;
  const targetLabel = preview?.kind === 'prompt' ? preview.name
    : preview?.kind === 'control' ? (preview.name ?? preview.verb)
    : null;
  const refusal = preview?.kind === 'refused' ? preview.reason : null;

  const capPct = Math.min(100, (voice.elapsedMs / Math.max(1, maxUtteranceMs)) * 100);

  const title = needsPermission
    ? 'Microphone blocked for this site. Allow it in Chrome\u2019s site settings (padlock in the address bar), then reload.'
    : voice.muted
      ? 'Voice input muted — click or press Alt+M to unmute'
      : listening
        ? `Say "${stopLabel}" to send, "cancel" to discard`
        : `Say "${startLabel}" to start`;

  const onActivate = needsPermission ? voice.requestPermission : voice.toggleMute;

  return (
    <div className={styles.host} style={bottomOffset !== undefined ? { bottom: bottomOffset } : undefined}>
      <div className={styles.wrap}>
        <div
          className={`${styles.pill} ${tone}`}
          onClick={onActivate}
          title={title}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onActivate(); }}
        >
          <span className={`${styles.dot} ${listening ? styles.pulsing : ''}`} />

          {needsPermission && <span className={styles.label}>microphone blocked</span>}

          {!needsPermission && voice.muted && <span className={styles.label}>mic off</span>}

          {!needsPermission && !voice.muted && errored && (
            <span className={styles.transcript}>{voice.error ?? 'voice error'}</span>
          )}

          {!needsPermission && !voice.muted && !errored && !listening && (
            notice
              ? <span className={styles.refused}>{notice}</span>
              : <>
                  <span className={styles.label}>say “{startLabel}”</span>
                  {voice.heard && <span className={styles.heard}>{voice.heard}</span>}
                </>
          )}

          {!needsPermission && !voice.muted && listening && (
            <>
              <span className={styles.label}>listening</span>
              <span className={styles.transcript}>
                {voice.captured.trim() === '' ? '…' : voice.captured}
              </span>
              {refusal
                ? <span className={styles.refused}>{refusal}</span>
                : targetLabel && <span className={styles.target}>{targetLabel}</span>}
            </>
          )}

          {listening && (
            <span className={styles.cap}>
              <span className={styles.capFill} style={{ width: `${capPct}%` }} />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
