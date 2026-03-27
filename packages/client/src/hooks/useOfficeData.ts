import { useState, useEffect, useRef, useCallback } from 'react';
import type { OfficeSnapshot, TerminalMessage } from '../types';

interface UseOfficeDataResult {
  snapshot: OfficeSnapshot | null;
  connected: boolean;
  sendMessage: (msg: object) => void;
}

export function useOfficeData(onTerminalMessage?: (msg: TerminalMessage) => void): UseOfficeDataResult {
  const [snapshot, setSnapshot] = useState<OfficeSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const mountedRef = useRef(true);
  const onTerminalMessageRef = useRef(onTerminalMessage);
  onTerminalMessageRef.current = onTerminalMessage;

  const sendMessage = useCallback((msg: object) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
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
          } else if (!data.type) {
            // Legacy format: bare OfficeSnapshot without type wrapper
            setSnapshot(data as unknown as OfficeSnapshot);
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
        }, 2000);
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

  return { snapshot, connected, sendMessage };
}
