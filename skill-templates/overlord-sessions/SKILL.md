# Overlord Sessions

Work with the Claude Code sessions Overlord manages: list live state, search records and
transcripts, look up their Jira tickets and plans, spawn new sessions into any room, and send
messages to a running session.

Available in every session (auto-linked from the Overlord server). Always answer with clickable
deep links so the user can jump straight to the worker.

## Configuration

```bash
OVERLORD_BASE="${OVERLORD_HOST:-http://localhost:3000}"
OVERLORD_UI="${OVERLORD_UI:-http://localhost:5173}"
SESS_DIR="$HOME/.claude/overlord/overlord-sessions"
ARCH_DIR="$HOME/.claude/overlord/overlord-sessions-archive"
```

If any curl fails to connect, report: "Cannot reach Overlord at $OVERLORD_BASE — is the server running?"

## Self-identification

```bash
curl -s "$OVERLORD_BASE/api/resolve?pid=$PPID"     # → {overlordId, sessionId, cwd}
```

Exclude yourself from "what are the other sessions doing" answers.

## Two sources of truth

| Need | Source |
|---|---|
| Live state (working / waiting / closed), pid, current name | `GET /api/debug/state` |
| Durable facts (intent, jiraKeys, skillsUsed, lineage, archive) | JSON records in `$SESS_DIR` |
| Conversation content | transcripts (see below) |

`/api/debug/state` returns `{sessionCount, sessions[], ovrToPty, ...}`; each session has
`sessionId, overlordId, name, cwd, state, sessionType, pid, color, lastActivity`.

**`sessionId` = the live Claude UUID** (what `inject` and screen endpoints take).
**`overlordId` = the stable ovr-XXXX identity** (what records, links, icons, and plans use).

## Live state

```bash
# Who is working / waiting right now
curl -s "$OVERLORD_BASE/api/debug/state" | jq -r '.sessions[] | "\(.state)\t\(.overlordId)\t\(.name // "?")\t\(.cwd)"' | sort

# Just the ones waiting on the user
curl -s "$OVERLORD_BASE/api/debug/state" | jq -r '.sessions[] | select(.state=="waiting") | "\(.overlordId)\t\(.name)"'

# What a session's terminal shows right now (live TUI screen)
curl -s "$OVERLORD_BASE/api/sessions/<claudeSessionId>/screen"
```

## Data layout on disk

| What | Where | Format |
|---|---|---|
| Active session records | `~/.claude/overlord/overlord-sessions/{overlordId}.json` | one JSON `OverlordSession` per file |
| Archived session records | `~/.claude/overlord/overlord-sessions-archive/{overlordId}.json` | same, plus an `archive` block |
| Live transcripts | `~/.claude/projects/{slug}/{sessionId}.jsonl` | JSONL, one message event per line |
| Subagent transcripts | `~/.claude/projects/{slug}/{sessionId}/subagents/*.jsonl` | JSONL per subagent |
| Archived transcripts | `~/.claude/overlord/archive/{slug}/{overlordId}/{sessionId}.jsonl` | frozen copies |

Record fields worth knowing: `overlordId`, `cwd`, `proposedName`, `intent` (rolling summary of what
the session is doing), `jiraKeys`, `skillsUsed`, `sessionType`, `color`, `icon`, `notes`,
`currentTask`, `completionHint`, and `lineage.currentSessionId` + `lineage.history[]` (every Claude
sessionId ever attached, each with its `transcriptPath`).

`slug` = the cwd with every `/` replaced by `-`, keeping the leading dash:
`/Users/foo/bar` → `-Users-foo-bar`.

**Freshness rule:** use the record file's mtime (or the transcript's mtime) — never the
`lastActivity` field, which is seed-only and goes stale.

## Search recipes

Needs `jq` (fall back to `python3 -c` if unavailable).

**All active sessions, most recently touched first:**
```bash
ls -t "$SESS_DIR"/*.json | while read f; do
  jq -r '"\(.overlordId)\t\(.proposedName // "?")\t\(.cwd)\t\((.intent // "")[0:80])"' "$f"
done
```

**By project / cwd:**
```bash
jq -r 'select(.cwd | test("overlord"; "i")) | "\(.overlordId)\t\(.proposedName // "?")"' "$SESS_DIR"/*.json
```

**By name or intent keyword:**
```bash
jq -r 'select(((.proposedName // "") + " " + (.intent // "")) | test("color picker"; "i")) | .overlordId' "$SESS_DIR"/*.json
```

