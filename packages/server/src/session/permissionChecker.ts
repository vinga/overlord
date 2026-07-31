import * as os from 'os';
import { detectModeFromText, SHIFT_TAB_SENTINEL } from './modeDetect.js';
import type { PendingQuestionSet } from '../types.js';

// Only active on Windows
const IS_WINDOWS = process.platform === 'win32';

// A real Claude permission dialog always has "do you want to ..."
// AND at least one of the secondary signals. Requiring co-occurrence eliminates
// false positives from slow tool runs, other TUI menus, or Claude's generated text.
const PRIMARY_PATTERN   = /do you want to/i;
const SECONDARY_PATTERNS = [
  /esc to cancel/i,
  /yes,? (?:and )?allow .* (?:during|for) this session/i,
  /don'?t ask again/i,          // newer permission format: "Yes, and don't ask again for X"
  /\(esc\)/i,                    // newer format puts "(esc)" at end of option 3
  /^\s*\d\.\s+yes\b/im,         // numbered option list starting with "1. Yes"
];

function looksLikePermissionPrompt(text: string): boolean {
  return PRIMARY_PATTERN.test(text) &&
         SECONDARY_PATTERNS.some(p => p.test(text));
}

function extractPromptBlock(text: string): string {
  const lines = text.split('\n');
  let lastNonEmpty = lines.length - 1;
  while (lastNonEmpty > 0 && lines[lastNonEmpty].trim() === '') lastNonEmpty--;
  const start = Math.max(0, lastNonEmpty - 14);
  return lines.slice(start, lastNonEmpty + 1).join('\n');
}

function cleanText(text: string): string {
  return text
    .split('\n')
    .map(line => line.replace(/[^\x20-\x7E]/g, '').trimEnd())
    .filter((line, i, arr) => {
      // Remove runs of empty lines (keep at most one blank between content)
      if (line === '' && i > 0 && arr[i - 1] === '') return false;
      return true;
    })
    .join('\n')
    .trim();
}

// AskUserQuestion interactive menu. Footer triad is its signature; it is NOT a
// permission prompt ("do you want to"), and shows even in bypassPermissions mode.
const ASK_FOOTER = [/enter to select/i, /to navigate/i, /esc to cancel/i];
// Built-in trailing options the AskUserQuestion TUI appends after the real choices.
const ASK_BUILTIN_OPTION = /^(type something|chat about this|let me (?:type|answer)|none of the above)\b/i;

// A menu taller than the viewport scrolls: the TUI drops the footer and shows a
// "Jump to bottom" rule instead. These three survive that clipping and are what a
// scrolled menu is recognised by.
const ASK_HEADER_CHIP = /^[ \t]*☐[ \t]+\S/m;             // ` ☐ FRUIT ` header chip
const ASK_OPTION_CARET = /^[ \t]*❯[ \t]*\d+\.[ \t]+\S/m; // arrow-selected numbered row
const ASK_BUILTIN_ROW = /^[ \t]*\d+\.[ \t]+(?:type something|chat about this)\b/im;
const ASK_JUMP_TO_BOTTOM = /jump to bottom/i;
const ASK_OPTION_LINE = /^\s*\d+\.\s+\S/m;

// Any evidence that an AskUserQuestion menu is on screen, footer or not. Used both
// to detect the menu and — inverted — to refuse to declare a question dead while
// one of these is still visible.
function hasAskUserQuestionMarkers(text: string): boolean {
  if (!ASK_OPTION_LINE.test(text)) return false;
  return ASK_HEADER_CHIP.test(text) || ASK_OPTION_CARET.test(text) || ASK_BUILTIN_ROW.test(text);
}

function looksLikeAskUserQuestion(text: string): boolean {
  if (PRIMARY_PATTERN.test(text)) return false;          // it's a permission prompt
  // Require at least one numbered option line so a bare footer echo doesn't trigger.
  if (!ASK_OPTION_LINE.test(text)) return false;
  if (ASK_FOOTER.every(p => p.test(text))) return true;  // the ordinary, fully-visible menu
  // Clipped menu. The chip alone is too weak (other TUI pickers use numbered rows),
  // so demand a second AskUserQuestion-only marker.
  return ASK_HEADER_CHIP.test(text)
    && (ASK_BUILTIN_ROW.test(text) || ASK_OPTION_CARET.test(text) || ASK_JUMP_TO_BOTTOM.test(text));
}

