# Job lifecycle — finishing, the callback window, closing, reopening

**Status: implemented 2026-09-24 (this document is the contract).**
Governs both surfaces. Sits under the lean reset (basic jobs stay basic — no
closeout wizard, no new module) and the task-led architecture (a job is the
operating context; nothing here changes task identity). It amends no Phil
principle: the crew's lists are views, and views stay views.

## The problem it solves

Until now a job had one `status` and no notion of time. Marking it `complete`
hid it from the crew **that instant** (#349), while the hours API still accepted
it — so the only way to log the callback everyone knew was coming was for the
office to flip it back to Active, and the only way to keep the crew's job list
short was to never mark anything finished. Fifteen production jobs, all
`active`, none ever completed: the dead end in one number.

## The model (smallest that fits)

One stored status, unchanged: `draft · active · on_hold · complete · archived`.
Two stamps the jobs PUT writes: `completedAt` (+ `completedByUserId`) when the
status crosses **into** `complete`, `reopenedAt` when it crosses **out**. Two
**derived** phases — no new stored state, no sweep, no cron:

| Stored status | Phase | Crew: in default lists? | Crew: can open / log? | Office |
| --- | --- | --- | --- | --- |
| `active` | **Active** | yes | yes | working portfolio |
| `on_hold` | **On hold** | yes (marked) | yes | working portfolio |
| `complete`, `completedAt` < 30 days ago | **Finished** (finishing) | yes — "Finished · log until 24 Oct" | yes | working portfolio, "Finished" pill |
| `complete`, later (or no stamp) | **Closed** | **no** — found by search | yes, by deliberate pick | history, "Closed" pill |
| `draft` | Draft | no | no | office-only |
| `archived` | Archived | no | **no** | history, "Archived" pill |

- **`GRACE_DAYS = 30`**, one constant in `api/_lib/job-lifecycle.js` (the callback
  window: defects, commissioning, the forgotten item).
- The phase is `jobPhase(job, now)` — the **only** predicate any consumer may
  use. The three "field-visible" rules that used to disagree (jobs API, Phil
  page loader, `isVisibleToField`, the hours gate) now all call it.
- A `complete` job with **no** `completedAt` (set before stamping existed) reads
  as **closed** — the same behaviour it had, never a silent 30-day window.

## Transitions (all via `PUT /api/jobs { id, status }`, admin tier only)

| From → to | What is written | Journal |
| --- | --- | --- |
| anything → `complete` ("Mark finished") | `completedAt = now`, `completedByUserId` | `job.closed` |
| `complete` → `active` ("Reopen") | `reopenedAt = now`; `completedAt` **kept** (history) | `job.reopened` |
| `complete` → `archived` | `reopenedAt = now` (it left the finished state) | `job.reopened` |
| re-finish after a reopen | `completedAt` moves forward — the window restarts | `job.closed` |

Every transition also lands in the per-job audit (`jobs/<id>/audit.json`,
kind `status`) as before. The cross-job journal entries (`audit/<month>.json`,
`targetId = <jobId>`) carry `fromStatus`, `toStatus`, `completedAt`,
`reopenedAt`, so "when was it finished, by whom, was it reopened" is answerable
after the per-job log trims.

There is no closeout wizard and no transition rule that refuses a status: the
office may set any status at any time. Two picks ask first — Finished and
Archived — because they change what the crew see.

## Worker experience (Phil)

- **Jobs tab / hours picker:** the default set = active + on hold + finishing.
  Finishing rows carry "Finished · log until <date>". Closed jobs are not in the
  list — the **same search box** reaches them (two characters → the server's
  `GET /api/jobs?scope=history&q=`), shown under "Finished jobs" / on the dial as
  "<name> · Closed <date>". Picking one shows "Closed <date> — these hours are a
  callback" on the picked line, and the receipt names the job. No new nav slot
  (P10); the closed state is visible where the worker is (P9).
- **Job page:** opens for any finishing or closed job (by list, search or an old
  link) with the lifecycle line under the name. Draft/archived still 404.
- **Hours:** the API accepts active, on-hold, finished and closed jobs; refuses
  draft and archived. Nothing about approval, payroll or Xero reads job status.

## Office experience (BuhlOS)

- **Hub:** the status pill is the control. "Complete" now confirms:
  *"Mark this job finished? The crew can keep logging hours to it until
  <date>; after that it leaves their list but stays in search, still takes
  callback hours, and can be reopened any time."* Archived confirms too. On a
  finished job the Active choice reads **Reopen**. The health band shows the
  lifecycle line ("Finished 3 Sep · crew can log until 3 Oct", "Closed 3 Sep…",
  "Reopened 20 Sep (finished 3 Sep)").
- **Jobs list:** pills are phases — Active · On hold · Finished · Closed · Draft ·
  Archived. "All" = the working portfolio (never closed/archived), so a closed
  job's stale tag can't keep "need attention" lit. `?status=complete` from an
  old bookmark lands on Closed.
- **Search (⌘K):** every job, subtitled "Active" / "Finished 14 Aug" /
  "Closed 14 Aug" / "Archived".

## Data-preservation guarantee

Closing, archiving and reopening change **prominence**, never records:

- jobs are never deleted by any of this (the only hard delete stays the
  QA-prefixed test-data path);
- time entries keep their `jobId` and resolve the job's name for payroll and
  Xero from `jobs.json` whatever the status (`payroll-inputs.js` reads name only);
- approved / locked / exported hours and payroll batches are untouched — nothing
  in this feature writes to them, and the batch tables are trigger-immutable;
- photos, tags, ITP records, materials and supplier-invoice allocations keep
  their job reference; their APIs read job existence, not status;
- `completedAt` is kept on reopen, so the history of a job that finished twice
  is in the journal, not overwritten.

## Storage

Blob `jobs.json` is authoritative for jobs
(`docs/architecture/data-ownership-map.md`); the two stamps are plain fields on
the row and ride the `jobs-summary.json` projection unchanged. The Postgres
`jobs` mirror is structure-only and does **not** carry them yet — a nullable
`completed_at` / `reopened_at` pair is the follow-up when jobs move toward a
PG-served read (`supabase-served-source-roadmap.md`). No migration in this
change; nothing reads the stamps from PG.

## Permissions

- Mark finished / reopen / archive: admin tier (`canManageJob`); leading hands
  are refused on `status` as before; field never.
- Log hours to a finished or closed job: field, LH and office — same as active.
- Open a closed job: anyone who could open it while active.
- View archived: admin tier only.

## Not built (deliberately)

A closeout snapshot of "final numbers", a callback counter, a job-history
dashboard, an automatic "reopen on callback hours". The stamps + journal make
all of these derivable later; none is asked for yet (pull, not push).
