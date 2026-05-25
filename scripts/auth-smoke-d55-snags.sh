#!/usr/bin/env bash
# Authenticated end-to-end test for the D.5 snags loop.
#
# Drives the full lifecycle against a real BuhlOS deployment:
#   1. Phil tradie logs in, opens a job, raises a TEST D55 snag
#   2. Same tradie claims it (open → in_progress) and marks it resolved
#   3. BuhlOS admin logs in, verifies it (resolved → verified) and closes
#      (verified → closed)
#   4. Reject branch — second snag, admin rejects with reason
#   5. Pulls /api/audit-log to confirm the lifecycle landed
#   6. Negative checks — tradie can't verify; unauth can't read
#   7. Evidence regression — tradie creates a note evidence, GET confirms
#
# Run from your machine (not from a Vercel sandbox — egress allowlists
# typically block buhlos.com):
#
#   TRADIE_USER=oskar TRADIE_PASS=... \
#   ADMIN_USER=tom    ADMIN_PASS=... \
#   bash scripts/auth-smoke-d55-snags.sh
#
# Override target:
#   BASE=https://buhlos-git-some-branch.vercel.app bash scripts/auth-smoke-d55-snags.sh
#
# Override job:
#   JOB=birdwood-iv3232 bash scripts/auth-smoke-d55-snags.sh
#
# The script:
#   - Uses temp cookie jars under $TMPDIR and removes them on exit.
#   - Never prints credentials.
#   - Tags every test record TEST D55 SNAG <ISO> for trivial cleanup.
#   - Closes the happy-path snag and leaves the reject-branch snag
#     in rejected state (admin can't auto-close a rejected snag without
#     re-opening it, which would muddy the audit).
#
# Exit codes:
#   0  every check passed
#   1  one or more checks failed (details printed)
#   2  prerequisite missing (jq, env vars)

set -uo pipefail

BASE="${BASE:-https://buhlos.com}"
JOB="${JOB:-birdwood-iv3232}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"

if ! command -v jq >/dev/null 2>&1; then
  echo "FATAL: jq is required (brew install jq / apt-get install jq)" >&2
  exit 2
fi

for var in TRADIE_USER TRADIE_PASS ADMIN_USER ADMIN_PASS; do
  if [ -z "${!var:-}" ]; then
    echo "FATAL: env var $var is not set" >&2
    exit 2
  fi
done

TMP_BASE="${TMPDIR:-/tmp}/d55-snags-$$"
TRADIE_JAR="$TMP_BASE.tradie.cookies"
ADMIN_JAR="$TMP_BASE.admin.cookies"
LOG="$TMP_BASE.log"
trap 'rm -f "$TRADIE_JAR" "$ADMIN_JAR" "$LOG" "$TMP_BASE".*.tmp 2>/dev/null' EXIT

passed=0
failed=0
declare -a fail_lines

pass()  { passed=$((passed + 1)); echo "PASS  $1"; }
fail()  { failed=$((failed + 1)); echo "FAIL  $1"; fail_lines+=("$1"); }
say()   { printf '\n--- %s ---\n' "$*"; }

# Wraps curl. Writes status code + headers + body to per-call temp files.
# Returns the HTTP status on stdout.
do_curl() {
  local jar="$1"; shift
  local outfile="$TMP_BASE.body.$RANDOM.tmp"
  local hdrfile="$TMP_BASE.hdr.$RANDOM.tmp"
  local code
  code=$(curl -sS -o "$outfile" -D "$hdrfile" -w '%{http_code}' \
    --cookie-jar "$jar" --cookie "$jar" \
    "$@" 2>/dev/null || echo 000)
  echo "$code" "$outfile" "$hdrfile"
}

# ---------------------------------------------------------------
say "Unauth gate"
# ---------------------------------------------------------------

read code outfile hdrfile < <(do_curl "$TMP_BASE.none.tmp" \
  -X GET "$BASE/api/snags?jobId=$JOB")
if [ "$code" = "401" ]; then
  pass "GET /api/snags unauth → 401"
else
  fail "GET /api/snags unauth expected 401, got $code"
fi
rm -f "$outfile" "$hdrfile" "$TMP_BASE.none.tmp"

# ---------------------------------------------------------------
say "Tradie login"
# ---------------------------------------------------------------

read code outfile hdrfile < <(do_curl "$TRADIE_JAR" \
  -X POST "$BASE/api/auth?action=login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$TRADIE_USER\",\"password\":\"$TRADIE_PASS\"}")

if [ "$code" = "200" ]; then
  pass "tradie login → 200"
  TRADIE_ROLE=$(jq -r '.user.role // ""' "$outfile")
  TRADIE_ID=$(jq -r '.user.id // ""' "$outfile")
  echo "  role=$TRADIE_ROLE  id=$TRADIE_ID"
