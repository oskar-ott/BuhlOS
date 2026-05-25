# Phase E testing checklist

> **Status:** docs-only.
> **Source plan:** [32-phase-e-plan.md](32-phase-e-plan.md) + [33-phase-e-build-prompts.md](33-phase-e-build-prompts.md).
> **Read alongside:** [26-phase-d-testing-checklist.md](26-phase-d-testing-checklist.md) (Phase D precedent), [28-d2-d3-d4-evidence-qa-checklist.md](28-d2-d3-d4-evidence-qa-checklist.md) (evidence loop QA precedent).

This is the QA gate for Phase E build sessions. Paste the relevant section into each Phase E build PR's test plan.

---

## §A · E1 ITP — pre-merge checks

### A.1 · Local build pass

| Check | Command | Pass criterion |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | clean |
| Lint | `npm run lint` | no warnings |
| Vitest | `npm run test` | 400+ pass after E1 |
| Build | `npm run build` | green, route sizes reasonable |
| Admin shell | `npm run check:admin-shell` | 22+ OK / 0 fail |
| SW cache version | `npm run check:sw-cache-version` | OK (only bump if admin shell files changed) |
| Production shell | `npm run check:production-shell` | 0 issues |
| Smoke admin routes | `npm run smoke:admin-routes` | all pass |

### A.2 · RSC client-manifest grep
Every new client component lives under `src/components/admin/` or `src/components/phil/`, never under `src/app/v2/jobs/[jobId]/itp/`. Grep:
```
git ls-files 'src/app/v2/jobs/**' 'src/app/v2/itp/**' 'src/app/phil/**' | xargs grep -l '"use client"' || true
```
Expected: empty result.

### A.3 · API auth wall (unauthenticated)
Every new endpoint returns 401 JSON when called without a session cookie:
- `GET /api/itp-templates`
- `POST /api/itp-templates`
- `GET /api/itps?jobId=birdwood-iv3232`
- `POST /api/itps?jobId=birdwood-iv3232`
- `POST /api/itps?jobId=birdwood-iv3232&action=submit`
- `POST /api/itps?jobId=birdwood-iv3232&action=review`
- `POST /api/itps?jobId=birdwood-iv3232&action=reopen`
- `GET /api/audit-log?targetType=itp&targetId=x&jobId=birdwood-iv3232`

Each returns `Content-Type: application/json; charset=utf-8` and a JSON body. **No HTML error pages.**

### A.4 · State machine matrix
Vitest `itp.test.ts` must assert the full transition matrix:

| From | To | Allowed |
| --- | --- | --- |
| null | in_progress | yes |
| null | * | no |
| in_progress | ready_for_review | yes |
| in_progress | accepted | no (skip-review) |
| in_progress | closed | no |
| ready_for_review | accepted | yes (admin/LH, four-eyes) |
| ready_for_review | rejected | yes (admin/LH, four-eyes, reason required) |
| ready_for_review | in_progress | yes (worker recalls) |
| rejected | in_progress | yes (worker fixes) |
| rejected | accepted | no |
| accepted | closed | yes (admin) |
| accepted | rejected | no (must reopen first) |
| closed | ready_for_review | yes (admin reopens) |
| closed | accepted | no |

### A.5 · Four-eyes enforcement
Server-side test: a user whose id matches `createdById` OR `submittedById` cannot transition `ready_for_review → accepted/rejected`. Returns 409 (state conflict — they failed the gate, not a generic 403).

### A.6 · Validation invariants
- Submit (`in_progress → ready_for_review`):
  - Every template item has a response.
  - Every `requiresPhoto: true` item has ≥1 evidenceId.
  - Every `requiresNote: true` item has a non-empty note.
  - Fails with 400 if any invariant breached.
