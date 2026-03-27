import { useEffect, useRef } from 'react';
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
  fillHeight?: boolean;
}

export function XtermTerminal({
  sessionId,
  onInput,
  onResize,
  registerOutputHandler,
  isExited,
  fillHeight,
}: XtermTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
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
      cursorBlink: true,
      scrollback: 5000,
      allowTransparency: false,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(containerRef.current);

    // Fit after a short tick so the container has measured
    requestAnimationFrame(() => {
      fitAddon.fit();
    });

    termRef.current = term;

    // Forward keyboard input to server
    const onDataDispose = term.onData((data) => {
      if (!isExited) onInput(data);
    });

    // Register handler for incoming PTY output
    const unregister = registerOutputHandler(sessionId, (data) => {
      term.write(data);
    });

    // Observe container size changes and fit/resize
    const observer = new ResizeObserver(() => {
      fitAddon.fit();
      onResize(term.cols, term.rows);
    });
    observer.observe(containerRef.current);

    return () => {
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
    <div className={styles.wrapper} style={fillHeight ? { flex: 1, minHeight: 0, height: 'auto' } : undefined}>
      {isExited && (
        <div className={styles.exitedBanner}>Session exited</div>
      )}
      <div ref={containerRef} className={styles.terminal} />
    </div>
  );
}
