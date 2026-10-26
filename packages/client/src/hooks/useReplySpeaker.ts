import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_SPOKEN_CHARS, ReplyVoice, isSpeechOutputSupported, toSpokenText } from '../lib/speechOutput';
import type { VoiceInputConfig } from '../lib/voiceConfig';
import type { Session } from '../types';

/** Server-side cap on `Session.lastMessage`; a message this long was cut. */
const LAST_MESSAGE_CAP = 300;
/** A voice prompt whose reply never came is forgotten after this long. */
export const PENDING_TTL_MS = 15 * 60_000;
/**
 * The worker can report "waiting" a snapshot or two before its new last
 * message arrives. Back from busy with the message unchanged, wait this long
 * before treating it as a reply that merely repeats the previous one —
 * otherwise the previous reply is read aloud.
 */
export const REPEAT_GRACE_MS = 3000;

export interface ReplyWorker {
  ovrId: string;
  name: string;
  state: Session['state'];
  lastMessage?: string;
}

export interface Pending {
  /** `lastMessage` when the prompt was sent — the reply must differ from it. */
  baseline: string | undefined;
  sawBusy: boolean;
  at: number;
  /** When the worker came back waiting with the message still unchanged. */
  waitingSince?: number;
}

export interface UseReplySpeakerOptions {
  cfg: VoiceInputConfig;
  workers: readonly ReplyWorker[];
  /** Asked right before a reading starts. False while the user is dictating —
   *  never talk over them. May close an empty stay-on capture to make room. */
  canSpeak: () => boolean;
  /** Fires when a reading ends; `completed` is false when it was cut off. */
  onSpoken?: (completed: boolean) => void;
}

export interface UseReplySpeakerResult {
  /** Name of the worker being read aloud, or null. */
  speaking: string | null;
  /** Records that `ovrId` was just prompted by voice, so its reply is read. */
  markVoicePrompt: (ovrId: string) => void;
  stop: () => void;
}

/**
 * Reads a worker's reply aloud when it answers a prompt that was sent by voice.
 *
 * "Answered" = the worker went busy and came back to waiting, or its last
 * message changed while waiting (a turn too quick for a snapshot to catch the
 * busy state). Typed prompts are never tracked, so they stay silent.
 */
/**
 * Advances `pending` against the current roster and returns the workers whose
 * reply is ready, in prompt order. Mutates `pending`: records busy phases and
 * drops prompts whose worker closed, vanished or never answered in time.
 * Answered entries are left in place — the caller removes what it consumes.
 *
 * "Answered" = waiting with a last message that differs from the one before
 * the prompt. An unchanged message counts only after a busy phase and
 * REPEAT_GRACE_MS of waiting (a reply that repeats the previous one).
 */
export function trackReplies(pending: Map<string, Pending>, workers: readonly ReplyWorker[], now: number): ReplyWorker[] {
  const answered: ReplyWorker[] = [];
  for (const [ovrId, p] of pending) {
    const w = workers.find(x => x.ovrId === ovrId);
    if (!w || w.state === 'closed' || now - p.at > PENDING_TTL_MS) { pending.delete(ovrId); continue; }
    if (w.state === 'working' || w.state === 'thinking') { p.sawBusy = true; p.waitingSince = undefined; continue; }
    const msg = w.lastMessage;
    if (w.state !== 'waiting' || !msg) continue;
    if (msg !== p.baseline) { answered.push(w); continue; }
    // Same text as before the prompt: either the new message has not arrived
    // yet, or the reply really repeats. Only time tells them apart.
    if (!p.sawBusy) continue;
    p.waitingSince ??= now;
    if (now - p.waitingSince >= REPEAT_GRACE_MS) answered.push(w);
  }
  return answered;
}

export function useReplySpeaker({ cfg, workers, canSpeak, onSpoken }: UseReplySpeakerOptions): UseReplySpeakerResult {
  const enabled = cfg.enabled && cfg.speakReplies && isSpeechOutputSupported();
  const [speaking, setSpeaking] = useState<string | null>(null);
  // Re-runs tracking when a grace period ends with no roster change.
  const [graceTick, setGraceTick] = useState(0);
  const voiceRef = useRef<ReplyVoice | null>(null);
  const pendingRef = useRef(new Map<string, Pending>());
  const workersRef = useRef(workers);
  workersRef.current = workers;
  const langRef = useRef(cfg.lang);
  langRef.current = cfg.lang;
  const engineRef = useRef({ engine: cfg.ttsEngine, kokoroVoice: cfg.kokoroVoice });
  engineRef.current = { engine: cfg.ttsEngine, kokoroVoice: cfg.kokoroVoice };
  const canSpeakRef = useRef(canSpeak);
  canSpeakRef.current = canSpeak;
  const onSpokenRef = useRef(onSpoken);
  onSpokenRef.current = onSpoken;

  const stop = useCallback(() => {
    voiceRef.current?.stop();
    setSpeaking(null);
  }, []);

  // Turning the feature off mid-sentence stops the voice and forgets prompts.
  useEffect(() => {
    if (enabled) return;
    pendingRef.current.clear();
    voiceRef.current?.stop();
    setSpeaking(null);
  }, [enabled]);

  useEffect(() => () => voiceRef.current?.stop(), []);

  const markVoicePrompt = useCallback((ovrId: string) => {
    if (!enabled) return;
    const w = workersRef.current.find(x => x.ovrId === ovrId);
    pendingRef.current.set(ovrId, { baseline: w?.lastMessage, sawBusy: false, at: Date.now() });
  }, [enabled]);

  useEffect(() => {
    const pending = pendingRef.current;
    if (!enabled || pending.size === 0) return;
    // Track every tick, even mid-reading, so a busy phase is never missed.
    const answered = trackReplies(pending, workers, Date.now());
    const inGrace = [...pending.values()].some(p => p.waitingSince !== undefined)
      && answered.length < pending.size;
    const graceTimer = inGrace ? setTimeout(() => setGraceTick(t => t + 1), REPEAT_GRACE_MS) : null;
    const cleanup = () => { if (graceTimer) clearTimeout(graceTimer); };
    // One reading at a time. `speaking` is a dependency, so replies that landed
    // meanwhile are picked up as soon as this one ends.
    if (speaking) return cleanup;
    for (const w of answered) {
      pending.delete(w.ovrId);
      const msg = w.lastMessage ?? '';
      const text = toSpokenText(msg, MAX_SPOKEN_CHARS, { truncated: msg.length >= LAST_MESSAGE_CAP });
      if (!text) continue;
      if (!canSpeakRef.current()) continue;   // the user is already talking

      voiceRef.current ??= new ReplyVoice();
      setSpeaking(w.name);
      voiceRef.current.speak(text, langRef.current, (completed) => {
        setSpeaking(null);
        onSpokenRef.current?.(completed);
      }, engineRef.current);
      break;
    }
    return cleanup;
  }, [enabled, workers, speaking, graceTick]);

  return { speaking, markVoicePrompt, stop };
}
