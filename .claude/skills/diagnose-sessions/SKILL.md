# Diagnose Session Issues

Run all session diagnostic checks automatically and produce a summary report. Diagnoses: missing sessions, ghost sessions, stuck states, orphaned transcripts, /clear detection failures, PTY linking issues, duplicate sessions, and PID mismatches.

**This is an automated skill. Run every check below without asking, then produce the summary table at the end.**

> For architecture details, known issues, and the quick symptom reference, see `reference.md` in this directory.

---

## Step 1 — Gather Server State

Hit the debug endpoint and capture the full state:

```bash
curl -s http://localhost:3000/api/debug/state
```

If the server is not running, note it and skip server-dependent checks.

Also capture the live WebSocket snapshot to compare what clients actually see:

```bash
cd C:/projekty/overlord && node -e "
const ws = require('ws');
const client = new ws('ws://localhost:3000');
client.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.type === 'snapshot') {
    console.log(JSON.stringify(msg, null, 2));
    client.close();
    process.exit(0);
  }
});
setTimeout(() => { console.log('TIMEOUT - no snapshot received'); process.exit(1); }, 5000);
"
```

Compare the debug endpoint sessions with the WebSocket snapshot sessions. They should match. Differences indicate a broadcast bug.

---

## Step 2 — Enumerate Session Files on Disk

```bash
node -e "
const fs = require('fs');
const path = require('path');
const home = require('os').homedir();
const sessDir = path.join(home, '.claude', 'sessions');
const fileIds = new Map();
for (const f of fs.readdirSync(sessDir).filter(f => f.endsWith('.json'))) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8'));
    fileIds.set(d.sessionId, { pid: d.pid, file: f, cwd: d.cwd || d.workingDirectory });
  } catch {}
}
console.log('Session files on disk:', fileIds.size);
for (const [sid, info] of fileIds) {
  console.log('  ', sid.slice(0,8), '| pid:', info.pid, '| file:', info.file, '| cwd:', info.cwd);
}
"
```

---

## Step 3 — Cross-Reference Session Files vs Server State

Compare session files on disk with what the server tracks. Report:
- **In files but NOT in server** -> server lost track (watcher missed event, or session created before server start)
- **In server but NOT in files** -> phantom/ghost session (loaded from transcript or known-sessions.json, or file deleted without notification)
- **In both** -> healthy

---

## Step 4 — Check Process Liveness

For each tracked session, verify the PID is alive:

```bash
node -e "
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const home = require('os').homedir();
const sessDir = path.join(home, '.claude', 'sessions');
for (const f of fs.readdirSync(sessDir).filter(f => f.endsWith('.json'))) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8'));
    const pid = d.pid;
    if (!pid) continue;
    let alive = false;
    try {
      const out = execSync('tasklist /FI \"PID eq ' + pid + '\" /FO CSV /NH', { encoding: 'utf8', timeout: 5000 });
      alive = out.includes(String(pid));
    } catch {}
    console.log('PID', pid, '|', d.sessionId.slice(0,8), '| alive:', alive);
  } catch {}
}
"
```

**Red flags:**
- PID dead but session shows as working/thinking/waiting -> processChecker failed or 30s grace period active
- PID alive but session shows as closed/idle -> PID mismatch (common with IntelliJ wrapper processes)
- Session is `idle` when process is clearly alive -> PID check failed or process restarted with new PID

---

## Step 5 — Find /clear Artifacts (Orphaned Transcripts)

```bash
node -e "
const fs = require('fs');
const path = require('path');
const home = require('os').homedir();
const sessDir = path.join(home, '.claude', 'sessions');
const sessionIds = new Set();
for (const f of fs.readdirSync(sessDir).filter(f => f.endsWith('.json'))) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8'));
    if (d.sessionId) sessionIds.add(d.sessionId);
  } catch {}
}
const projDir = path.join(home, '.claude', 'projects');
let orphanCount = 0;
for (const slug of fs.readdirSync(projDir).filter(d => fs.statSync(path.join(projDir, d)).isDirectory())) {
  const dir = path.join(projDir, slug);
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))) {
    const sid = f.replace('.jsonl', '');
    if (!sessionIds.has(sid)) {
      const stat = fs.statSync(path.join(dir, f));
      const age = (Date.now() - stat.mtimeMs) / 60000;
      if (age < 120) {
        orphanCount++;
        console.log('ORPHAN:', sid.slice(0,8), '| age:', age.toFixed(1) + 'm | size:', stat.size, '| slug:', slug.slice(0,30));
      }
    }
  }
}
if (orphanCount === 0) console.log('No recent orphaned transcripts found.');
"
```

