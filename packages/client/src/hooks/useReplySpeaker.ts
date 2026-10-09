import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_SPOKEN_CHARS, ReplyVoice, isSpeechOutputSupported, toSpokenText } from '../lib/speechOutput';
import type { VoiceInputConfig } from '../lib/voiceConfig';
import type { Session } from '../types';

/** Server-side cap on `Session.lastMessage`; a message this long was cut. */
const LAST_MESSAGE_CAP = 300;
/** A voice prompt whose reply never came is forgotten after this long. */
export const PENDING_TTL_MS = 15 * 60_000;

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
}

export interface UseReplySpeakerOptions {
  cfg: VoiceInputConfig;
  workers: readonly ReplyWorker[];
  /** True while the user is dictating — never talk over them. */
  isListening: () => boolean;
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
 * "Answered" = waiting with a last message, after either a busy phase or a
 * change of that message (a turn too quick for a snapshot to see it busy).
 */
export function trackReplies(pending: Map<string, Pending>, workers: readonly ReplyWorker[], now: number): ReplyWorker[] {
  const answered: ReplyWorker[] = [];
  for (const [ovrId, p] of pending) {
    const w = workers.find(x => x.ovrId === ovrId);
    if (!w || w.state === 'closed' || now - p.at > PENDING_TTL_MS) { pending.delete(ovrId); continue; }
    if (w.state === 'working' || w.state === 'thinking') { p.sawBusy = true; continue; }
    const msg = w.lastMessage;
    if (w.state === 'waiting' && msg && (p.sawBusy || msg !== p.baseline)) answered.push(w);
  }
  return answered;
}

export function useReplySpeaker({ cfg, workers, isListening, onSpoken }: UseReplySpeakerOptions): UseReplySpeakerResult {
  const enabled = cfg.enabled && cfg.speakReplies && isSpeechOutputSupported();
  const [speaking, setSpeaking] = useState<string | null>(null);
  const voiceRef = useRef<ReplyVoice | null>(null);
  const pendingRef = useRef(new Map<string, Pending>());
  const workersRef = useRef(workers);
  workersRef.current = workers;
  const langRef = useRef(cfg.lang);
  langRef.current = cfg.lang;
  const isListeningRef = useRef(isListening);
  isListeningRef.current = isListening;
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
    // One reading at a time. `speaking` is a dependency, so replies that landed
    // meanwhile are picked up as soon as this one ends.
    if (speaking) return;
    for (const w of answered) {
      pending.delete(w.ovrId);
      if (isListeningRef.current()) continue;   // the user is already talking
      const msg = w.lastMessage ?? '';
      const text = toSpokenText(msg, MAX_SPOKEN_CHARS, { truncated: msg.length >= LAST_MESSAGE_CAP });
      if (!text) continue;

      voiceRef.current ??= new ReplyVoice();
      setSpeaking(w.name);
      voiceRef.current.speak(text, langRef.current, (completed) => {
        setSpeaking(null);
        onSpokenRef.current?.(completed);
      });
      break;
    }
  }, [enabled, workers, speaking]);

  return { speaking, markVoicePrompt, stop };
}
