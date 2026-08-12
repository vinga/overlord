# Overlord Sessions

Work with the Claude Code sessions Overlord manages: list live state, search records and
transcripts, look up their Jira tickets and plans, spawn new sessions into any room, and send
messages to a running session.

Available in every session (auto-linked from the Overlord server). Always answer with clickable
deep links so the user can jump straight to the worker.

## Configuration

```bash
OVERLORD_BASE="${OVERLORD_HOST:-http://localhost:3173}"
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
  -d '{"cwd":"/path/of/target/room","name":"WorkerName","prompt":"optional first task","icon":"investigate"}'
# → {"ok":true,"sessionId":"ovr-XXXX","ptySessionId":"pty-..."}
```

- `cwd` (required): take it verbatim from a record's `cwd` field so the session lands in that room.
- `name`: display name — pick one not already in use; match the room's naming style.
- `prompt`: injected once the TUI is ready — this is how you hand the new worker its first task.
  **Best-effort, not guaranteed — always verify (below).**
- `icon`: avatar glyph, applied at creation (see below). An invalid value 400s the whole spawn.
- `master: true`: crown session (oversight role). Rarely needed.

### Verify the prompt landed — REQUIRED

The spawn `prompt` is queued against the new PTY and fired on its first output (or a 1.5s fallback
timer). It can silently not land: the queued entry expires after 120s if the PTY never produced
output, the keystrokes can arrive before the input box accepts them, or the Enter may not confirm.
The spawn still returns `{"ok":true}` — a session that came up idle looks identical to one that got
its task. **A spawn is not done until you have seen the worker leave `waiting`.**

```bash
OVR=ovr-XXXX   # from the spawn response
sleep 10
curl -s "$OVERLORD_BASE/api/debug/state" \
  | jq -r --arg o "$OVR" '.sessions[] | select(.overlordId==$o) | "\(.state)\t\(.sessionId)"'
```

`state` is `working` → the prompt landed, done. Still `waiting` (or `idle`) → it did not; inject it
yourself with the **Claude sessionId** from that same line:

```bash
curl -s -X POST "$OVERLORD_BASE/api/sessions/<claudeSessionId>/inject" \
  -H 'Content-Type: application/json' -d '{"text":"the same first task"}'
```

Then re-check `state` once more. Never report a spawned worker as started on the `{"ok":true}` alone.

### Choosing the room

A repo often has several worktree rooms (`foo`, `foo-A`, `foo-B`, `foo-operations`, …). They are not
interchangeable: the new worker inherits that checkout's branch, uncommitted state, `.env`, and
virtualenv.

Default to **the room you are spawning from** — the user's active checkout is the one whose tooling
they keep working. Pick a different room only when the task genuinely needs it (e.g. a long-running
job that must not disturb the active branch), and say which room you chose and why.

Do not read a room's *name* as a routing hint. A room called `-operations` or `-debug` is just
another worktree; it may be stale or lack local config. Room population (`/api/debug/state`) tells
you which rooms are actually in use — a room with recent sessions is a safer target than a quiet one.

### Set the icon

Put `icon` in the spawn body. A worker spawned without one renders with the default `user` glyph,
indistinguishable from a session the human started by hand — set it whenever the task has an obvious
shape. The glyph is on the record before the worker first draws, so there is no follow-up call and no
flash of the default icon.

Valid values (anything else 400s with the list): `user`, `dashboard`, `ticket`, `investigate`,
`teach`, `notes`, `btw`, `release`.

| Icon | Use for |
|---|---|
| `investigate` | debugging, root-cause hunts, log/incident analysis |
| `ticket` | implementation work — a Jira ticket, or any discrete change request |
| `release` | releases, deploys, promotion and rollout babysitting |
| `dashboard` | monitoring, metrics, Grafana/ClickHouse queries, reporting |
| `teach` | explaining or walking the user through something |
| `notes` | docs, specs, write-ups, meeting notes |
| `btw` | side quests and asides that don't fit the room's main thread |
| `user` | the default — leave it when the task has no clear shape |

`"icon":"user"` in a spawn is accepted but does nothing — `user` is already the default.

**Changing the icon of a session that already exists** — the PUT endpoint, which keys on the
**Claude sessionId**, not the overlordId (`ovr-XXXX` returns `404 session not found`):

```bash
curl -s -X PUT "$OVERLORD_BASE/api/sessions/<claudeSessionId>/icon" \
  -H 'Content-Type: application/json' -d '{"icon":"investigate"}'
# → {"ok":true}
```

Here `user` means *clear* — it patches `icon: undefined`, resetting to the default glyph.

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

**The `#session/...` hash is the only route — there is no path-based one.** The client reads the
hash on mount and listens for `hashchange`; it has no router. An invented path like
`/s/<overlordId>` or `/session/<overlordId>` is **not** an error you will notice: Vite's SPA
fallback answers `200` with `index.html`, so the app loads normally, sees an empty hash, and selects
nothing. The link looks fine and quietly does half its job. Copy the format above literally.

## Rules

- Read-only on disk: never modify, move, or delete anything under `~/.claude/overlord/` or
  `~/.claude/projects/`. Mutations go through the API endpoints above.
- Prefer record fields (`intent`, `proposedName`, `jiraKeys`) before grepping transcripts — records
  are small, transcripts can be hundreds of MB. Always `tail -c` large transcripts.
- Cross-check freshness with file mtime, not `lastActivity`.
- `sessionId` (Claude UUID) and `overlordId` (ovr-XXXX) are different keys — inject/screen and the
  icon **PUT** take the former, links/records/plans the latter. (Spawn needs neither — pass `icon`
  in the body.)
- A session you spawn is yours to label: give it a `name` that reads in the room and an `icon` that
  matches the task. A wall of default `user` glyphs makes the office unreadable.
- Spawning and injecting are visible actions with side effects: say what you did, and don't do
  either speculatively.