- Review accept (`ready_for_review → accepted`):
  - No item state is `fail`. If any are `fail`, must reject with reason.
  - Fails with 409 (not 400 — it's a state-machine issue, not request-validation).
- Reject:
  - `rejectionReason` ≥1 trimmed char, ≤500.
  - Fails with 400 if missing or whitespace-only.

### A.7 · Audit-log dual-write
- Every transition writes to `audit/<yyyy-mm>.json` (new monthly journal).
- Every transition writes to `api/_lib/job-audit.js` (legacy per-job log).
- Audit verbs: `itp.instance.created`, `itp.instance.submitted`, `itp.instance.accepted`, `itp.instance.rejected`, `itp.instance.reopened`.
- `/api/audit-log?targetType=itp&targetId=<id>` returns ≥N entries matching N transitions.

### A.8 · Canonical response shape
Every mutation API returns the canonical updated `ITPInstance` (no separate GET round-trip required). Test by mocking + asserting shape.

---

## §B · E1 ITP — preview verification

### B.1 · Vercel preview must reach READY

The PR's branch preview deploy must be in `state: READY` (per Vercel MCP `get_deployment`). Note the deployment ID in the PR description.

### B.2 · Unauthenticated preview smoke

Against the preview URL:
- All `/api/...` endpoints from §A.3 return 401 JSON.
- `/v2/jobs/birdwood-iv3232/itp` gated (HTML 200 of `/v2/login` after middleware redirect).
- `/v2/itp/templates` gated (admin-tier only — same response shape).
- `/phil/jobs/birdwood-iv3232` still returns gated HTML.
- Legacy routes still serve (`/admin/operations`, `/phil`, `/login`, `/my-day`).

Use `mcp__vercel__web_fetch_vercel_url` from the sandbox; or `curl -sL` from operator's machine.

### B.3 · Authenticated preview smoke

Operator runs from their machine (sandbox egress blocks buhlos.com):
```
TRADIE_USER=… TRADIE_PASS=… \
ADMIN_USER=… ADMIN_PASS=… \
ADMIN2_USER=… ADMIN2_PASS=… \
BASE=https://birdwood-…vercel.app \
npm run smoke:auth-e1-itp
```

(`ADMIN2_USER` is required for the four-eyes test — must be a different admin than `ADMIN_USER`.)

Script asserts:
- Template creation → 201
- Instance assignment → 201
- Worker submits → 200 with status=ready_for_review
- ADMIN1 (creator) attempts review → 409 four-eyes
- ADMIN2 reviews accept → 200 with status=accepted, reviewedByName=ADMIN2
- ADMIN2 closes → 200 with status=closed
- Second instance: ADMIN2 rejects with reason → 200 with status=rejected, rejectionReason set
- Worker fixes → status=in_progress, then ready_for_review again
- Audit-log GET returns ≥6 entries
- Evidence regression: worker creates a note evidence on the same job → 201

Exit 0 on full pass; 1 on failure with list of failed checks.

---

## §C · E1 ITP — production verification

### C.1 · Production deploy is the merge commit

After merge, verify:
- Vercel MCP `list_deployments` shows a new `target: 'production'` deployment with `meta.githubCommitSha === <merge sha>`.
- `state: READY`.
- `alias` includes `buhlos.com`.

### C.2 · Production unauth smoke

`npm run smoke:evidence-routes` against `https://buhlos.com` returns 30+/30+ pass. All new ITP routes return their expected status codes.

### C.3 · Production authenticated smoke

Operator runs the smoke script from §B.3 against `BASE=https://buhlos.com`. Same assertions; full pass.

### C.4 · Manual UI verification (Birdwood pilot)

1. Admin creates a TEST E1 ITP TEMPLATE "Power point rough-in checks" with 5 items, 2 with `requiresPhoto`.
2. Admin assigns instance to Birdwood IV3232, stage=roughIn.
3. Tradie (`oskar`) opens `/phil/jobs/birdwood-iv3232`. Confirms:
   - `<JobITPPanel>` renders below the snags panel
   - "1 to do" pill in the header
   - Row appears with status=in_progress and template name
4. Tradie taps the row → `<ITPCompletionSheet>` opens full-screen.
   - All 5 items render with severity pills + acceptance-criteria text
   - Pass/Fail/N-A buttons are ≥48px tap targets
   - Required-photo items disable Submit until a photo is attached
5. Tradie completes all 5 items, attaches photos to the required items, taps Submit.
   - Sheet closes
   - Row in panel flips to status=ready_for_review
6. Admin (`tom`) opens `/v2/jobs/birdwood-iv3232/itp`:
   - Queue shows the submitted instance with submitter name
   - Active filter (default) includes ready_for_review
7. Admin opens the drawer:
   - Per-item responses visible with photo thumbnails
   - History panel shows `itp.instance.created` + `itp.instance.submitted`
   - Accept + Reject buttons available (assuming `tom` ≠ creator/submitter)
8. Admin taps Accept → row flips to accepted; history adds `itp.instance.accepted`
9. Admin taps Close → row moves to "Done" filter; history adds `itp.instance.closed`
10. Repeat steps 1–5 with a second instance.
11. Admin opens drawer → Reject modal → enters "TEST E1 reject reason" → submit.
12. Refresh Phil → rejected instance now shows in worker's panel with rose-bordered alert + reason inline.
13. Tradie taps the row → ITPCompletionSheet re-opens for fixes.

### C.5 · Regression matrix

| Surface | Expected | Verified |
| --- | --- | --- |
| `/v2/jobs/birdwood-iv3232/evidence` | D4 admin evidence still works | □ |
| `/v2/jobs/birdwood-iv3232/snags` | D.5 snags still work | □ |
| `/phil/jobs/birdwood-iv3232` | D1 + D3 capture + D.5 snags + E1 ITP all render | □ |
| `/hours/approvals` | Phase B unchanged | □ |
| `/gear`, `/phil/gear` | Phase C unchanged | □ |
| `/v2/jobs` | D6 index now includes ITP counter chip per row | □ |
| `/admin/operations`, `/phil`, `/login`, `/my-day` | legacy routes still serve | □ |
| `/api/audit-log?targetType=evidence` | still works | □ |
| `/api/audit-log?targetType=snag` | still works | □ |
| `/api/audit-log?targetType=itp` | new — accepts | □ |

### C.6 · Rollback criteria

Rollback to `dpl_995h3eh8H5ksE6WYsz7FbJtsv71m` only if:
- Workers can't access `/phil/jobs/[jobId]` (Phil broken)
- Admin can't access `/hours/approvals` or `/v2/jobs/[jobId]/evidence` (D4 broken)
- 5xx rate >1% on any pre-existing route
- Data corruption observed in evidence, snags, or hours

Do NOT rollback for:
- E1 ITP-specific bugs (fix forward via E1.1 hardening)
- UI polish issues
- Test-data cleanup failures
- Single-user reproducible bugs

---

## §D · E1 ITP — test data conventions

| Record type | Naming pattern | Cleanup |
| --- | --- | --- |
| ITP template | `TEST E1 ITP TEMPLATE <ISO>` | archive at end of test (if archive ships); otherwise leave + report |
| ITP instance | `TEST E1 ITP INSTANCE <ISO>` | drive to `closed` via accept path, or `closed` via reject → fix → accept → close |
| Snag (if linked) | `TEST E1 LINKED SNAG <ISO>` | close via snag lifecycle |
| Evidence | `TEST E1 EVIDENCE <ISO>` | leave (D2-L2: no automated cleanup endpoint) |

The auth-smoke script (§B.3) handles its own cleanup. Manual UI tests leave records that the operator closes via the UI; remaining records reported in the session report.

Vercel Blob dashboard cleanup path (manual, last resort):
1. Filter `jobs/<jobId>/data.json` — edit JSON, remove TEST entries from `itpsV1[]` and `snagsV2[]`.
2. Filter `audit/<yyyy-mm>.json` — leave (append-only by design).
3. Filter `itp-templates.json` — remove TEST templates.

---

## §E · E2 RFI testing (placeholder)

When E2 ships, this section mirrors §A–§D for the RFI loop. Specifics depend on the E2 build prompt (whether external email integration ships or not). Document at planning-doc-time.

---

## §F · E3 Materials testing (placeholder)

When E3 ships, this section mirrors §A–§D for the materials loop. If E3 splits into E3a (request) + E3b (delivery + reconciliation), each gets its own subsection.

---

## §G · Phase E exit gates

Phase E is "complete" when:
- E1 ITP has been live in production for ≥30 days without rollback.
- E1 ITP has ≥1 real (non-TEST) completion accepted by a real reviewer.
- E1 four-eyes rule has fired at least once in a real session (not just test).
- E2 RFI plan exists OR explicit decision to defer.
- E3 Materials plan exists OR explicit decision to defer.
- Doc 23 ship table updated.

Until all gates pass, Phase E remains "shipping in progress" in the rebuild index.

---

## Cross-references

- [26-phase-d-testing-checklist.md](26-phase-d-testing-checklist.md) — Phase D testing precedent.
- [28-d2-d3-d4-evidence-qa-checklist.md](28-d2-d3-d4-evidence-qa-checklist.md) — evidence loop QA precedent.
- [phase-d55-snags-runbook.md](phase-d55-snags-runbook.md) — proven authenticated smoke pattern E1 mirrors.
- `scripts/smoke-evidence-routes.js` — unauthenticated smoke; E1 extends.
- `scripts/auth-smoke-d55-snags.sh` — authenticated smoke; E1's companion mirrors.
