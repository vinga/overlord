import { useRef, useCallback, useState } from 'react';
import type { TerminalMessage, TerminalSpawnMode } from '../types';

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

export interface UseTerminalResult {
  handleTerminalMessage: (msg: TerminalMessage) => void;
  spawnSession: (cwd: string, cols?: number, rows?: number, name?: string) => void;
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
  openNewTerminal: (cwd: string, name?: string, mode?: TerminalSpawnMode) => void;
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
        // Buffer until handler registers (e.g. during panel transition)
        try {
          const bytes = decodeBase64(msg.data);
          const buf = outputBuffer.current.get(msg.sessionId) ?? [];
          buf.push(bytes);
          if (buf.length > 2000) buf.splice(0, buf.length - 2000);
          outputBuffer.current.set(msg.sessionId, buf);
        } catch { /* ignore */ }
      }
    } else if (msg.type === 'terminal:spawned') {
      // msg.sessionId is the ptySessionId (before linking).
      // Add temporarily; terminal:linked replaces it with ovrId.
      setPtySessionIds((prev) => {
        const next = new Set(prev);
        next.add(msg.sessionId);
        return next;
      });
      if (onSpawnedRef.current) onSpawnedRef.current(msg.sessionId);
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
    } else if (msg.type === 'terminal:linked') {
      // ovrId is the stable overlord session ID; all state should be keyed by it.
      // ptySessionId was a temporary ID used before linking (added by terminal:spawned).
      const { ovrId, ptySessionId, claudeSessionId, replay } = msg;

      // Transition: remove temporary ptySessionId, add stable ovrId.
      // Also add claudeSessionId so isPtySession() returns true even if the
      // snapshot hasn't arrived yet with overlordId (snapshot race fix).
      setPtySessionIds(prev => {
        if (prev.has(ovrId)) return prev; // already known
        const next = new Set(prev);
        next.delete(ptySessionId); // remove pre-link entry
        next.add(ovrId);
        next.add(claudeSessionId); // temporary until snapshot delivers overlordId
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
        // Clear buffered output and reset xterm to discard startup noise from --resume
        outputBuffer.current.delete(ovrId);
        const handler = outputHandlers.current.get(ovrId);
        if (handler) {
          handler(new TextEncoder().encode('\x1b[2J\x1b[H'));
        }
        // Notify App.tsx with claudeSessionId so it can select the session in the UI
        if (onSpawnedRef.current) onSpawnedRef.current(claudeSessionId);
      }
    }
  }, []);

  const spawnSession = useCallback(
    (cwd: string, cols = 80, rows = 24, name?: string) => {
      sendMessage({ type: 'terminal:spawn', cwd, cols, rows, name });
    },
    [sendMessage]
  );

  const resumeSession = useCallback(
    (resumeSessionId: string, cwd: string, cols = 80, rows = 24) => {
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
      // Request server-side buffer replay
      sendMessage({ type: 'terminal:replay', sessionId: ovrId, ...(cols && rows ? { cols, rows } : {}) });
      return () => {
        outputHandlers.current.delete(ovrId);
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
    (cwd: string, name?: string, mode: TerminalSpawnMode = 'bridge') => {
      sendMessage({ type: 'terminal:open-new', cwd, name, mode });
    },
    [sendMessage]
  );

  return {
    handleTerminalMessage,
    spawnSession,
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
