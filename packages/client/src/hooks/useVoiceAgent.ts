import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { VoiceAgent, type VoiceCue, type VoiceSnapshot } from '../lib/voiceAgent';
import { MacSpeechProvider, WebSpeechProvider, isSpeechSupported, type SpeechProvider, type WsSend } from '../lib/speechProvider';
import type { VoiceDispatch, VoiceWorker } from '../lib/resolveVoiceTarget';
import type { VoiceInputConfig } from '../lib/voiceConfig';

const MUTE_KEY = 'overlord:voice:muted';

function readMuted(): boolean {
  try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; }
}

function writeMuted(muted: boolean): void {
  try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch { /* ignore */ }
}

const OFF: VoiceSnapshot = {
  state: 'off',
  captured: '',
  preview: null,
  elapsedMs: 0,
  heard: '',
  muted: false,
  error: null,
  manual: false,
  sending: false,
  session: false,
  followUp: false,
};

export interface UseVoiceAgentOptions {
  cfg: VoiceInputConfig;
  workers: readonly VoiceWorker[];
  selectedOvrId: string | null;
  onDispatch: (dispatch: VoiceDispatch) => void;
  /** Audible feedback for capture start / send / cancel. */
  onCue?: (cue: VoiceCue) => void;
  /** Office WebSocket sender; required for the 'macos' engine. */
  sendWs?: WsSend;
  /** Test seam. Defaults to the provider named by `cfg.provider`. */
  createProvider?: () => SpeechProvider;
}

/** Whether the server's native macOS speech helper is usable. null = not yet known. */
function useMacSpeechAvailable(wanted: boolean): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    if (!wanted) return;
    let alive = true;
    fetch('/api/speech/mac')
      .then(r => r.json() as Promise<{ available?: boolean }>)
      .then(d => { if (alive) setAvailable(d.available === true); })
      .catch(() => { if (alive) setAvailable(false); });
    return () => { alive = false; };
  }, [wanted]);
  return available;
}

/** 'unknown' = the Permissions API could not answer; we try anyway. */
export type MicPermission = 'granted' | 'denied' | 'prompt' | 'unknown';

export interface UseVoiceAgentResult extends VoiceSnapshot {
  supported: boolean;
  permission: MicPermission;
  toggleMute: () => void;
  discard: () => void;
  /** Push-to-talk: opens a capture. Returns false when voice is off or muted. */
  begin: () => boolean;
  /** Sends the open capture. */
  commit: () => void;
  /** begin() when idle, commit() when capturing — the single-key / single-button flow. */
  toggleCapture: () => void;
  /** Forces Chrome's microphone prompt, then starts recognition on success. */
  requestPermission: () => void;
  /** Stay-on: hold the idle countdown while the last target is busy. */
  setIdleHold: (held: boolean) => void;
  /** Before reading a reply: true when speaking is fine (an empty follow-up
   *  capture is closed for it). */
  yieldForReply: () => boolean;
  /** After reading: reopen a session paused by yieldForReply, or end it. */
  resumeSession: (resume: boolean) => void;
}

/**
 * Thin React wrapper over the framework-free `VoiceAgent`. The agent is created
 * once and reads live config and roster through refs, so a settings change or a
 * new snapshot never tears down recognition mid-utterance.
 */
