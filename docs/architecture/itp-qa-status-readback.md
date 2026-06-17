# Cross-job QA status readback (ITP) — #290, first increment

> Status: **read-only office QA-exposure dashboard.** First narrow increment of
> #290 (Epic 11 — ITP & QA). Route `/qa`. The ITP analog of the job-control
> proof-status view ([job-control-required-proof-authoring](job-control-required-proof-authoring.md)).
> Reuses the proven *compile → status-readback* pattern.

## Why

QA state was only visible job-by-job (`/v2/jobs/[jobId]/itps`) or in the deleted
legacy SPA. The office had no v2 answer to "what is our QA exposure right now" —
which checks are sitting unwitnessed, which jobs are drifting toward an audit
finding. This surfaces that across every active job, worst-first.

## What it does

A read-only `/qa` admin page showing, per active job:
- ITP **instance counts by status** (`pending` / `in-progress` / `witnessed` / `signed-off`),
- **open points** (required, not-yet-recorded, across active instances),
- **oldest active age** (whole days since the oldest active instance's
  `updatedAt`/`createdAt`),
- **awaiting sign-off** (witnessed) highlighted,

sorted worst-first (most awaiting sign-off → oldest active age → name), each row
**drilling through** to the existing `/v2/jobs/[jobId]/itps` surface (no duplicate
detail view, per the #290 AC).

## How a check reaches "awaiting sign-off" (the Submit-for-review handoff)

An ITP only counts as **awaiting sign-off** once it's `witnessed`. Reaching
`witnessed` is an **explicit step**: after every required point is recorded, the
worker (in Phil) or the office (in the admin queue) taps **"Submit for review"** —
`POST /api/job-itps?action=submit`, guarded by the pure `canSubmitForReview`
([`src/domains/itp/service.ts`](../../src/domains/itp/service.ts)).

This replaced the older *implicit* behaviour where recording the last required
point silently flipped the instance to `witnessed`. The implicit flip left the
office no signal that work was *declared* done versus merely *recorded*, and gave
the worker no deliberate "send it in" moment. Now `record` only auto-advances
`pending → in-progress`; `in-progress → witnessed` is the submit verb. The rollup
is unchanged — it still counts `witnessed` as awaiting sign-off — but a job now
appears in that column when someone **submits**, not as a side effect of the last
record.

## Aggregation strategy (the #290 AC: documented + cost)

There is **no cross-job ITP index**. The reader
([`src/server/itp/qa-status.ts`](../../src/server/itp/qa-status.ts)) therefore
**scans `jobs/<jobId>/itps.json` for every active job** — the same per-job-blob
fan-out the legacy dashboard and the `api/jobs.js?withStats=1` ITP scan already
pay, and the same shape as the hours-ledger scan (PR #89).

- **Cost:** one Blob read per active job, run **in parallel** (`Promise.all`).
- **Resilience:** a single job whose blob fails to read is recorded in
  `failedJobs` and skipped — it never crashes the board (surfaced honestly in the
  UI, not hidden). A failure *listing* jobs returns `{ ok: false }` (a distinct
  state from an empty board).
- **Deferred optimization:** a real cross-job ITP index (write-time projection)
  is the follow-up if the scan cost bites; until then the cost is bounded by the
  active-job count.

The aggregation itself
([`src/domains/itp/qa-rollup.ts`](../../src/domains/itp/qa-rollup.ts)) is **pure**
(no I/O, `now` injected) and reuses the ITP domain's own semantics —
`isActive` and `formatProgress` (`src/domains/itp/format.ts`) — so the dashboard
and the per-job ITP surface agree on status/progress (P7, no drift).

## Honesty rules

- **Oldest active age** is computed only from real timestamps — **no invented due
  dates** (the AC's "overdue from data that exists").
- A job with **zero ITPs** renders as a **gap** ("No ITPs attached"), never as
  all-clear.
- Archived instances are excluded; signed-off instances are not "active".
- **Read-only** — the page and reader write nothing, compile nothing, and gate on
  `isAdminRole` (server-side direct read, like the Phil/job-control readers).

## Explicitly NOT in this increment (follow-ups)

- **Pass rates** — belong to the completion-analytics child (#297) and need
  per-point verdict logic; this readback answers "what's open / stuck /
  unwitnessed", not "pass %".
- Filters / search / charts; **active hold-points** display (depends on #288);
  cross-job index.

## Files

- `src/domains/itp/qa-rollup.ts` — pure rollup + dashboard (+ tests).
- `src/server/itp/qa-status.ts` — admin read-only reader (scan + aggregate; + tests).
- `src/components/admin/QaStatusBoard.tsx` — pure presentational board (+ render tests).
- `src/app/(admin)/qa/page.tsx` — admin-gated page.
- `src/components/admin/nav.ts` — "QA status" nav item (Jobs group).
