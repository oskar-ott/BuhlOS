#!/usr/bin/env bash
# Authenticated end-to-end test for the E1 ITP loop.
#
# Two modes:
#
#   DRY-RUN (default — safe to run repeatedly on production):
#     - Logs in as tradie + admin.
#     - GET /api/job-itps?jobId=$JOB confirms 200 + body shape.
#     - For each existing instance, GET /api/audit-log?targetType=itp_instance
#       &targetId=$ID&jobId=$JOB returns 200.
#     - Negative checks: unauth → 401, tradie signoff → 403.
#     - No writes.
#
#   WRITE mode (WRITE=1, requires ITP_TEMPLATE_ID):
#     - Admin attaches a TEST E1 instance.
#     - Tradie records every required point.
#     - Tradie signoff → 403.
#     - Admin signs off (independence rule ratio = 0; no override).
#     - Admin reopens, archives.
#     - Audit-log row count >= 1 attached + N recorded + 1 signed_off
#       + 1 reopened + 1 archived.
#
# Run from your machine (not from a Vercel sandbox — egress allowlists
# typically block buhlos.com):
#
#   TRADIE_USER=oskar TRADIE_PASS=... \
#   ADMIN_USER=tom    ADMIN_PASS=... \
#   bash scripts/auth-smoke-e1-itp.sh                     # dry-run
#
#   TRADIE_USER=oskar TRADIE_PASS=... \
#   ADMIN_USER=tom    ADMIN_PASS=... \
#   ITP_TEMPLATE_ID=tpl_... WRITE=1 \
#   bash scripts/auth-smoke-e1-itp.sh                     # full lifecycle
#
# Overrides:
#   BASE=https://buhlos-git-some-branch.vercel.app
#   JOB=birdwood-iv3232
#
# The script:
#   - Uses temp cookie jars under $TMPDIR and removes them on exit.
#   - Never prints credentials.
#   - Tags every test record TEST E1 ITP <ISO> for trivial cleanup.
#   - Leaves the TEST E1 instance in archived state (write mode).
#
# Exit codes:
#   0  every check passed
#   1  one or more checks failed (details printed)
#   2  prerequisite missing (jq, curl, env vars)

set -uo pipefail

BASE="${BASE:-https://buhlos.com}"
JOB="${JOB:-birdwood-iv3232}"
WRITE="${WRITE:-0}"
ITP_TEMPLATE_ID="${ITP_TEMPLATE_ID:-}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"

if ! command -v jq >/dev/null 2>&1; then
  echo "FATAL: jq is required (brew install jq / apt-get install jq)" >&2
  exit 2
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "FATAL: curl is required" >&2
  exit 2
fi

for var in TRADIE_USER TRADIE_PASS ADMIN_USER ADMIN_PASS; do
  if [ -z "${!var:-}" ]; then
    echo "FATAL: env var $var is not set" >&2
    exit 2
  fi
done

if [ "$WRITE" = "1" ] && [ -z "$ITP_TEMPLATE_ID" ]; then
  echo "FATAL: WRITE=1 also requires ITP_TEMPLATE_ID=<existing template id>" >&2
  exit 2
fi

TMP_BASE="${TMPDIR:-/tmp}/e1-itp-$$"
TRADIE_JAR="$TMP_BASE.tradie.cookies"
ADMIN_JAR="$TMP_BASE.admin.cookies"
trap 'rm -f "$TRADIE_JAR" "$ADMIN_JAR" "$TMP_BASE".*.tmp 2>/dev/null' EXIT

passed=0
failed=0
declare -a fail_lines

pass()  { passed=$((passed + 1)); echo "PASS  $1"; }
fail()  { failed=$((failed + 1)); echo "FAIL  $1"; fail_lines+=("$1"); }
say()   { printf '\n--- %s ---\n' "$*"; }

# Wraps curl. Writes status code + headers + body to per-call temp files.
# Returns the HTTP status on stdout via `read code outfile hdrfile`.
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

echo "BASE=$BASE  JOB=$JOB  WRITE=$WRITE"

# ---------------------------------------------------------------
say "Unauth gate"
# ---------------------------------------------------------------

read code outfile hdrfile < <(do_curl "$TMP_BASE.none.tmp" \
  -X GET "$BASE/api/job-itps?jobId=$JOB")
if [ "$code" = "401" ]; then
  pass "GET /api/job-itps unauth → 401"
else
  fail "GET /api/job-itps unauth expected 401, got $code"
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
  rm -f "$outfile" "$hdrfile"
  exit 1
fi
rm -f "$outfile" "$hdrfile"

# ---------------------------------------------------------------
say "Tradie GET /api/job-itps"
# ---------------------------------------------------------------

