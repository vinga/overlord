/**
 * Quiet audio cues for voice capture, synthesized with Web Audio — no files to
 * ship. Each cue is a short sine blip (the reminder, two) with a soft envelope,
 * kept well below speech volume so it confirms without startling.
 */

import type { VoiceCue } from './voiceAgent';

interface Tone {
  freq: number; ms: number; gain: number;
  /** End frequency, for a glide. */ to?: number;
  /** Extra blips after the first, `gapMs` apart (onset to onset). */ repeat?: number; gapMs?: number;
}

const TONES: Record<VoiceCue, Tone> = {
  start:  { freq: 660, ms: 60, gain: 0.05 },
  send:   { freq: 880, to: 1320, ms: 90, gain: 0.07 },
  cancel: { freq: 440, to: 300, ms: 110, gain: 0.05 },
  // Stay-on "mic is still open": two soft low ticks, unlike any other cue.
  reminder: { freq: 520, ms: 35, gain: 0.03, repeat: 1, gapMs: 120 },
};

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  // One shared context: Chrome caps how many may exist per page.
  ctx ??= new Ctor();
  // A context created before any user gesture starts suspended. Cues follow a
  // keypress or click, so resuming here succeeds.
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

export function playCue(cue: VoiceCue): void {
  const ac = audio();
  if (!ac) return;
  const t = TONES[cue];
  for (let i = 0; i <= (t.repeat ?? 0); i++) blip(ac, t, ac.currentTime + (i * (t.gapMs ?? 0)) / 1000);
}

function blip(ac: AudioContext, t: Tone, now: number): void {
  const end = now + t.ms / 1000;

  const osc = ac.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(t.freq, now);
  if (t.to) osc.frequency.exponentialRampToValueAtTime(t.to, end);

  // 8ms attack, exponential release: no click at either edge.
  const amp = ac.createGain();
  amp.gain.setValueAtTime(0.0001, now);
  amp.gain.exponentialRampToValueAtTime(t.gain, now + 0.008);
  amp.gain.exponentialRampToValueAtTime(0.0001, end);

  osc.connect(amp).connect(ac.destination);
  osc.start(now);
  osc.stop(end + 0.02);
}
