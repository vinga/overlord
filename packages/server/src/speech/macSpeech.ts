import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * Relays the native macOS speech helper (`packages/speech-mac/overlord-speech`)
 * to WebSocket clients. Each subscribed socket gets its OWN helper process:
 * the helper holds one utterance, and a reset from one browser tab must not
 * wipe what another tab is capturing. A helper starts on the socket's first
 * `speech:start` and is killed on its `speech:stop` or disconnect, so the
 * microphone is only held while some client is actually listening.
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

interface HelperSession {
  proc: ChildProcessWithoutNullStreams;
  sink: SpeechSink;
  buf: string;
}

export class MacSpeechRelay {
  private readonly sessions = new Map<unknown, HelperSession>();

  constructor(private readonly opts: MacSpeechRelayOptions = {}) {}

  /** Starts (or re-targets) recognition in `lang` for `key`'s own helper. */
  start(key: unknown, sink: SpeechSink, lang: string): void {
    let sess = this.sessions.get(key);
    if (sess) {
      sess.sink = sink;
    } else {
      sess = this.spawnFor(key, sink) ?? undefined;
      if (!sess) return;
    }
    this.write(sess, { cmd: 'start', lang });
  }

  stop(key: unknown): void {
    const sess = this.sessions.get(key);
    if (!sess) return;
    this.sessions.delete(key);
    kill(sess.proc);
  }

  reset(key: unknown): void {
    const sess = this.sessions.get(key);
    if (sess) this.write(sess, { cmd: 'reset' });
  }

  subscriberCount(): number { return this.sessions.size; }
  isRunning(key?: unknown): boolean {
    return key === undefined ? this.sessions.size > 0 : this.sessions.has(key);
  }

  dispose(): void {
    for (const sess of this.sessions.values()) kill(sess.proc);
    this.sessions.clear();
  }

  private spawnFor(key: unknown, sink: SpeechSink): HelperSession | null {
    let cmd: string;
    let args: string[];
    if (this.opts.command) {
      ({ cmd, args } = this.opts.command);
    } else {
      const binary = this.opts.binary ?? getSpeechHelperPath();
      const avail = macSpeechAvailability(binary);
      if (!avail.available) {
        safeSend(sink, { type: 'speech:error', message: avail.reason ?? 'macOS speech unavailable' });
        return null;
      }
      cmd = binary;
      args = [];
    }

    const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const sess: HelperSession = { proc, sink, buf: '' };
    this.sessions.set(key, sess);
    const current = () => this.sessions.get(key) === sess;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => { if (current()) this.onData(sess, chunk); });
    // The helper's stderr is Apple framework noise ("No Assistant asset…").
    proc.stderr.resume();
    proc.on('error', (err) => {
      if (!current()) return;
      this.sessions.delete(key);
      safeSend(sess.sink, { type: 'speech:error', message: `Speech helper failed: ${err.message}` });
    });
    proc.on('exit', (code, signal) => {
      if (!current()) return; // killed on purpose
      this.sessions.delete(key);
      safeSend(sess.sink, { type: 'speech:error', message: `Speech helper exited (${signal ?? code})` });
    });
    return sess;
  }

  private onData(sess: HelperSession, chunk: string): void {
    sess.buf += chunk;
    let nl: number;
    while ((nl = sess.buf.indexOf('\n')) >= 0) {
      const line = sess.buf.slice(0, nl).trim();
      sess.buf = sess.buf.slice(nl + 1);
      if (line) this.onLine(sess, line);
    }
  }

  private onLine(sess: HelperSession, line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.type === 'result' && typeof msg.transcript === 'string') {
      safeSend(sess.sink, { type: 'speech:result', transcript: msg.transcript, isFinal: msg.isFinal === true });
    } else if (msg.type === 'error' && typeof msg.message === 'string') {
      safeSend(sess.sink, { type: 'speech:error', message: msg.message });
    }
  }

  private write(sess: HelperSession, obj: object): void {
    if (!sess.proc.stdin.writable) return;
    sess.proc.stdin.write(`${JSON.stringify(obj)}\n`);
  }
}

function safeSend(sink: SpeechSink, msg: SpeechOut): void {
  try { sink(msg); } catch { /* a dead socket must not throw into the relay */ }
}

function kill(proc: ChildProcessWithoutNullStreams): void {
  // Closing stdin lets the helper stop the audio engine cleanly; SIGTERM backs it up.
  try { proc.stdin.end(); } catch { /* already closed */ }
  const t = setTimeout(() => { try { proc.kill('SIGTERM'); } catch { /* gone */ } }, 500);
  t.unref();
  proc.once('exit', () => clearTimeout(t));
}

export const macSpeechRelay = new MacSpeechRelay();
