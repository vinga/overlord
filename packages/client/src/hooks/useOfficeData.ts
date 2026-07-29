import { useState, useEffect, useRef, useCallback } from 'react';
import type { OfficeSnapshot, TerminalMessage } from '../types';

interface UseOfficeDataOptions {
  onTerminalMessage?: (msg: TerminalMessage) => void;
  onSessionReplaced?: (oldId: string, newId: string) => void;
  /** ovrId of the session shown in the detail panel. The server sends
   *  activityFeed/sessionHistory only for this one — 75% of the payload — so it
   *  is declared on every change AND re-declared on reconnect. */
  focusOvrId?: string | null;
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
  // Read inside ws.onopen, so the reconnect path always declares the CURRENT
  // focus rather than whatever it was when the effect first ran.
  const focusRef = useRef(options?.focusOvrId ?? null);
  focusRef.current = options?.focusOvrId ?? null;

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
          // Send current visibility so the server can gate background polling
          // (PR cache, etc.) when the tab is hidden at connect time.
          try {
            ws.send(JSON.stringify({ type: 'visibility', visible: document.visibilityState !== 'hidden' }));
            // Re-declare focus BEFORE the first snapshot arrives. Without this a
            // reconnect leaves the server with no focus for this client and the
            // detail panel comes back permanently empty.
            ws.send(JSON.stringify({ type: 'snapshot:focus', ovrId: focusRef.current ?? '' }));
          } catch { /* ignore */ }
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
          } else if (data.type === 'archive:added') {
            const detail = (data as unknown as { entry?: { roomId?: string } }).entry;
            window.dispatchEvent(new CustomEvent('archive:changed', { detail: { roomId: detail?.roomId } }));
          } else if (data.type === 'archive:removed') {
            const detail = data as unknown as { roomId?: string };
            window.dispatchEvent(new CustomEvent('archive:changed', { detail: { roomId: detail.roomId } }));
          } else if (data.type === 'artifact:changed') {
            const detail = data as unknown as {
              artifactId: string;
              kind: 'plan' | 'summary' | 'compact';
              overlordId: string;
              cwd: string;
              op: 'create' | 'update' | 'delete';
            };
            window.dispatchEvent(new CustomEvent('artifact:changed', { detail }));
          } else if (data.type === 'session:replaced') {
            // Session replacement (e.g. Claude Code's /clear command)
            const msg = data as unknown as { type: string; oldSessionId: string; newSessionId: string };
            if (onSessionReplacedRef.current) {
              onSessionReplacedRef.current(msg.oldSessionId, msg.newSessionId);
            }
            // No terminal PTY migration needed — PTY is keyed by stable ovrId which
            // persists across session replacements; ovrId propagated via session snapshot.
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

    const onVisibilityChange = (): void => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ type: 'visibility', visible: document.visibilityState !== 'hidden' }));
      } catch { /* ignore */ }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      mountedRef.current = false;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (reconnectTimer.current !== null) {
        clearTimeout(reconnectTimer.current);
      }
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
  }, []);

  // Declare focus whenever the selection changes. The server replies with a
  // snapshot immediately, so the panel fills on this tick.
  const focus = options?.focusOvrId ?? null;
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: 'snapshot:focus', ovrId: focus ?? '' }));
    } catch { /* ignore */ }
  }, [focus, connected]);

  return { snapshot, connected, connecting, sendMessage };
}
