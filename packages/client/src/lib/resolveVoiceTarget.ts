/**
 * Decides who hears a spoken utterance, and whether it is a prompt or a
 * command. Pure: it takes a flattened worker roster rather than an
 * OfficeSnapshot, so every branch is testable without building a snapshot.
 *
 * This is where a misfire would live, so the bias throughout is to refuse with
 * a reason rather than guess.
 */

import type { VoiceInputConfig } from './voiceConfig';
import {
  classifyUtterance,
  fuzzyName,
  stripLeadingAddress,
  type ControlVerb,
  type NameCandidate,
} from './voiceGrammar';

/**
 * Floor for the leading-address path, which *infers* that a prompt's first word
 * names a worker. It is deliberately much stricter than `cfg.nameMatchFloor`:
 * at 0.72 a worker called "updater" would swallow the first word of "update the
 * readme" and receive "the readme" instead. An explicit `select <name>` keeps
 * the configured floor, because there the user's intent to name a worker is not
 * in question.
 */
const ADDRESS_FLOOR = 0.9;

/** Minimal projection of a session the voice agent needs. */
export interface VoiceWorker {
  ovrId: string;
  name: string;
  state: 'working' | 'thinking' | 'waiting' | 'closed';
}

export type VoiceDispatch =
  | {
      kind: 'prompt';
      text: string;
      ovrId: string;
      name: string;
      /** Worker is mid-turn — hand to the queue instead of injecting now. */
      queue: boolean;
    }
  | {
      kind: 'control';
      verb: ControlVerb;
      /** Present for `select` / `open`, which name a worker. */
      ovrId?: string;
      name?: string;
      text: string;
    }
  | { kind: 'refused'; reason: string; candidates?: string[] };

export interface ResolveInput {
  /** Utterance with the start word already consumed. */
  rest: string;
  /** Worker whose own name opened capture, if any. */
  viaName?: string;
  workers: readonly VoiceWorker[];
  /** Currently open worker in the UI — the fallback target. */
  selectedOvrId: string | null;
  cfg: VoiceInputConfig;
}

function candidatesOf(workers: readonly VoiceWorker[]): NameCandidate[] {
  return workers.map(w => ({ id: w.ovrId, name: w.name }));
}

/** Injection gate. `closed` cannot receive anything; a worker mid-turn is
 *  queued rather than interrupted mid-tool-call. */
function gate(worker: VoiceWorker, text: string): VoiceDispatch {
  if (worker.state === 'closed') {
    return { kind: 'refused', reason: `${worker.name} is closed` };
  }
  return {
    kind: 'prompt',
    text,
    ovrId: worker.ovrId,
    name: worker.name,
    queue: worker.state === 'working' || worker.state === 'thinking',
  };
}

export function resolveVoiceTarget(input: ResolveInput): VoiceDispatch {
  const { rest, viaName, workers, selectedOvrId, cfg } = input;
  const trimmed = rest.trim();
  if (trimmed === '') return { kind: 'refused', reason: 'nothing said' };

  const utterance = classifyUtterance(trimmed);

  // Commands first — they never address a worker by prefix, and `select`/`open`
  // resolve their own argument.
  if (utterance.kind === 'control') {
    if (utterance.arg !== undefined) {
      // The whole argument is the name — intent to name a worker is explicit
      // here, so the configured (looser) floor applies.
      const match = fuzzyName(utterance.arg, candidatesOf(workers), cfg.nameMatchFloor);
      if (match.kind === 'hit') {
        return { kind: 'control', verb: utterance.verb!, ovrId: match.id, name: match.name, text: trimmed };
      }
      if (match.kind === 'ambiguous') {
        return {
          kind: 'refused',
          reason: `which one?`,
          candidates: match.candidates.map(c => c.name),
        };
      }
      return { kind: 'refused', reason: `no worker matches "${utterance.arg}"` };
    }
    return { kind: 'control', verb: utterance.verb!, text: trimmed };
  }

  // 1. The worker's own name opened capture — it is the target, and the whole
  //    utterance is the prompt.
  if (viaName) {
    const worker = workers.find(w => w.name === viaName);
    if (worker) return gate(worker, utterance.text);
  }

  // 2. Leading address: "morion, fix the enter bug".
  if (cfg.wakeOnWorkerName) {
    const addressed = stripLeadingAddress(utterance.text, candidatesOf(workers), ADDRESS_FLOOR);
    if (addressed.match.kind === 'ambiguous') {
      return {
        kind: 'refused',
        reason: 'which worker?',
        candidates: addressed.match.candidates.map(c => c.name),
      };
    }
    if (addressed.match.kind === 'hit') {
      const worker = workers.find(w => w.ovrId === (addressed.match as { id: string }).id);
      if (worker) {
        if (addressed.text === '') return { kind: 'refused', reason: 'nothing said' };
        return gate(worker, addressed.text);
      }
    }
  }

  // 3. Fall back to whatever worker is open in the UI.
  if (selectedOvrId) {
    const worker = workers.find(w => w.ovrId === selectedOvrId);
    if (worker) return gate(worker, utterance.text);
  }

  return { kind: 'refused', reason: 'no worker selected' };
}
