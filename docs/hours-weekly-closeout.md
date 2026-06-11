# Hours — weekly closeout / payroll readiness

_Status: shipped in `feature/weekly-hours-closeout` (PR #113). Scope: the
weekly control layer over the #112 daily loop — NOT payroll finalisation,
wage calculation, Xero, or export._

## The model

Workers log **day by day** in Phil (that part is #112 and is unchanged).
The business closes hours **week by week** in BuhlOS:

```text
Workers log daily hours in Phil.          (unchanged)
BuhlOS collects the week.                 /hours/weekly?week=<any date in week>
Boss reviews the week.                    decision-first board, not a raw table
Boss approves/rejects submitted days.     same endpoints as /hours/approvals
Clean approved weekly hours = payroll-ready.
Xero / committed export comes later.      (out of scope, unchanged)
```

There is **no daily closeout** and **no worker "Submit timesheet" button** —
daily entries are submitted as logged; the weekly closeout is a boss/admin
concept. (The pre-existing "Today's closeout" card on `/hours` predates this
and was deliberately not extended.)

## Where things live

- **BuhlOS `/hours/weekly`** — the closeout board. Server component fetches
  ONE existing endpoint (`/api/time-entries-overview?fromDate&toDate` for the
  Mon–Sun range) and derives everything through the pure
  `buildWeeklyHoursCloseout()` (`src/domains/timesheets/weekly-closeout.ts`).
  Linked from the `/hours` hub; week-navigable with the same `?week=`
  convention as `/hours`; admin-gated by the existing middleware prefix.
- **Phil `/phil/hours`** — a worker "This week" summary (`PhilWeekSummary`)
  above the history: per-day status in worker words, week verdict, and
  one-tap **Fix** / **Log** actions that deep-link into the existing
  `/phil/my-day?fixDate=` flow. No payroll language, no admin verbs.
- **Phil My Day strip** — `philWeek.ts` is now status-aware: a **rejected**
  day renders as red "fix" (never a calm green "logged"), submitted days say
  "waiting", approved days say "approved", drafts read amber "draft".

## Readiness rules (buildWeeklyHoursCloseout)

Per worker, per day (Mon–Sun):

| Day state | Source |
| --- | --- |
| `approved` / `submitted` / `rejected` / `draft` | the day's real entry status |
| `missing` | ONLY the server's `missing[]` from `/api/time-entries-overview` |
| `future` | date is after today (business timezone) |
| `not-required` | weekend with no entry, or a past weekday the server doesn't track for this worker |

Worker readiness (single label, counts shown alongside):

```text
needs-review    any submitted day      → admin's move (approve/reject in place)
needs-worker    any rejected/draft day → worker's move (fix/submit)
missing-hours   any missing day        → chase the worker to log
payroll-ready   none of the above and ≥1 approved day
```

The **week** is payroll-ready only when every included worker is
payroll-ready. An empty week is never payroll-ready — it renders an honest
empty state. Approved totals are summed per worker and sliced per job from
allocations (approved entries only — the `/hours` rollup's byJob mixes all
statuses; this one is the payroll-relevant slice).

## Missing-day honesty

Missing days are **consumed, never derived**: the server's existing detection
(`api/time-entries-overview.js`) flags assigned crew with no entry on
weekdays, past/today only. The model adds nothing to it:

- future days are never missing;
- weekends are never missing;
- no roster/schedule is guessed;
- workers appear on the board ONLY if they have an entry or a server-flagged
  missing day — no fabricated rows.

**Tracked-worker rule (#114 — the #113 limitation is resolved):** the crew
filter now uses the shared `isHoursTrackedWorker(user)` helper
(`api/_lib/auth.js`) instead of literal `tradie`/`leadingHand` matching.

| Tracked (expected to log hours) | Not tracked |
| --- | --- |
| the whole field tier: `tradie`, `electrician`, `apprentice`, `labourer` | admin/office tier: `admin`, `boss`, `owner`, `manager`, `office`, `pm`, `estimator` |
| leading hands in every stored spelling (`leadingHand`, `leadinghand`, `leading_hand`, `lh` — normalised) | `client`, unknown roles |
| live accounts only | archived / disabled accounts (not expected to submit — same liveness rule as `listTradies`) |

This is an EXPECTATION tier (who the office chases), deliberately distinct
from the `canSubmitHours` permission and from "can be assigned to jobs". The
fix is server-side only — `/hours`, `/hours/weekly` and the command-centre
card all consume the same corrected `missing[]`; no client-side missing-row
generation was added, and future-day / weekend handling is unchanged.

**Known follow-up (found in #114, deliberately not changed):** the overview's
*viewer* scoping still literal-matches `viewer.role === 'admin'`, so
admin-tier viewers other than literal `admin` (office/boss/pm…) get
LH-scoped — likely empty — overview data. That's a viewer-visibility rule,
not the tracked-worker rule, and widening it deserves its own reviewed PR.

## Actions and safety

The board calls the **same** endpoints as `/hours/approvals` via
`timesheetsClient` — `POST /api/time-entries-approve` and
`POST /api/time-entries-reject` (reason required; pushes the reason to the
worker with the `?fixDate=` deep link). After every action the route is
refreshed so the model is rebuilt from persisted state. Nothing else is
mutated from this surface; everything #112 guarantees (approved lock,
attribution gate, duplicate 409, LH scoping, self-approval block) is
untouched. Bulk "approve worker's week" stays out — the bulk API exists but
wiring it here was deferred to keep this PR's write path identical to the
proven queue.

## Tests

- `src/domains/timesheets/weekly-closeout.test.ts` — week shape, grouping,
  approved totals (worker + per-job), every readiness rule, future-days-never-
  missing, missing-only-from-server, ordering, labels.
- `src/components/admin/WeeklyHoursCloseoutBoard.render.test.tsx` — readiness
  summary first, needing-action before ready, approve/reject on submitted
  days, rejected shows reason + "Waiting for worker", honest empties, no
  fabricated missing.
- `src/components/phil/PhilWeekSummary.render.test.tsx` — worker words only,
  Fix/Log deep links, future days never flagged, drafts truthful without a
  dead-end action, weekends hidden unless worked.
- `src/components/phil/philWeek.test.ts` — status awareness (fix/waiting/
  approved/draft), honest week tallies; existing pins unchanged.
- `src/middleware.test.ts` — `/hours/weekly` auth-gated + admin-passable.
