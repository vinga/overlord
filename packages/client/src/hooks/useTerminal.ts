import { useRef, useCallback, useState } from 'react';
import type { SessionProvider, TerminalMessage, TerminalSpawnMode } from '../types';

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

export interface UseTerminalResult {
  handleTerminalMessage: (msg: TerminalMessage) => void;
  spawnSession: (cwd: string, cols?: number, rows?: number, name?: string, provider?: SessionProvider) => void;
  spawnRawShell: (cwd: string, cols?: number, rows?: number, name?: string) => void;
  restartShell: (sessionId: string, cols?: number, rows?: number) => void;
  resumeSession: (resumeSessionId: string, cwd: string, cols?: number, rows?: number) => void;
  sendInput: (ovrId: string, data: string) => void;
  injectText: (ovrId: string, text: string, extraEnter?: boolean) => boolean;
  resizePty: (ovrId: string, cols: number, rows: number) => void;
  registerOutputHandler: (ovrId: string, handler: (data: Uint8Array) => void, cols?: number, rows?: number) => () => void;
  isPtySession: (ovrId: string) => boolean;
  getError: (ovrId: string) => string | undefined;
  killSession: (ovrId: string) => void;
  openInTerminal: (sessionId: string, cwd: string) => void;
  openBridgedTerminal: (sessionId: string, cwd: string) => void;
  openNewTerminal: (cwd: string, name?: string, mode?: TerminalSpawnMode, provider?: SessionProvider) => void;
  ptySessionIds: Set<string>;
  exitedSessions: Set<string>;
  isBridgeSession: (ovrId: string) => boolean;
}

