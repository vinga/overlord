import React from 'react';
import type { UseVoiceAgentResult } from '../hooks/useVoiceAgent';
import styles from './VoicePill.module.css';

interface Props {
  voice: UseVoiceAgentResult;
  /** Transient message from the last dispatch — a refusal, or an unwired verb. */
  notice: string | null;
  /** Words that commit / discard a capture, shown as the hint while listening. */
  stopWord: string;
  cancelWord: string;
  maxUtteranceMs: number;
  /**
   * Distance from the viewport bottom. The default gutter (44px) assumes a
   * right-docked panel; a bottom-docked panel covers the whole lower edge, so
   * the pill must sit above its top edge or it lands on the composer.
   */
  bottomOffset?: number;
}

/**
 * Shown only while dictating (or for a few seconds after a refused dispatch).
 * The idle, muted and blocked states live in the status-bar chip, so nothing
 * floats over the office when the microphone is not in use.
 *
 * While capturing it shows what was heard, who will receive it, how to finish,
 * and how much of the utterance cap is used — so a wrong target is obvious
 * before sending rather than after.
 */
export function VoicePill({ voice, notice, stopWord, cancelWord, maxUtteranceMs, bottomOffset }: Props) {
  const listening = voice.state === 'listening';
  if (!listening && !notice) return null;

  const stopLabel = stopWord.split(',')[0].trim() || stopWord;
  const cancelLabel = cancelWord.split(',')[0].trim() || cancelWord;

  const preview = voice.preview;
  const targetLabel = preview?.kind === 'prompt' ? preview.name
    : preview?.kind === 'control' ? (preview.name ?? preview.verb)
    : null;
  const refusal = preview?.kind === 'refused' ? preview.reason : null;
  const capPct = Math.min(100, (voice.elapsedMs / Math.max(1, maxUtteranceMs)) * 100);

  return (
    <div className={styles.host} style={bottomOffset !== undefined ? { bottom: bottomOffset } : undefined}>
      <div className={`${styles.pill} ${listening ? styles.listening : styles.errored}`} role="status">
        {!listening && <span className={styles.refused}>{notice}</span>}

        {listening && (
          <>
            <span className={`${styles.dot} ${voice.sending ? '' : styles.pulsing}`} />
            <span className={styles.transcript}>
              {voice.captured.trim() === '' ? 'Listening…' : voice.captured}
            </span>
            {refusal
              ? <span className={styles.refused}>{refusal}</span>
              : targetLabel && <span className={styles.target}>→ {targetLabel}</span>}
            <span className={styles.hint}>
              {voice.sending ? <b>sending…</b> : voice.manual
                ? <><kbd>Enter</kbd> send · <kbd>Esc</kbd> cancel</>
                : <>“{stopLabel}” send · “{cancelLabel}” cancel</>}
            </span>
            <button className={styles.iconBtn} onClick={voice.commit} title="Send">↵</button>
            <button className={styles.iconBtn} onClick={voice.discard} title="Cancel (Esc)">✕</button>
            <span className={styles.cap}>
              <span className={styles.capFill} style={{ width: `${capPct}%` }} />
            </span>
          </>
        )}
      </div>
    </div>
  );
}
