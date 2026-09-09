/**
 * The hands-free state machine. Framework-free on purpose: no React, no DOM, no
 * `Date.now()` reached for directly — the clock is injected — so every
 * transition is testable with fake timers.
 *
 *   IDLE ──start word──> LISTENING ──stop word──> dispatch ──> IDLE
 *                            ├── cancel word ──> discard ──> IDLE
 *                            └── maxUtteranceMs ──> discard ──> IDLE
 *
 * Nothing commits on silence. The only automatic transition is the cap, and it
 * discards: forgetting the stop word must never fire a half-thought at a worker.
 */

import { resolveVoiceTarget, type VoiceDispatch, type VoiceWorker } from './resolveVoiceTarget';
import type { SpeechEvent, SpeechProvider } from './speechProvider';
import type { VoiceInputConfig } from './voiceConfig';
import { isCommitWord, matchStart, matchTrailingPhrase } from './voiceGrammar';

export type VoiceState = 'off' | 'idle' | 'listening' | 'error';

export type DiscardReason = 'cancel' | 'timeout' | 'manual';

export interface VoiceSnapshot {
  state: VoiceState;
  /** Text captured so far, with the start word already stripped. */
  captured: string;
  /** Resolved target for what is captured so far, for the HUD to preview. */
  preview: VoiceDispatch | null;
  /** Time since capture opened, for the cap indicator. 0 when not listening. */
  elapsedMs: number;
  /** Tail of what was heard while idle, so a start word that never matched is
   *  visible instead of looking like a dead microphone. */
  heard: string;
  muted: boolean;
  error: string | null;
}

export interface VoiceAgentDeps {
  provider: SpeechProvider;
  /** Live config; read on every event so a settings change applies at once. */
  getConfig: () => VoiceInputConfig;
  /** Live roster; the fallback target and name candidates come from here. */
  getContext: () => { workers: readonly VoiceWorker[]; selectedOvrId: string | null };
  onDispatch: (dispatch: VoiceDispatch) => void;
  onChange: (snapshot: VoiceSnapshot) => void;
  /** Injected clock, so tests can drive elapsed time. */
  now?: () => number;
}

/** Idle-buffer cap. Long enough to catch a multi-word start phrase spoken
 *  mid-sentence, short enough that an unattended mic never grows without
 *  bound. */
const IDLE_BUFFER_WORDS = 40;

function lastWords(text: string, n: number): string {
  const parts = text.split(/\s+/).filter(Boolean);
  return parts.length <= n ? text.trim() : parts.slice(parts.length - n).join(' ');
}

export class VoiceAgent {
  private state: VoiceState = 'off';
  private muted = false;
  private error: string | null = null;

