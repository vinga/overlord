import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import styles from './XtermTerminal.module.css';

interface XtermTerminalProps {
  sessionId: string;
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  registerOutputHandler: (sessionId: string, handler: (data: Uint8Array) => void) => () => void;
  isExited?: boolean;
  onResume?: () => void;
  fillHeight?: boolean;
  /** Fixed terminal size (disables auto-fit). Used for bridge sessions where ConPTY size is predetermined. */
  fixedSize?: { cols: number; rows: number };
}

export function XtermTerminal({
  sessionId,
  onInput,
  onResize,
  registerOutputHandler,
  isExited,
  onResume,
  fillHeight,
  fixedSize,
}: XtermTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [showResumePrompt, setShowResumePrompt] = useState(false);
  const isExitedRef = useRef(isExited);
  const onResumeRef = useRef(onResume);

  useEffect(() => { isExitedRef.current = isExited; }, [isExited]);
  useEffect(() => { onResumeRef.current = onResume; }, [onResume]);
  useEffect(() => { if (!isExited) setShowResumePrompt(false); }, [isExited]);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: 'transparent',
        cursorAccent: '#0d1117',
        selectionBackground: 'rgba(88, 166, 255, 0.25)',
        black: '#0d1117',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39c5cf',
        white: '#b1bac4',
        brightBlack: '#6e7681',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d4dd',
        brightWhite: '#f0f6fc',
      },
      fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", "Consolas", monospace',
      fontSize: fixedSize ? 11 : 13,
      lineHeight: 1.4,
      cursorBlink: false,
      cursorStyle: 'block',
      scrollback: 5000,
      allowTransparency: false,
      ...(fixedSize ? { cols: fixedSize.cols, rows: fixedSize.rows } : {}),
    });

    const fitAddon = fixedSize ? null : new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    if (fitAddon) term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(containerRef.current);

    // Fit after panel slide-in animation completes (200ms)
    const fitTimer = setTimeout(() => {
      if (fitAddon) {
        fitAddon.fit();
      }
      onResize(term.cols, term.rows);
    }, 250);

    termRef.current = term;

    // Forward keyboard input to server
    const onDataDispose = term.onData((data) => {
      if (!isExitedRef.current) {
        onInput(data);
      } else if (onResumeRef.current) {
        setShowResumePrompt(true);
      }
    });

    // Register handler for incoming PTY output
    const unregister = registerOutputHandler(sessionId, (data) => {
      term.write(data);
    });

    // Observe container size changes and fit/resize (skip for fixed-size bridge terminals)
    let observer: ResizeObserver | null = null;
    if (fitAddon) {
      observer = new ResizeObserver(() => {
        fitAddon.fit();
        onResize(term.cols, term.rows);
      });
      observer.observe(containerRef.current);
    }

    return () => {
      clearTimeout(fitTimer);
      onDataDispose.dispose();
      unregister();
      observer?.disconnect();
      term.dispose();
      termRef.current = null;
    };
    // Only re-initialize if sessionId changes; isExited is handled via ref below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  return (
    <div
      className={`${styles.wrapper} ${isExited ? styles.wrapperExited : ''}`}
      style={fillHeight ? { flex: 1, minHeight: 0, height: 'auto' } : undefined}
    >
      {isExited && (
        <div className={styles.exitedBanner}>Session exited</div>
      )}
      {showResumePrompt && onResume && (
        <div className={styles.resumeOverlay}>
          <div className={styles.resumePrompt}>
            <span className={styles.resumePromptText}>
              This session has exited. Resume it?
            </span>
            <div className={styles.resumePromptActions}>
              <button
                className={`${styles.resumePromptButton} ${styles.resumePromptButtonPrimary}`}
                onClick={() => { setShowResumePrompt(false); onResume(); }}
              >
                Resume Session
              </button>
              <button
                className={`${styles.resumePromptButton} ${styles.resumePromptButtonSecondary}`}
                onClick={() => setShowResumePrompt(false)}
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}
      <div ref={containerRef} className={styles.terminal} />
    </div>
  );
}
