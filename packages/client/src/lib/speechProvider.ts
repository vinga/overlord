/**
 * Speech recognition behind a narrow interface, so the state machine in
 * `voiceAgent.ts` never touches a browser API and the engine can be swapped
 * (local Whisper, an STT API) without changing a line of the agent or the UI.
 */

export interface SpeechEvent {
  /**
   * The COMPLETE transcript of the current utterance, not a delta.
   *
   * Chrome restates: it emits an interim ("overlord say hi"), then a final that
   * repeats the whole thing ("overlord say hi go"). Emitting deltas made the
   * consumer append a restatement onto text it had already stripped the wake
   * word from, so the wake word reappeared and was sent to the worker. A full
   * transcript is idempotent — the consumer re-derives from scratch every time.
   */
  transcript: string;
  /** True when this event carried newly finalized words. */
  isFinal: boolean;
  /**
   * Milliseconds since the previous result event. Used as a proxy for the pause
   * before the last word spoken: the Web Speech API exposes no word timings, but
   * it emits interim results continuously while speech is flowing, so a large
   * gap before the event carrying the stop word means the speaker paused.
   */
  gapMsBefore: number;
}

export interface SpeechProvider {
  /** Begin recognizing. Safe to call when already running. */
  start(lang: string): void;
  /** Stop recognizing and release the microphone. */
  stop(): void;
  onResult(cb: (e: SpeechEvent) => void): void;
  onError(cb: (message: string) => void): void;
  /** Discards the current utterance so the next transcript starts empty. */
  reset(): void;
  dispose(): void;
}

/** Minimal shape of the vendor-prefixed Web Speech API. */
interface RecognitionAlternative { transcript: string }
interface RecognitionResult { isFinal: boolean; 0: RecognitionAlternative }
interface RecognitionEvent { resultIndex: number; results: { length: number; [i: number]: RecognitionResult } }
interface RecognitionErrorEvent { error: string }
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isSpeechSupported(): boolean {
  return typeof window !== 'undefined' && recognitionCtor() !== null;
}

/**
 * Chrome's Web Speech API.
 *
 * Two behaviors it forces on us: it ends the session on its own after a stretch
 * of silence, and it reports 'no-speech' as an error rather than a state. Both
 * are handled by restarting while the caller still wants us running, so the
 * agent above sees one continuous stream.
 *
 * Note for callers: while running, Chrome streams microphone audio to Google
 * for transcription. Stopping is the only way to release the microphone — there
 * is no MediaStream to detach.
 */
export class WebSpeechProvider implements SpeechProvider {
  private rec: Recognition | null = null;
  private wantRunning = false;
  private lang = 'en-US';
  private lastEventAt = 0;
  /** Finalized text from earlier recognition sessions in the same utterance.
   *  Chrome ends a session on its own mid-sentence; without this the transcript
   *  would restart from empty and lose the first half. */
  private carry = '';
  /** Set by reset(): the session being torn down must not add to `carry`. */
  private dropSession = false;
  /** Finalized text of the CURRENT session, tracked as it arrives so `onend`
   *  can carry it forward — the engine's result list is gone by then. */
  private sessionFinal = '';
  private resultCb: ((e: SpeechEvent) => void) | null = null;
  private errorCb: ((m: string) => void) | null = null;
  /** Guards against a restart storm when the engine fails repeatedly. */
  private consecutiveFailures = 0;

  onResult(cb: (e: SpeechEvent) => void): void { this.resultCb = cb; }
  onError(cb: (m: string) => void): void { this.errorCb = cb; }

  reset(): void {
    this.carry = '';
    if (!this.rec) return;
    // Abort so the engine's own result list clears; onend restarts us.
    this.dropSession = true;
    try { this.rec.abort(); } catch { /* already dead */ }
  }

  start(lang: string): void {
    this.lang = lang;
    this.wantRunning = true;
    this.ensure();
  }

  stop(): void {
    this.wantRunning = false;
    this.carry = '';
    this.sessionFinal = '';
    const rec = this.rec;
    this.rec = null;
    if (rec) {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try { rec.abort(); } catch { /* already dead */ }
    }
  }

  dispose(): void {
    this.stop();
    this.resultCb = null;
    this.errorCb = null;
  }

  private ensure(): void {
    if (!this.wantRunning || this.rec) return;
    const Ctor = recognitionCtor();
    if (!Ctor) {
      this.errorCb?.('Speech recognition is not available in this browser');
      this.wantRunning = false;
      return;
    }

    const rec = new Ctor();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = (e) => {
      this.consecutiveFailures = 0;
      const now = Date.now();
      const gap = this.lastEventAt === 0 ? 0 : now - this.lastEventAt;
      this.lastEventAt = now;

      // Read the engine's whole result list, not just the new entries: the list
      // IS the utterance, and later results restate earlier ones.
      // Join with a space rather than concatenating: Chrome's leading-space
      // convention is not guaranteed, and "say hi" + "go" must not become
      // "say higo".
      const parts: string[] = [];
      const finalParts: string[] = [];
      let sawNewFinal = false;
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        parts.push(r[0].transcript);
        if (r.isFinal) {
          finalParts.push(r[0].transcript);
          if (i >= e.resultIndex) sawNewFinal = true;
        }
      }
      const sessionText = parts.join(' ').replace(/\s+/g, ' ').trim();
      this.sessionFinal = finalParts.join(' ').replace(/\s+/g, ' ').trim();
      const transcript = `${this.carry} ${sessionText}`.trim();
      if (transcript) this.resultCb?.({ transcript, isFinal: sawNewFinal, gapMsBefore: gap });
    };

    rec.onerror = (e) => {
      // 'no-speech' and 'aborted' are routine in continuous mode — the restart
      // in onend handles them. Anything else is worth showing.
      if (e.error !== 'no-speech' && e.error !== 'aborted') {
        this.consecutiveFailures++;
        this.errorCb?.(e.error);
      }
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.wantRunning = false;
      }
    };

    rec.onend = () => {
      // Carry this session's finalized words into the next one, so an utterance
      // split across two recognition sessions is not silently truncated.
      if (this.dropSession) {
        this.dropSession = false;
        this.carry = '';
      } else {
        this.carry = `${this.carry} ${this.sessionFinal}`.trim();
      }
      this.sessionFinal = '';
      this.rec = null;
      if (!this.wantRunning) return;
      if (this.consecutiveFailures >= 5) {
        this.wantRunning = false;
        this.errorCb?.('Speech recognition kept failing — voice input stopped');
        return;
      }
      // Chrome ends the session on its own; restart so the agent sees one stream.
      setTimeout(() => this.ensure(), 250);
    };

    this.rec = rec;
    try {
      rec.start();
    } catch {
      // start() throws when a previous session is still tearing down. onend
      // does NOT fire in that case, so without an explicit retry here the
      // recognizer would stay dead while the UI still looked live.
      this.rec = null;
      if (this.wantRunning) setTimeout(() => this.ensure(), 400);
    }
  }
}
