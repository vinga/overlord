import net from 'net';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// ── Pipe path helpers ────────────────────────────────────────────────────────

function pipePath(sessionId: string): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\overlord-${sessionId}`;
  }
  return path.join(os.tmpdir(), `overlord-${sessionId}.sock`);
}

// ── Bridge binary path ──────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function getBridgePath(): string {
  const ext = process.platform === 'win32' ? '.exe' : '';
  return path.join(__dirname, '..', '..', '..', 'bridge', `overlord-bridge${ext}`);
}

export function getPipeName(sessionId: string): string {
  return `overlord-${sessionId}`;
}

export function getPipeFullPath(sessionId: string): string {
  return pipePath(sessionId);
}

// ── Bridge connection manager ───────────────────────────────────────────────

export interface BridgeEvents {
  output: (sessionId: string, data: Buffer) => void;
  connected: (sessionId: string) => void;
  disconnected: (sessionId: string) => void;
}

class BridgeConnectionManager extends EventEmitter {
  private connections = new Map<string, net.Socket>();
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Connect to a bridge pipe and start reading output */
  connect(sessionId: string): void {
    if (this.connections.has(sessionId)) return;

    const pp = pipePath(sessionId);
    console.log(`[bridge-pipe] connecting to ${pp}`);

    const socket = net.connect(pp, () => {
      console.log(`[bridge-pipe] connected to ${sessionId.slice(0, 8)}`);
      this.connections.set(sessionId, socket);
      this.emit('connected', sessionId);
    });

    socket.on('data', (data: Buffer) => {
      this.emit('output', sessionId, data);
    });

    socket.on('error', (err) => {
      console.log(`[bridge-pipe] error for ${sessionId.slice(0, 8)}: ${err.message}`);
      this.connections.delete(sessionId);
      this.scheduleReconnect(sessionId);
    });

    socket.on('close', () => {
      console.log(`[bridge-pipe] disconnected from ${sessionId.slice(0, 8)}`);
      this.connections.delete(sessionId);
      this.emit('disconnected', sessionId);
      this.scheduleReconnect(sessionId);
    });

    // Mark as connecting (will be replaced when 'connect' fires)
    this.connections.set(sessionId, socket);
  }

  /** Stop tracking a session (no more reconnects) */
  disconnect(sessionId: string): void {
    this.autoReconnect.delete(sessionId);
    const timer = this.reconnectTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(sessionId);
    }
    const socket = this.connections.get(sessionId);
    if (socket) {
      socket.destroy();
      this.connections.delete(sessionId);
    }
  }

  /** Write input to the bridge pipe */
  write(sessionId: string, data: string): boolean {
    const socket = this.connections.get(sessionId);
    if (!socket || socket.destroyed || !socket.writable) return false;
    socket.write(data);
    return true;
  }

  /** Register an externally-created socket (e.g. from linkPendingBridge) */
  registerSocket(sessionId: string, socket: net.Socket): void {
    this.connections.set(sessionId, socket);
  }

  /** Check if connected to a bridge */
  isConnected(sessionId: string): boolean {
    const socket = this.connections.get(sessionId);
    return !!socket && !socket.destroyed && socket.writable;
  }

  // Track which sessions we should auto-reconnect
  private autoReconnect = new Set<string>();

  /** Mark a session for auto-reconnect on disconnect */
  enableReconnect(sessionId: string): void {
    this.autoReconnect.add(sessionId);
  }

  private scheduleReconnect(sessionId: string): void {
    if (!this.autoReconnect.has(sessionId)) return;
    if (this.reconnectTimers.has(sessionId)) return;

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(sessionId);
      if (!this.connections.has(sessionId)) {
        this.connect(sessionId);
      }
    }, 3000);
    timer.unref();
    this.reconnectTimers.set(sessionId, timer);
  }

  /** Clean up everything */
  destroy(): void {
    for (const [id] of this.connections) {
      this.disconnect(id);
    }
  }
}

// Singleton
export const bridgeManager = new BridgeConnectionManager();

// ── Legacy API (kept for simple injection-only callers) ─────────────────────

/**
 * Inject text into a session via the bridge's named pipe.
 * Returns true if successful, false if the pipe doesn't exist (caller should fallback).
 */
export async function injectViaPipe(sessionId: string, text: string): Promise<boolean> {
  // Try the persistent connection first
  if (bridgeManager.write(sessionId, text)) return true;

  // Fallback: try a one-shot connection (bridge exists but we haven't connected yet)
  try {
    return await new Promise<boolean>((resolve) => {
      const pp = pipePath(sessionId);
      const socket = net.connect(pp, () => {
        socket.write(text, (err) => {
          socket.destroy();
          resolve(!err);
        });
      });
      socket.on('error', () => resolve(false));
      socket.setTimeout(3000, () => { socket.destroy(); resolve(false); });
    });
  } catch {
    return false;
  }
}

export function hasPipe(sessionId: string): boolean {
  return bridgeManager.isConnected(sessionId);
}

export function closePipe(sessionId: string): void {
  bridgeManager.disconnect(sessionId);
}