export function useTerminal(
  sendMessage: (msg: object) => boolean,
  onSpawned?: (sessionId: string) => void
): UseTerminalResult {
  // All maps keyed by ovrId (stable Overlord session ID) — never migrated
  const outputHandlers = useRef(new Map<string, (data: Uint8Array) => void>());
  const outputBuffer = useRef(new Map<string, Uint8Array[]>());
  const exitHandlers = useRef(new Map<string, () => void>());

  // Use state for ptySessionIds and exitedSessions so components re-render on change.
  // These sets contain ovrIds (or ptySessionIds before terminal:linked arrives).
  const [ptySessionIds, setPtySessionIds] = useState<Set<string>>(new Set());
  const [exitedSessions, setExitedSessions] = useState<Set<string>>(new Set());
  const [sessionErrors, setSessionErrors] = useState<Map<string, string>>(new Map());

  // Bridge sessions tracked by ovrId
  const bridgeSessionIds = useRef(new Set<string>());

  // FIFO counter of spawn intents originating from THIS client. Each
  // spawn*/resume call increments; the next terminal:spawned consumes one and
  // fires onSpawned immediately so the UI can redirect to the new session
  // before terminal:linked arrives.
  const pendingLocalSpawnsRef = useRef(0);

  const onSpawnedRef = useRef(onSpawned);
  onSpawnedRef.current = onSpawned;

  const handleTerminalMessage = useCallback((msg: TerminalMessage) => {
    if (msg.type === 'terminal:output') {
      // msg.sessionId is ovrId
      const handler = outputHandlers.current.get(msg.sessionId);
      if (handler) {
        try {
          handler(decodeBase64(msg.data));
        } catch {
          handler(new TextEncoder().encode(msg.data));
        }
      } else {
        // Buffer until handler registers (e.g. during panel transition).
        // Byte-capped at 2 MB per session — beyond that the oldest chunks are
        // dropped; the server-side ptyOutputBuffer replay covers the gap.
        try {
          const bytes = decodeBase64(msg.data);
          const buf = outputBuffer.current.get(msg.sessionId) ?? [];
          buf.push(bytes);
          let total = buf.reduce((n, c) => n + c.byteLength, 0);
          while (total > 2 * 1024 * 1024 && buf.length > 1) {
            total -= buf.shift()!.byteLength;
          }
          outputBuffer.current.set(msg.sessionId, buf);
        } catch { /* ignore */ }
      }
    } else if (msg.type === 'terminal:spawned') {
      setPtySessionIds((prev) => {
        const next = new Set(prev);
        next.add(msg.sessionId);
        return next;
      });
      // A (re)spawn means this session is alive again — clear any stale exited
      // flag so the terminal embed stops showing "Session exited". On resume the
      // server pre-sets ovrToPty, so the marker-link path is skipped and
      // terminal:linked (which also clears this) never fires — without clearing
      // here the worker reads as working while its Terminal PTY shows ended.
      setExitedSessions((prev) => {
        if (!prev.has(msg.sessionId)) return prev;
        const next = new Set(prev);
        next.delete(msg.sessionId);
        return next;
      });
      setSessionErrors((prev) => {
        if (!prev.has(msg.sessionId)) return prev;
        const next = new Map(prev);
        next.delete(msg.sessionId);
        return next;
      });
      // If this client originated a spawn, fire onSpawned now so the UI can
      // redirect to the new ovrId immediately. terminal:linked still fires
      // later (idempotent re-select).
      if (pendingLocalSpawnsRef.current > 0) {
        pendingLocalSpawnsRef.current -= 1;
        if (onSpawnedRef.current) onSpawnedRef.current(msg.sessionId);
      }
    } else if (msg.type === 'terminal:exit') {
      // msg.sessionId is ovrId
      setPtySessionIds((prev) => {
        const next = new Set(prev);
        next.delete(msg.sessionId);
        return next;
      });
      setExitedSessions((prev) => {
        const next = new Set(prev);
        next.add(msg.sessionId);
        return next;
      });
      outputBuffer.current.delete(msg.sessionId);
      const handler = exitHandlers.current.get(msg.sessionId);
      if (handler) handler();
    } else if (msg.type === 'terminal:error') {
      console.warn('[terminal:error]', msg.sessionId, msg.message);
      setSessionErrors((prev) => {
        const next = new Map(prev);
        next.set(msg.sessionId, msg.message);
        return next;
      });
    } else if (msg.type === 'terminal:clear') {
      const { sessionId } = msg as { type: string; sessionId: string };
      // Clear client-side buffered output so it doesn't replay after the nudge
      outputBuffer.current.delete(sessionId);
      const handler = outputHandlers.current.get(sessionId);
      if (handler) {
        handler(new TextEncoder().encode('\x1bc'));
      }
    } else if (msg.type === 'terminal:history-dump') {
      // Revived raw-shell history: clear the terminal and write the disk log.
      const handler = outputHandlers.current.get(msg.sessionId);
      const bytes = (() => { try { return decodeBase64(msg.data); } catch { return new TextEncoder().encode(msg.data); } })();
      if (handler) {
        handler(new TextEncoder().encode('\x1bc'));
        handler(bytes);
      } else {
        const buf = outputBuffer.current.get(msg.sessionId) ?? [];
        buf.push(new TextEncoder().encode('\x1bc'));
        buf.push(bytes);
        outputBuffer.current.set(msg.sessionId, buf);
      }
    } else if (msg.type === 'terminal:linked') {
      // ovrId is the stable overlord session ID. Server pre-mints it at PTY
      // spawn time, so terminal:spawned already added it to ptySessionIds and
      // App selection is already on ovrId. terminal:linked is informational —
      // it announces the claudeSessionId that this PTY is now bound to.
      const { ovrId, ptySessionId, claudeSessionId, replay } = msg;

      // Add claudeSessionId so isPtySession() lookups succeed before the snapshot
      // delivers overlordId. Idempotent if ovrId already present.
      setPtySessionIds(prev => {
        if (prev.has(ovrId) && prev.has(claudeSessionId)) return prev;
        const next = new Set(prev);
        next.add(ovrId);
        next.add(claudeSessionId);
        return next;
      });

      // Clear exited state — reconnection means session is alive
      setExitedSessions(prev => {
        if (!prev.has(ovrId)) return prev;
        const next = new Set(prev);
        next.delete(ovrId);
        return next;
      });

      // Track bridge sessions by ovrId
      if (ptySessionId.startsWith('bridge-')) {
        bridgeSessionIds.current.add(ovrId);
      }

      if (!replay) {
        // Targeted send to originator → fresh spawn for this client.
        // Fire onSpawned with the stable ovrId so App can select it.
        if (onSpawnedRef.current) onSpawnedRef.current(ovrId);
        // Reset xterm to discard startup noise from --resume.
        outputBuffer.current.delete(ovrId);
        const handler = outputHandlers.current.get(ovrId);
        if (handler) {
          handler(new TextEncoder().encode('\x1b[2J\x1b[H'));
        }
      }
    }
  }, []);

  const spawnSession = useCallback(
    (cwd: string, cols = 80, rows = 24, name?: string, provider: SessionProvider = 'claude') => {
      pendingLocalSpawnsRef.current += 1;
      sendMessage({ type: 'terminal:spawn', cwd, cols, rows, name, provider });
    },
    [sendMessage]
  );

  const spawnRawShell = useCallback(
    (cwd: string, cols = 80, rows = 24, name?: string) => {
      pendingLocalSpawnsRef.current += 1;
      sendMessage({ type: 'terminal:spawn-raw', cwd, cols, rows, name });
    },
    [sendMessage]
  );

  const restartShell = useCallback(
    (sessionId: string, cols = 80, rows = 24) => {
      setExitedSessions((prev) => {
        if (!prev.has(sessionId)) return prev;
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
      sendMessage({ type: 'terminal:restart-shell', sessionId, cols, rows });
    },
    [sendMessage]
  );

  const resumeSession = useCallback(
    (resumeSessionId: string, cwd: string, cols = 80, rows = 24) => {
      setSessionErrors((prev) => {
        if (!prev.has(resumeSessionId)) return prev;
        const next = new Map(prev);
        next.delete(resumeSessionId);
        return next;
      });
      pendingLocalSpawnsRef.current += 1;
      sendMessage({ type: 'terminal:resume', resumeSessionId, cwd, cols, rows });
    },
    [sendMessage]
  );

  const sendInput = useCallback(
    (ovrId: string, data: string) => {
      sendMessage({ type: 'terminal:input', sessionId: ovrId, data });
    },
    [sendMessage]
  );

  const injectText = useCallback(
    (ovrId: string, text: string, extraEnter = false): boolean => {
      setSessionErrors((prev) => {
        const next = new Map(prev);
        next.delete(ovrId);
        return next;
      });
      const sent = sendMessage({ type: 'terminal:inject', sessionId: ovrId, text, extraEnter });
      if (!sent) {
        setSessionErrors((prev) => {
          const next = new Map(prev);
          next.set(ovrId, 'Not connected – message not sent. Try again.');
          return next;
        });
      }
      return sent;
    },
    [sendMessage]
  );

  const resizePty = useCallback(
    (ovrId: string, cols: number, rows: number) => {
      sendMessage({ type: 'terminal:resize', sessionId: ovrId, cols, rows });
    },
    [sendMessage]
  );

  const registerOutputHandler = useCallback(
    (ovrId: string, handler: (data: Uint8Array) => void, cols?: number, rows?: number) => {
      outputHandlers.current.set(ovrId, handler);
      // Flush any client-side buffered output
      const buf = outputBuffer.current.get(ovrId);
      if (buf && buf.length > 0) {
        for (const chunk of buf) handler(chunk);
        outputBuffer.current.delete(ovrId);
      }
      // Request server-side buffer replay (also subscribes this WS client to
      // the session's terminal:output stream on the server)
      sendMessage({ type: 'terminal:replay', sessionId: ovrId, ...(cols && rows ? { cols, rows } : {}) });
      return () => {
        outputHandlers.current.delete(ovrId);
        // Stop the server streaming output for an unmounted terminal; the
        // next mount's terminal:replay re-subscribes and backfills.
        sendMessage({ type: 'terminal:unsubscribe', sessionId: ovrId });
      };
    },
    [sendMessage]
  );

  const isPtySession = useCallback(
    (ovrId: string) => ptySessionIds.has(ovrId),
    [ptySessionIds]
  );

  const isBridgeSession = useCallback(
    (ovrId: string) => bridgeSessionIds.current.has(ovrId),
    []
  );

  const getError = useCallback(
    (ovrId: string) => sessionErrors.get(ovrId),
    [sessionErrors]
  );

  const killSession = useCallback(
    (ovrId: string) => {
      sendMessage({ type: 'terminal:kill', sessionId: ovrId });
      setPtySessionIds((prev) => {
        const next = new Set(prev);
        next.delete(ovrId);
        return next;
      });
    },
    [sendMessage]
  );

  const openInTerminal = useCallback(
    (sessionId: string, cwd: string) => {
      console.log('[openInTerminal] sending', sessionId, cwd);
      sendMessage({ type: 'terminal:open-external', sessionId, cwd });
    },
    [sendMessage]
  );

  const openBridgedTerminal = useCallback(
    (sessionId: string, cwd: string) => {
      console.log('[openBridgedTerminal] sending', sessionId, cwd);
      sendMessage({ type: 'terminal:open-bridged', sessionId, cwd });
    },
    [sendMessage]
  );

  const openNewTerminal = useCallback(
    (cwd: string, name?: string, mode: TerminalSpawnMode = 'bridge', provider: SessionProvider = 'claude') => {
      sendMessage({ type: 'terminal:open-new', cwd, name, mode, provider });
    },
    [sendMessage]
  );

  return {
    handleTerminalMessage,
    spawnSession,
    spawnRawShell,
    restartShell,
    resumeSession,
    sendInput,
    injectText,
    resizePty,
    registerOutputHandler,
    isPtySession,
    getError,
    killSession,
    openInTerminal,
    openBridgedTerminal,
    openNewTerminal,
    ptySessionIds,
    exitedSessions,
    isBridgeSession,
  };
}
