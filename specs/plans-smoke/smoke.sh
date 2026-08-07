#!/usr/bin/env bash
# V4: API smoke for /api/plans
# Usage: BASE=http://localhost:3173 OVERLORD_ID=ovr-XXXX ./smoke.sh

set -euo pipefail
BASE="${BASE:-http://localhost:3173}"
OVERLORD_ID="${OVERLORD_ID:?OVERLORD_ID required — pick a real overlordId}"

echo "→ list (no filter)"
curl -s "$BASE/api/plans" | head -c 200; echo

echo "→ list by overlordId"
curl -s "$BASE/api/plans?overlordId=$OVERLORD_ID" | head -c 200; echo

echo "→ POST unknown overlord (expect 404)"
curl -s -o /dev/null -w "  status=%{http_code}\n" \
  -X POST "$BASE/api/plans" \
  -H 'Content-Type: application/json' \
  -d '{"overlordId":"ovr-nonexistent","title":"X","body":""}'

echo "→ POST create plan"
CREATED=$(curl -s -X POST "$BASE/api/plans" \
  -H 'Content-Type: application/json' \
  -d "{\"overlordId\":\"$OVERLORD_ID\",\"title\":\"Smoke plan\",\"body\":\"# H\\n\\nbody\"}")
echo "$CREATED"
PLAN_ID=$(echo "$CREATED" | python3 -c "import sys,json;print(json.load(sys.stdin)['plan']['planId'])")

echo "→ PUT update status=active"
curl -s -X PUT "$BASE/api/plans/$PLAN_ID" \
  -H 'Content-Type: application/json' \
  -d '{"status":"active","title":"Smoke updated"}' | head -c 300; echo

echo "→ GET single"
curl -s "$BASE/api/plans/$PLAN_ID" | head -c 300; echo

echo "→ DELETE"
curl -s -X DELETE "$BASE/api/plans/$PLAN_ID"; echo

echo "→ GET after delete (expect 404)"
curl -s -o /dev/null -w "  status=%{http_code}\n" "$BASE/api/plans/$PLAN_ID"

echo "✓ smoke passed"
