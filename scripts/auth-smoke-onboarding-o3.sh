#!/usr/bin/env bash
# Authenticated end-to-end smoke for the employee-onboarding chain (O1→O3).
#
# Proves the real chain against a live deployment:
#   admin creates employee → invite link issued → worker resolves invite →
#   weak PINs rejected → valid PIN accepted (account created + activated) →
#   invite is single-use (re-accept blocked) → employee Active / invite Accepted.
#
# Mirrors scripts/auth-smoke-e1-itp.sh: temp cookie jars, never prints
# credentials, never prints the raw invite token (masked), DRY-RUN by default.
# It logs in through the real /api/auth?action=login endpoint with credentials
# YOU supply — it does NOT bypass auth, fake cookies, or fake any state.
#
#   DRY-RUN (default — safe, no writes):
#     - unauth gates: /api/employees 401, invite resolve(bogus)=invalid,
#       accept(bogus)=404
#     - admin login + GET /api/employees 200
#
#   WRITE mode (WRITE=1 — creates a CLEARLY-TAGGED test worker + account):
#     - create employee (+invite) → resolve(valid) → weak/mismatch PIN rejected
#       → valid accept(200) → re-accept(409 single-use) → resolve(accepted)
#       → employee Active/invite Accepted → disable the test employee.
#     - Leaves behind: the created users.json login (no delete endpoint) and a
#       disabled employee row, both tagged by TEST_WORKER_EMAIL. Manual Blob
#       cleanup if needed.
#
# Run from your machine (NOT a Vercel sandbox — egress allowlists block
# buhlos.com). Point BASE at a PREVIEW for write tests, not production.
#
#   BASE=https://birdwood-git-buhlos-onboarding-o3-….vercel.app \
#   ADMIN_USER=oskar ADMIN_PASS=… \
#   bash scripts/auth-smoke-onboarding-o3.sh                 # dry-run
#
#   BASE=https://…preview….vercel.app \
#   ADMIN_USER=oskar ADMIN_PASS=… WRITE=1 \
#   bash scripts/auth-smoke-onboarding-o3.sh                 # full chain
#
# Exit: 0 all checks passed · 1 a check failed · 2 prerequisite missing.

set -uo pipefail

BASE="${BASE:-https://buhlos.com}"
WRITE="${WRITE:-0}"
TS="$(date -u +%Y%m%d%H%M%S)"
TEST_WORKER_EMAIL="${TEST_WORKER_EMAIL:-test.worker+o3-$TS@example.com}"
TEST_ROLE="${TEST_ROLE:-electrician}"

command -v jq   >/dev/null 2>&1 || { echo "FATAL: jq required"   >&2; exit 2; }
command -v curl >/dev/null 2>&1 || { echo "FATAL: curl required" >&2; exit 2; }
for v in ADMIN_USER ADMIN_PASS; do
  [ -n "${!v:-}" ] || { echo "FATAL: env var $v is not set" >&2; exit 2; }
done

TMP_BASE="${TMPDIR:-/tmp}/o3-onboarding-$$"
ADMIN_JAR="$TMP_BASE.admin.cookies"
WORKER_JAR="$TMP_BASE.worker.cookies"
trap 'rm -f "$TMP_BASE".* 2>/dev/null' EXIT

passed=0; failed=0; declare -a fails
pass() { passed=$((passed+1)); echo "PASS  $1"; }
fail() { failed=$((failed+1)); echo "FAIL  $1"; fails+=("$1"); }
say()  { printf '\n--- %s ---\n' "$*"; }
mask() { local t="$1"; [ -n "$t" ] && echo "${t:0:4}…(${#t} chars)" || echo "(none)"; }

# do_curl <jar> <curl-args...> → echoes "<code> <bodyfile>"
do_curl() {
  local jar="$1"; shift
  local out="$TMP_BASE.body.$RANDOM.tmp" code
  code=$(curl -sS -o "$out" -w '%{http_code}' --cookie-jar "$jar" --cookie "$jar" "$@" 2>/dev/null || echo 000)
  echo "$code $out"
}

