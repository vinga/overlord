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
        cursor: fixedSize ? '#0d1117' : 'transparent',
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
    // xterm.js grabs focus on open — prevent that from stealing OS focus
    term.blur();

    termRef.current = term;

    // Forward keyboard input to server
    const onDataDispose = term.onData((data) => {
      if (!isExitedRef.current) {
        onInput(data);
      } else if (onResumeRef.current) {
        setShowResumePrompt(true);
      }
    });

    // Register handler for incoming PTY output.
    // Pass cols/rows for bridge sessions so the server can resize the ConPTY to match.
    const hasContent = { current: false };
    setBridgeDisconnected(false);
    const makeHandler = () => registerOutputHandler(sessionId, (data) => {
      hasContent.current = true;
      setBridgeDisconnected(false);
      term.write(data);
    }, fixedSize?.cols ?? term.cols, fixedSize?.rows ?? term.rows);

    // For bridge sessions (fixedSize): register immediately — size is known upfront.
    // For PTY sessions: delay registration until after fitAddon.fit() so the terminal:replay
    // request is sent with the correct cols/rows. Without this, replay sends 80×24 (xterm
    // defaults), the server resizes the PTY to 80×24, Claude repaints at the wrong size,
    // and the terminal shows a fragment until a second SIGWINCH at the correct size arrives.
    let unregister: () => void = () => {};
    if (fixedSize) {
      unregister = makeHandler();
    }

    // Fit using rAF so layout is resolved (faster than 250ms timer, avoids wrong-size replay).
    // For PTY sessions, also register the output handler here (after fit) with correct cols/rows.
    let fitRaf = requestAnimationFrame(() => {
      fitRaf = 0;
      if (fitAddon) fitAddon.fit();
      onResize(term.cols, term.rows);
      if (!fixedSize) {
        unregister = makeHandler();
      }
    });

    // If no content arrives within 1.5s, re-register to trigger another terminal:replay nudge.
    // This recovers from timing issues where the bridge nudge fires before the WS handler is ready.
    const retryTimer = setTimeout(() => {
      if (!hasContent.current) {
        unregister();
        unregister = makeHandler();
      }
    }, 1500);

    // Only for fixed-size (bridge) terminals: if still no content after 8s, the bridge
    // pipe is likely dead. Show a disconnected overlay instead of a blank black screen.
    const disconnectTimer = fixedSize ? setTimeout(() => {
      if (!hasContent.current) setBridgeDisconnected(true);
    }, 8000) : null;

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
      if (fitRaf) cancelAnimationFrame(fitRaf);
      clearTimeout(retryTimer);
      if (disconnectTimer) clearTimeout(disconnectTimer);
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
