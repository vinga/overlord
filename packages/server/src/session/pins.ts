import type { Pin, PinKind } from '../types.js';

export const PIN_KINDS: readonly PinKind[] = ['ticket', 'pr', 'branch', 'link', 'text', 'todo'];
export const MAX_PINS = 30;
/** TODO pins have their own cap, apart from links. */
export const MAX_TODOS = 50;
export const MAX_TODO_TEXT = 300;
export const MAX_TEXT = 2000;
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

/** Jira issue key a ticket pin points at (`/browse/KEY-N` or `?selectedIssue=`), else undefined. */
export function jiraKeyOfPin(pin: Pin): string | undefined {
  if (pin.kind !== 'ticket') return undefined;
  let u: URL;
  try { u = new URL(pin.url); } catch { return undefined; }
  const m = u.pathname.match(/\/browse\/([A-Z][A-Z0-9_]*-\d+)/);
  if (m) return m[1];
  const sel = u.searchParams.get('selectedIssue');
  return sel && /^[A-Z][A-Z0-9_]*-\d+$/.test(sel) ? sel : undefined;
}

/** `owner/repo#N` of a PR pin (`github.com/o/r/pull/N`), else undefined. */
export function prRefOfPin(pin: Pin): string | undefined {
  if (pin.kind !== 'pr') return undefined;
  const m = pin.url.match(/^https?:\/\/github\.com\/([^/?#]+\/[^/?#]+)\/pull\/(\d+)/i);
  return m ? `${m[1]}#${m[2]}` : undefined;
}

/** Ticket keys the user pinned: ticket pins first, then the legacy
 *  `jiraKeysPinned` (inline `+` from before pins existed). Feeds mergeJiraKeys. */
export function pinnedJiraKeys(rec: { pins?: Pin[]; jiraKeysPinned?: string[] } | undefined): string[] | undefined {
  const out: string[] = [];
  for (const p of rec?.pins ?? []) { const k = jiraKeyOfPin(p); if (k && !out.includes(k)) out.push(k); }
  for (const k of rec?.jiraKeysPinned ?? []) if (!out.includes(k)) out.push(k);
  return out.length ? out : undefined;
}

/** PR refs the user pinned: PR pins first, then the legacy `prRefsPinned`. Feeds mergePrRefs. */
export function pinnedPrRefs(rec: { pins?: Pin[]; prRefsPinned?: string[] } | undefined): string[] | undefined {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (r: string) => { const k = r.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(r); } };
  for (const p of rec?.pins ?? []) { const r = prRefOfPin(p); if (r) add(r); }
  for (const r of rec?.prRefsPinned ?? []) add(r);
  return out.length ? out : undefined;
}

/** Pins with that Jira key (ticket) or PR ref (case-insensitive) removed;
 *  undefined when nothing matched. */
export function withoutPinsFor(
  list: readonly Pin[] | undefined,
  match: { jiraKey?: string; prRef?: string },
): Pin[] | undefined {
  const pr = match.prRef?.toLowerCase();
  const next = (list ?? []).filter(p => !(
    (match.jiraKey && jiraKeyOfPin(p) === match.jiraKey)
    || (pr && prRefOfPin(p)?.toLowerCase() === pr)
  ));
  return next.length === (list ?? []).length ? undefined : next;
}

/** Move the pin with `url` to the front, adding it when missing. */
export function frontPin(
  list: readonly Pin[] | undefined,
  input: { url: string; title: string; kind: PinKind; text?: string },
  now = Date.now(),
): Pin[] {
  const pins = [...(list ?? [])];
  const i = pins.findIndex(p => p.url === input.url);
  const pin = i >= 0 ? pins.splice(i, 1)[0] : { id: newPinId(now), ...input, createdAt: now };
  return [pin, ...pins].slice(0, MAX_PINS);
}

export interface PinInput { url: unknown; title?: unknown; kind?: unknown; text?: unknown; owner?: unknown }
export type TodoOwner = 'user' | 'agent';
export const isTodoOwner = (v: unknown): v is TodoOwner => v === 'user' || v === 'agent';

type ValidPin = { url: string; title: string; kind: PinKind; text?: string; owner?: TodoOwner };

/** Validate raw input; returns the normalized fields or an error string.
 *  `kind: 'text'` pins a piece of text instead of a URL (url becomes ''). */
export function validatePinInput(input: PinInput): ValidPin | { error: string } {
  const { url, title, kind, text, owner } = input;
  if (kind === 'todo') {
    if (typeof text !== 'string' || !text.trim()) return { error: 'text required' };
    const t = text.trim().replace(/\s*\n\s*/g, ' ');
    if (t.length > MAX_TODO_TEXT) return { error: `text longer than ${MAX_TODO_TEXT}` };
    if (t.includes('\0')) return { error: 'text must not contain NUL' };
    if (owner !== undefined && owner !== null && !isTodoOwner(owner)) return { error: 'owner must be user or agent' };
    return { url: '', title: t.slice(0, MAX_TITLE), kind: 'todo', text: t, owner: owner === 'agent' ? 'agent' : 'user' };
  }
  if (kind === 'text') {
    if (typeof text !== 'string' || !text.trim()) return { error: 'text required' };
    const t = text.trim();
    if (t.length > MAX_TEXT) return { error: `text longer than ${MAX_TEXT}` };
    if (t.includes('\0')) return { error: 'text must not contain NUL' };
    const firstLine = t.split('\n').map(l => l.trim()).find(Boolean) ?? t;
    return { url: '', title: firstLine.slice(0, MAX_TITLE), kind: 'text', text: t };
  }
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
  input: ValidPin,
  now = Date.now(),
): { pins: Pin[]; pin: Pin } | { error: string } {
  const pins = [...(list ?? [])];
  // Text and TODO pins are the same pin when kind and text match; link pins when the url does.
  const byText = input.kind === 'text' || input.kind === 'todo';
  const i = byText
    ? pins.findIndex(p => p.kind === input.kind && p.text === input.text)
    : pins.findIndex(p => p.kind !== 'text' && p.kind !== 'todo' && p.url === input.url);
  if (i >= 0) {
    const pin = { ...pins[i], title: input.title, kind: input.kind };
    pins[i] = pin;
    return { pins, pin };
  }
  const isTodo = (p: { kind: PinKind }) => p.kind === 'todo';
  if (isTodo(input)) {
    if (pins.filter(isTodo).length >= MAX_TODOS) return { error: `at most ${MAX_TODOS} TODOs` };
  } else if (pins.filter(p => !isTodo(p)).length >= MAX_PINS) return { error: `at most ${MAX_PINS} pins` };
  const pin: Pin = { id: newPinId(now), url: input.url, title: input.title, kind: input.kind, createdAt: now };
  if (byText) pin.text = input.text;
  if (input.kind === 'todo' && input.owner === 'agent') pin.owner = 'agent';
  pins.push(pin);
  return { pins, pin };
}

/** Check or uncheck a TODO pin. undefined when no TODO has that id. */
export function setPinDone(
  list: readonly Pin[] | undefined,
  pinId: string,
  done: boolean,
  by: 'user' | 'agent' = 'user',
  now = Date.now(),
): { pins: Pin[]; pin: Pin } | undefined {
  const pins = [...(list ?? [])];
  const i = pins.findIndex(p => p.id === pinId && p.kind === 'todo');
  if (i < 0) return undefined;
  const { done: _d, doneAt: _a, doneBy: _b, ...rest } = pins[i];
  const pin: Pin = done ? { ...rest, done: true, doneAt: now, doneBy: by } : rest;
  pins[i] = pin;
  return { pins, pin };
}

/** Hand a TODO pin to the user or the agent. undefined when no TODO has that id. */
export function setPinOwner(
  list: readonly Pin[] | undefined,
  pinId: string,
  owner: TodoOwner,
): { pins: Pin[]; pin: Pin } | undefined {
  const pins = [...(list ?? [])];
  const i = pins.findIndex(p => p.id === pinId && p.kind === 'todo');
  if (i < 0) return undefined;
  const { owner: _o, ...rest } = pins[i];
  const pin: Pin = owner === 'agent' ? { ...rest, owner } : rest;
  pins[i] = pin;
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
    && typeof (p as Pin).createdAt === 'number'
    && (((p as Pin).kind !== 'text' && (p as Pin).kind !== 'todo') || typeof (p as Pin).text === 'string'))
    .map(p => (p.owner === undefined || p.owner === 'agent' ? p : (({ owner: _o, ...rest }) => rest)(p)));
  return out.length ? out : undefined;
}