// The TUI marks every assistant turn (text or tool call) with this bullet, then
// indents continuation lines by two spaces. `⏺` is the bullet; the separator
// after it is sometimes a NBSP.
const TUI_BULLET = /^⏺[\s\u00a0]*/;
// The question box opens with a full-width rule.
const BOX_RULE = /^─{20,}\s*$/;
// A bullet line that is a tool call, not prose: `Bash(...)`, `Read(...)`, `Task(…)`.
const TOOL_CALL_BULLET = /^[A-Z][A-Za-z0-9_]*\(/;
const MAX_PREAMBLE = 2000;

// The assistant text sitting between the previous turn and the question box. Walks
// back from the box rule to the nearest bullet, refusing to cross the user's own
// prompt (`❯`) or an earlier rule — either means there is no preamble for THIS
// question and we would otherwise attribute an older message to it.
function extractPreamble(rawLines: string[], questionIdx: number): string | undefined {
  let ruleIdx = -1;
  for (let i = questionIdx; i >= 0; i--) {
    if (BOX_RULE.test(rawLines[i].trimEnd())) { ruleIdx = i; break; }
  }
  if (ruleIdx <= 0) return undefined;
  let bulletIdx = -1;
  for (let i = ruleIdx - 1; i >= 0; i--) {
    const line = rawLines[i];
    if (TUI_BULLET.test(line)) { bulletIdx = i; break; }
    const trimmed = line.trim();
    // `❯` is the prompt caret, `╰`/`╭` the welcome-box corners. Deliberately NOT
    // `│`: the assistant's own markdown tables render with it, and bailing there
    // would drop the preamble of any message that contains one. Reaching the
    // welcome box without passing a bullet means there is no preamble anyway.
    if (BOX_RULE.test(line.trimEnd()) || /^[❯╰╭]/.test(trimmed)) return undefined;
  }
  if (bulletIdx < 0) return undefined;
  const body = rawLines.slice(bulletIdx, ruleIdx).map((l, i) => (
    i === 0 ? l.replace(TUI_BULLET, '') : l.replace(/^ {1,2}/, '')
  ).replace(/\u00a0/g, ' ').trimEnd());
  // A tool call or its `⎿` result is not prose — don't pass it off as the preamble.
  if (TOOL_CALL_BULLET.test(body[0]) || body.some(l => l.trimStart().startsWith('⎿'))) return undefined;
  const out = body.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return out ? out.slice(0, MAX_PREAMBLE) : undefined;
}

// Best-effort parse of the question + ordered real option labels from the menu screen.
// Screen text is partial/space-mangled, so this is presentation only; injection relies
// on option ORDER (index), not label text.
export function parseScreenQuestion(text: string): PendingQuestionSet | null {
  const rawLines = text.split('\n');
  const lines = rawLines.map(l => l.replace(/[^\x20-\x7E]/g, '').trim());
  // End of the option list: the menu footer, or — when the menu is taller than the
  // viewport and has scrolled — the "Jump to bottom" rule that replaces it.
  let footerIdx = lines.findIndex(l => /enter to select/i.test(l));
  if (footerIdx < 0) {
    const jumpIdx = lines.findIndex(l => ASK_JUMP_TO_BOTTOM.test(l));
    // The indicator is painted over the right-hand side of whatever row is last on
    // screen, so it often shares a line with an option. Excluding that line would
    // silently drop the option.
    footerIdx = jumpIdx < 0 ? lines.length : (ASK_OPTION_LINE.test(lines[jumpIdx]) ? jumpIdx + 1 : jumpIdx);
  }
  // Start of the box: the ` ☐ HEADER ` chip. Anchoring here keeps numbered lines in
  // the assistant's own prose above the box (a "1. …" list) from being parsed as
  // options — that would shift every index and send the arrow-key injection to the
  // wrong row. Absent chip ⇒ scan from the top, as before.
  let boxIdx = 0;
  let header: string | undefined;
  for (let i = footerIdx - 1; i >= 0; i--) {
    const m = rawLines[i].match(/^[ \t]*☐[ \t]+(.*?)\s*$/);
    if (m) { boxIdx = i + 1; header = m[1].trim() || undefined; break; }
  }
  const options: { label: string; builtin?: boolean }[] = [];
  let firstOptionIdx = -1;
  for (let i = boxIdx; i < footerIdx; i++) {
    const m = lines[i].match(/^\d+\.\s+(.+)$/);
    if (m) {
      if (firstOptionIdx < 0) firstOptionIdx = i;
      // Strip the scroll indicator when it is painted onto this option's row.
      const label = m[1].replace(/\s{2,}Jump to bottom.*$/i, '').trim();
      // Keep "Type something" / "Chat about this" — they are real, selectable rows.
      // Tag them so the UI opens a free-text field instead of committing the choice.
      // They always trail the model-authored options, so option index still maps 1:1
      // to the TUI's arrow-key order.
      const builtin = ASK_BUILTIN_OPTION.test(label);
      options.push(builtin ? { label: label.slice(0, 120), builtin: true } : { label: label.slice(0, 120) });
    }
  }
  // Question text: the last non-empty line(s) above the first option.
  let question = '';
  let questionIdx = firstOptionIdx < 0 ? footerIdx : firstOptionIdx;
  for (let i = questionIdx - 1; i >= boxIdx; i--) {
    if (lines[i]) { question = lines[i]; questionIdx = i; break; }
  }
  if (!question && options.length === 0) return null;
  const preamble = extractPreamble(rawLines, questionIdx);
  return {
    questions: [{ question: question.slice(0, 300), header, multiSelect: false, options }],
    ...(preamble ? { preamble } : {}),
  };
}

/** Detection predicates, exported for tests only. */
export const __testing = { looksLikeAskUserQuestion, hasAskUserQuestionMarkers };

// Rate-limit prompt: Claude CLI blocks on Enter when the usage limit is hit
const RATE_LIMIT_PATTERN = /you'?ve hit your limit/i;

// Detect permission mode from the CLI status bar text.
// Returns a mode id (known or custom) when a status-bar keyword is present; undefined otherwise.
function detectPermissionMode(text: string): string | undefined {
  const { sentinelFound, mode } = detectModeFromText(text);
  if (!sentinelFound) return undefined;
  // 'default' means sentinel present but no keyword — caller needs to distinguish this
  // from "no status bar" and reset accordingly. Keep the undefined semantics here.
  return mode === 'default' ? undefined : mode;
}

export interface PermissionCheckable {
  getAllSessionIds(): string[];
  getSession(id: string): { pid: number; state: string; permissionMode?: string; permissionModeLockedUntil?: number } | undefined;
  setNeedsPermission(sessionId: string, value: boolean, promptText?: string, isLimitPrompt?: boolean): void;
  setPermissionMode(sessionId: string, mode: string | undefined): void;
  setScreenQuestion(sessionId: string, question: PendingQuestionSet | null, screenReadable?: boolean): void;
}

export function startPermissionChecker(
  stateManager: PermissionCheckable,
  getScreenText?: (sessionId: string, pid: number) => Promise<string | null>,
  injectIntoSession?: (sessionId: string, text: string) => Promise<void>,
): (() => void) | undefined {
  // On non-Windows, only proceed if a cross-platform screen reader is provided
  if (!IS_WINDOWS && !getScreenText) return undefined;

  // Lazy import to avoid loading on non-Windows
  let readScreen: ((pid: number) => Promise<string | null>) | undefined;

  if (IS_WINDOWS) {
    const load = async () => {
      const mod = await import('../pty/consoleInjector.js');
      readScreen = mod.readScreen;
    };
    load().catch(() => { /* ignore — runCycle will retry */ });
  }

  // Hysteresis: only clear needsPermission after 3 consecutive misses
  const missCount = new Map<string, number>();
  // Separate hysteresis for screen-detected AskUserQuestion prompts
  const questionMissCount = new Map<string, number>();

  let stopped = false;

  const runCycle = async () => {
    if (stopped) return;
    if (!readScreen && !getScreenText) {
      // Windows console reader not loaded yet and no custom screen reader — retry soon
      setTimeout(runCycle, 1000);
      return;
    }
    const ids = stateManager.getAllSessionIds();

    // Remove stale entries from missCount for sessions no longer tracked
    for (const id of missCount.keys()) {
      if (!ids.includes(id)) missCount.delete(id);
    }
    for (const id of questionMissCount.keys()) {
      if (!ids.includes(id)) questionMissCount.delete(id);
    }

    for (const id of ids) {
      if (stopped) break;
      const session = stateManager.getSession(id);
      if (!session) continue;
      // Only check sessions that might be stuck
      if (session.state === 'closed') continue;
      // In bypassPermissions mode, Claude never actually prompts — any screen text
      // matching the prompt pattern is stale buffer content. Skip the setNeedsPermission
      // path to avoid oscillation with stateManager clearing it on every transcript tick.
      const isBypass = session.permissionMode === 'bypassPermissions';
      try {
        const text = getScreenText
          ? await getScreenText(id, session.pid)
          : (readScreen ? await readScreen(session.pid) : null);
        const hasPrompt = text ? looksLikePermissionPrompt(text) : false;
        if (hasPrompt && !isBypass) {
          // Prompt detected: set flag and reset miss counter
          missCount.set(id, 0);
          stateManager.setNeedsPermission(id, true, cleanText(extractPromptBlock(text!)));
        } else {
          // No prompt detected from screen: do NOT clear — the transcript heuristic
          // owns clearing. Screen reader only CONFIRMS/ENHANCES, never removes.
          missCount.set(id, (missCount.get(id) ?? 0) + 1);
        }
        // Rate-limit prompt: surface it in the UI so the user can dismiss manually
        if (text && RATE_LIMIT_PATTERN.test(text) && !isBypass) {
          if (!hasPrompt) {
            // Not already flagged as a normal permission prompt — flag as limit prompt
            stateManager.setNeedsPermission(id, true, cleanText(extractPromptBlock(text)), true);
          }
        }
        // AskUserQuestion (interactive, shows even in bypass): surface the live TUI
        // question so it appears inline in the conversation. Clear after 3 misses.
        if (text && !hasPrompt && looksLikeAskUserQuestion(text)) {
          const parsed = parseScreenQuestion(text);
          if (parsed) {
            questionMissCount.set(id, 0);
            stateManager.setScreenQuestion(id, parsed);
          }
        } else {
          const misses = (questionMissCount.get(id) ?? 0) + 1;
          questionMissCount.set(id, misses);
          // `screenReadable` is the difference between "screen says no menu" (a
          // transcript-derived question is stale) and "no evidence either way"
          // (leave the question interactive). Marking a LIVE question stale is the
          // costly mistake — it makes the only way to answer it read-only — so any
          // leftover menu marker downgrades this to "can't tell", even though the
          // full-detection check above just failed on this same screen.
          const readable = text != null && !hasAskUserQuestionMarkers(text);
          if (misses >= 3) stateManager.setScreenQuestion(id, null, readable);
        }
        // Detect permission mode from status bar
        if (text) {
          const screenMode = detectPermissionMode(text);
          const currentSession = stateManager.getSession(id);
          const current = currentSession?.permissionMode;
          const locked = currentSession?.permissionModeLockedUntil !== undefined && Date.now() < currentSession.permissionModeLockedUntil;
          if (screenMode) {
            // Always call setPermissionMode when screen confirms a non-default mode —
            // even if unchanged — so the lock is refreshed every 3s cycle and the
            // transcript can never overwrite it while the mode is visible in terminal.
            stateManager.setPermissionMode(id, screenMode);
          } else if (!screenMode && current && current !== 'default' && !locked) {
            // Only reset to default when we have positive evidence: the sentinel is
            // present but no mode keyword (confirmed default). Do NOT reset when the
            // sentinel is absent — that just means the screen text is partial/stale
            // (e.g. ptyOutputBuffer cleared after a repaint, only showing tail output).
            const hasSentinel = SHIFT_TAB_SENTINEL.test(text);
            if (hasSentinel && currentSession?.state === 'waiting') {
              stateManager.setPermissionMode(id, 'default');
            }
          }
        }
      } catch (err) {
        console.log(`[permCheck] ${id.slice(0,8)} error: ${err}`);
      }
    }

    // Schedule next cycle after completion (no overlap)
    if (!stopped) setTimeout(runCycle, 3000);
  };

  // Start first cycle after initial delay
  const timer = setTimeout(runCycle, 3000);

  return () => { stopped = true; clearTimeout(timer); };
}
