# Manage Overlord Plans

Manage plans linked to this Claude session via the Overlord server.

Plans are stored as artifacts with `kind=plan`. The API is `/api/artifacts`; this skill always filters/creates with `kind=plan`.

## Configuration

```bash
OVERLORD_BASE="${OVERLORD_HOST:-http://localhost:3173}"
```

`OVERLORD_HOST` may be set in the environment (e.g. `http://overlord.internal:3173`).
If unset, defaults to `http://localhost:3173`.

## Self-identification

At the start of every invocation, resolve this session's overlordId:

```bash
OVERLORD_BASE="${OVERLORD_HOST:-http://localhost:3173}"
RESOLVE=$(curl -s "$OVERLORD_BASE/api/resolve?pid=$PPID")
OVERLORD_ID=$(echo "$RESOLVE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['overlordId'])" 2>/dev/null)
```

If `OVERLORD_ID` is empty or `RESOLVE` contains an `error` key, stop and report:
> "Cannot reach Overlord at $OVERLORD_BASE — is the server running?"

---

## Commands

Detect intent from the user's args or message. Default (no args) → **list**.

### list
List all plans for this session.

```bash
curl -s "$OVERLORD_BASE/api/artifacts?kind=plan&overlordId=$OVERLORD_ID" \
  | python3 -c "
import sys, json
artifacts = json.load(sys.stdin)['artifacts']
if not artifacts:
    print('No plans.')
else:
    for p in artifacts:
        print(f\"[{p['status'].upper():8}] {p['artifactId']}  {p['title']}\")
"
```

### create `<title>` [body]
Create a new plan. Title comes from args; body is optional (use `''` if absent).
If no title is provided in args, ask the user before posting.

**Use the full plan body — never a shortcut summary.** If a fuller plan already exists for this
work (e.g. a `/pr-start` plan at `~/.claude/PLANS/<TICKET>/<service>.md`, or a plan already written
out in this conversation), the Overlord `body` MUST be that content **verbatim** — read the file and
paste it whole. Do NOT hand-write a condensed/re-summarized version. If no such plan exists yet,
write a complete plan first (TL;DR / Summary, Boundaries, Behavior change, Risks, Out of scope,
Detailed plan with files + implementation steps + testing) — the same structure `/pr-start` uses —
and post that. A thin summary body is not acceptable.

**Always create as `draft` first**, then ask the user for explicit approval before
flipping to `active`. Do not skip the draft step. Do not implement before approval.

```bash
curl -s -X POST "$OVERLORD_BASE/api/artifacts" \
  -H 'Content-Type: application/json' \
  -d "{\"kind\":\"plan\",\"overlordId\":\"$OVERLORD_ID\",\"title\":\"$TITLE\",\"body\":\"$BODY\",\"status\":\"draft\"}" \
  | python3 -c "import sys,json; p=json.load(sys.stdin)['artifact']; print(f\"Created {p['artifactId']}  '{p['title']}' [{p['status']}]\")"
```

After the POST returns, paste the full plan body in chat and ask:
> "Draft plan `<artifactId>` created. Approve to activate?"

Only on explicit user approval, run `update <artifactId> status=active`.

### update `<artifactId>` `<field>=<value> …`
Update one or more fields. Valid fields: `title`, `body`, `status`.
Valid statuses: `draft`, `active`, `done`, `archived`.
Build PATCH JSON only from the fields the user specified.

```bash
curl -s -X PUT "$OVERLORD_BASE/api/artifacts/$ARTIFACT_ID" \
  -H 'Content-Type: application/json' \
  -d "$PATCH_JSON" \
  | python3 -c "import sys,json; p=json.load(sys.stdin)['artifact']; print(f\"Updated {p['artifactId']}  status={p['status']}\")"
```

### delete `<artifactId>`
Always confirm with the user before deleting.

```bash
curl -s -X DELETE "$OVERLORD_BASE/api/artifacts/$ARTIFACT_ID"
echo "Deleted $ARTIFACT_ID"
```

### show `<artifactId>`
Fetch and display full metadata and body for a single plan.

```bash
curl -s "$OVERLORD_BASE/api/artifacts/$ARTIFACT_ID" \
  | python3 -c "
import sys, json
p = json.load(sys.stdin)['artifact']
print(f\"Title:  {p['title']}\")
print(f\"Status: {p['status']}  Source: {p['source']}\")
print(f\"ID:     {p['artifactId']}\")
print()
print(p['body'])
"
```

---

## Rules

- Set `OVERLORD_BASE` at the start of every invocation; never hardcode a host.
- For `create`, ask for title if not provided in args.
- For `create`, always POST as `status=draft` first, paste the body, then wait for explicit user approval before flipping to `active`. Never go straight to `active`.
- For `create`, the `body` must be the **full** plan — if a `/pr-start` `PLANS/*.md` (or an already-written plan) exists, paste it **verbatim**, never a condensed re-summary.
- For `delete`, always confirm with the user before calling DELETE.
- For `update`, include only the fields the user specified in the PATCH JSON.
- If any curl returns a non-2xx status, surface the error body verbatim.
- After any mutation, confirm with artifactId + new status.
