import React from 'react';
import type { UseVoiceAgentResult } from '../hooks/useVoiceAgent';
import styles from './VoicePill.module.css';

interface Props {
  voice: UseVoiceAgentResult;
  /** Transient message from the last dispatch — a refusal, or an unwired verb. */
  notice: string | null;
}

/**
 * Shown only while dictating (or for a few seconds after a refused dispatch).
 * Deliberately minimal: it says that the mic is recording and nothing else.
 * The dictated text lands in the composer, and the shortcuts live in the
 * header mic's cheat sheet.
 */
export function VoicePill({ voice, notice }: Props) {
  const listening = voice.state === 'listening';
  if (!listening && !notice) return null;

  return (
    <div className={styles.host}>
      <div className={`${styles.pill} ${listening ? styles.listening : styles.errored}`} role="status">
        {listening ? (
          <>
            <span className={`${styles.dot} ${voice.sending ? '' : styles.pulsing}`} />
            <span className={styles.label}>{voice.sending ? 'Sending…' : 'Recording'}</span>
          </>
        ) : (
          <span className={styles.refused}>{notice}</span>
        )}
      </div>
    </div>
  );
}