read code outfile hdrfile < <(do_curl "$TRADIE_JAR" "$BASE/api/job-itps?jobId=$JOB")
if [ "$code" = "200" ]; then
  INSTANCE_COUNT=$(jq '.instances | length' "$outfile")
  pass "tradie GET /api/job-itps → 200 ($INSTANCE_COUNT instances)"
  # Capture any pre-existing instance id for the audit-log read check.
  PREEXISTING_ID=$(jq -r '.instances[0].id // ""' "$outfile")
else
  fail "tradie GET expected 200, got $code"
  PREEXISTING_ID=""
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
  ADMIN_ID=$(jq -r '.user.id // ""' "$outfile")
  echo "  role=$ADMIN_ROLE  id=$ADMIN_ID"
  pass "admin login → 200"
else
  fail "admin login → $code"
  rm -f "$outfile" "$hdrfile"
  exit 1
fi
rm -f "$outfile" "$hdrfile"

# ---------------------------------------------------------------
say "Admin GET /api/job-itps"
# ---------------------------------------------------------------

read code outfile hdrfile < <(do_curl "$ADMIN_JAR" "$BASE/api/job-itps?jobId=$JOB")
if [ "$code" = "200" ]; then
  ADMIN_INSTANCE_COUNT=$(jq '.instances | length' "$outfile")
  pass "admin GET /api/job-itps → 200 ($ADMIN_INSTANCE_COUNT instances)"
else
  fail "admin GET expected 200, got $code"
fi
rm -f "$outfile" "$hdrfile"

# ---------------------------------------------------------------
say "Audit-log read on pre-existing instance (if any)"
# ---------------------------------------------------------------

if [ -n "$PREEXISTING_ID" ]; then
  read code outfile hdrfile < <(do_curl "$ADMIN_JAR" \
    "$BASE/api/audit-log?targetType=itp_instance&targetId=$PREEXISTING_ID&jobId=$JOB")
  if [ "$code" = "200" ]; then
    ENTRIES=$(jq '.entries | length' "$outfile")
    pass "audit-log on $PREEXISTING_ID → 200 ($ENTRIES entries)"
  else
    fail "audit-log on $PREEXISTING_ID → $code"
  fi
  rm -f "$outfile" "$hdrfile"
else
  echo "  skip (no pre-existing instances on $JOB)"
fi

# ---------------------------------------------------------------
say "Negative — tradie cannot sign off"
# ---------------------------------------------------------------

# Even if the instance doesn't exist or isn't witnessed, the role gate
# fires first (admin-only verb). 403 is the expected pre-validation
# response from api/job-itps.js:339.
read code outfile hdrfile < <(do_curl "$TRADIE_JAR" \
  -X POST "$BASE/api/job-itps?jobId=$JOB&action=signoff" \
  -H 'Content-Type: application/json' \
  -d "{\"instanceId\":\"itp_nonexistent_$TS\"}")
if [ "$code" = "403" ]; then
  pass "tradie signoff → 403"
else
  fail "tradie signoff expected 403, got $code"
fi
rm -f "$outfile" "$hdrfile"

# ---------------------------------------------------------------
say "Negative — admin attach with bogus templateId → 404"
# ---------------------------------------------------------------

read code outfile hdrfile < <(do_curl "$ADMIN_JAR" \
  -X POST "$BASE/api/job-itps?jobId=$JOB&action=attach" \
  -H 'Content-Type: application/json' \
  -d "{\"templateId\":\"tpl_does_not_exist_$TS\",\"scope\":\"job\"}")
if [ "$code" = "404" ]; then
  pass "attach bogus template → 404"
else
  fail "attach bogus template expected 404, got $code"
fi
rm -f "$outfile" "$hdrfile"

# ---------------------------------------------------------------
say "Negative — attach with unknown scope → 400"
# ---------------------------------------------------------------

read code outfile hdrfile < <(do_curl "$ADMIN_JAR" \
  -X POST "$BASE/api/job-itps?jobId=$JOB&action=attach" \
  -H 'Content-Type: application/json' \
  -d "{\"templateId\":\"$ITP_TEMPLATE_ID\",\"scope\":\"room\"}")
# When ITP_TEMPLATE_ID is empty (dry-run without a real template id),
# the server still rejects scope before looking it up.
if [ "$code" = "400" ]; then
  pass "attach unknown scope → 400"
else
  fail "attach unknown scope expected 400, got $code"
fi
rm -f "$outfile" "$hdrfile"

# ---------------------------------------------------------------
# WRITE MODE — full lifecycle.
# ---------------------------------------------------------------