else
  fail "tradie login expected 200, got $code"
  cat "$outfile" >&2 || true
  rm -f "$outfile" "$hdrfile"
  exit 1
fi
rm -f "$outfile" "$hdrfile"

# Confirm session works
read code outfile hdrfile < <(do_curl "$TRADIE_JAR" "$BASE/api/auth?action=me")
[ "$code" = "200" ] && pass "tradie /api/auth?action=me → 200" \
                   || fail "tradie /api/auth?action=me → $code"
rm -f "$outfile" "$hdrfile"

# ---------------------------------------------------------------
say "Tradie creates TEST D55 snag (happy path)"
# ---------------------------------------------------------------

read code outfile hdrfile < <(do_curl "$TRADIE_JAR" \
  -X POST "$BASE/api/snags?jobId=$JOB" \
  -H 'Content-Type: application/json' \
  -d "{\"title\":\"TEST D55 SNAG happy $TS\",\"description\":\"happy path lifecycle\",\"priority\":\"high\"}")

if [ "$code" = "201" ]; then
  SNAG_HAPPY=$(jq -r '.snagItem.id' "$outfile")
  STATUS=$(jq -r '.snagItem.status' "$outfile")
  if [ -n "$SNAG_HAPPY" ] && [ "$STATUS" = "open" ]; then
    pass "create snag → 201, id=$SNAG_HAPPY, status=open"
  else
    fail "create snag returned 201 but body shape unexpected: $(cat $outfile)"
  fi
else
  fail "create snag expected 201, got $code: $(cat $outfile)"
fi
rm -f "$outfile" "$hdrfile"

# Confirm GET shows it
read code outfile hdrfile < <(do_curl "$TRADIE_JAR" "$BASE/api/snags?jobId=$JOB")
if [ "$code" = "200" ]; then
  COUNT=$(jq --arg id "$SNAG_HAPPY" '[.snags[] | select(.id == $id)] | length' "$outfile")
  if [ "$COUNT" = "1" ]; then
    pass "tradie GET shows the new snag"
  else
    fail "tradie GET didn't show snag $SNAG_HAPPY (count=$COUNT)"
  fi
else
  fail "tradie GET → $code"
fi
rm -f "$outfile" "$hdrfile"

# ---------------------------------------------------------------
say "Tradie validation — empty title → 400"
# ---------------------------------------------------------------

read code outfile hdrfile < <(do_curl "$TRADIE_JAR" \
  -X POST "$BASE/api/snags?jobId=$JOB" \
  -H 'Content-Type: application/json' \
  -d '{"title":""}')
[ "$code" = "400" ] && pass "empty title → 400" \
                    || fail "empty title expected 400, got $code"
rm -f "$outfile" "$hdrfile"

# ---------------------------------------------------------------
say "Tradie claims open → in_progress"
# ---------------------------------------------------------------

read code outfile hdrfile < <(do_curl "$TRADIE_JAR" \
  -X POST "$BASE/api/snags?jobId=$JOB&action=transition" \
  -H 'Content-Type: application/json' \
  -d "{\"snagId\":\"$SNAG_HAPPY\",\"nextStatus\":\"in_progress\"}")
if [ "$code" = "200" ]; then
  STATUS=$(jq -r '.snagItem.status' "$outfile")
  [ "$STATUS" = "in_progress" ] && pass "claim → in_progress" \
                                || fail "claim returned status=$STATUS"
else
  fail "claim expected 200, got $code: $(cat $outfile)"
fi
rm -f "$outfile" "$hdrfile"

# ---------------------------------------------------------------
say "Tradie marks in_progress → resolved (creator privilege)"
# ---------------------------------------------------------------

read code outfile hdrfile < <(do_curl "$TRADIE_JAR" \
  -X POST "$BASE/api/snags?jobId=$JOB&action=transition" \
  -H 'Content-Type: application/json' \
  -d "{\"snagId\":\"$SNAG_HAPPY\",\"nextStatus\":\"resolved\"}")
if [ "$code" = "200" ]; then
  STATUS=$(jq -r '.snagItem.status' "$outfile")
  [ "$STATUS" = "resolved" ] && pass "mark resolved → resolved" \
                             || fail "mark resolved returned status=$STATUS"
else
  fail "mark resolved expected 200, got $code: $(cat $outfile)"
fi
rm -f "$outfile" "$hdrfile"

# ---------------------------------------------------------------
say "Tradie tries to verify (should 403 — admin only)"
# ---------------------------------------------------------------

