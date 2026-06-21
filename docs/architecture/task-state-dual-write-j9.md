# J9 — Task state dual-write mirror

Part of the Blob→Postgres migration (#152). J8 mirrors job STRUCTURE; J8.5/J8.75
made the structure read overlays load-bearing. J9 migrates the highest-value
operational WRITE — **task status** — without making Postgres authoritative.

Blob stays authoritative; Postgres becomes a live mirror; the field write path is
unchanged.

## Delivery — off the request path, dependency-free

Task toggles are high-frequency, so the mirror must add **zero** latency to the
field interaction. Constraints in this repo: `@vercel/functions` is not a
dependency (so no `waitUntil` without adding one to the shared install), and the
proven async primitive is **crons** (the hours sync-check cron). So:

> The task-toggle's existing `data.json` write IS the durable enqueue; a
> CRON_SECRET-gated reconciliation cron is the async mirror worker that drains it
> to Postgres.

`api/task-toggle.js` is **unchanged** — the request path gains nothing. The mirror
runs entirely in `/api/internal/mirror-tasks` (cron).

## What the mirror does

`api/_lib/task-mirror.js` reconciles per-job task STATUS (the authoritative
`jobs/{id}/data.json` dwellings) into `public.tasks.status`, appending one
append-only `public.task_status_events` row per **real transition**:

- Reuses the ONE expansion engine (`buildTaskProjection`) — **no new task
  identity**. Resolution is the existing bridge:
  `(jobId, areaId, stage, taskId) → (tenant, job_id, site_area_id, stage,
  legacy_template_id) → tasks.id`.
- **Status only** in `{not_started, in_progress, complete}`. An unknown status is
  rejected by the projection gate (job **quarantined + reported**) — never coerced
  (the schema CHECK forbids anything else anyway).
- **Idempotent:** `UPDATE … WHERE status IS DISTINCT FROM` + an event **only for
  rows the UPDATE actually changed**. A replay with no change writes 0 rows / 0
  events. No dedupe index needed (idempotency is in the transition logic).
- **Event:** `from_status` = the prior PG status, `to_status` = the Blob status,
  `source = 'mirror'`, `actor_label` = the area's `lastTouchedBy` (best-effort).
- **Triple-gated** so production is inert: no `SUPABASE_DB_URL` → skip;
  `supabase_dual_write_tasks` flag off (default) → skip; `getDb({mode:'write'})`
  env guard. **Best-effort** — never throws; a PG failure can never affect a
  worker's toggle (which already succeeded against Blob).

## Verification — task-status sync-check

The existing structure sync-check already compares task **status** (it's in the
per-task hash), so status drift is a per-key mismatch → PASS/FAIL already works.
J9 surfaces **status totals** (`not_started`/`in_progress`/`complete` counts, blob
vs pg) on the tasks section for visibility. PASS criteria for tasks:
`hash_match` true · orphans 0 · duplicates 0 · unresolved 0.

## Honest scope / tradeoffs

- **Net transitions, not every tap.** Reconciliation captures the net status
  change since the last drain; rapid flap (complete→not_started→complete between
  drains) records no event. The end state is always correct; the event log is
  net-accurate. A per-toggle delivery (waitUntil/outbox) would capture each tap +
  exact actor — a later refinement (needs `@vercel/functions`).
- **Lag = cron interval.** PG trails Blob by up to the cron interval. Irrelevant
  while the task READ stays on Blob (J10 is the read cutover); increase the cron
  frequency before relying on PG task reads.
- **Reconciles all jobs each run.** Fine at current scale; a `lastTouchedAt`
  dirty-filter is an easy later optimization.
- **Cron registered daily** (`vercel.json`), dark (no-op without env + flag);
  raise frequency when going live.

## Dev validation (dev project)

Toggle a task → reconcile → **PG status mirrored + one transition event**;
**idempotent replay → 0**; a second toggle → +1 event (correct transition); **PG
outage → best-effort skip, Blob intact**; status parity (blob == pg). Then fully
reverted (data.json + the job's PG statuses restored, test events deleted). The
task-toggle request path was not touched.

## Not in J9

Task READ cutover (Phil/admin reading task status from PG — J10), proof/evidence
workflows, schema changes, production rollout, per-toggle waitUntil delivery,
Blob retirement.