echo "BASE=$BASE  WRITE=$WRITE  WORKER=$TEST_WORKER_EMAIL"

# ── Unauth gates ───────────────────────────────────────────────────────────
say "Unauth gates"
read code out < <(do_curl "$TMP_BASE.none" -X GET "$BASE/api/employees")
[ "$code" = "401" ] && pass "GET /api/employees unauth → 401" || fail "GET /api/employees unauth expected 401, got $code"
rm -f "$out"

read code out < <(do_curl "$TMP_BASE.none" "$BASE/api/invites?action=resolve&token=bogus_$TS")
if [ "$code" = "200" ] && [ "$(jq -r '.state' "$out" 2>/dev/null)" = "invalid" ]; then
  pass "resolve(bogus) → 200 invalid (no leak)"
else fail "resolve(bogus) expected 200 invalid, got $code"; fi
rm -f "$out"

read code out < <(do_curl "$TMP_BASE.none" -X POST "$BASE/api/invites?action=accept" -H 'Content-Type: application/json' -d "{\"token\":\"bogus_$TS\",\"pin\":\"8053\",\"confirmPin\":\"8053\"}")
[ "$code" = "404" ] && pass "accept(bogus) → 404 (no account created)" || fail "accept(bogus) expected 404, got $code"
rm -f "$out"

# ── Admin login ────────────────────────────────────────────────────────────
say "Admin login"
read code out < <(do_curl "$ADMIN_JAR" -X POST "$BASE/api/auth?action=login" -H 'Content-Type: application/json' -d "{\"username\":\"$ADMIN_USER\",\"secret\":\"$ADMIN_PASS\"}")
if [ "$code" != "200" ]; then
  # Some deployments use {username,password}; retry once with that shape.
  read code out < <(do_curl "$ADMIN_JAR" -X POST "$BASE/api/auth?action=login" -H 'Content-Type: application/json' -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}")
fi
[ "$code" = "200" ] && pass "admin login → 200" || { fail "admin login → $code"; rm -f "$out"; summary; exit 1; }
rm -f "$out"

read code out < <(do_curl "$ADMIN_JAR" "$BASE/api/employees")
[ "$code" = "200" ] && pass "admin GET /api/employees → 200" || fail "admin GET /api/employees → $code"
rm -f "$out"

summary() {
  say "Summary"
  echo "PASSED $passed / $((passed+failed))"
  echo "FAILED $failed / $((passed+failed))"
  if [ "$failed" -gt 0 ]; then printf '  - %s\n' "${fails[@]}"; fi
}

if [ "$WRITE" != "1" ]; then
  echo; echo "DRY-RUN — no writes. Set WRITE=1 (against a PREVIEW) for the full chain."
  summary; [ "$failed" -eq 0 ] && exit 0 || exit 1
fi

# ── WRITE: create employee + invite ─────────────────────────────────────────
say "Create test employee + invite"
read code out < <(do_curl "$ADMIN_JAR" -X POST "$BASE/api/employees" -H 'Content-Type: application/json' \
  -d "{\"firstName\":\"Test\",\"lastName\":\"Worker\",\"email\":\"$TEST_WORKER_EMAIL\",\"role\":\"$TEST_ROLE\",\"sendInvite\":true,\"notes\":\"O3 smoke $TS\"}")
if [ "$code" = "200" ]; then
  EMP_ID=$(jq -r '.row.employee.id' "$out")
  LINK=$(jq -r '.inviteLink // ""' "$out")
  TOKEN="${LINK##*/}"
  pass "create employee → 200 (id=$EMP_ID, token=$(mask "$TOKEN"))"
else fail "create employee → $code"; rm -f "$out"; summary; exit 1; fi
# Security: create response must not leak hash/pin
if jq -e 'tostring | test("tokenHash|passwordHash";"i")' "$out" >/dev/null 2>&1; then
  fail "create response leaked tokenHash/passwordHash"; else pass "create response has no token/password hash"; fi
rm -f "$out"