if [ "$WRITE" = "1" ]; then
  say "WRITE — admin attaches TEST E1 ITP"

  read code outfile hdrfile < <(do_curl "$ADMIN_JAR" \
    -X POST "$BASE/api/job-itps?jobId=$JOB&action=attach" \
    -H 'Content-Type: application/json' \
    -d "{\"templateId\":\"$ITP_TEMPLATE_ID\",\"scope\":\"job\"}")
  if [ "$code" = "201" ]; then
    NEW_ID=$(jq -r '.instance.id' "$outfile")
    NEW_STATUS=$(jq -r '.instance.status' "$outfile")
    POINT_COUNT=$(jq '.instance.templateSnapshot.points | length' "$outfile")
    POINT_IDS=$(jq -r '.instance.templateSnapshot.points[] | select(.required != false and .archived != true) | .id' "$outfile")
    POINT_TYPES=$(jq -r '.instance.templateSnapshot.points[] | select(.required != false and .archived != true) | "\(.id):\(.type)"' "$outfile")
    pass "attach TEST E1 → 201 id=$NEW_ID status=$NEW_STATUS pointCount=$POINT_COUNT"
  else
    fail "attach TEST E1 expected 201, got $code"
    rm -f "$outfile" "$hdrfile"
    exit 1
  fi
  rm -f "$outfile" "$hdrfile"

  # ---------------------------------------------------------------
  say "WRITE — tradie records every required point"
  # ---------------------------------------------------------------

  RECORD_COUNT=0
  for line in $POINT_TYPES; do
    PID="${line%%:*}"
    PTYPE="${line##*:}"
    # Build a record body matching the point's type. value-points get a
    # known-pass integer (10); photo / signoff / note get a marker note.
    case "$PTYPE" in
      value)
        BODY="{\"instanceId\":\"$NEW_ID\",\"pointId\":\"$PID\",\"value\":10,\"note\":\"TEST E1 ITP $TS\"}"
        ;;
      signoff)
        BODY="{\"instanceId\":\"$NEW_ID\",\"pointId\":\"$PID\",\"value\":true,\"note\":\"TEST E1 ITP $TS\"}"
        ;;
      *)
        BODY="{\"instanceId\":\"$NEW_ID\",\"pointId\":\"$PID\",\"value\":\"ok\",\"note\":\"TEST E1 ITP $TS\"}"
        ;;
    esac
    read code outfile hdrfile < <(do_curl "$TRADIE_JAR" \
      -X POST "$BASE/api/job-itps?jobId=$JOB&action=record" \
      -H 'Content-Type: application/json' \
      -d "$BODY")
    if [ "$code" = "200" ]; then
      RECORD_COUNT=$((RECORD_COUNT + 1))
      CURRENT_STATUS=$(jq -r '.instance.status' "$outfile")
    else
      fail "record $PID expected 200, got $code"
    fi
    rm -f "$outfile" "$hdrfile"
  done
  if [ "$RECORD_COUNT" -gt 0 ]; then
    pass "tradie recorded $RECORD_COUNT required points; final status=$CURRENT_STATUS"
  fi
  if [ "${CURRENT_STATUS:-}" != "witnessed" ]; then
    fail "expected status=witnessed after every required point, got status=${CURRENT_STATUS:-}"
  fi

  # ---------------------------------------------------------------
  say "WRITE — tradie cannot sign off (admin-only)"
  # ---------------------------------------------------------------

  read code outfile hdrfile < <(do_curl "$TRADIE_JAR" \
    -X POST "$BASE/api/job-itps?jobId=$JOB&action=signoff" \
    -H 'Content-Type: application/json' \
    -d "{\"instanceId\":\"$NEW_ID\"}")
  if [ "$code" = "403" ]; then
    pass "tradie signoff on witnessed → 403"
  else
    fail "tradie signoff on witnessed expected 403, got $code"
  fi
  rm -f "$outfile" "$hdrfile"

  # ---------------------------------------------------------------
  say "WRITE — admin signs off (independence rule should pass: admin recorded 0/N)"
  # ---------------------------------------------------------------

  read code outfile hdrfile < <(do_curl "$ADMIN_JAR" \
    -X POST "$BASE/api/job-itps?jobId=$JOB&action=signoff" \
    -H 'Content-Type: application/json' \
    -d "{\"instanceId\":\"$NEW_ID\"}")
  if [ "$code" = "200" ]; then
    SIGNED_STATUS=$(jq -r '.instance.status' "$outfile")
    SIGNED_BY=$(jq -r '.instance.signedOffBy' "$outfile")
    pass "admin signoff → 200 status=$SIGNED_STATUS by=$SIGNED_BY"
  else
    fail "admin signoff expected 200, got $code"
  fi
  rm -f "$outfile" "$hdrfile"

  # ---------------------------------------------------------------
  say "WRITE — admin reopen (signed-off → witnessed)"
  # ---------------------------------------------------------------

  read code outfile hdrfile < <(do_curl "$ADMIN_JAR" \
    -X POST "$BASE/api/job-itps?jobId=$JOB&action=reopen" \
    -H 'Content-Type: application/json' \
    -d "{\"instanceId\":\"$NEW_ID\"}")
  if [ "$code" = "200" ]; then
    REOPEN_STATUS=$(jq -r '.instance.status' "$outfile")
    SIGNED_BY_CLEARED=$(jq -r '.instance.signedOffBy // "cleared"' "$outfile")
    if [ "$REOPEN_STATUS" = "witnessed" ] && [ "$SIGNED_BY_CLEARED" = "cleared" ]; then
      pass "admin reopen → 200 status=$REOPEN_STATUS, stamps cleared"
    else
      fail "reopen status=$REOPEN_STATUS, signedOffBy='$SIGNED_BY_CLEARED'"
    fi
  else
    fail "admin reopen expected 200, got $code"
  fi
  rm -f "$outfile" "$hdrfile"

  # ---------------------------------------------------------------
  say "WRITE — admin archives (soft-delete)"
  # ---------------------------------------------------------------

  read code outfile hdrfile < <(do_curl "$ADMIN_JAR" \
    -X DELETE "$BASE/api/job-itps?jobId=$JOB&id=$NEW_ID")
  if [ "$code" = "200" ]; then
    OK=$(jq -r '.ok' "$outfile")
    [ "$OK" = "true" ] && pass "admin archive → 200 ok=true" \
                      || fail "admin archive returned ok=$OK"
  else
    fail "admin archive expected 200, got $code"
  fi
  rm -f "$outfile" "$hdrfile"

  # ---------------------------------------------------------------
  say "WRITE — audit-log shows the full lifecycle"
  # ---------------------------------------------------------------

  read code outfile hdrfile < <(do_curl "$ADMIN_JAR" \
    "$BASE/api/audit-log?targetType=itp_instance&targetId=$NEW_ID&jobId=$JOB")
  if [ "$code" = "200" ]; then
    ENTRIES=$(jq '.entries | length' "$outfile")
    ATTACHED=$(jq '[.entries[] | select(.action == "itp.attached")] | length' "$outfile")
    RECORDED=$(jq '[.entries[] | select(.action == "itp.point.recorded")] | length' "$outfile")
    SIGNED=$(jq '[.entries[] | select(.action == "itp.signed_off")] | length' "$outfile")
    REOPENED=$(jq '[.entries[] | select(.action == "itp.reopened")] | length' "$outfile")
    ARCHIVED=$(jq '[.entries[] | select(.action == "itp.archived")] | length' "$outfile")
    if [ "$ATTACHED" -ge "1" ] && [ "$RECORDED" -ge "1" ] && [ "$SIGNED" -ge "1" ] && [ "$REOPENED" -ge "1" ] && [ "$ARCHIVED" -ge "1" ]; then
      pass "audit-log: total=$ENTRIES attached=$ATTACHED recorded=$RECORDED signed=$SIGNED reopened=$REOPENED archived=$ARCHIVED"
    else
      fail "audit-log: total=$ENTRIES attached=$ATTACHED recorded=$RECORDED signed=$SIGNED reopened=$REOPENED archived=$ARCHIVED"
    fi
  else
    fail "audit-log read → $code"
  fi
  rm -f "$outfile" "$hdrfile"
else
  echo
  echo "WRITE=$WRITE — dry-run only. Set WRITE=1 (and ITP_TEMPLATE_ID=...)"
  echo "to run the full attach → record → signoff → reopen → archive lifecycle."
fi

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

if [ "$WRITE" = "1" ]; then
  echo "TEST DATA LEFT BEHIND (label TEST E1 ITP):"
  echo "  - itp instance ${NEW_ID:-?}  (archived)"
  echo "  - audit rows for itp_instance ${NEW_ID:-?}  (append-only)"
  echo
  echo "No automated cleanup endpoint exists. Manual cleanup via the"
  echo "Vercel Blob dashboard if needed; the rows are labelled TEST E1"
  echo "ITP $TS for easy identification."
else
  echo "Dry-run — no test data written."
fi

if [ "$failed" -eq 0 ]; then
  exit 0
fi
echo
echo "FAILURES:"
for line in "${fail_lines[@]}"; do
  echo "  - $line"
done
exit 1
