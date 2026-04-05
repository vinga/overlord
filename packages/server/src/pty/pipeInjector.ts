import net from 'net';
import path from 'path';
import os from 'os';

// ── Pipe path helpers ────────────────────────────────────────────────────────

function pipePath(sessionId: string): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\overlord-${sessionId}`;
  }
  return path.join(os.tmpdir(), `overlord-${sessionId}.sock`);
}

// ── Bridge binary path ──────────────────────────────────────────────────────

import { fileURLToPath } from 'url';
import { dirname } from 'path';

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

// ── Connection cache ────────────────────────────────────────────────────────

const connectionCache = new Map<string, { socket: net.Socket; lastUsed: number }>();
const CACHE_TTL = 30_000; // 30s idle → close

// Cleanup idle connections every 15s
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of connectionCache) {
    if (now - entry.lastUsed > CACHE_TTL) {
      entry.socket.destroy();
      connectionCache.delete(id);
    }
  }
}, 15_000).unref();

function getCachedConnection(sessionId: string): Promise<net.Socket> {
  const cached = connectionCache.get(sessionId);
  if (cached && !cached.socket.destroyed) {
    cached.lastUsed = Date.now();
    return Promise.resolve(cached.socket);
  }

  // Remove stale entry
  if (cached) connectionCache.delete(sessionId);

  return new Promise<net.Socket>((resolve, reject) => {
    const pp = pipePath(sessionId);
    const socket = net.connect(pp, () => {
      connectionCache.set(sessionId, { socket, lastUsed: Date.now() });
      resolve(socket);
    });
    socket.on('error', (err) => {
      connectionCache.delete(sessionId);
      reject(err);
    });
    socket.on('close', () => {
      connectionCache.delete(sessionId);
    });
    // Timeout after 3s
    socket.setTimeout(3000, () => {
      socket.destroy();
      reject(new Error('Pipe connection timed out'));
    });
  });
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Inject text into a session via the bridge's named pipe.
 * Returns true if successful, false if the pipe doesn't exist (caller should fallback).
 */
export async function injectViaPipe(sessionId: string, text: string): Promise<boolean> {
  try {
    const socket = await getCachedConnection(sessionId);
    return new Promise<boolean>((resolve) => {
      socket.write(text, (err) => {
        if (err) {
          connectionCache.delete(sessionId);
          socket.destroy();
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
  } catch {
    // Pipe doesn't exist or connection failed — caller should use fallback
    return false;
  }
}

/**
 * Check if a bridge pipe exists for this session (non-blocking).
 */
export function hasPipe(sessionId: string): boolean {
  return connectionCache.has(sessionId) && !connectionCache.get(sessionId)!.socket.destroyed;
}

/**
 * Close cached connection for a session (e.g., when session ends).
 */
export function closePipe(sessionId: string): void {
  const cached = connectionCache.get(sessionId);
  if (cached) {
    cached.socket.destroy();
    connectionCache.delete(sessionId);
  }
}
