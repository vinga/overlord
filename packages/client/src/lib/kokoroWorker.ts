/// <reference lib="webworker" />
/**
 * Kokoro text-to-speech, off the main thread. `kokoro-js` (and the ONNX
 * runtime under it) is imported lazily, so nothing loads until the first
 * request. Audio goes back one sentence at a time, so playback can start
 * while the rest is still being generated.
 */
import type { KokoroTTS } from 'kokoro-js';
import type { KokoroIn, KokoroOut } from './kokoroVoice';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: KokoroOut, transfer: Transferable[] = []) => ctx.postMessage(m, transfer);

let model: Promise<KokoroTTS> | null = null;
const cancelled = new Set<number>();

function load(): Promise<KokoroTTS> {
  model ??= (async () => {
    post({ type: 'status', status: 'loading' });
    const { KokoroTTS } = await import('kokoro-js');
    const progress_callback = (p: { status: string; file?: string; progress?: number }) => {
      if (p.status === 'progress' && p.file?.endsWith('.onnx') && typeof p.progress === 'number') {
        post({ type: 'status', status: 'loading', progress: Math.round(p.progress) });
      }
    };
    // q8 on WASM: ~90 MB, small enough to finish downloading before a page
    // reload cuts it off (the cache only keeps complete files). WebGPU wants
    // fp32 (~330 MB, quantized weights garble on some GPUs) — not worth it
    // for 300-character replies.
    const tts = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: 'q8', device: 'wasm', progress_callback });
    post({ type: 'status', status: 'ready', device: 'wasm' });
    return tts;
  })().catch((e: unknown) => {
    model = null;   // a later request may retry, e.g. once back online
    post({ type: 'status', status: 'error', error: e instanceof Error ? e.message : String(e) });
    throw e;
  });
  return model;
}

async function speak(id: number, text: string, voice: string): Promise<void> {
  try {
    const tts = await load();
    const { TextSplitterStream } = await import('kokoro-js');
    // Given a plain string, stream() never closes its splitter, so the last
    // sentence is held back forever. Feed and close one ourselves.
    const splitter = new TextSplitterStream();
    splitter.push(text);
    splitter.close();
    for await (const { audio } of tts.stream(splitter, { voice: voice as never })) {
      if (cancelled.has(id)) break;
      const samples = audio.audio as Float32Array;
      post({ type: 'chunk', id, audio: samples, sampleRate: audio.sampling_rate }, [samples.buffer]);
    }
    post({ type: 'done', id });
  } catch (e) {
    post({ type: 'done', id, error: e instanceof Error ? e.message : String(e) });
  } finally {
    cancelled.delete(id);
  }
}

ctx.onmessage = (e: MessageEvent<KokoroIn>) => {
  const m = e.data;
  if (m.type === 'load') void load().catch(() => {});
  else if (m.type === 'speak') void speak(m.id, m.text, m.voice);
  else if (m.type === 'cancel') cancelled.add(m.id);
};
