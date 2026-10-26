/**
 * Main-thread side of the Kokoro voice: owns the worker, plays its audio
 * gaplessly through Web Audio, and reports load status to whoever listens
 * (the settings page). One instance per page — the model is ~90 MB.
 */

export type KokoroStatus = 'idle' | 'loading' | 'ready' | 'error';

export type KokoroIn =
  | { type: 'load' }
  | { type: 'speak'; id: number; text: string; voice: string }
  | { type: 'cancel'; id: number };

export type KokoroOut =
  | { type: 'status'; status: KokoroStatus; device?: 'webgpu' | 'wasm'; progress?: number; error?: string }
  | { type: 'chunk'; id: number; audio: Float32Array; sampleRate: number }
  | { type: 'done'; id: number; error?: string };

export interface KokoroState {
  status: KokoroStatus;
  device?: 'webgpu' | 'wasm';
  /** Model download progress, 0–100, while loading. */
  progress?: number;
  error?: string;
}

/** English voices worth offering (Kokoro's own grade C or better). */
export const KOKORO_VOICES: readonly { id: string; label: string }[] = [
  { id: 'af_heart', label: 'Heart — US, female' },
  { id: 'af_bella', label: 'Bella — US, female' },
  { id: 'af_nicole', label: 'Nicole — US, female, soft' },
  { id: 'af_aoede', label: 'Aoede — US, female' },
  { id: 'af_kore', label: 'Kore — US, female' },
  { id: 'af_sarah', label: 'Sarah — US, female' },
  { id: 'am_michael', label: 'Michael — US, male' },
  { id: 'am_fenrir', label: 'Fenrir — US, male' },
  { id: 'am_puck', label: 'Puck — US, male' },
  { id: 'bf_emma', label: 'Emma — UK, female' },
  { id: 'bf_isabella', label: 'Isabella — UK, female' },
  { id: 'bm_george', label: 'George — UK, male' },
  { id: 'bm_fable', label: 'Fable — UK, male' },
];

/** Handle to one reading. `stop()` cuts generation and playback. */
export interface KokoroReading { stop(): void }

/**
 * `onEnd(completed, failed)`: `completed` when everything was played;
 * `failed` when generation broke before any audio played, so the caller can
 * fall back to another voice.
 */
export type KokoroEnd = (completed: boolean, failed: boolean) => void;

export class KokoroClient {
  private worker: Worker | null = null;
  private state: KokoroState = { status: 'idle' };
  private listeners = new Set<(s: KokoroState) => void>();
  private nextId = 1;
  private readings = new Map<number, { chunk(a: Float32Array, rate: number): void; done(error?: string): void }>();
  private audio: AudioContext | null = null;

  getState(): KokoroState { return this.state; }

  subscribe(fn: (s: KokoroState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Starts loading the model (no-op once loading or ready). */
  load(): void {
    if (this.state.status === 'loading' || this.state.status === 'ready') return;
    this.ensureWorker().postMessage({ type: 'load' } satisfies KokoroIn);
  }

  /** Resolves true once the model is ready, false on error or after `timeoutMs`. */
  whenReady(timeoutMs: number): Promise<boolean> {
    if (this.state.status === 'ready') return Promise.resolve(true);
    this.load();
    return new Promise(resolve => {
      const timer = setTimeout(() => { off(); resolve(false); }, timeoutMs);
      const off = this.subscribe(s => {
        if (s.status === 'ready' || s.status === 'error') {
          clearTimeout(timer);
          off();
          resolve(s.status === 'ready');
        }
      });
    });
  }

  speak(text: string, voice: string, onEnd: KokoroEnd): KokoroReading {
    const id = this.nextId++;
    const ac = this.audioContext();
    const sources: AudioBufferSourceNode[] = [];
    let nextAt = 0;
    let played = false;
    let generationDone = false;
    let pending = 0;
    let finished = false;

    const finish = (completed: boolean, failed: boolean) => {
      if (finished) return;
      finished = true;
      this.readings.delete(id);
      onEnd(completed, failed);
    };

    this.readings.set(id, {
      chunk: (samples, rate) => {
        if (finished || !ac) return;
        const buf = ac.createBuffer(1, samples.length, rate);
        buf.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
        const src = ac.createBufferSource();
        src.buffer = buf;
        src.connect(ac.destination);
        // Back to back: each sentence starts where the previous one ends.
        nextAt = Math.max(nextAt, ac.currentTime + 0.05);
        src.start(nextAt);
        nextAt += buf.duration;
        played = true;
        pending++;
        src.onended = () => {
          pending--;
          if (generationDone && pending === 0) finish(true, false);
        };
        sources.push(src);
      },
      done: (error) => {
        generationDone = true;
        if (error && !played) { finish(false, true); return; }
        if (pending === 0) finish(played, false);
      },
    });
    this.ensureWorker().postMessage({ type: 'speak', id, text, voice } satisfies KokoroIn);

    return {
      stop: () => {
        if (finished) return;
        this.worker?.postMessage({ type: 'cancel', id } satisfies KokoroIn);
        for (const s of sources) { s.onended = null; try { s.stop(); } catch { /* not started */ } }
        finish(false, false);
      },
    };
  }

  private audioContext(): AudioContext | null {
    if (typeof window === 'undefined' || !window.AudioContext) return null;
    this.audio ??= new AudioContext();
    if (this.audio.state === 'suspended') void this.audio.resume();
    return this.audio;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('./kokoroWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<KokoroOut>) => {
      const m = e.data;
      if (m.type === 'status') this.setState({ status: m.status, device: m.device, progress: m.progress, error: m.error });
      else if (m.type === 'chunk') this.readings.get(m.id)?.chunk(m.audio, m.sampleRate);
      else if (m.type === 'done') this.readings.get(m.id)?.done(m.error);
    };
    w.onerror = (e) => {
      this.setState({ status: 'error', error: e.message || 'Kokoro worker failed' });
      for (const r of [...this.readings.values()]) r.done('worker failed');
    };
    this.worker = w;
    return w;
  }

  private setState(s: KokoroState): void {
    this.state = s;
    for (const l of this.listeners) l(s);
  }
}

let shared: KokoroClient | null = null;

/** The page-wide Kokoro client, created on first use. */
export function kokoro(): KokoroClient {
  shared ??= new KokoroClient();
  return shared;
}
