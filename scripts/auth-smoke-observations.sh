#!/usr/bin/env bash
# Authenticated end-to-end smoke for the Observations field-to-office loop.
#
# Proves the real loop against a live deployment, using YOUR admin credentials
# (no auth bypass, no faked cookies, no production backdoor). Mirrors
# scripts/auth-smoke-onboarding-o3.sh: temp cookie jars, masked tokens,
# DRY-RUN by default.
#
#   DRY-RUN (safe — no writes):
#     - unauth gates: /api/observations 401 (cross-job), 401 (job-scoped)
#     - admin login + GET cross-job inbox 200 + GET job-scoped 200
#     - (optional) field-tier user gets 403 on the cross-job inbox
#
#   WRITE mode (WRITE=1 — creates a CLEARLY-TAGGED test observation):
#     - admin POST observation (type=note, title="qa smoke <ts>") → 201
#     - admin GET inbox finds the new id
#     - admin PATCH status (new → needs_action → in_review → resolved)
#     - admin PATCH priority (high)
#     - admin PATCH bad status → 400 · bad id → 404
#     - (PR 6 add-on) if /api/observations supports action=convert-to-snag,
#       smoke admin POST convert-to-snag for an eligible observation and
#       verify a real snag is created + observation linked + status=converted.
#       Skipped automatically if the endpoint isn't shipped on this deploy.
#
# Run from your machine (NOT a Vercel sandbox — egress allowlists may block
# buhlos.com). Point BASE at a PREVIEW for write tests, NOT production:
#
#   BASE=https://birdwood-git-<branch>-<hash>.vercel.app \
#   ADMIN_USER=oskar ADMIN_PASS=… \
#   bash scripts/auth-smoke-observations.sh                   # dry-run
#
#   BASE=https://…preview….vercel.app \
#   ADMIN_USER=oskar ADMIN_PASS=… \
#   TEST_JOB_ID=birdwood-iv3232 WRITE=1 \
#   bash scripts/auth-smoke-observations.sh                   # full chain
#
#   # Optional: also verify a field-tier user is locked out of the inbox API.
#   FIELD_USER=qa-field FIELD_PASS=… bash scripts/auth-smoke-observations.sh
#
# Leaves behind in WRITE mode: ONE observation row in observations.json,
# title "qa smoke <ts>" (status=resolved at the end), and — if the conversion
# endpoint exists — ONE snag on the test job. Manual Blob cleanup if desired.
#
# Exit: 0 all checks passed · 1 a check failed · 2 prerequisite missing.

set -uo pipefail

BASE="${BASE:-https://buhlos.com}"
WRITE="${WRITE:-0}"
TEST_JOB_ID="${TEST_JOB_ID:-birdwood-iv3232}"
TS="$(date -u +%Y%m%d%H%M%S)"
TEST_TITLE="qa smoke $TS"
FIELD_USER="${FIELD_USER:-}"
FIELD_PASS="${FIELD_PASS:-}"

command -v jq   >/dev/null 2>&1 || { echo "FATAL: jq required"   >&2; exit 2; }
command -v curl >/dev/null 2>&1 || { echo "FATAL: curl required" >&2; exit 2; }
for v in ADMIN_USER ADMIN_PASS; do
  [ -n "${!v:-}" ] || { echo "FATAL: env var $v is not set" >&2; exit 2; }
done

TMP_BASE="${TMPDIR:-/tmp}/observations-smoke-$$"
ADMIN_JAR="$TMP_BASE.admin.cookies"
FIELD_JAR="$TMP_BASE.field.cookies"
trap 'rm -f "$TMP_BASE".* 2>/dev/null' EXIT

passed=0; failed=0; declare -a fails
pass() { passed=$((passed+1)); echo "PASS  $1"; }
fail() { failed=$((failed+1)); echo "FAIL  $1"; fails+=("$1"); }
say()  { printf '\n--- %s ---\n' "$*"; }
mask() { local t="$1"; [ -n "$t" ] && echo "${t:0:8}…(${#t} chars)" || echo "(none)"; }

