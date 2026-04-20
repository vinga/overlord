// Permission mode detection from Claude CLI status bar.
//
// Status bar format (tail-anchored): "<mode text>? (shift+tab to cycle)"
// Known values:
//   "bypass permissions on" → bypassPermissions
//   "accept edits on"       → acceptEdits
//   "plan mode on"          → plan
//   (no keyword)            → default
// Any future "<word> mode on" is captured generically (e.g. "auto mode on" → "auto").

export const SHIFT_TAB_SENTINEL = /\(shift\+tab to cycle\)/i;

// Extract a mode id from a prefix that ends just before the status-bar sentinel.
// Must be anchored at end so stale earlier status-bar text in the same buffer never wins.
function matchModeAtEnd(prefix: string): string | undefined {
  // Strip trailing non-letter runs (whitespace, punctuation like '?', '.', bullets)
  // before matching. Some terminals surface "plan mode on?" or bullets between the
  // keyword and "(shift+tab to cycle)" — require letters at the tail, not exact "on".
  const tail = prefix.replace(/[^a-zA-Z]+$/, '');
  if (/bypass permissions on$/i.test(tail)) return 'bypassPermissions';
  if (/accept edits on$/i.test(tail)) return 'acceptEdits';
  const g = tail.match(/([a-z][a-z0-9_-]*)\s+mode on$/i);
  if (g) return g[1].toLowerCase();
  return undefined;
}

// Returns a mode id from a single line that already contains the status bar sentinel.
// Returns undefined when no mode keyword matches (caller maps this to 'default').
export function detectModeFromStatusLine(line: string): string | undefined {
  const re = /\(shift\+tab to cycle\)/gi;
  let lastIdx = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) lastIdx = m.index;
  if (lastIdx < 0) return undefined;
  return matchModeAtEnd(line.slice(Math.max(0, lastIdx - 200), lastIdx));
}

// Find the last status-bar sentinel in `text` and extract the mode from the text
// immediately preceding it. Anchored-at-end matching prevents stale earlier status
// bars (same line or same buffer) from winning over the current one.
// Returns:
//   { sentinelFound: false }                    — no status bar present
//   { sentinelFound: true, mode: 'default' }    — status bar with no keyword
//   { sentinelFound: true, mode: '<id>' }       — status bar with a known or custom mode
export function detectModeFromText(text: string): { sentinelFound: boolean; mode?: string } {
  const re = /\(shift\+tab to cycle\)/gi;
  let lastIdx = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) lastIdx = m.index;
  if (lastIdx < 0) return { sentinelFound: false };
  // The mode keyword must live on the SAME line as the sentinel. Without this
  // restriction, conversation content on prior lines ending in "<word> mode on\n"
  // gets pulled in when trailing whitespace is stripped, producing spurious
  // custom modes like "auto" or "plan" from chat text.
  const window = text.slice(Math.max(0, lastIdx - 200), lastIdx);
  const nl = window.lastIndexOf('\n');
  const sameLine = nl >= 0 ? window.slice(nl + 1) : window;
  const mode = matchModeAtEnd(sameLine);
  return { sentinelFound: true, mode: mode ?? 'default' };
}