**Jira tickets — which session works on what:**
```bash
# every session and its tickets
jq -r 'select((.jiraKeys // []) | length > 0) | "\(.overlordId)\t\(.proposedName // "?")\t\(.jiraKeys | join(","))"' "$SESS_DIR"/*.json

# sessions touching one ticket (active + archived)
jq -r 'select((.jiraKeys // []) | index("BACKEND-1234")) | "\(.overlordId)\t\(.proposedName // "?")"' "$SESS_DIR"/*.json "$ARCH_DIR"/*.json
```

**Skills a session has used:**
```bash
jq -r '"\(.proposedName // .overlordId): \((.skillsUsed // []) | join(", "))"' "$SESS_DIR"/*.json
```

**Record → transcript:**
```bash
OVR=ovr-xxxxxxxx
jq -r '.lineage.currentSessionId as $sid | (.cwd | gsub("/"; "-")) as $slug
       | "\(env.HOME)/.claude/projects/\($slug)/\($sid).jsonl"' "$SESS_DIR/$OVR.json"
# every transcript in the lineage (survives /clear and /compact):
jq -r '.lineage.history[].transcriptPath // empty' "$SESS_DIR/$OVR.json"
```

**Grep transcript content, mapped back to sessions:**
```bash
grep -rl "needle" ~/.claude/projects/*/*.jsonl 2>/dev/null | while read t; do
  sid=$(basename "$t" .jsonl)
  grep -l "\"$sid\"" "$SESS_DIR"/*.json "$ARCH_DIR"/*.json 2>/dev/null | head -1
done | sort -u
```
Every record embeds its sessionIds in `lineage.history`, so grepping the record dirs for a sid
resolves transcript → overlordId.

**Read a transcript's messages** (they are large — tail, don't cat):
```bash
tail -c 200000 "$T" | while read -r l; do
  echo "$l" | jq -r 'select(.type=="user" or .type=="assistant")
    | "\(.type): \(.message.content | if type=="string" then . else (map(select(.type=="text").text) | join(" ")) end)"' 2>/dev/null
done | tail -40
```

**Plans / artifacts of a session:**
```bash
curl -s "$OVERLORD_BASE/api/artifacts?kind=plan&overlordId=$OVR" | jq -r '.artifacts[] | "[\(.status)] \(.title)"'
```

**Archived work** — repeat any record recipe against `$ARCH_DIR`; archived transcripts stay under
`~/.claude/overlord/archive/` even after the live transcript is gone. Full-text archive search:
```bash
curl -s "$OVERLORD_BASE/api/archive/search?q=needle"
```

## Spawn a session in any room

Rooms are the distinct `cwd` values across the records. To create a new embedded Claude session:

```bash
curl -s -X POST "$OVERLORD_BASE/api/sessions/spawn" \
  -H 'Content-Type: application/json' \
  -d '{"cwd":"/path/of/target/room","name":"WorkerName","prompt":"optional first task"}'
# → {"ok":true,"sessionId":"ovr-XXXX","ptySessionId":"pty-..."}
```

- `cwd` (required): take it verbatim from a record's `cwd` field so the session lands in that room.
- `name`: display name — pick one not already in use; match the room's naming style.
- `prompt`: injected once the TUI is ready — this is how you hand the new worker its first task.
- `master: true`: crown session (oversight role). Rarely needed.

The returned `sessionId` is the **overlordId**. Print its deep link immediately. The worker appears
in the office within a few seconds.

## Send a message to a running session

```bash
curl -s -X POST "$OVERLORD_BASE/api/sessions/<claudeSessionId>/inject" \
  -H 'Content-Type: application/json' -d '{"text":"your message"}'
```

Takes the **Claude sessionId** (from `/api/debug/state`, or a record's `lineage.currentSessionId`) —
not the overlordId. Announce what you sent and to whom; never inject on a guess about which session
the user meant.

## Clickable links — REQUIRED in every answer

Whenever you mention a session, print its deep link. The Overlord UI selects the worker and scrolls
its desk into view:

```
http://localhost:5173/#session/<overlordId>
http://localhost:5173/#session/<overlordId>/<subagentId>     # deep-link a subagent
```

Subagent ids are the `.jsonl` basenames in that session's `subagents/` directory.

Format results as a markdown list: name — one-line intent — link. Never answer with bare overlordIds.

## Rules

- Read-only on disk: never modify, move, or delete anything under `~/.claude/overlord/` or
  `~/.claude/projects/`. Mutations go through the API endpoints above.
- Prefer record fields (`intent`, `proposedName`, `jiraKeys`) before grepping transcripts — records
  are small, transcripts can be hundreds of MB. Always `tail -c` large transcripts.
- Cross-check freshness with file mtime, not `lastActivity`.
- `sessionId` (Claude UUID) and `overlordId` (ovr-XXXX) are different keys — inject/screen take the
  former, links/records/plans the latter.
- Spawning and injecting are visible actions with side effects: say what you did, and don't do
  either speculatively.