# do_curl <jar> <curl-args...> → "<code> <bodyfile>"
do_curl() {
  local jar="$1"; shift
  local out="$TMP_BASE.body.$RANDOM.tmp" code
  code=$(curl -sS -o "$out" -w '%{http_code}' --cookie-jar "$jar" --cookie "$jar" "$@" 2>/dev/null || echo 000)
  echo "$code $out"
}

login() {
  # Try {username, secret} then fall back to {username, password}.
  local jar="$1" user="$2" pass="$3" code out
  read code out < <(do_curl "$jar" -X POST "$BASE/api/auth?action=login" -H 'Content-Type: application/json' -d "{\"username\":\"$user\",\"secret\":\"$pass\"}")
  if [ "$code" != "200" ]; then
    rm -f "$out"
    read code out < <(do_curl "$jar" -X POST "$BASE/api/auth?action=login" -H 'Content-Type: application/json' -d "{\"username\":\"$user\",\"password\":\"$pass\"}")
  fi
  rm -f "$out"
  echo "$code"
}

summary() {
  say "Summary"
  echo "PASSED $passed / $((passed+failed))"
  echo "FAILED $failed / $((passed+failed))"
  if [ "$failed" -gt 0 ]; then printf '  - %s\n' "${fails[@]}"; fi
}

echo "BASE=$BASE  WRITE=$WRITE  TEST_JOB_ID=$TEST_JOB_ID"

# ── Unauth gates ───────────────────────────────────────────────────────────
say "Unauth gates"
read code out < <(do_curl "$TMP_BASE.none" "$BASE/api/observations")
[ "$code" = "401" ] && pass "GET /api/observations unauth → 401" || fail "GET /api/observations unauth expected 401, got $code"
rm -f "$out"

read code out < <(do_curl "$TMP_BASE.none" "$BASE/api/observations?jobId=$TEST_JOB_ID")
[ "$code" = "401" ] && pass "GET /api/observations?jobId unauth → 401" || fail "GET /api/observations?jobId unauth expected 401, got $code"
rm -f "$out"

read code out < <(do_curl "$TMP_BASE.none" -X POST "$BASE/api/observations?jobId=$TEST_JOB_ID" -H 'Content-Type: application/json' -d '{"type":"note","title":"x"}')
[ "$code" = "401" ] && pass "POST /api/observations unauth → 401" || fail "POST /api/observations unauth expected 401, got $code"
rm -f "$out"

read code out < <(do_curl "$TMP_BASE.none" -X PATCH "$BASE/api/observations" -H 'Content-Type: application/json' -d '{"id":"ob_bogus","status":"resolved"}')
[ "$code" = "401" ] && pass "PATCH /api/observations unauth → 401" || fail "PATCH /api/observations unauth expected 401, got $code"
rm -f "$out"

# ── Admin login ────────────────────────────────────────────────────────────
say "Admin login"
code=$(login "$ADMIN_JAR" "$ADMIN_USER" "$ADMIN_PASS")
[ "$code" = "200" ] && pass "admin login → 200" || { fail "admin login → $code"; summary; exit 1; }

read code out < <(do_curl "$ADMIN_JAR" "$BASE/api/observations")
[ "$code" = "200" ] && pass "admin GET cross-job inbox → 200" || fail "admin GET cross-job inbox expected 200, got $code"
INITIAL_COUNT=$(jq -r '.observations | length' "$out" 2>/dev/null || echo 0)
rm -f "$out"

read code out < <(do_curl "$ADMIN_JAR" "$BASE/api/observations?jobId=$TEST_JOB_ID")
[ "$code" = "200" ] && pass "admin GET job-scoped → 200" || fail "admin GET job-scoped expected 200, got $code"
rm -f "$out"