say "Resolve (valid)"
read code out < <(do_curl "$WORKER_JAR" "$BASE/api/invites?action=resolve&token=$TOKEN")
if [ "$code" = "200" ] && [ "$(jq -r '.state' "$out")" = "valid" ] && [ "$(jq -r '.invite.firstName' "$out")" = "Test" ]; then
  pass "resolve(valid) → 200 valid, shows worker"
else fail "resolve(valid) expected 200 valid, got $code state=$(jq -r '.state' "$out" 2>/dev/null)"; fi
jq -e '.invite | has("tokenHash")' "$out" >/dev/null 2>&1 && fail "resolve leaked tokenHash" || pass "resolve has no tokenHash"
rm -f "$out"

say "Weak / mismatched PIN rejected"
for bad in 1234 0000 1111 4321; do
  read code out < <(do_curl "$WORKER_JAR" -X POST "$BASE/api/invites?action=accept" -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\",\"pin\":\"$bad\",\"confirmPin\":\"$bad\"}")
  [ "$code" = "400" ] && pass "weak PIN $bad → 400" || fail "weak PIN $bad expected 400, got $code"
  rm -f "$out"
done
read code out < <(do_curl "$WORKER_JAR" -X POST "$BASE/api/invites?action=accept" -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\",\"pin\":\"8053\",\"confirmPin\":\"8054\"}")
[ "$code" = "400" ] && pass "mismatched PIN → 400" || fail "mismatched PIN expected 400, got $code"
rm -f "$out"

say "Accept (valid PIN)"
read code out < <(do_curl "$WORKER_JAR" -X POST "$BASE/api/invites?action=accept" -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\",\"pin\":\"8053\",\"confirmPin\":\"8053\"}")
if [ "$code" = "200" ] && [ "$(jq -r '.ok' "$out")" = "true" ]; then
  pass "accept(valid) → 200 (landing=$(jq -r '.landing' "$out"))"
else fail "accept(valid) expected 200, got $code"; fi
jq -e 'tostring | test("pin|passwordHash|tokenHash";"i")' "$out" >/dev/null 2>&1 && fail "accept response leaked pin/hash" || pass "accept response has no pin/hash"
rm -f "$out"

say "Single-use (re-accept blocked)"
read code out < <(do_curl "$WORKER_JAR" -X POST "$BASE/api/invites?action=accept" -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\",\"pin\":\"8053\",\"confirmPin\":\"8053\"}")
[ "$code" = "409" ] && pass "re-accept → 409 (single-use)" || fail "re-accept expected 409, got $code"
rm -f "$out"

say "Re-resolve shows accepted"
read code out < <(do_curl "$WORKER_JAR" "$BASE/api/invites?action=resolve&token=$TOKEN")
[ "$(jq -r '.state' "$out" 2>/dev/null)" = "accepted" ] && pass "re-resolve → accepted" || fail "re-resolve expected accepted, got $(jq -r '.state' "$out" 2>/dev/null)"
rm -f "$out"

say "Admin sees employee Active / invite Accepted"
read code out < <(do_curl "$ADMIN_JAR" "$BASE/api/employees?id=$EMP_ID")
EST=$(jq -r '.row.employee.status' "$out" 2>/dev/null); IST=$(jq -r '.row.invite.status' "$out" 2>/dev/null)
{ [ "$EST" = "active" ] && [ "$IST" = "accepted" ]; } && pass "employee=active invite=accepted" || fail "expected active/accepted, got employee=$EST invite=$IST"
rm -f "$out"

say "Cleanup — disable test employee"
read code out < <(do_curl "$ADMIN_JAR" -X POST "$BASE/api/employees?action=disable&id=$EMP_ID" -H 'Content-Type: application/json' -d "{\"id\":\"$EMP_ID\"}")
[ "$code" = "200" ] && pass "disabled test employee" || fail "disable → $code"
rm -f "$out"

echo
echo "NOTE: a users.json login for $TEST_WORKER_EMAIL was created (no delete"
echo "endpoint in O3) and the employee row is now disabled. Remove via the"
echo "Vercel Blob dashboard if needed — both are tagged 'O3 smoke $TS'."

summary
[ "$failed" -eq 0 ] && exit 0 || exit 1
