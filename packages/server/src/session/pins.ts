import type { Pin, PinKind } from '../types.js';

export const PIN_KINDS: readonly PinKind[] = ['ticket', 'pr', 'branch', 'link'];
export const MAX_PINS = 30;
const MAX_URL = 2048;
const MAX_TITLE = 120;

export function isPinKind(v: unknown): v is PinKind {
  return typeof v === 'string' && (PIN_KINDS as readonly string[]).includes(v);
}

/** Kind + default title derived from the URL alone — no network. */
export function classifyPinUrl(raw: string): { kind: PinKind; title: string } {
  let u: URL;
  try { u = new URL(raw); } catch { return { kind: 'link', title: raw.slice(0, MAX_TITLE) }; }
  const parts = u.pathname.split('/').filter(Boolean).map(p => { try { return decodeURIComponent(p); } catch { return p; } });

  const jira = u.pathname.match(/\/browse\/([A-Z][A-Z0-9_]*-\d+)/);
  if (jira) return { kind: 'ticket', title: jira[1] };
  const selected = u.searchParams.get('selectedIssue');
  if (selected && /^[A-Z][A-Z0-9_]*-\d+$/.test(selected)) return { kind: 'ticket', title: selected };

  if (u.hostname === 'github.com' && parts.length >= 4) {
    const [, repo, section, rest] = parts;
    if (section === 'pull' && /^\d+$/.test(rest)) return { kind: 'pr', title: `${repo}#${rest}` };
    if (section === 'tree') return { kind: 'branch', title: parts.slice(3).join('/') };
    if (section === 'issues' && /^\d+$/.test(rest)) return { kind: 'ticket', title: `${repo}#${rest}` };
  }

  const path = parts.length ? `/${parts.slice(-2).join('/')}` : '';
  return { kind: 'link', title: `${u.hostname.replace(/^www\./, '')}${path}`.slice(0, MAX_TITLE) };
}

export interface PinInput { url: unknown; title?: unknown; kind?: unknown }

/** Validate raw input; returns the normalized fields or an error string. */
export function validatePinInput(input: PinInput): { url: string; title: string; kind: PinKind } | { error: string } {
  const { url, title, kind } = input;
  if (typeof url !== 'string' || !url.trim()) return { error: 'url required' };
  const trimmed = url.trim();
  if (trimmed.length > MAX_URL) return { error: `url longer than ${MAX_URL}` };
  let parsed: URL;
  try { parsed = new URL(trimmed); } catch { return { error: 'url is not valid' }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { error: 'url must be http(s)' };
  if (title !== undefined && title !== null && typeof title !== 'string') return { error: 'title must be a string' };
  if (kind !== undefined && kind !== null && !isPinKind(kind)) return { error: `kind must be one of: ${PIN_KINDS.join(', ')}` };
  const derived = classifyPinUrl(trimmed);
  const t = typeof title === 'string' && title.trim() ? title.trim().slice(0, MAX_TITLE) : derived.title;
  return { url: trimmed, title: t, kind: isPinKind(kind) ? kind : derived.kind };
}

function newPinId(now: number): string {
  return `pin-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Add or update (same url) a pin. Returns the new list and the pin, or an error at the cap. */
export function upsertPin(
  list: readonly Pin[] | undefined,
  input: { url: string; title: string; kind: PinKind },
  now = Date.now(),
): { pins: Pin[]; pin: Pin } | { error: string } {
  const pins = [...(list ?? [])];
  const i = pins.findIndex(p => p.url === input.url);
  if (i >= 0) {
    const pin = { ...pins[i], title: input.title, kind: input.kind };
    pins[i] = pin;
    return { pins, pin };
  }
  if (pins.length >= MAX_PINS) return { error: `at most ${MAX_PINS} pins` };
  const pin: Pin = { id: newPinId(now), url: input.url, title: input.title, kind: input.kind, createdAt: now };
  pins.push(pin);
  return { pins, pin };
}

export function removePin(list: readonly Pin[] | undefined, pinId: string): Pin[] | undefined {
  const pins = list ?? [];
  const next = pins.filter(p => p.id !== pinId);
  return next.length === pins.length ? undefined : next;
}

/** Load-time sanitizer for pins read from disk. */
export function sanitizePins(v: unknown): Pin[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((p): p is Pin =>
    !!p && typeof p === 'object'
    && typeof (p as Pin).id === 'string' && typeof (p as Pin).url === 'string'
    && typeof (p as Pin).title === 'string' && isPinKind((p as Pin).kind)
    && typeof (p as Pin).createdAt === 'number');
  return out.length ? out : undefined;
}
