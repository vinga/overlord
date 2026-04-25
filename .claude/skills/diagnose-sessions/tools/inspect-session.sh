#!/usr/bin/env bash
# inspect-session.sh <ovrId|sessionId>
#
# Depth-first inspector for one Overlord session. Prints disk record,
# in-memory snapshot, persistent-field diff, transcript freshness,
# PID liveness, bridge / PTY wiring, recent log lines, and LIKELY:
# verdicts for common mismatch shapes.
#
# Verdicts are HINTS, not conclusions — keep reading.

set -u

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  echo "usage: inspect-session.sh <ovrId|sessionId>" >&2
  exit 2
fi

OVR_DIR="$HOME/.claude/overlord/overlord-sessions"
PROJECTS_DIR="$HOME/.claude/projects"
SHADOW_DIR="$HOME/.claude/overlord/transcripts"
SESSIONS_DIR="$HOME/.claude/sessions"
API="http://localhost:3000/api/debug/state"

bold() { printf "\n\033[1m== %s ==\033[0m\n" "$1"; }
warn() { printf "\033[33m%s\033[0m\n" "$1"; }
verdict() { printf "\033[36mLIKELY: %s\033[0m\n" "$1"; }
fail() { printf "\033[31mERROR: %s\033[0m\n" "$1"; }

# ───── 1. Resolve target ────────────────────────────────────────────
OVR=""
SID=""
if [[ "$TARGET" == ovr-* ]]; then
  OVR="$TARGET"
else
  SID="$TARGET"
  # Find the ovr file whose lineage.currentSessionId or history matches
  for f in "$OVR_DIR"/*.json "$OVR_DIR"/active/*.json "$OVR_DIR"/archive/*.json; do
    [ -f "$f" ] || continue
    if grep -q "\"$SID\"" "$f" 2>/dev/null; then
      OVR=$(basename "$f" .json)
      break
    fi
  done
fi

if [ -z "$OVR" ]; then
  fail "could not resolve $TARGET to an ovrId"
  exit 1
fi

# Locate the disk file (flat or active/ or archive/)
DISK_FILE=""
for cand in "$OVR_DIR/$OVR.json" "$OVR_DIR/active/$OVR.json" "$OVR_DIR/archive/$OVR.json"; do
  if [ -f "$cand" ]; then DISK_FILE="$cand"; break; fi
done

# ───── 2. Disk record ──────────────────────────────────────────────
bold "Disk record ($OVR)"
if [ -z "$DISK_FILE" ]; then
  warn "no disk record found for $OVR"
else
  echo "path: $DISK_FILE"
  cat "$DISK_FILE"
  if [ -z "$SID" ]; then
    SID=$(node -e "const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(d.lineage?.currentSessionId||'')" "$DISK_FILE" 2>/dev/null)
  fi
fi
DISK_TYPE=""
PIPE=""
if [ -n "$DISK_FILE" ]; then
  DISK_TYPE=$(node -e "const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(d.sessionType||'')" "$DISK_FILE" 2>/dev/null)
  PIPE=$(node -e "const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(d.bridgePipeName||'')" "$DISK_FILE" 2>/dev/null)
fi

# ───── 3. Live snapshot (server) ───────────────────────────────────
bold "Live snapshot (server /api/debug/state)"
SNAP=$(curl -s --max-time 3 "$API" 2>/dev/null || true)
if [ -z "$SNAP" ]; then
  warn "server not reachable at $API — skipping live checks"
  LIVE_JSON=""
else
  LIVE_JSON=$(node -e "
    const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const ovr=process.env.OVR;
    const matches=(d.sessions||[]).filter(s=>s.overlordId===ovr);
    console.log(JSON.stringify(matches,null,2));
  " <<<"$SNAP" OVR="$OVR" 2>/dev/null || true)
  if [ -z "$LIVE_JSON" ] || [ "$LIVE_JSON" = "[]" ]; then
    warn "no live Session for $OVR (closed/not hydrated)"
  else
    echo "$LIVE_JSON"
  fi
fi

# ───── 4. Persistent-field diff (disk vs live) ────────────────────
bold "Persistent-field diff (disk vs live)"
if [ -z "$DISK_FILE" ] || [ -z "$LIVE_JSON" ] || [ "$LIVE_JSON" = "[]" ]; then
  warn "skipped (need both disk record and live snapshot)"
else
  node -e "
    const fs=require('fs');
    const disk=JSON.parse(fs.readFileSync(process.env.DISK_FILE,'utf8'));
    const live=JSON.parse(process.env.LIVE_JSON)[0]||{};
    const fields=['sessionType','color','proposedName','slug','model','intent','gitBranch','provider','providerSessionId','resumedFrom','replacedBy','bridgePipeName','bridgeMarker','historyOnly','userAccepted'];
    let any=false;
    for (const f of fields) {
      const d=disk[f], l=live[f];
      const dv=d===undefined?'∅':JSON.stringify(d);
      const lv=l===undefined?'∅':JSON.stringify(l);
      if (dv !== lv) {
        any=true;
        console.log(\`  MISMATCH \${f}: disk=\${dv} live=\${lv}\`);
      }
    }
    if (!any) console.log('  (no persistent-field mismatches)');
  " DISK_FILE="$DISK_FILE" LIVE_JSON="$LIVE_JSON" || true
fi

# ───── 5. Transcript freshness ────────────────────────────────────
bold "Transcript"
if [ -n "$SID" ]; then
  CANON=""
  for d in "$PROJECTS_DIR"/*/; do
    p="$d$SID.jsonl"
    if [ -f "$p" ]; then CANON="$p"; break; fi
  done
  SHADOW="$SHADOW_DIR/$OVR/$SID.jsonl"
  if [ -n "$CANON" ]; then
    echo "canonical: $CANON"
    stat -f "  size=%z mtime=%Sm lines=$(wc -l <"$CANON" | tr -d ' ')" -t "%Y-%m-%d %H:%M:%S" "$CANON" 2>/dev/null || stat "$CANON"
  else
    warn "canonical transcript missing for $SID"
  fi
  if [ -f "$SHADOW" ]; then
    echo "shadow:    $SHADOW"
    stat -f "  size=%z mtime=%Sm" -t "%Y-%m-%d %H:%M:%S" "$SHADOW" 2>/dev/null
  else
    warn "no shadow link"
  fi
