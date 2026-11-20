import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * Relays the native macOS speech helper (`packages/speech-mac/overlord-speech`)
 * to WebSocket clients. One helper process is shared; it starts on the first
 * subscriber and is killed when the last one leaves, so the microphone is only
 * held while some client is actually listening.
 *
 * Helper protocol (JSON lines): see packages/speech-mac/main.swift.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function getSpeechHelperPath(): string {
  // __dirname = packages/server/src/speech → ../../../speech-mac
  return path.join(__dirname, '..', '..', '..', 'speech-mac', 'overlord-speech');
}

export interface MacSpeechAvailability {
  available: boolean;
  reason?: string;
}

export function macSpeechAvailability(binary = getSpeechHelperPath()): MacSpeechAvailability {
  if (process.platform !== 'darwin') return { available: false, reason: 'macOS only' };
  if (!fs.existsSync(binary)) {
    return { available: false, reason: 'Helper not built. Run packages/speech-mac/build.sh' };
  }
  return { available: true };
}

/** Messages the relay pushes to a subscriber. */
export type SpeechOut =
  | { type: 'speech:result'; transcript: string; isFinal: boolean }
  | { type: 'speech:error'; message: string };

export type SpeechSink = (msg: SpeechOut) => void;

export interface MacSpeechRelayOptions {
  binary?: string;
  /** Extra argv before the binary's own args — lets tests run a node script. */
  command?: { cmd: string; args: string[] };
}

export class MacSpeechRelay {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private readonly subs = new Map<unknown, SpeechSink>();
  private buf = '';

  constructor(private readonly opts: MacSpeechRelayOptions = {}) {}

  /** Subscribes `key` and starts (or re-targets) recognition in `lang`. */
  start(key: unknown, sink: SpeechSink, lang: string): void {
    this.subs.set(key, sink);
    if (!this.ensureProc()) return;
    this.write({ cmd: 'start', lang });
  }

  stop(key: unknown): void {
    if (!this.subs.delete(key)) return;
    if (this.subs.size === 0) this.kill();
  }

  reset(key: unknown): void {
    if (!this.subs.has(key)) return;
    this.write({ cmd: 'reset' });
  }

  subscriberCount(): number { return this.subs.size; }
  isRunning(): boolean { return this.proc !== null; }

  dispose(): void {
    this.subs.clear();
    this.kill();
  }

  private ensureProc(): boolean {
    if (this.proc) return true;
    let cmd: string;
    let args: string[];
    if (this.opts.command) {
      ({ cmd, args } = this.opts.command);
    } else {
      const binary = this.opts.binary ?? getSpeechHelperPath();
      const avail = macSpeechAvailability(binary);
      if (!avail.available) {
        this.broadcast({ type: 'speech:error', message: avail.reason ?? 'macOS speech unavailable' });
        return false;
      }
      cmd = binary;
      args = [];
    }

    const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    this.buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => this.onData(chunk));
    // The helper's stderr is Apple framework noise ("No Assistant asset…").
    proc.stderr.resume();
    proc.on('error', (err) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.broadcast({ type: 'speech:error', message: `Speech helper failed: ${err.message}` });
    });
    proc.on('exit', (code, signal) => {
      if (this.proc !== proc) return; // killed on purpose
      this.proc = null;
      if (this.subs.size > 0) {
        this.broadcast({ type: 'speech:error', message: `Speech helper exited (${signal ?? code})` });
      }
    });
    return true;
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.type === 'result' && typeof msg.transcript === 'string') {
      this.broadcast({ type: 'speech:result', transcript: msg.transcript, isFinal: msg.isFinal === true });
    } else if (msg.type === 'error' && typeof msg.message === 'string') {
      this.broadcast({ type: 'speech:error', message: msg.message });
    }
  }

  private broadcast(msg: SpeechOut): void {
    for (const sink of this.subs.values()) {
      try { sink(msg); } catch { /* a dead socket must not stop the others */ }
    }
  }

  private write(obj: object): void {
    if (!this.proc || !this.proc.stdin.writable) return;
    this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  private kill(): void {
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    // Closing stdin lets the helper stop the audio engine cleanly; SIGTERM backs it up.
    try { proc.stdin.end(); } catch { /* already closed */ }
    const t = setTimeout(() => { try { proc.kill('SIGTERM'); } catch { /* gone */ } }, 500);
    t.unref();
    proc.once('exit', () => clearTimeout(t));
  }
}

export const macSpeechRelay = new MacSpeechRelay();