  /** Complete transcript of the current utterance, as last reported. */
  private transcript = '';
  /** Utterance with the start word stripped, once LISTENING. */
  private captured = '';
  private viaName: string | undefined;
  private captureOpenedAt = 0;
  /** Offset in `transcript` where the current utterance's prompt begins. A
   *  later offset means the speaker said the wake word again. */
  private wakeAt = -1;
  private capTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private deps: VoiceAgentDeps) {
    deps.provider.onResult(e => this.handleEvent(e));
    deps.provider.onError(msg => {
      this.error = msg;
      this.state = 'error';
      this.emit();
    });
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Starts or stops recognition to match the current config and mute state. */
  sync(): void {
    const cfg = this.deps.getConfig();
    const shouldRun = cfg.enabled && !this.muted;

    if (!shouldRun) {
      this.deps.provider.stop();
      this.clearCap();
      this.resetBuffers();
      if (this.state !== 'off') { this.state = 'off'; this.emit(); }
      return;
    }
    this.deps.provider.start(cfg.lang);
    if (this.state === 'off') {
      this.state = 'idle';
      this.error = null;
      this.emit();
    }
  }

  setMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    this.sync();
    this.emit();
  }

  isMuted(): boolean { return this.muted; }

  /** Abandons an in-flight utterance without sending it. */
  discard(reason: DiscardReason = 'manual'): void {
    if (this.state !== 'listening') return;
    void reason;
    this.toIdle();
  }

  dispose(): void {
    this.clearCap();
    this.deps.provider.dispose();
  }

  snapshot(): VoiceSnapshot {
    return {
      state: this.state,
      captured: this.state === 'listening' ? this.captured : '',
      preview: this.state === 'listening' && this.captured.trim() !== '' ? this.resolve(this.captured) : null,
      elapsedMs: this.state === 'listening' ? this.now() - this.captureOpenedAt : 0,
      heard: this.state === 'listening' ? '' : lastWords(this.transcript, 6),
      muted: this.muted,
      error: this.error,
    };
  }

  private emit(): void {
    this.deps.onChange(this.snapshot());
  }

  private resetBuffers(): void {
    this.transcript = '';
    this.captured = '';
    this.viaName = undefined;
    this.wakeAt = -1;
    // The engine keeps its own result list; without clearing it the next
    // utterance would arrive with the previous one still prefixed.
    this.deps.provider.reset();
  }

  private clearCap(): void {
    if (this.capTimer) { clearTimeout(this.capTimer); this.capTimer = null; }
  }

  private toIdle(): void {
    this.clearCap();
    this.resetBuffers();
    this.state = 'idle';
    this.emit();
  }

  private resolve(rest: string): VoiceDispatch {
    const { workers, selectedOvrId } = this.deps.getContext();
    return resolveVoiceTarget({
      rest,
      viaName: this.viaName,
      workers,
      selectedOvrId,
      cfg: this.deps.getConfig(),
    });
  }

  private handleEvent(e: SpeechEvent): void {
    if (this.state === 'off' || this.muted) return;
    const cfg = this.deps.getConfig();
    if (!cfg.enabled) return;

    // `transcript` is the whole utterance, so the wake word is re-stripped from
    // scratch on every event. This is what makes a restated final harmless:
    // appending deltas is what previously let the wake word back into the text.
    const prev = this.transcript;
    this.transcript = lastWords(e.transcript.trim(), IDLE_BUFFER_WORDS);
    const chunk = this.transcript.startsWith(prev) && prev !== ''
      ? this.transcript.slice(prev.length).trim()
      : this.transcript;

    const listening = this.state === 'listening';

    // Opening capture: anything before the wake word is noise, and a worker's
    // name may open it (which also addresses that worker).
    //
    // Already capturing: only the configured start word is re-checked, and the
    // LAST occurrence wins. Saying it again is how a fumbled sentence is
    // restarted — without that the only way out of capture is the utterance
    // cap, which feels exactly like the feature having jammed. Worker names are
    // deliberately excluded here, or naming a worker mid-prompt
    // ("ask morion about it") would silently re-target and truncate.
    const names = !listening && cfg.wakeOnWorkerName
      ? this.deps.getContext().workers.map(w => w.name)
      : [];
    const start = matchStart(this.transcript, cfg.startWord, names, listening ? 'last' : 'first');

    if (!start.matched) {
      if (listening) {
        // The engine revised the transcript and the wake word is gone from it.
        // Nothing trustworthy is left to send.
        this.toIdle();
        return;
      }
      // Report it anyway: a user whose start word is being misheard needs to
      // see that the microphone is working at all.
      this.emit();
      return;
    }

    const restarted = listening && start.at > this.wakeAt;
    if (!listening || restarted) {
      this.state = 'listening';
      this.error = null;
      this.captureOpenedAt = this.now();
      this.armCap(cfg.maxUtteranceMs);
      if (restarted) this.viaName = undefined;   // re-woken by the start word
    }
    if (!listening) this.viaName = start.viaName;
    this.wakeAt = start.at;
    this.captured = start.rest;
    // One breath can carry the wake word, the prompt and the stop word.
    this.checkCommit(cfg, chunk, e.gapMsBefore, e.isFinal);
    this.emit();
  }

  /**
   * A commit word counts in either of two shapes, because the recognizer uses
   * both:
   *
   *  - its own chunk after a pause — highest confidence;
   *  - the last words of a *finalized* chunk. The engine finalizes when the
   *    speaker stops, so a final chunk ending in the stop word means they said
   *    it and stopped. Without this, an utterance spoken in one breath never
   *    commits at all, which is the worse failure: the text just sits there.
   *
   * The cost is that a sentence genuinely ending in the stop word ("ready to
   * go") will send. Interim chunks are still ignored, so mid-sentence "go
   * ahead and fix it" cannot fire.
   */
  private checkCommit(cfg: VoiceInputConfig, chunk: string, gapMsBefore: number, isFinal: boolean): void {
    if (this.state !== 'listening') return;

    // Both paths tolerate the engine mangling the word, exactly as the wake
    // word does, and both strip whatever it actually returned.
    const committed = (word: string) =>
      isCommitWord(chunk, word, gapMsBefore) || (isFinal && matchTrailingPhrase(this.captured, word).hit);

    if (committed(cfg.cancelWord)) {
      this.toIdle();
      return;
    }

    if (!committed(cfg.stopWord)) return;

    const text = matchTrailingPhrase(this.captured, cfg.stopWord).stripped;
    if (text === '') { this.toIdle(); return; }

    const dispatch = this.resolve(text);
    this.toIdle();
    this.deps.onDispatch(dispatch);
  }

  private armCap(ms: number): void {
    this.clearCap();
    this.capTimer = setTimeout(() => {
      this.capTimer = null;
      // Discard, never send. An utterance with no stop word is unfinished.
      if (this.state === 'listening') this.toIdle();
    }, ms);
  }
}