export function useVoiceAgent(opts: UseVoiceAgentOptions): UseVoiceAgentResult {
  const { cfg, workers, selectedOvrId, onDispatch, onCue, createProvider, sendWs } = opts;

  const engine = cfg.provider;
  const isMac = engine === 'macos';
  const webSupported = useMemo(() => isSpeechSupported(), []);
  const macAvailable = useMacSpeechAvailable(isMac);
  const supported = isMac ? macAvailable === true : webSupported;
  const sendWsRef = useRef(sendWs);
  sendWsRef.current = sendWs;
  const [snapshot, setSnapshot] = useState<VoiceSnapshot>(OFF);
  const [muted, setMuted] = useState<boolean>(readMuted);
  // What the Permissions API reports. Not trusted for 'denied': Chrome can
  // report it while getUserMedia and recognition both work, so only a real
  // refusal (`refused`) blocks the microphone.
  const [queried, setPermission] = useState<MicPermission>('unknown');
  const [refused, setRefused] = useState(false);
  // The macOS engine's microphone belongs to the native helper, not the
  // browser; its permission problems arrive as engine errors instead.
  const permission: MicPermission = isMac ? 'unknown'
    : refused ? 'denied' : queried === 'denied' ? 'unknown' : queried;

  // Speech recognition silently produces nothing when the microphone was never
  // granted — no error, no results. Tracking the permission is the only way to
  // tell the user why saying the start word does nothing.
  useEffect(() => {
    if (!supported || isMac) return;
    let status: PermissionStatus | null = null;
    const onChange = () => {
      if (!status) return;
      setPermission(status.state as MicPermission);
      if (status.state === 'granted') setRefused(false);
    };
    navigator.permissions
      ?.query({ name: 'microphone' as PermissionName })
      .then(s => { status = s; setPermission(s.state as MicPermission); s.addEventListener('change', onChange); })
      .catch(() => setPermission('unknown'));
    return () => { status?.removeEventListener('change', onChange); };
  }, [supported, isMac]);

  // Refs keep the agent's view of the world current without re-creating it.
  const cfgRef = useRef(cfg);
  const ctxRef = useRef({ workers, selectedOvrId });
  const dispatchRef = useRef(onDispatch);
  cfgRef.current = cfg;
  ctxRef.current = { workers, selectedOvrId };
  dispatchRef.current = onDispatch;
  const cueRef = useRef(onCue);
  cueRef.current = onCue;

  const agentRef = useRef<VoiceAgent | null>(null);

  useEffect(() => {
    if (!supported) return;
    const provider = createProvider ? createProvider()
      : isMac ? new MacSpeechProvider(msg => sendWsRef.current?.(msg) ?? false)
      : new WebSpeechProvider();
    const agent = new VoiceAgent({
      provider,
      getConfig: () => cfgRef.current,
      getContext: () => ctxRef.current,
      onDispatch: d => dispatchRef.current(d),
      onChange: setSnapshot,
      onCue: c => cueRef.current?.(c),
    });
    agentRef.current = agent;
    return () => {
      agentRef.current = null;
      agent.dispose();
      setSnapshot(OFF);
    };
    // createProvider is a stable test seam; the agent must outlive prop changes.
    // Switching engine is the one change that rebuilds it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported, isMac]);

  // Start/stop recognition when enablement, language, mute or permission
  // changes. Starting without a granted microphone would look live but hear
  // nothing, so a missing grant is treated as muted.
  useEffect(() => {
    const agent = agentRef.current;
    if (!agent) return;
    // Only a real refusal blocks. Chrome reports 'prompt' for a live but
    // session-scoped grant, and sometimes 'denied' for a working one, so
    // trusting the query would silence a microphone that is actually working.
    agent.setMuted(muted || (refused && !isMac));
    agent.sync();
    // supported/isMac: a rebuilt agent (engine switch, macOS availability
    // resolving after mount) must be started too.
  }, [muted, refused, cfg.enabled, cfg.lang, cfg.activation, supported, isMac]);

  // Chrome refused recognition itself: that is a real block.
  useEffect(() => {
    if (snapshot.error === 'not-allowed' || snapshot.error === 'service-not-allowed') setRefused(true);
  }, [snapshot.error]);

  // Tick the elapsed-time readout only while an utterance is open.
  useEffect(() => {
    if (snapshot.state !== 'listening') return;
    const id = setInterval(() => {
      const agent = agentRef.current;
      if (agent) setSnapshot(agent.snapshot());
    }, 250);
    return () => clearInterval(id);
  }, [snapshot.state]);

  const toggleMute = useCallback(() => {
    setMuted(prev => { writeMuted(!prev); return !prev; });
  }, []);

  const discard = useCallback(() => {
    agentRef.current?.discard('manual');
  }, []);

  const begin = useCallback(() => agentRef.current?.begin() ?? false, []);
  const commit = useCallback(() => { agentRef.current?.commit(); }, []);
  const toggleCapture = useCallback(() => {
    const agent = agentRef.current;
    if (!agent) return;
    if (agent.snapshot().state === 'listening') agent.commit();
    else agent.begin();
  }, []);

  const requestPermission = useCallback(() => {
    // macOS engine: the helper asks macOS itself on start; just retry.
    if (isMac) { agentRef.current?.sync(); return; }
    // getUserMedia opens Chrome's prompt reliably; SpeechRecognition on its own
    // can fail to. The stream is released immediately — only the grant matters.
    navigator.mediaDevices?.getUserMedia({ audio: true })
      .then(stream => {
        stream.getTracks().forEach(t => t.stop());
        setPermission('granted');
        setRefused(false);
      })
      .catch(() => setRefused(true));
  }, [isMac]);

  const setIdleHold = useCallback((held: boolean) => { agentRef.current?.setIdleHold(held); }, []);
  const yieldForReply = useCallback(() => agentRef.current?.yieldForReply() ?? true, []);
  const resumeSession = useCallback((resume: boolean) => { agentRef.current?.resumeSession(resume); }, []);

  return {
    ...snapshot, muted, supported, permission, toggleMute, discard, begin, commit, toggleCapture, requestPermission,
    setIdleHold, yieldForReply, resumeSession,
  };
}
