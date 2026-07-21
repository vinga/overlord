import type { WebSocket } from 'ws';

// Per-WS-client state shared between index.ts (broadcast paths) and
// wsHandler.ts (message handlers). All three structures are cleaned up in the
// ws 'close' handler in wsHandler.ts.

/** Tab visibility per client. Default true on connect; clients send
 *  {type:'visibility', visible:false} when document.visibilityState goes
 *  hidden. Snapshot broadcasts skip hidden clients — a full snapshot is
 *  300–600 KB and re-sent up to 5Hz, which ratchets renderer RSS in
 *  backgrounded tabs. A fresh snapshot is pushed on the hidden→visible flip. */
export const wsVisible = new Map<WebSocket, boolean>();

/** ovrIds whose terminal output this client is subscribed to. Populated by
 *  terminal:replay (sent whenever an xterm mounts) and terminal:input/resize;
 *  cleared by terminal:unsubscribe (xterm unmount). terminal:output is only
 *  sent to subscribed clients — unwatched output is served later by the
 *  server-side ptyOutputBuffer replay. */
export const wsTermSubs = new Map<WebSocket, Set<string>>();

/** Clients that never want snapshots (e.g. the LogsPage socket, which only
 *  consumes log:history/log:entry). Opt in via {type:'snapshot:optout'}. */
export const wsSnapshotOptOut = new Set<WebSocket>();

export function subscribeTerminal(ws: WebSocket, ovrId: string): void {
  if (!ovrId) return;
  let subs = wsTermSubs.get(ws);
  if (!subs) {
    subs = new Set();
    wsTermSubs.set(ws, subs);
  }
  subs.add(ovrId);
}

export function clearClientState(ws: WebSocket): void {
  wsVisible.delete(ws);
  wsTermSubs.delete(ws);
  wsSnapshotOptOut.delete(ws);
}