else
  warn "no sessionId resolved"
fi

# ───── 6. PID liveness ────────────────────────────────────────────
bold "Process"
if [ -n "$LIVE_JSON" ] && [ "$LIVE_JSON" != "[]" ]; then
  PID=$(node -e "const a=JSON.parse(process.env.LIVE_JSON);console.log(a[0]?.pid||'')" LIVE_JSON="$LIVE_JSON")
else
  PID=""
fi
if [ -n "$PID" ] && [ "$PID" != "0" ]; then
  if ps -p "$PID" -o pid=,ppid=,command= 2>/dev/null; then
    :
  else
    warn "pid $PID not alive"
  fi
  PIDFILE="$SESSIONS_DIR/$PID.json"
  if [ -f "$PIDFILE" ]; then
    echo "  pid-file: $PIDFILE"
    PID_SID=$(node -e "const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(d.sessionId||'')" "$PIDFILE" 2>/dev/null)
    echo "  pid-file sessionId: $PID_SID"
    if [ -n "$SID" ] && [ "$PID_SID" != "$SID" ]; then
      verdict "pid $PID points at $PID_SID, lineage current is $SID — /clear may have happened or detection is lagging"
    fi
  fi
else
  warn "no PID (closed or never had one)"
fi

# ───── 7. Bridge wiring ───────────────────────────────────────────
bold "Bridge"
if [ -n "$PIPE" ]; then
  echo "  bridgePipeName: $PIPE  (sessionType on disk: ${DISK_TYPE:-?})"
  for sock in "/tmp/$PIPE" "/tmp/$PIPE.sock" "$TMPDIR$PIPE"; do
    if [ -e "$sock" ]; then echo "  socket: $sock"; fi
  done
  if [ "$DISK_TYPE" != "bridge" ]; then
    verdict "bridgePipeName set but sessionType=$DISK_TYPE on disk — setSessionType('bridge') likely didn't patch sessionStore (composeSession reads disk)"
  fi
  pgrep -fl overlord-bridge | grep -F "$PIPE" || warn "  no overlord-bridge process holding pipe $PIPE"
else
  echo "  (no bridgePipeName on record)"
fi

# ───── 8. PTY (embedded) ─────────────────────────────────────────
bold "PTY (embedded)"
if [ "$DISK_TYPE" = "embedded" ]; then
  if [ -n "$LIVE_JSON" ] && [ "$LIVE_JSON" != "[]" ]; then
    node -e "
      const a=JSON.parse(process.env.LIVE_JSON)[0]||{};
      console.log('  ptyAlive:', a.ptyAlive);
      console.log('  state:', a.state);
    " LIVE_JSON="$LIVE_JSON"
  else
    warn "  no live snapshot to inspect ptyAlive"
  fi
else
  echo "  (sessionType=$DISK_TYPE — N/A)"
fi

# ───── 9. Recent log lines ───────────────────────────────────────
bold "Recent logs"
LOG_GUESSES=("/tmp/overlord-server.log" "$HOME/.claude/overlord/server.log")
LOG=""
for g in "${LOG_GUESSES[@]}"; do
  [ -f "$g" ] && LOG="$g" && break
done
if [ -n "$LOG" ]; then
  echo "log: $LOG"
  PAT="$OVR"
  [ -n "$SID" ] && PAT="$OVR\|${SID:0:8}"
  grep -E "$PAT" "$LOG" 2>/dev/null | tail -30 || warn "  no matches"
else
  warn "no server log file found at known paths"
fi

# ───── 10. Verdict roll-up ───────────────────────────────────────
bold "Summary"
echo "ovrId:     $OVR"
echo "sessionId: ${SID:-?}"
echo "type:      ${DISK_TYPE:-?}"
echo "(See LIKELY: lines above. They are hints — verify before acting.)"
