/**
 * The hands-free state machine. Framework-free on purpose: no React, no DOM, no
 * `Date.now()` reached for directly — the clock is injected — so every
 * transition is testable with fake timers.
 *
 *   IDLE ──start word──> LISTENING ──stop word──> dispatch ──> IDLE
 *                            ├── cancel word ──> discard ──> IDLE
 *                            └── maxUtteranceMs of silence ──> close ──> IDLE
 *
 * Nothing commits on silence. The only automatic transition is the cap, and it
 * never sends: forgetting the stop word must never fire a half-thought at a
 * worker. The cap counts silence (re-armed on every result), so a long
 * dictation is never cut off mid-speech. Closing never erases the dictated
 * text — the composer keeps it (see the dictation mirror in App).
 *
 * Push-to-talk ('push' activation) skips the start word: `begin()` opens
 * capture and starts recognition, `commit()` sends, `discard()` drops. The
 * microphone is released whenever capture closes, so nothing streams while
 * idle. Stop and cancel words still work inside a push capture.
 *
 * Stay-on session (push + `stayOnAfterSend`): a send reopens an empty
 * follow-up capture instead of closing the mic. While it waits it plays a
 * reminder cue every REMINDER_INTERVAL_MS and closes after FOLLOW_UP_IDLE_MS
 * of silence (held while the last target works). Esc, the cancel word, Alt+V
 * on an empty capture, a refused send or the utterance cap end the session.
 */

import { resolveVoiceTarget, type VoiceDispatch, type VoiceWorker } from './resolveVoiceTarget';
import type { SpeechEvent, SpeechProvider } from './speechProvider';
import { FOLLOW_UP_IDLE_MS, INTERIM_STOP_PAUSE_MS, REMINDER_INTERVAL_MS, STOP_PAUSE_MS, type VoiceInputConfig } from './voiceConfig';
import { matchStart, matchTrailingPhrase } from './voiceGrammar';

export type VoiceState = 'off' | 'idle' | 'listening' | 'error';

export type VoiceCue = 'start' | 'send' | 'cancel' | 'reminder';

type PendingCommit = 'send' | 'cancel';

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
  /** True while a push-to-talk capture is open (as opposed to a wake-word one). */
  manual: boolean;
  /** The stop word was heard and the send fires after the pause unless more
   *  words arrive. */
  sending: boolean;
  /** A stay-on session is active (listening, or paused while a reply is read). */
  session: boolean;
  /** The open capture is an empty follow-up, waiting for the next message. */
  followUp: boolean;
}

export interface VoiceAgentDeps {
  provider: SpeechProvider;
  /** Live config; read on every event so a settings change applies at once. */
  getConfig: () => VoiceInputConfig;
  /** Live roster; the fallback target and name candidates come from here. */
  getContext: () => { workers: readonly VoiceWorker[]; selectedOvrId: string | null };
  onDispatch: (dispatch: VoiceDispatch) => void;
  onChange: (snapshot: VoiceSnapshot) => void;
  /** Audible feedback hook: capture opened, sent, or thrown away. */
  onCue?: (cue: VoiceCue) => void;
  /** Injected clock, so tests can drive elapsed time. */
  now?: () => number;
}

/** Idle-buffer cap. Long enough to catch a multi-word start phrase spoken
 *  mid-sentence, short enough that an unattended mic never grows without
 *  bound. */
const IDLE_BUFFER_WORDS = 40;

/** How long `commit()` waits for the engine to deliver the last words. Chrome
 *  reports a word a few hundred ms after it is spoken, so sending on the
 *  keypress itself would cut off the end of the sentence. */