# ── Optional field-tier user is locked out of the inbox ───────────────────
if [ -n "$FIELD_USER" ] && [ -n "$FIELD_PASS" ]; then
  say "Field-tier login + inbox 403"
  code=$(login "$FIELD_JAR" "$FIELD_USER" "$FIELD_PASS")
  if [ "$code" = "200" ]; then
    pass "field login → 200"
    read code out < <(do_curl "$FIELD_JAR" "$BASE/api/observations")
    [ "$code" = "403" ] && pass "field GET cross-job inbox → 403" || fail "field GET cross-job inbox expected 403, got $code"
    rm -f "$out"
  else
    fail "field login → $code (skipping field 403 check)"
  fi
fi

if [ "$WRITE" != "1" ]; then
  echo; echo "DRY-RUN — no writes. Set WRITE=1 (against a PREVIEW) for the full chain."
  summary; [ "$failed" -eq 0 ] && exit 0 || exit 1
fi

# ── WRITE mode: full observation triage chain ─────────────────────────────
say "Create observation (admin, type=note)"
read code out < <(do_curl "$ADMIN_JAR" -X POST "$BASE/api/observations?jobId=$TEST_JOB_ID" \
  -H 'Content-Type: application/json' \
  -d "{\"type\":\"note\",\"title\":\"$TEST_TITLE\",\"description\":\"observations smoke $TS\"}")
if [ "$code" = "201" ]; then
  OBS_ID=$(jq -r '.observation.id' "$out")
  OBS_SOURCE=$(jq -r '.observation.source' "$out")
  pass "POST observation → 201 (id=$(mask "$OBS_ID"), source=$OBS_SOURCE)"
else
  fail "POST observation → $code"; rm -f "$out"; summary; exit 1
fi
rm -f "$out"

say "Verify observation appears in inbox + job-scoped GET"
read code out < <(do_curl "$ADMIN_JAR" "$BASE/api/observations")
NEW_COUNT=$(jq -r '.observations | length' "$out" 2>/dev/null || echo 0)
if jq -e --arg id "$OBS_ID" '.observations[] | select(.id==$id)' "$out" >/dev/null 2>&1; then
  pass "GET inbox includes new observation ($INITIAL_COUNT → $NEW_COUNT)"
else
  fail "GET inbox missing observation id=$OBS_ID"
fi
rm -f "$out"

read code out < <(do_curl "$ADMIN_JAR" "$BASE/api/observations?jobId=$TEST_JOB_ID")
if jq -e --arg id "$OBS_ID" '.observations[] | select(.id==$id)' "$out" >/dev/null 2>&1; then
  pass "GET ?jobId includes new observation"
else
  fail "GET ?jobId missing observation id=$OBS_ID"
fi
rm -f "$out"

say "PATCH triage chain"
for s in needs_action in_review; do
  read code out < <(do_curl "$ADMIN_JAR" -X PATCH "$BASE/api/observations" \
    -H 'Content-Type: application/json' \
    -d "{\"id\":\"$OBS_ID\",\"status\":\"$s\"}")
  got=$(jq -r '.observation.status // "?"' "$out" 2>/dev/null)
  [ "$code" = "200" ] && [ "$got" = "$s" ] && pass "PATCH status=$s → 200 ($got)" || fail "PATCH status=$s expected 200, got code=$code status=$got"
  rm -f "$out"
done

read code out < <(do_curl "$ADMIN_JAR" -X PATCH "$BASE/api/observations" \
  -H 'Content-Type: application/json' \
  -d "{\"id\":\"$OBS_ID\",\"priority\":\"high\"}")
got=$(jq -r '.observation.priority // "?"' "$out" 2>/dev/null)
[ "$code" = "200" ] && [ "$got" = "high" ] && pass "PATCH priority=high → 200" || fail "PATCH priority=high expected 200, got code=$code priority=$got"
rm -f "$out"