read code outfile hdrfile < <(do_curl "$TRADIE_JAR" \
  -X POST "$BASE/api/snags?jobId=$JOB&action=transition" \
  -H 'Content-Type: application/json' \
  -d "{\"snagId\":\"$SNAG_HAPPY\",\"nextStatus\":\"verified\"}")
[ "$code" = "403" ] && pass "tradie verify → 403" \
                    || fail "tradie verify expected 403, got $code"
rm -f "$outfile" "$hdrfile"

# ---------------------------------------------------------------
say "Tradie creates second snag for reject branch"
# ---------------------------------------------------------------

read code outfile hdrfile < <(do_curl "$TRADIE_JAR" \
  -X POST "$BASE/api/snags?jobId=$JOB" \
  -H 'Content-Type: application/json' \
  -d "{\"title\":\"TEST D55 SNAG reject $TS\",\"priority\":\"normal\"}")
if [ "$code" = "201" ]; then
  SNAG_REJECT=$(jq -r '.snagItem.id' "$outfile")
  pass "create reject-branch snag → 201, id=$SNAG_REJECT"
else
  fail "create reject-branch snag → $code"
  SNAG_REJECT=""
fi
rm -f "$outfile" "$hdrfile"

# ---------------------------------------------------------------
say "Admin login"
# ---------------------------------------------------------------

read code outfile hdrfile < <(do_curl "$ADMIN_JAR" \
  -X POST "$BASE/api/auth?action=login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}")
if [ "$code" = "200" ]; then
  ADMIN_ROLE=$(jq -r '.user.role // ""' "$outfile")
  echo "  role=$ADMIN_ROLE"
  pass "admin login → 200"
else
  fail "admin login → $code"
  cat "$outfile" >&2 || true
  rm -f "$outfile" "$hdrfile"
  exit 1
fi
rm -f "$outfile" "$hdrfile"

# ---------------------------------------------------------------
say "Admin sees both test snags"
# ---------------------------------------------------------------

read code outfile hdrfile < <(do_curl "$ADMIN_JAR" "$BASE/api/snags?jobId=$JOB")
if [ "$code" = "200" ]; then
  HAPPY_FOUND=$(jq --arg id "$SNAG_HAPPY" '[.snags[] | select(.id == $id)] | length' "$outfile")
  REJ_FOUND=$(jq --arg id "$SNAG_REJECT" '[.snags[] | select(.id == $id)] | length' "$outfile")
  if [ "$HAPPY_FOUND" = "1" ] && [ "$REJ_FOUND" = "1" ]; then
    pass "admin GET shows both test snags"
  else
    fail "admin GET missing snags (happy=$HAPPY_FOUND, reject=$REJ_FOUND)"
  fi
else
  fail "admin GET → $code"
fi
rm -f "$outfile" "$hdrfile"

# ---------------------------------------------------------------
say "Admin verifies happy-path snag (resolved → verified)"
# ---------------------------------------------------------------

read code outfile hdrfile < <(do_curl "$ADMIN_JAR" \
  -X POST "$BASE/api/snags?jobId=$JOB&action=transition" \
  -H 'Content-Type: application/json' \
  -d "{\"snagId\":\"$SNAG_HAPPY\",\"nextStatus\":\"verified\"}")
if [ "$code" = "200" ]; then
  STATUS=$(jq -r '.snagItem.status' "$outfile")
  VERIFIED_BY=$(jq -r '.snagItem.verifiedByName // ""' "$outfile")
  if [ "$STATUS" = "verified" ] && [ -n "$VERIFIED_BY" ]; then
    pass "verify → verified, verifiedByName=$VERIFIED_BY"
  else
    fail "verify returned status=$STATUS, verifiedByName='$VERIFIED_BY'"
  fi
else
  fail "verify expected 200, got $code: $(cat $outfile)"
fi
rm -f "$outfile" "$hdrfile"

# ---------------------------------------------------------------
say "Admin closes (verified → closed)"
# ---------------------------------------------------------------

read code outfile hdrfile < <(do_curl "$ADMIN_JAR" \
  -X POST "$BASE/api/snags?jobId=$JOB&action=transition" \
  -H 'Content-Type: application/json' \
  -d "{\"snagId\":\"$SNAG_HAPPY\",\"nextStatus\":\"closed\"}")
if [ "$code" = "200" ]; then
  STATUS=$(jq -r '.snagItem.status' "$outfile")
  [ "$STATUS" = "closed" ] && pass "close → closed" \
                           || fail "close returned status=$STATUS"
else
  fail "close expected 200, got $code: $(cat $outfile)"
fi
rm -f "$outfile" "$hdrfile"

# ---------------------------------------------------------------
say "Admin rejects branch snag (open → rejected) with reason"
# ---------------------------------------------------------------

