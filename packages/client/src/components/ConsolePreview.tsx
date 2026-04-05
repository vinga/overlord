import React, { useState, useEffect, useRef } from 'react';
import type { WorkerState } from '../types';
import styles from './ConsolePreview.module.css';

interface ConsolePreviewProps {
  sessionId: string;
  sessionState: WorkerState;
  isPty: boolean;
  launchMethod?: string;
}

export function ConsolePreview({ sessionId, sessionState, isPty, launchMethod }: ConsolePreviewProps) {
  const [expanded, setExpanded] = useState(false);
  const [screenText, setScreenText] = useState('');
  const [available, setAvailable] = useState(true);
  // Generation counter — incremented on every session change and effect restart.
  // Stale fetches compare their captured generation to the current ref and discard if mismatched.
  const generationRef = useRef(0);
  const prevSessionId = useRef(sessionId);

  // Reset on session change
  if (prevSessionId.current !== sessionId) {
    prevSessionId.current = sessionId;
    generationRef.current++;
    setExpanded(false);
    setScreenText('');
    setAvailable(true);
  }

  // Poll when expanded and session is active
  useEffect(() => {
    if (!expanded || isPty || sessionState === 'closed') return;

    const gen = ++generationRef.current;

    const doFetch = async () => {
      if (generationRef.current !== gen) return;
      try {
        const res = await fetch(`/api/sessions/${sessionId}/screen`);
        if (generationRef.current !== gen) return; // stale — discard
        if (!res.ok) {
          setAvailable(false);
          return;
        }
        const data = await res.json();
        if (generationRef.current !== gen) return; // stale — discard
        // Verify server returned data for the correct session
        if (data.sessionId && data.sessionId !== sessionId) return;
        const text = (data.text ?? '').trimEnd();
        if (text) {
          setScreenText(text);
          setAvailable(true);
        } else {
          setScreenText('');
        }
      } catch {
        if (generationRef.current === gen) setAvailable(false);
      }
    };

    void doFetch();
    const interval = setInterval(() => { void doFetch(); }, 4000);
    return () => {
      generationRef.current++;
      clearInterval(interval);
    };
  }, [expanded, isPty, sessionState, sessionId]);

  // Don't render for PTY sessions (Terminal tab), IDE sessions (shared console), or closed
  if (isPty || sessionState === 'closed' || launchMethod === 'ide') return null;
  if (!available && !screenText) return null;

  return (
    <div className={styles.consolePreviewContainer}>
      <button
        className={styles.consoleToggle}
        onClick={() => setExpanded(e => !e)}
      >
        <span className={styles.consoleToggleIcon}>{expanded ? '▾' : '▸'}</span>
        <span className={styles.consoleToggleLabel}>Console Preview</span>
      </button>
      {expanded && screenText && (
        <>
          <pre className={styles.consoleContent}>{screenText}</pre>
          <div className={styles.consoleDisclaimer}>Live console screen buffer · refreshes every 4s</div>
        </>
      )}
      {expanded && !screenText && (
        <div className={styles.consoleEmpty}>No console output captured</div>
      )}
    </div>
  );
}
