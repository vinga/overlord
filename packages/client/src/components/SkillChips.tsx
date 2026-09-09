import React, { useState } from 'react';
import styles from './SkillChips.module.css';

const VISIBLE_MAX = 8;

interface SkillChipsProps {
  skills: string[];
  /** When set, chips become buttons and report the clicked skill name. */
  onSelect?: (skill: string) => void;
}

/** Chip list of skill/command names a session has invoked. */
export function SkillChips({ skills, onSelect }: SkillChipsProps) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? skills : skills.slice(0, VISIBLE_MAX);
  const hidden = skills.length - visible.length;
  return (
    <span className={styles.row}>
      {visible.map((s) => (
        onSelect ? (
          <button
            key={s}
            type="button"
            className={`${styles.chip} ${styles.chipClickable}`}
            onClick={() => onSelect(s)}
            title={`Open /${s}`}
          >
            {s}
          </button>
        ) : (
          <span key={s} className={styles.chip}>{s}</span>
        )
      ))}
      {hidden > 0 && (
        <button
          type="button"
          className={styles.more}
          onClick={() => setExpanded(true)}
          title={`Show ${hidden} more`}
        >
          +{hidden}
        </button>
      )}
    </span>
  );
}
