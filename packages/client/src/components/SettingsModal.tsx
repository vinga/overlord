import React, { useEffect } from 'react';
import type { GlobalSettings } from '../types';
import styles from './SettingsModal.module.css';

interface Props {
  settings: GlobalSettings;
  onUpdate: (partial: Partial<GlobalSettings>) => void;
  onClose: () => void;
}

export function SettingsModal({ settings, onUpdate, onClose }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Settings">
        <div className={styles.header}>
          <h2 className={styles.title}>Settings</h2>
          <button className={styles.close} onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className={styles.body}>
          <div className={styles.row}>
            <div className={styles.rowText}>
              <div className={styles.rowLabel}>Enable background AI intent queries</div>
              <div className={styles.rowHint}>
                Lets Overlord run Haiku queries to label sessions with a rolling intent summary. Worker cards will show what each session is working on. Turn off to be cheaper and quieter.
              </div>
            </div>
            <button
              className={`${styles.toggle} ${!settings.disableBackgroundLLM ? styles.toggleOn : ''}`}
              onClick={() => onUpdate({ disableBackgroundLLM: !settings.disableBackgroundLLM })}
              role="switch"
              aria-checked={!settings.disableBackgroundLLM}
              aria-label="Enable background AI intent queries"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
