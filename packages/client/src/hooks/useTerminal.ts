import { useRef, useCallback, useState } from 'react';
import type { TerminalMessage } from '../types';

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

export interface UseTerminalResult {
  handleTerminalMessage: (msg: TerminalMessage) => void;
  spawnSession: (cwd: string, cols?: number, rows?: number) => void;
  resumeSession: (resumeSessionId: string, cwd: string, cols?: number, rows?: number) => void;
  sendInput: (sessionId: string, data: string) => void;
  injectText: (sessionId: string, text: string, extraEnter?: boolean) => void;
  resizePty: (sessionId: string, cols: number, rows: number) => void;
  registerOutputHandler: (sessionId: string, handler: (data: Uint8Array) => void) => () => void;
  isPtySession: (sessionId: string) => boolean;
  getError: (sessionId: string) => string | undefined;
  killSession: (sessionId: string) => void;
  openInTerminal: (sessionId: string, cwd: string) => void;
  openNewTerminal: (cwd: string, name?: string) => void;
  ptySessionIds: Set<string>;
  exitedSessions: Set<string>;
}

export function useTerminal(
  sendMessage: (msg: object) => void,
  onSpawned?: (sessionId: string) => void
): UseTerminalResult {
  const outputHandlers = useRef(new Map<string, (data: Uint8Array) => void>());
  const outputBuffer = useRef(new Map<string, Uint8Array[]>());
  const exitHandlers = useRef(new Map<string, () => void>());

  // Use state for ptySessionIds and exitedSessions so components re-render on change
  const [ptySessionIds, setPtySessionIds] = useState<Set<string>>(new Set());
  const [exitedSessions, setExitedSessions] = useState<Set<string>>(new Set());
  const [sessionErrors, setSessionErrors] = useState<Map<string, string>>(new Map());

  const onSpawnedRef = useRef(onSpawned);
  onSpawnedRef.current = onSpawned;

  function migrateId(oldId: string, newId: string) {
    // migrate outputBuffer
    const buf = outputBuffer.current.get(oldId);
    if (buf && buf.length > 0) {
      outputBuffer.current.delete(oldId);
      const existing = outputBuffer.current.get(newId) ?? [];
      outputBuffer.current.set(newId, [...buf, ...existing]);
    }
    // migrate outputHandlers
    const handler = outputHandlers.current.get(oldId);
    if (handler) {
      outputHandlers.current.delete(oldId);
      outputHandlers.current.set(newId, handler);
    }
    // migrate exitHandlers
    const exitHandler = exitHandlers.current.get(oldId);
    if (exitHandler) {
      exitHandlers.current.delete(oldId);
      exitHandlers.current.set(newId, exitHandler);
    }
    // migrate ptySessionIds set
    setPtySessionIds(prev => {
      const next = new Set(prev);
      next.delete(oldId);
      next.add(newId);
      return next;
    });
  }

  const handleTerminalMessage = useCallback((msg: TerminalMessage) => {
    if (msg.type === 'terminal:output') {
      const handler = outputHandlers.current.get(msg.sessionId);
      if (handler) {
        try {
          handler(decodeBase64(msg.data));
        } catch {
          // fallback: encode raw string as UTF-8 bytes
          handler(new TextEncoder().encode(msg.data));
        }
      } else {
        // Buffer output until a handler registers (e.g. during panel transition)
        try {
          const bytes = decodeBase64(msg.data);
          const buf = outputBuffer.current.get(msg.sessionId) ?? [];
          buf.push(bytes);
          if (buf.length > 2000) buf.splice(0, buf.length - 2000); // cap buffer size
          outputBuffer.current.set(msg.sessionId, buf);
        } catch { /* ignore */ }
      }
    } else if (msg.type === 'terminal:spawned') {
      setPtySessionIds((prev) => {
        const next = new Set(prev);
        next.add(msg.sessionId);
        return next;
      });
      if (onSpawnedRef.current) onSpawnedRef.current(msg.sessionId);
    } else if (msg.type === 'terminal:exit') {
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
    } else if (msg.type === 'terminal:session-replaced') {
      const { oldSessionId, newSessionId } = msg;
      migrateId(oldSessionId, newSessionId);
    } else if (msg.type === 'terminal:linked') {
      const { ptySessionId, claudeSessionId } = msg as { type: string; ptySessionId: string; claudeSessionId: string };
      migrateId(ptySessionId, claudeSessionId);
      if (onSpawnedRef.current) onSpawnedRef.current(claudeSessionId);  // update activePtySessionId in App.tsx
    }
  }, []);

  const spawnSession = useCallback(
    (cwd: string, cols = 80, rows = 24) => {
      sendMessage({ type: 'terminal:spawn', cwd, cols, rows });
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
    (sessionId: string, data: string) => {
      sendMessage({ type: 'terminal:input', sessionId, data });
    },
    [sendMessage]
  );

  const injectText = useCallback(
    (sessionId: string, text: string, extraEnter = false) => {
      // Clear previous error for this session when sending
      setSessionErrors((prev) => {
        const next = new Map(prev);
        next.delete(sessionId);
        return next;
      });
      sendMessage({ type: 'terminal:inject', sessionId, text, extraEnter });
    },
    [sendMessage]
  );

  const resizePty = useCallback(
    (sessionId: string, cols: number, rows: number) => {
      sendMessage({ type: 'terminal:resize', sessionId, cols, rows });
    },
    [sendMessage]
  );

  const registerOutputHandler = useCallback(
    (sessionId: string, handler: (data: Uint8Array) => void) => {
      outputHandlers.current.set(sessionId, handler);
      // Flush any buffered output
      const buf = outputBuffer.current.get(sessionId);
      if (buf && buf.length > 0) {
        for (const chunk of buf) handler(chunk);
        outputBuffer.current.delete(sessionId);
      }
      return () => {
        outputHandlers.current.delete(sessionId);
      };
    },
    []
  );

  const isPtySession = useCallback(
    (sessionId: string) => ptySessionIds.has(sessionId),
    [ptySessionIds]
  );

  const getError = useCallback(
    (sessionId: string) => sessionErrors.get(sessionId),
    [sessionErrors]
  );

  const killSession = useCallback(
    (sessionId: string) => {
      sendMessage({ type: 'terminal:kill', sessionId });
      setPtySessionIds((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
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

  const openNewTerminal = useCallback(
    (cwd: string, name?: string) => {
      sendMessage({ type: 'terminal:open-new', cwd, name });
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
    openNewTerminal,
    ptySessionIds,
    exitedSessions,
  };
}