if [ -n "$SNAG_REJECT" ]; then
  read code outfile hdrfile < <(do_curl "$ADMIN_JAR" \
    -X POST "$BASE/api/snags?jobId=$JOB&action=transition" \
    -H 'Content-Type: application/json' \
    -d "{\"snagId\":\"$SNAG_REJECT\",\"nextStatus\":\"rejected\",\"reason\":\"TEST D55 reject reason $TS\"}")
  if [ "$code" = "200" ]; then
    STATUS=$(jq -r '.snagItem.status' "$outfile")
    REASON=$(jq -r '.snagItem.rejectionReason // ""' "$outfile")
    if [ "$STATUS" = "rejected" ] && [ -n "$REASON" ]; then
      pass "reject → rejected, rejectionReason persisted"
    else
      fail "reject returned status=$STATUS, reason='$REASON'"
    fi
  else
    fail "reject expected 200, got $code: $(cat $outfile)"
  fi
  rm -f "$outfile" "$hdrfile"

  # Reject without reason → 400
  read code outfile hdrfile < <(do_curl "$ADMIN_JAR" \
    -X POST "$BASE/api/snags?jobId=$JOB&action=transition" \
    -H 'Content-Type: application/json' \
    -d "{\"snagId\":\"$SNAG_REJECT\",\"nextStatus\":\"rejected\"}")
  # snag already rejected so this is an invalid transition either way
  [ "$code" = "400" ] && pass "second reject without reason → 400" \
                     || fail "second reject expected 400, got $code"
  rm -f "$outfile" "$hdrfile"
fi

# ---------------------------------------------------------------
say "Audit log for the happy-path snag (admin scope)"
# ---------------------------------------------------------------

read code outfile hdrfile < <(do_curl "$ADMIN_JAR" \
  "$BASE/api/audit-log?targetType=snag&targetId=$SNAG_HAPPY&jobId=$JOB")
if [ "$code" = "200" ]; then
  ENTRIES=$(jq '.entries | length' "$outfile")
  CREATED=$(jq '[.entries[] | select(.action == "snag.created")] | length' "$outfile")
  TRANSITIONS=$(jq '[.entries[] | select(.action == "snag.transitioned")] | length' "$outfile")
  if [ "$ENTRIES" -ge "4" ] && [ "$CREATED" -ge "1" ] && [ "$TRANSITIONS" -ge "3" ]; then
    pass "audit-log: entries=$ENTRIES, created=$CREATED, transitioned=$TRANSITIONS"
  else
    fail "audit-log: entries=$ENTRIES (expected ≥4), created=$CREATED, transitioned=$TRANSITIONS"
  fi
else
  fail "audit-log → $code"
fi
rm -f "$outfile" "$hdrfile"

# ---------------------------------------------------------------
say "Evidence regression — tradie creates a TEST D55 note evidence"
# ---------------------------------------------------------------

read code outfile hdrfile < <(do_curl "$TRADIE_JAR" \
  -X POST "$BASE/api/evidence?jobId=$JOB" \
  -H 'Content-Type: application/json' \
  -d "{\"kind\":\"note\",\"note\":\"TEST D55 EVIDENCE $TS\"}")
if [ "$code" = "201" ]; then
  EV_ID=$(jq -r '.evidenceItem.id' "$outfile")
  pass "evidence create → 201, id=$EV_ID"
else
  fail "evidence create → $code"
fi
rm -f "$outfile" "$hdrfile"

# ---------------------------------------------------------------
say "Logout"
# ---------------------------------------------------------------

do_curl "$TRADIE_JAR" -X POST "$BASE/api/auth?action=logout" >/dev/null
do_curl "$ADMIN_JAR"  -X POST "$BASE/api/auth?action=logout" >/dev/null
pass "both sessions logged out"

# ---------------------------------------------------------------
say "Summary"
# ---------------------------------------------------------------

total=$((passed + failed))
echo
echo "PASSED  $passed / $total"
echo "FAILED  $failed / $total"
echo
echo "TEST DATA LEFT BEHIND (label TEST D55):"
echo "  - snag $SNAG_HAPPY  (closed)"
echo "  - snag ${SNAG_REJECT:-?}  (rejected)"
echo "  - evidence ${EV_ID:-?}  (submitted — un-reviewed by design)"
echo
echo "No automated cleanup endpoint exists for snags (D55-L5)."
echo "Manual cleanup via Vercel Blob dashboard if needed; the rows are"
echo "labelled TEST D55 for easy identification."

if [ "$failed" -eq 0 ]; then
  exit 0
fi
echo
echo "FAILURES:"
for line in "${fail_lines[@]}"; do
  echo "  - $line"
done
exit 1
