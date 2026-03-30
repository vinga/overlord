import { useRef, useCallback, useState } from 'react';
import type { TerminalMessage } from '../types';

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

  const handleTerminalMessage = useCallback((msg: TerminalMessage) => {
    if (msg.type === 'terminal:output') {
      const handler = outputHandlers.current.get(msg.sessionId);
      if (handler) {
        try {
          const binary = atob(msg.data);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          handler(bytes);
        } catch {
          // fallback: encode raw string as UTF-8 bytes
          handler(new TextEncoder().encode(msg.data));
        }
      } else {
        // Buffer output until a handler registers (e.g. during panel transition)
        try {
          const binary = atob(msg.data);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
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
    } else if (msg.type === 'terminal:linked') {
      const { ptySessionId, claudeSessionId } = msg as { type: string; ptySessionId: string; claudeSessionId: string };
      // Move buffered output from pty-xxx to claudeSessionId
      const ptyBuf = outputBuffer.current.get(ptySessionId);
      if (ptyBuf && ptyBuf.length > 0) {
        outputBuffer.current.delete(ptySessionId);
        const existing = outputBuffer.current.get(claudeSessionId) ?? [];
        outputBuffer.current.set(claudeSessionId, [...ptyBuf, ...existing]);
      }
      setPtySessionIds((prev) => {
        const next = new Set(prev);
        next.delete(ptySessionId);   // remove the temp pty-xxx ID
        next.add(claudeSessionId);   // add the real Claude session ID
        return next;
      });
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
    ptySessionIds,
    exitedSessions,
  };
}
