# Manage Overlord Plans

Manage plans linked to this Claude session via the Overlord server.

## Configuration

```bash
OVERLORD_BASE="${OVERLORD_HOST:-http://localhost:3000}"
```

`OVERLORD_HOST` may be set in the environment (e.g. `http://overlord.internal:3000`).
If unset, defaults to `http://localhost:3000`.

## Self-identification

At the start of every invocation, resolve this session's overlordId:

```bash
OVERLORD_BASE="${OVERLORD_HOST:-http://localhost:3000}"
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
curl -s "$OVERLORD_BASE/api/plans?overlordId=$OVERLORD_ID" \
  | python3 -c "
import sys, json
plans = json.load(sys.stdin)['plans']
if not plans:
    print('No plans.')
else:
    for p in plans:
        print(f\"[{p['status'].upper():8}] {p['planId']}  {p['title']}\")
"
```

### create `<title>` [body]
Create a new plan. Title comes from args; body is optional (use `''` if absent).
If no title is provided in args, ask the user before posting.

```bash
curl -s -X POST "$OVERLORD_BASE/api/plans" \
  -H 'Content-Type: application/json' \
  -d "{\"overlordId\":\"$OVERLORD_ID\",\"title\":\"$TITLE\",\"body\":\"$BODY\",\"status\":\"draft\"}" \
  | python3 -c "import sys,json; p=json.load(sys.stdin)['plan']; print(f\"Created {p['planId']}  '{p['title']}' [{p['status']}]\")"
```

### update `<planId>` `<field>=<value> …`
Update one or more fields. Valid fields: `title`, `body`, `status`.
Valid statuses: `draft`, `active`, `done`, `archived`.
Build PATCH JSON only from the fields the user specified.

```bash
curl -s -X PUT "$OVERLORD_BASE/api/plans/$PLAN_ID" \
  -H 'Content-Type: application/json' \
  -d "$PATCH_JSON" \
  | python3 -c "import sys,json; p=json.load(sys.stdin)['plan']; print(f\"Updated {p['planId']}  status={p['status']}\")"
```

### delete `<planId>`
Always confirm with the user before deleting.

```bash
curl -s -X DELETE "$OVERLORD_BASE/api/plans/$PLAN_ID"
echo "Deleted $PLAN_ID"
```

### show `<planId>`
Fetch and display full metadata and body for a single plan.

```bash
curl -s "$OVERLORD_BASE/api/plans/$PLAN_ID" \
  | python3 -c "
import sys, json
p = json.load(sys.stdin)['plan']
print(f\"Title:  {p['title']}\")
print(f\"Status: {p['status']}  Source: {p['source']}\")
print(f\"ID:     {p['planId']}\")
print()
print(p['body'])
"
```

---

## Rules

- Set `OVERLORD_BASE` at the start of every invocation; never hardcode a host.
- For `create`, ask for title if not provided in args.
- For `delete`, always confirm with the user before calling DELETE.
- For `update`, include only the fields the user specified in the PATCH JSON.
- If any curl returns a non-2xx status, surface the error body verbatim.
- After any mutation, confirm with planId + new status.