export const COMMIT_SETTLE_MS = 400;

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
  /** True while a push-to-talk capture is open. */
  private manual = false;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Fires the send/cancel once the speaker has paused after the word. */
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: PendingCommit | null = null;
  /** Stay-on session state. `followUp`: the open capture is an empty
   *  follow-up; `paused`: closed while a reply is read, to be resumed. */
  private session = false;
  private followUp = false;
  private paused = false;
  private idleHeld = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private reminderTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: VoiceAgentDeps) {
    deps.provider.onResult(e => this.handleEvent(e));
    deps.provider.onError(msg => {
      // A failed push capture is over; release the microphone rather than let
      // the provider's auto-restart keep it open behind an error state.
      if (this.manual) {
        this.manual = false;
        this.clearCap();
        this.clearSettle();
        this.releaseManualMic();
      }
      this.endSession();
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
      this.clearSettle();
      this.manual = false;
      this.endSession();
      this.resetBuffers();
      if (this.state !== 'off') { this.state = 'off'; this.emit(); }
      return;
    }
    // Push-to-talk keeps the microphone closed until begin().
    if (cfg.activation === 'push') {
      if (!this.manual) this.deps.provider.stop();
    } else {
      this.manual = false;
      this.endSession();
      this.deps.provider.start(cfg.lang);
    }
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

  /** Opens a push-to-talk capture. No-op when disabled, muted or already
   *  capturing. Returns whether a capture is open afterwards. */
  begin(): boolean {
    const cfg = this.deps.getConfig();
    if (!cfg.enabled || this.muted || this.state === 'off') return false;
    if (this.state === 'listening') return true;
    this.resetBuffers();
    this.manual = true;
    this.state = 'listening';
    this.error = null;
    this.paused = false;
    this.session = cfg.activation === 'push' && cfg.stayOnAfterSend;
    this.captureOpenedAt = this.now();
    this.armCap(cfg.maxUtteranceMs);
    this.deps.provider.start(cfg.lang);
    this.deps.onCue?.('start');
    this.emit();
    return true;
  }

  /**
   * Holds the follow-up idle countdown while the worker that got the last
   * message is busy — waiting for its reply is not idleness. Releasing
   * restarts the full FOLLOW_UP_IDLE_MS.
   */
  setIdleHold(held: boolean): void {
    if (this.idleHeld === held) return;
    this.idleHeld = held;
    if (this.followUp) this.armIdle();
  }

  /**
   * Called before a reply is read aloud. Returns whether speaking is fine:
   * true when not capturing, or when the open capture was an empty follow-up,
   * which is closed (mic released) so the mic does not hear the reply. The
   * session survives, and `resumeSession()` reopens it. False while the user
   * is mid-capture — never talk over them.
   */
  yieldForReply(): boolean {
    if (this.state !== 'listening') return true;
    if (!this.followUp) return false;
    this.clearFollowUpTimers();
    this.followUp = false;
    this.manual = false;
    this.paused = true;
    this.resetBuffers();
    this.deps.provider.stop();
    this.state = 'idle';
    this.emit();
    return true;
  }

  /** Reopens a session paused by `yieldForReply()`. `false` ends it instead
   *  (the reading was cut off, e.g. Esc). */
  resumeSession(resume = true): void {
    if (!this.paused) return;
    this.paused = false;
    if (!resume || this.muted || this.state === 'off') { this.endSession(); this.emit(); return; }
    const cfg = this.deps.getConfig();
    this.manual = true;
    this.deps.provider.start(cfg.lang);
    this.openFollowUp();
    this.deps.onCue?.('start');
    this.emit();
  }

  /** Sends the open capture. In push mode it first waits COMMIT_SETTLE_MS for
   *  the engine's trailing words; in wake mode it sends what is captured. */
  commit(): void {
    if (this.state !== 'listening' || this.settleTimer) return;
    this.clearPause();
    // Alt+V on an empty follow-up is how a stay-on session is switched off.
    if (this.followUp) { this.cancelWithCue(); return; }
    // Enter right after saying "go" must not send the word itself.
    const final = () => matchTrailingPhrase(this.captured, this.deps.getConfig().stopWord).stripped;
    if (!this.manual) { this.send(final()); return; }
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      if (this.state === 'listening') this.send(final());
    }, COMMIT_SETTLE_MS);
  }

  /** Abandons an in-flight utterance without sending it. */
  discard(reason: DiscardReason = 'manual'): void {
    if (this.state !== 'listening') return;
    void reason;
    this.cancelWithCue();
  }

  dispose(): void {
    this.endSession();
    this.clearCap();
    this.clearSettle();
    this.clearPause();
    this.deps.provider.dispose();
  }

  snapshot(): VoiceSnapshot {
    return {
      state: this.state,
      captured: this.state === 'listening' ? this.captured : '',
      preview: this.state === 'listening' && this.captured.trim() !== '' ? this.resolve(this.captured) : null,
      elapsedMs: this.state === 'listening' && !this.followUp ? this.now() - this.captureOpenedAt : 0,
      heard: this.state === 'listening' ? '' : lastWords(this.transcript, 6),
      muted: this.muted,
      error: this.error,
      manual: this.state === 'listening' && this.manual,
      sending: this.state === 'listening' && this.pending === 'send',
      session: this.session,
      followUp: this.state === 'listening' && this.followUp,
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

  private clearSettle(): void {
    if (this.settleTimer) { clearTimeout(this.settleTimer); this.settleTimer = null; }
  }

  private toIdle(): void {
    this.clearCap();
    this.clearSettle();
    this.clearPause();
    this.resetBuffers();
    if (this.manual) {
      this.manual = false;
      this.releaseManualMic();
    }
    this.endSession();
    this.state = 'idle';
    this.emit();
  }

  /** Clears every stay-on timer and flag. Does not touch the capture. */
  private endSession(): void {
    this.clearFollowUpTimers();
    this.session = false;
    this.followUp = false;
    this.paused = false;
  }

  /** Turns the open push capture into an empty follow-up: fresh buffers, no
   *  utterance cap until the first word, idle countdown and reminder armed. */
  private openFollowUp(): void {
    this.clearCap();
    this.clearSettle();
    this.clearPause();
    this.resetBuffers();
    this.state = 'listening';
    this.error = null;
    this.followUp = true;
    this.captureOpenedAt = this.now();
    this.armIdle();
    this.reminderTimer = setInterval(() => {
      if (this.followUp && this.state === 'listening') this.deps.onCue?.('reminder');
    }, REMINDER_INTERVAL_MS);
  }

  private armIdle(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (!this.followUp || this.idleHeld) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.followUp && this.state === 'listening') this.cancelWithCue();
    }, FOLLOW_UP_IDLE_MS);
  }

  private clearFollowUpTimers(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.reminderTimer) { clearInterval(this.reminderTimer); this.reminderTimer = null; }
  }

  /** A push capture owns the microphone only while open. In wake mode the
   *  recognizer was already running for the start word, so it stays on. */
  private releaseManualMic(): void {
    if (this.deps.getConfig().activation === 'push') this.deps.provider.stop();
  }

  /** Dispatches `text` (stop word already stripped) and closes capture. */
  private send(text: string): void {
    const trimmed = text.trim();
    if (trimmed === '') {
      // Only the stop word was said: nothing to send, keep waiting in a session.
      if (this.session && this.manual) { this.openFollowUp(); this.emit(); } else this.toIdle();
      return;
    }
    const dispatch = this.resolve(trimmed);
    // Stay-on: reopen for the next message. A refused send ends the session —
    // there is no point listening into nothing.
    if (this.session && this.manual && dispatch.kind !== 'refused') {
      this.openFollowUp();
      this.emit();
    } else {
      this.toIdle();
    }
    // A refused dispatch reached nobody, so it must not sound like a send.
    this.deps.onCue?.(dispatch.kind === 'refused' ? 'cancel' : 'send');
    this.deps.onDispatch(dispatch);
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

    if (this.manual) {
      if (this.state !== 'listening') return;
      // No start word to strip: the whole utterance is the prompt, and it is not
      // capped to the idle buffer — dictation can run long.
      this.transcript = e.transcript.trim();
      if (this.followUp && this.transcript !== '') {
        // The next message has started: back to a normal, capped capture.
        this.followUp = false;
        this.clearFollowUpTimers();
        this.captureOpenedAt = this.now();
        this.armCap(cfg.maxUtteranceMs);
      }
      this.captured = this.transcript;
      // Silence cap, not a length cap: keep the capture open while speech flows.
      this.armCap(cfg.maxUtteranceMs);
      this.checkCommit(cfg, e.isFinal);
      if (this.state === 'listening') this.emit();
      return;
    }
    // A stale event from a push capture that just closed.
    if (cfg.activation === 'push') return;

    const listening = this.state === 'listening';

    // `transcript` is the whole utterance, so the wake word is re-stripped from
    // scratch on every event. This is what makes a restated final harmless:
    // appending deltas is what previously let the wake word back into the text.
    // Only the idle buffer is capped: once capturing, a long dictation must not
    // scroll its own wake word out of the window and drop the capture.
    const full = e.transcript.trim();
    this.transcript = listening ? full : lastWords(full, IDLE_BUFFER_WORDS);
    // Offset of the (possibly capped) buffer within `full`, so wakeAt is kept in
    // full-transcript coordinates across the cap → uncapped switch.
    const bufferOffset = !listening && full.endsWith(this.transcript) ? full.length - this.transcript.length : 0;

    // Opening capture: anything before the wake word is noise, and a worker's
    // name may open it (which also addresses that worker).
    //
    // Already capturing: only the configured start word is re-checked, and the
    // LAST occurrence wins. Saying it again is how a fumbled sentence is
    // restarted — without that the only way out of capture is the utterance
    // cap, which feels exactly like the feature having jammed. Worker names are
    // deliberately excluded here, or naming a worker mid-prompt
    // ("ask morion about it") would silently re-target and truncate — except
    // the name that opened this capture, which is its only anchor.
    const names = !listening && cfg.wakeOnWorkerName
      ? this.deps.getContext().workers.map(w => w.name)
      : listening && this.viaName ? [this.viaName] : [];
    const start = matchStart(this.transcript, cfg.startWord, names, listening ? 'last' : 'first');

    if (!start.matched) {
      if (listening) {
        // The engine revised the wake word out of the transcript. Keep what was
        // already captured — dictated text must survive until the stop word —
        // and wait for the next result to re-anchor.
        this.armCap(cfg.maxUtteranceMs);
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
      if (restarted) this.viaName = start.viaName;   // re-woken by the start word, or the same name
      else this.deps.onCue?.('start');
    }
    // The cap counts silence, not length: every result is speech, so a long
    // dictation stays open for as long as the speaker keeps talking.
    this.armCap(cfg.maxUtteranceMs);
    if (!listening) this.viaName = start.viaName;
    this.wakeAt = start.at + bufferOffset;
    this.captured = start.rest;
    // One breath can carry the wake word, the prompt and the stop word.
    this.checkCommit(cfg, e.isFinal);
    this.emit();
  }

  /**
   * The stop (or cancel) word commits when it ends the transcript and the
   * speaker then pauses for STOP_PAUSE_MS. Timing it ourselves rather than
   * waiting for the engine to finalize matters: Chrome finalizes erratically,
   * so "go" used to send instantly on one utterance and never on the next.
   *
   * Any later word — or the engine revising "go" into "goal" — lands as a new
   * event, which re-decides from scratch, so "go ahead and fix it" never
   * fires. Interim results count, since the pause is what carries the intent.
   * The cost: a sentence genuinely ending in the stop word ("ready to go")
   * sends after the pause.
   *
   * The pause is short only once the engine finalized the stop word; an
   * interim "go" is often the start of a longer word and gets the long pause.
   */
  private checkCommit(cfg: VoiceInputConfig, isFinal: boolean): void {
    if (this.state !== 'listening') return;
    // Every result event is speech activity, so whatever was pending is
    // re-decided from the current transcript and the pause starts over.
    this.clearPause();

    const kind: PendingCommit | null = matchTrailingPhrase(this.captured, cfg.cancelWord).hit ? 'cancel'
      : matchTrailingPhrase(this.captured, cfg.stopWord).hit ? 'send'
      : null;
    if (!kind) return;

    this.pending = kind;
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = null;
      this.pending = null;
      if (this.state !== 'listening') return;
      const now = this.deps.getConfig();
      if (kind === 'cancel') {
        if (matchTrailingPhrase(this.captured, now.cancelWord).hit) this.cancelWithCue();
        return;
      }
      const m = matchTrailingPhrase(this.captured, now.stopWord);
      if (m.hit) this.send(m.stripped);
    }, isFinal ? STOP_PAUSE_MS : INTERIM_STOP_PAUSE_MS);
  }

  private clearPause(): void {
    if (this.pauseTimer) { clearTimeout(this.pauseTimer); this.pauseTimer = null; }
    this.pending = null;
  }

  private cancelWithCue(): void {
    this.toIdle();
    this.deps.onCue?.('cancel');
  }

  private armCap(ms: number): void {
    this.clearCap();
    this.capTimer = setTimeout(() => {
      this.capTimer = null;
      // Close, never send. An utterance with no stop word is unfinished; its
      // text stays in the composer.
      if (this.state === 'listening') this.cancelWithCue();
    }, ms);
  }
}
