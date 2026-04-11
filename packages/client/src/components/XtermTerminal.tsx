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
  registerOutputHandler: (sessionId: string, handler: (data: Uint8Array) => void, cols?: number, rows?: number) => () => void;
  isExited?: boolean;
  onResume?: () => void;
  fillHeight?: boolean;
  /** Whether this is a bridge session — used to show disconnect overlay if no content arrives. */
  isBridge?: boolean;
}

export function XtermTerminal({
  sessionId,
  onInput,
  onResize,
  registerOutputHandler,
  isExited,
  onResume,
  fillHeight,
  isBridge,
}: XtermTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [showResumePrompt, setShowResumePrompt] = useState(false);
  const [bridgeDisconnected, setBridgeDisconnected] = useState(false);
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
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: false,
      cursorStyle: 'block',
      scrollback: 5000,
      allowTransparency: false,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(containerRef.current);
    // xterm.js grabs focus on open — prevent that from stealing OS focus
    term.blur();

    termRef.current = term;

    // Forward keyboard input to server.
    // Strip focus-tracking sequences (ESC[I = focus-in, ESC[O = focus-out)
    // that xterm.js generates when the browser gains/loses focus if the running
    // application enabled focus reporting (ESC[?1004h). Claude's TUI does this,
    // so without filtering they appear as ^[[I / ^[[O garbage in the prompt.
    const onDataDispose = term.onData((data) => {
      if (!isExitedRef.current) {
        const filtered = data.replace(/\x1b\[I|\x1b\[O/g, '');
        if (filtered) onInput(filtered);
      } else if (onResumeRef.current) {
        setShowResumePrompt(true);
      }
    });

    // Register handler for incoming PTY output immediately — even if the terminal
    // tab isn't visible yet. Output accumulates in xterm's scrollback buffer so
    // switching to the terminal tab shows the full history.
    const hasContent = { current: false };
    setBridgeDisconnected(false);
    let fitted = false;
    const makeHandler = (cols?: number, rows?: number) => registerOutputHandler(sessionId, (data) => {
      hasContent.current = true;
      setBridgeDisconnected(false);
      term.write(data);
    }, cols ?? term.cols, rows ?? term.rows);

    // Register immediately with current (possibly 80×24) dimensions so output starts
    // flowing into the scrollback. We'll re-register after fit to send the right size.
    let unregister = makeHandler();

    // Fit once dimensions are positive (element visible). ResizeObserver handles both:
    //   1. Initial case — container already visible on mount (terminal tab is active)
    //   2. Tab-switch case — container goes display:none → flex, observer fires
    const tryFit = () => {
      const el = containerRef.current;
      if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
      fitAddon.fit();
      if (!fitted) {
        // First fit: re-register with correct dimensions so terminal:replay uses real size
        fitted = true;
        unregister();
        unregister = makeHandler(term.cols, term.rows);
      } else {
        onResize(term.cols, term.rows);
      }
    };

    // Also try immediately in case the container is already visible
    requestAnimationFrame(tryFit);

    // If no content arrives within 800ms, re-register to trigger another terminal:replay nudge.
    const retryTimer = setTimeout(() => {
      if (!hasContent.current) {
        unregister();
        unregister = makeHandler(fitted ? term.cols : undefined, fitted ? term.rows : undefined);
      }
    }, 800);

    // For bridge sessions: if still no content after 8s, show disconnected overlay.
    const disconnectTimer = isBridge ? setTimeout(() => {
      if (!hasContent.current) setBridgeDisconnected(true);
    }, 8000) : null;

    // Observe container size changes — handles tab-switch visibility changes and resizes
    const observer = new ResizeObserver(() => {
      tryFit();
    });
    observer.observe(containerRef.current);

    return () => {
      clearTimeout(retryTimer);
      if (disconnectTimer) clearTimeout(disconnectTimer);
      onDataDispose.dispose();
      unregister();
      observer.disconnect();
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
      {bridgeDisconnected && (
        <div className={styles.resumeOverlay}>
          <div className={styles.resumePrompt}>
            <span className={styles.resumePromptText}>Bridge disconnected</span>
            <span style={{ fontSize: 12, color: '#6e7681', textAlign: 'center' }}>
              The IntelliJ bridge process is no longer running.<br />
              Re-run the session from IntelliJ to reconnect.
            </span>
          </div>
        </div>
      )}
      <div ref={containerRef} className={styles.terminal} />
    </div>
  );
}
