import { useState, useEffect, useRef, useCallback } from 'react';
import type { OfficeSnapshot, TerminalMessage } from '../types';

interface UseOfficeDataOptions {
  onTerminalMessage?: (msg: TerminalMessage) => void;
  onSessionReplaced?: (oldId: string, newId: string) => void;
}

interface UseOfficeDataResult {
  snapshot: OfficeSnapshot | null;
  connected: boolean;
  connecting: boolean;
  sendMessage: (msg: object) => boolean;
}

export function useOfficeData(onTerminalMessage?: (msg: TerminalMessage) => void, options?: UseOfficeDataOptions): UseOfficeDataResult {
  const [snapshot, setSnapshot] = useState<OfficeSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(true);
  const everConnectedRef = useRef(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const mountedRef = useRef(true);
  const onTerminalMessageRef = useRef(onTerminalMessage);
  onTerminalMessageRef.current = onTerminalMessage;
  const onSessionReplacedRef = useRef(options?.onSessionReplaced);
  onSessionReplacedRef.current = options?.onSessionReplaced;

  const sendMessage = useCallback((msg: object): boolean => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    function connect() {
      if (!mountedRef.current) return;

      const ws = new WebSocket('ws://localhost:3000');
      wsRef.current = ws;

      ws.onopen = () => {
        if (mountedRef.current) {
          setConnected(true);
          if (!everConnectedRef.current) {
            everConnectedRef.current = true;
            setConnecting(false);
          }
        }
      };

      ws.onmessage = (event: MessageEvent) => {
        if (!mountedRef.current) return;
        try {
          const data = JSON.parse(event.data as string) as { type?: string };

          if (data.type === 'snapshot') {
            // New typed message format
            setSnapshot(data as unknown as OfficeSnapshot);
          } else if (data.type && data.type.startsWith('terminal:')) {
            // Terminal message — dispatch to handler
            if (onTerminalMessageRef.current) {
              onTerminalMessageRef.current(data as unknown as TerminalMessage);
            }
          } else if (data.type === 'session:replaced') {
            // Session replacement (e.g. Claude Code's /clear command)
            const msg = data as unknown as { type: string; oldSessionId: string; newSessionId: string };
            if (onSessionReplacedRef.current) {
              onSessionReplacedRef.current(msg.oldSessionId, msg.newSessionId);
            }
            // Also notify terminal handler to migrate PTY state
            if (onTerminalMessageRef.current) {
              onTerminalMessageRef.current({ type: 'terminal:session-replaced', oldSessionId: msg.oldSessionId, newSessionId: msg.newSessionId });
            }
          }
        } catch {
          // ignore malformed messages
        }
      };

      ws.onclose = () => {
        if (!mountedRef.current) return;
        setConnected(false);
        reconnectTimer.current = setTimeout(() => {
          if (mountedRef.current) {
            connect();
          }
        }, 500);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimer.current !== null) {
        clearTimeout(reconnectTimer.current);
      }
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
  }, []);

  return { snapshot, connected, connecting, sendMessage };
}