read code out < <(do_curl "$ADMIN_JAR" -X PATCH "$BASE/api/observations" \
  -H 'Content-Type: application/json' \
  -d "{\"id\":\"$OBS_ID\",\"status\":\"resolved\",\"resolutionNote\":\"smoke done\"}")
res_by=$(jq -r '.observation.resolvedById // ""' "$out" 2>/dev/null)
[ "$code" = "200" ] && [ -n "$res_by" ] && pass "PATCH status=resolved stamps resolvedById" || fail "resolve expected 200 + resolvedById, got code=$code resolvedById=$res_by"
rm -f "$out"

say "Negative cases"
read code out < <(do_curl "$ADMIN_JAR" -X PATCH "$BASE/api/observations" \
  -H 'Content-Type: application/json' -d "{\"id\":\"ob_bogus_$TS\",\"status\":\"resolved\"}")
[ "$code" = "404" ] && pass "PATCH unknown id → 404" || fail "PATCH unknown id expected 404, got $code"
rm -f "$out"

read code out < <(do_curl "$ADMIN_JAR" -X PATCH "$BASE/api/observations" \
  -H 'Content-Type: application/json' -d "{\"id\":\"$OBS_ID\",\"status\":\"bogus\"}")
[ "$code" = "400" ] && pass "PATCH invalid status → 400" || fail "PATCH invalid status expected 400, got $code"
rm -f "$out"

# ── PR 6 add-on: convert-to-snag (skipped if endpoint absent) ───────────
say "Convert-to-snag (PR 6, skipped if endpoint absent on this deploy)"
read code out < <(do_curl "$ADMIN_JAR" -X POST "$BASE/api/observations?jobId=$TEST_JOB_ID" \
  -H 'Content-Type: application/json' \
  -d "{\"type\":\"defect\",\"title\":\"qa smoke defect $TS\",\"description\":\"will convert to snag\"}")
CONV_ID=$(jq -r '.observation.id // ""' "$out" 2>/dev/null)
[ "$code" = "201" ] && [ -n "$CONV_ID" ] && pass "POST defect observation for conversion → 201 ($(mask "$CONV_ID"))" || fail "POST defect observation → $code"
rm -f "$out"

read code out < <(do_curl "$ADMIN_JAR" -X POST "$BASE/api/observations?action=convert-to-snag" \
  -H 'Content-Type: application/json' \
  -d "{\"id\":\"$CONV_ID\"}")
case "$code" in
  200|201)
    SNAG_ID=$(jq -r '.snag.id // .observation.convertedTargetId // ""' "$out" 2>/dev/null)
    OBS_LINK=$(jq -r '.observation.linkedSnagId // ""' "$out" 2>/dev/null)
    OBS_STAT=$(jq -r '.observation.status // ""' "$out" 2>/dev/null)
    if [ -n "$SNAG_ID" ] && [ "$OBS_LINK" = "$SNAG_ID" ] && [ "$OBS_STAT" = "converted" ]; then
      pass "convert-to-snag → $code (snag=$(mask "$SNAG_ID"), observation linked + status=converted)"
    else
      fail "convert-to-snag $code but shape unexpected: snag=$SNAG_ID linked=$OBS_LINK status=$OBS_STAT"
    fi
    # Idempotency: a second convert should reject (already converted).
    rm -f "$out"
    read code out < <(do_curl "$ADMIN_JAR" -X POST "$BASE/api/observations?action=convert-to-snag" \
      -H 'Content-Type: application/json' -d "{\"id\":\"$CONV_ID\"}")
    [ "$code" = "409" ] || [ "$code" = "400" ] && pass "double convert rejected → $code" || fail "double convert expected 409/400, got $code"
    ;;
  404|405)
    pass "convert-to-snag endpoint not deployed yet (PR 6) — got $code (skipping)"
    ;;
  *)
    fail "convert-to-snag → $code (unexpected)"
    ;;
esac
rm -f "$out"

summary; [ "$failed" -eq 0 ] && exit 0 || exit 1