**What orphans mean:**
- Transcript with no matching session file -> created before `/clear` (the OLD conversation)
- If a new transcript appeared at roughly the same time -> `/clear` happened, detection may have worked
- If NO new transcript appeared -> `/clear` didn't create a new session properly (IDE session issue)

---

## Step 6 — Check Transcript Freshness

For every active (non-closed) session, check if its transcript is being updated:

```bash
node -e "
const fs = require('fs');
const path = require('path');
const home = require('os').homedir();
const projDir = path.join(home, '.claude', 'projects');
const http = require('http');
http.get('http://localhost:3000/api/debug/state', (res) => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    const state = JSON.parse(data);
    for (const s of state.sessions) {
      if (s.state === 'closed') continue;
      const slugDirs = fs.readdirSync(projDir).filter(d => fs.statSync(path.join(projDir, d)).isDirectory());
      for (const slug of slugDirs) {
        const tp = path.join(projDir, slug, s.sessionId + '.jsonl');
        if (fs.existsSync(tp)) {
          const stat = fs.statSync(tp);
          const age = (Date.now() - stat.mtimeMs) / 60000;
          const flag = age > 5 && s.state !== 'waiting' ? ' STALE' : '';
          console.log(s.sessionId.slice(0,8), '|', s.state, '| transcript age:', age.toFixed(1) + 'm' + flag);
        }
      }
    }
  });
}).on('error', () => console.log('Server not reachable, skipping transcript freshness check.'));
"
```

**Red flags:**
- Session is `working` or `thinking` but transcript hasn't been modified in >5 minutes -> stale state, likely /clear happened
- Session is `waiting` but transcript is very old -> normal (waiting for user input)

---

## Step 7 — Read Console Screen Buffer

For non-PTY sessions, read the actual console screen content via the screen-read endpoint. This shows what the user would see in the terminal — including permission prompts, TUI state, and tool output that may NOT appear in the transcript.

```bash
# Read console screen for a specific session
curl -s http://localhost:3000/api/sessions/SESSION_ID/screen | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).text))"
```

**Use this to:**
- Verify permission prompt text matches what `permissionChecker` detected
- See post-interrupt state (after sending Escape via inject endpoint)
- Debug sessions stuck in `working` state — the console may show an error or prompt not captured by transcript
- Compare console output with transcript to find discrepancies

**How it works:** Uses `readScreen(pid)` from `consoleInjector.ts` which reads the Windows console screen buffer via a persistent PowerShell daemon (`inject.ps1`). Same mechanism used by `permissionChecker.ts`. Only works on Windows.

**Endpoint:** `GET /api/sessions/:sessionId/screen` -> `{ text: string }` (returns 400 if closed, 404 if not found)

---

## Step 8 — Check PTY State (Indirect)

The debug endpoint does not expose the PTY map or `wsSessionMap` directly. To check PTY state indirectly:

```bash
tasklist /FO CSV /NH | grep -i node
```

Cross-reference node processes with tracked PIDs. Look for:
- Sessions in `wsSessionMap` that don't exist in `stateManager` -> linking failed
- PTY sessions with no corresponding session file -> leaked PTY

If deeper PTY diagnostics are needed, suggest adding a temporary debug log to `packages/server/src/pty/ptyManager.ts`.

---

## Step 9 — Summary Report

After running all checks, produce this summary table:

| Check | Status | Details |
|-------|--------|---------|
| Server running | pass/fail | |
| WebSocket snapshot matches debug state | pass/fail/skipped | |
| Sessions tracked (server) | N | |
| Session files on disk | N | |
| File-Server mismatches | N | list any |
| Dead PIDs (non-closed sessions) | N | list any |
| Orphaned transcripts (<2h old) | N | list any |
| Stale transcripts (active but >5m old) | N | list any |
| /clear detection failures | N | session file unchanged but transcript stale |
| Suspected PTY leaks | N | list any |