import React, { useState, useRef } from 'react';
import styles from './SessionCommands.module.css';

interface Props {
  cwd: string;
  name: string;
  /** If provided, generates resume commands; otherwise generates new-session commands. */
  sessionId?: string;
  bridgePath?: string;
  label?: string;
}

function CopyIcon({ confirmed }: { confirmed: boolean }) {
  if (confirmed) {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    );
  }
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CommandRow({ command, dim, small }: { command: string; dim?: boolean; small?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className={styles.commandRow} style={{ opacity: dim ? 0.72 : undefined }}>
      <code style={small ? { fontSize: '0.78em' } : undefined}>{command}</code>
      <button className={styles.copyIcon} onClick={copy} title="Copy">
        <CopyIcon confirmed={copied} />
      </button>
    </div>
  );
}

/**
 * Renders a direct `claude` command and a bridge command for a session,
 * each with a copy button. Pass `sessionId` for resume commands, omit for new-session commands.
 */
export function SessionCommands({ cwd, name, sessionId, bridgePath, label }: Props) {
  // Stable random marker for new sessions (no sessionId available yet)
  const newMarkerRef = useRef(Math.random().toString(36).slice(2, 10));

  const safeName = name.replace(/["\s]/g, '-');
  const bridgeBin = bridgePath ? `& "${bridgePath}"` : 'overlord-bridge';

  let directCmd: string;
  let bridgeCmd: string;

  if (sessionId) {
    // Resume: --resume handles CWD internally, so no cd needed in the bridge variant
    const marker = sessionId.slice(0, 8);
    directCmd = `cd "${cwd}" && claude --resume ${sessionId} --name "${name}"`;
    bridgeCmd = `${bridgeBin} --pipe overlord-${marker} -- claude --resume ${sessionId} --name ${safeName}___BRG:${marker}`;
  } else {
    // New session: include cd in both variants
    const marker = newMarkerRef.current;
    directCmd = `cd "${cwd}" && claude --name "${name}"`;
    bridgeCmd = `cd "${cwd}" && ${bridgeBin} --pipe overlord-${marker} -- claude --name ${safeName}___BRG:${marker}`;
  }

  return (
    <div className={styles.root}>
      {label && <div className={styles.sectionLabel}>{label}</div>}
      <CommandRow command={directCmd} />
      <CommandRow command={bridgeCmd} dim small />
    </div>
  );
}
