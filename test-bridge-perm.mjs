#!/usr/bin/env node
/**
 * Diagnostic test for bridge session permission mode detection.
 */

const BASE = 'http://localhost:3000';

const BRIDGE_PERM_MODE_PATTERNS = [
  { pattern: /bypass permissions on/i, mode: 'bypassPermissions' },
  { pattern: /accept edits on/i,       mode: 'acceptEdits' },
  { pattern: /plan mode on/i,          mode: 'plan' },
];

// Uses "(shift+tab to cycle)" as sentinel — same as server-side detection
function detectModeFromTail(tail) {
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!/\(shift\+tab to cycle\)/i.test(line)) continue;
    for (const { pattern, mode } of BRIDGE_PERM_MODE_PATTERNS) {
      if (pattern.test(line)) return mode;
    }
    return 'default';
  }
  return undefined;
}

// ── 1. Unit tests ────────────────────────────────────────────────────────────
const unitTests = [
  { name: 'bypass in tail',            tail: 'content\n>> bypass permissions on (shift+tab to cycle)\n',  expected: 'bypassPermissions' },
  { name: 'acceptEdits in tail',       tail: 'content\n>> accept edits on (shift+tab to cycle)\n',        expected: 'acceptEdits' },
  { name: 'default mode (no keyword)', tail: 'content\n>> (shift+tab to cycle)\n',                        expected: 'default' },
  { name: 'old bypass + new default',  tail: '>> bypass permissions on (shift+tab to cycle)\ncontent\n>> (shift+tab to cycle)\n', expected: 'default' },
  { name: 'old default + new bypass',  tail: '>> (shift+tab to cycle)\ncontent\n>> bypass permissions on (shift+tab to cycle)\n', expected: 'bypassPermissions' },
  { name: 'no status bar at all',      tail: 'just some output without sentinel',                          expected: undefined },
  { name: 'false >> in content',       tail: 'no >> status bar appears in output\n>> bypass permissions on (shift+tab to cycle)', expected: 'bypassPermissions' },
  { name: 'false >> only (no cycle)',  tail: 'no >> status bar appears\nmore content with >>',             expected: undefined },
];

console.log('── Unit Tests ──────────────────────────────────────────');
let pass = 0, fail = 0;
for (const t of unitTests) {
  const result = detectModeFromTail(t.tail);
  const ok = result === t.expected;
  console.log(`  ${ok ? '✓' : '✗'} ${t.name}: got=${JSON.stringify(result)} want=${JSON.stringify(t.expected)}`);
  if (ok) pass++; else fail++;
}
console.log(`  ${pass}/${unitTests.length} passed\n`);

// ── 2. Live bridge session state ─────────────────────────────────────────────
console.log('── Live Bridge Sessions ────────────────────────────────');

let debugState;
try {
  const r = await fetch(`${BASE}/api/debug/state`);
  debugState = await r.json();
} catch (e) {
  console.error('  Cannot reach server:', e.message);
  process.exit(1);
}

const sessions = debugState.sessions ?? [];
const bridgeConnected = debugState.bridgeConnected ?? [];
const bridgeSessions = sessions.filter(s => s.sessionType === 'bridge');
console.log(`  ${bridgeSessions.length} bridge session(s)\n`);

for (const s of bridgeSessions) {
  const sid = s.sessionId;
  const shortId = sid.slice(0, 8);
  const connInfo = bridgeConnected.find(b => b.id === shortId);

  let screenText = '';
  try {
    const r = await fetch(`${BASE}/api/sessions/${sid}/screen`);
    const j = await r.json();
    screenText = j.text ?? '';
  } catch { /* ignore */ }

  const detectedMode = detectModeFromTail(screenText);
  const hasSentinel = /\(shift\+tab to cycle\)/i.test(screenText);

  console.log(`  ${s.name || shortId} (${shortId})`);
  console.log(`    state:          ${s.state}`);
  console.log(`    permissionMode: ${s.permissionMode ?? '(unset)'}`);
  console.log(`    locked:         ${s.permissionModeLockedUntil > Date.now() ? 'yes (until ' + new Date(s.permissionModeLockedUntil).toISOString() + ')' : 'no'}`);
  console.log(`    connected:      ${connInfo?.connected ?? 'unknown'}`);
  console.log(`    screenText len: ${screenText.length}`);
  console.log(`    has sentinel:   ${hasSentinel}`);
  console.log(`    detectedMode:   ${JSON.stringify(detectedMode)}`);
  if (hasSentinel) {
    const statusLine = screenText.split('\n').filter(l => /\(shift\+tab to cycle\)/i.test(l)).pop();
    console.log(`    status bar:     ${JSON.stringify(statusLine)}`);
  }
  console.log('');
}
