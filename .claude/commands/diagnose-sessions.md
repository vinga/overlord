# Diagnose Session Issues

Run all session diagnostic checks automatically and produce a summary report. Diagnoses: missing sessions, ghost sessions, stuck states, orphaned transcripts, /clear detection failures, PTY linking issues, duplicate sessions, and PID mismatches.

**This is an automated skill. Run every check below without asking, then produce the summary table at the end.**

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

## Step 7 — Check PTY State (Indirect)

The debug endpoint does not expose the PTY map or `wsSessionMap` directly. To check PTY state indirectly:

```bash
tasklist /FO CSV /NH | grep -i node
```

Cross-reference node processes with tracked PIDs. Look for:
- Sessions in `wsSessionMap` that don't exist in `stateManager` -> linking failed
- PTY sessions with no corresponding session file -> leaked PTY

If deeper PTY diagnostics are needed, suggest adding a temporary debug log to `packages/server/src/ptyManager.ts`.

---

## Step 8 — Summary Report

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

---

## Known Issues & Patterns

### IntelliJ /clear doesn't update session file
When `/clear` is run in an IntelliJ terminal, the session file (named by PID) sometimes doesn't update its `sessionId` field, and no new transcript file appears. The process stays alive. Overlord continues tracking the old session with stale data. **Detection approach:** if a session's transcript stopped being updated >5min ago and the process is alive, it may be a silent /clear. **Mitigation (implemented):** `refreshTranscript()` now tracks a `staleCount` — consecutive polls where `lastActivity` hasn't changed for `working`/`thinking` sessions. After 3 stale checks (~9 seconds), it re-reads the session file to check if the sessionId changed. If it did, the full replacement flow fires (markClosed → session:replaced → transferSessionIdentity).

### `overlord-resume` hides sessions with dead successors (FIXED)
`transferSessionIdentity()` sets `launchMethod = 'overlord-resume'` on old sessions after `/clear` detection. `getSnapshot()` was filtering ALL `overlord-resume` sessions, even when their successor had died or been closed. This caused old/closed sessions to vanish from the UI after a server restart when the successor was no longer alive. **Fix:** only hide `overlord-resume` sessions when their successor session is still alive (not closed).

### Server restart kills Claude sessions (FIXED)
The `restart-server.md` command previously ran `Get-Process -Name 'node' | Stop-Process` which killed ALL node processes including active Claude sessions. **Fix:** the restart command now only kills processes that are listening on ports 3000 and 5173, leaving Claude sessions untouched.

### IDE session PID guard (IMPLEMENTED)
`updateAlivePids()` now checks the transcript file mtime before closing IDE-launched sessions. If the transcript was written to within 60 seconds, the session stays alive even if the wrapper PID is dead. This mitigates the IntelliJ wrapper PID mismatch where the shell wrapper exits but Claude keeps running.

### Dormitory feature removed
Previously, sessions could be placed in a "dormitory" (stored in localStorage) which made them invisible in the main office UI. This was a common cause of "missing sessions" — the session existed in server state but was filtered out client-side by the dormitory filter. The dormitory feature has been completely removed, eliminating this source of confusion.

### Duplicate sessions from transcript loading
On server restart, `loadClosedSessionsFromTranscripts()` scans `.jsonl` files and creates closed sessions. If the same session is also in `known-sessions.json`, and the dedup check fails (e.g., one loaded with slightly different metadata), duplicates appear.

### PTY sessions not linking
When a PTY is spawned from the Overlord UI, a temporary `pty-xxx` ID is created. It links to the real Claude session when the session file appears with the matching PID. If the PTY dies before linking, the `pendingPtyByPid` entry leaks.

### IDE wrapper PID mismatch
IntelliJ launches Claude through a shell wrapper. The PID in the session file is the wrapper, not the node process. When the wrapper dies (e.g., terminal tab closed), `processChecker` marks the session closed even though the Claude process may still be running. The 30-second grace period and transcript-mtime check (for IDE sessions) help mitigate this.

### ConPTY PID mismatch breaks PTY linking on Windows (FIXED)
On Windows, `node-pty` spawns processes through ConPTY, which creates a wrapper process. The PID reported by `node-pty` (`pid-ready` event) is the ConPTY wrapper PID, NOT the actual `claude.exe` PID. Claude writes its own PID to the session file (`~/.claude/sessions/{pid}.json`). Since the PIDs differ, the PID-based linking in `pendingPtyByPid` never matches, and the PTY session fails to link to the real Claude session.

**Symptoms:**
- PTY terminal shows garbled output (minified JS, stack traces)
- `ptyToClaudeId` / `claudeToPtyId` maps are empty after resume
- Session appears as `launch: ide` instead of `overlord-pty`
- Phantom closed sessions with `launch: overlord-pty` appear

**Fix (implemented):** Instead of PID-based linking, a `pendingPtyByResumeId` map tracks which PTY session is waiting for a resume. When the `terminal:resume` handler spawns Claude, it stores `{ ptySessionId, ws, timestamp }` keyed by the resume session ID. When the new session appears via session watcher (with `resumedFrom` set by `pendingResumes` in `addOrUpdate`), the linking code matches `resumedFrom` against `pendingPtyByResumeId` and links the PTY to the NEW session ID. This completely bypasses PID matching for resumes.

**Key insight:** `claude --resume <id>` creates a NEW session ID (it does NOT reuse the old one). The initial approach of pre-linking to the old session ID was wrong — the client would listen on the old ID while output arrived on the new ID.

**Cleanup:** Stale `pendingPtyByResumeId` entries are cleaned up in the 60-second periodic interval (entries older than 60s or with dead PTY) and on PTY exit events.

**Remaining risk:** For `terminal:spawn` (new sessions), PID-based linking is still the primary mechanism. If ConPTY wrapper PID ≠ claude PID, new PTY sessions may also fail to link. A similar `pendingPtyByCwd` approach could be used (match by CWD + timing).

### Quick Symptom Reference

| Symptom | Most Likely Cause | Where to Check |
|---|---|---|
| Session visible in files, missing from UI | Server lost watcher event | Step 3 cross-reference |
| Session stuck as `idle` but process alive | PID check failed; process restarted with new PID | Step 4 PID check |
| Session stuck as `working` forever | Transcript not updating; file watcher stalled | Step 6 transcript freshness |
| New session appeared after `/clear` | `/clear` creates a new sessionId | Step 5 orphan check |
| Duplicate sessions in UI | Two `.json` files with same `cwd`, or dedup failure on restart | Step 2 file list |
| PTY terminal not connecting | wsSessionMap / PTY link failed | Step 7 PTY state |
| Ghost session in server, no file | Session file deleted; server not notified | Step 3 cross-reference |
| Old/closed sessions missing from UI after restart | `overlord-resume` filter hiding sessions with dead successors | Step 3 cross-reference + check `launchMethod` |
| PTY terminal shows garbled output after resume | ConPTY PID mismatch — PTY linked to wrong session or not linked at all | Check `ptyToClaudeId`/`claudeToPtyId` maps in debug endpoint |