---
name: overlord-pins
description: Pin links (Jira ticket, PR, branch, any URL) to this Overlord session or its room, so they show as chips above the session tabs or in the room view. Use when starting work on a ticket, after opening a PR or pushing a branch, or when the user says "pin this", "przypnij". Usage: /overlord-pins add <url> [--title T] [--room] | ls | rm <pinId>
---

# Overlord Pins

Pinned links show as chips (icon + title) above the Conversation / Details / Notes tabs of a
session, or in the room view when pinned to the room. Use the `ovr` CLI (on PATH).

## Commands

```bash
ovr pin add <url>                      # pin to this session
ovr pin add <url> --title "Short name" # custom chip title
ovr pin add <url> --room               # pin to this session's room (all sessions in the folder)
ovr pin ls [--room]                    # id, kind, title, url
ovr pin rm <pinId> [--room]
ovr whoami                             # overlordId, sessionId, cwd
```

- Kind and default title come from the URL: Jira `/browse/KEY-N` → ticket `KEY-N`;
  GitHub `/pull/N` → pr `repo#N`; `/tree/<branch>` → branch; anything else → link.
  Override with `--kind ticket|pr|branch|link`.
- The same URL pinned twice updates the existing chip (title/kind), no duplicate.
- Max 30 pins per session or room. Only `http(s)` URLs.

## When to pin

- Starting work on a Jira ticket → pin the ticket to the session.
- After `gh pr create` → pin the PR URL to the session.
- A long-lived branch or design doc shared by every session in the folder → `--room`.
- Pin only what the user will want to click again. Do not pin every link you read.

## Session targeting

`ovr` finds the session from `$OVERLORD_PTY_ID` (set by Overlord at spawn), else the nearest
ancestor process Overlord tracks. If neither works it exits 2; pass `--session <overlordId>`.

## Fallback: raw API

```bash
OVERLORD_BASE="${OVERLORD_HOST:-http://localhost:3173}"
# target: {"overlordId": "..."} | {"ptyId": "$OVERLORD_PTY_ID"} | {"cwd": "/abs/room"}; add "room": true for the session's room
curl -s -X POST "$OVERLORD_BASE/api/pins" -H 'Content-Type: application/json' \
  -d '{"ptyId":"'"$OVERLORD_PTY_ID"'","url":"https://…","title":"…"}'
curl -s "$OVERLORD_BASE/api/pins?ptyId=$OVERLORD_PTY_ID"           # list
curl -s -X DELETE "$OVERLORD_BASE/api/pins/<pinId>?ptyId=$OVERLORD_PTY_ID"
```

If a call cannot connect, report: "Cannot reach Overlord at $OVERLORD_BASE — is the server running?"
