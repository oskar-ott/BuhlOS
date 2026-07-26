# Hours — the operational loop

_Status: live. This documents the end-to-end daily hours workflow across Phil
(field) and BuhlOS (office) as it actually works, plus the last-mile fixes that
closed the loop. Scope: the daily submit → review → result loop only — not
payroll finalisation, Xero, or weekly batch submission._

## The loop

```text
Worker logs hours in Phil.            POST /api/time-entries (status: submitted)
Office sees them in BuhlOS.           /hours + /hours/approvals (scope=approver)
Office approves or rejects.           POST /api/time-entries-approve | -reject (reason required)
Worker sees the result in Phil.       /phil/my-day week strip + status line + push notification
Worker can change a sent day          "Change these hours" on a submitted (undecided) day —
until the office decides.             content-edit PATCH, journalled hours.edited_while_submitted
                                      (2026-07-26 owner-directed)
Rejected hours are fixed in place.    /phil/my-day?fixDate= → inline fix-and-resubmit (PATCH → submitted)
Approved hours are locked.            PATCH 403 for non-admin; admin uses /api/time-entries-reopen
State persists.                       Vercel Blob: users/<userId>/time-entries/<date>.json
```

## Worker (Phil)

- **Home: `/phil/my-day`.** Week strip (Mon–Sun, real entries), one yellow
  action — _Log today's hours_ (Standard day `7h 36m` = 456 min, the
  `STANDARD_DAY_HOURS`/`STANDARD_DAY_MINUTES` constants), date back-dateable
  14 days, custom hours + note tucked behind a disclosure.
- **Attribution:** hours are always tied to an active assigned job
  (`users.json.assignedJobIds`) — see `docs/phil-hours-job-attribution.md`.
  One job → preselected; multiple → required pick; zero/failed → submit blocked
  honestly.
- **Status for the selected day** shows on the status line: Draft / Submitted /
  Approved / Rejected (with the office's reason).
- **Rejected → fix in place.** The rejection notice carries the inline
  fix-and-resubmit sheet (`RejectedHoursResubmitSheet`, the same component
  `/phil/hours` uses). Single-allocation entries only — a split day says so
  honestly and stays a legacy/office fix.
- **Deep link:** `/phil/my-day?fixDate=YYYY-MM-DD` selects that day and
  auto-opens the fix sheet. The "Hours rejected" push notification and the
  Needs You feed both use it, so the fix is one tap away. Invalid values are
  ignored (`parseFixDate`). The entries window stretches to include an older
  `fixDate` so the entry to fix is always loaded.
- **Sent day, not decided yet → the worker can still fix it** (2026-07-26
  owner-directed). A submitted day shows "Sent to the office — waiting for
  approval" plus a quiet "Change these hours" affordance (the same fix sheet
  the rejected flow uses, with change-and-resend words and a named
  consequence: the office gets the new version). The edit is a content PATCH
  (status stays `submitted`), stamps `editedWhileSubmittedAt` and journals
  `hours.edited_while_submitted`.
- **Duplicates:** one entry per worker+date. The server answers 409 on a
  duplicate POST; a selected day that's already submitted/approved never shows
  the log actions — it shows its status (and, for submitted, the change
  affordance; approved says it's locked for pay) instead of a dead button.
- **History:** `/phil/hours` (linked from the week strip) lists every entry
  with status, reason, and the same fix-and-resubmit flow.

## Office (BuhlOS)

- **`/hours`** — today's closeout (pending / approved / not-submitted with a
  ready-to-close verdict), queue-depth cards, week-navigable rollup (totals by
  job / worker / status), **missing hours per worker** (server-detected from
  assigned crew), payroll export dry-run preview.
- **`/hours/approvals`** — the review queue: submitted entries grouped by
  worker (longest-waiting first) with worker, role, date, hours, note, and
  job allocation (amber "No job assigned" flag for legacy null attribution).
  **Approve** in one tap; **Reject** requires a reason (it is pushed to the
  worker verbatim). Empty state is honest ("No entries to approve").
- **Leading hands** see/action only entries on jobs they run, never another
  LH's entry. Self-approval is impossible for everyone.

## Status transitions (server-enforced)

```text
draft     → submitted          worker (or staff on behalf)
submitted → approved           admin/LH via /api/time-entries-approve (never self)
submitted → rejected           admin/LH via /api/time-entries-reject (reason required; 30s undo)
submitted → submitted          worker content-edits a sent, undecided day (2026-07-26
                               owner-directed); stamps editedWhileSubmittedAt, journals
                               hours.edited_while_submitted; attribution gate applies
rejected  → submitted          worker fixes + resubmits (PATCH; attribution gate applies)
approved  → (locked)           PATCH 403 for non-admin; admin /api/time-entries-reopen
```

Not possible: worker editing/resubmitting an approved entry, approving via
PATCH, rewinding submitted → draft, rejecting without a reason, duplicate
active entries for one worker+date, field self-edits re-allocating hours to a
draft/archived/unknown job or to NO job — a `jobId: null` allocation on a
field self-edit PATCH is refused server-side (2026-07-26 owner-directed; the
create path keeps its backward-compat null acceptance — see
`docs/phil-hours-job-attribution.md`).

## Notifications

Approve/reject push notifications deep-link to the **live Phil surface**:

- rejected (single + bulk): `/phil/my-day?fixDate=<date>` — opens the fix sheet
- approved: `/phil/my-day` — status visible on the week strip

(They previously pointed at legacy `/my-day`; the legacy page keeps its own
`?fixDate=` handler for direct visits.)

## The weekly layer on top

The business closes hours **week by week**: `/hours/weekly` (PR #113, see
`docs/hours-weekly-closeout.md`) rolls these daily entries into a payroll-
readiness board — who's ready, who's blocking, approve/reject in place. It is
a pure projection over this loop; nothing below changed.

## What this loop is NOT (yet)

- **Weekly batch "Submit timesheet"** — does not exist by design; logging a day
  already submits it. Don't fake it.
- **Bulk approve a worker's week in BuhlOS v2** — the API exists
  (`/api/time-entries-bulk-approve`) and legacy `/admin/hours` uses it; the v2
  queue approves per entry. Candidate next PR.
- **Committed payroll export / Xero** — recording a payroll run is now the
  immutable payroll-batch flow on `/hours/period` (create → validate → lock →
  Export to Xero / Download batch CSV). The legacy stamp-based committed run and
  POST finalise are **retired** (#895); `/api/time-entries-export` is read-only
  preview/download. The Xero draft-timesheet write (#249) rides its own
  `xero_payroll_export` flag — DRAFT timesheets only, no pay run.
- **Admin reopen from the v2 UI** — API exists (`/api/time-entries-reopen`),
  surface is legacy for now.

## Tests that pin the loop

- `src/domains/time-entries/time-entry-attribution-api.test.ts` — create + edit
  attribution gates, duplicate 409, approved-entry lock.
- `src/domains/time-entries/time-entries-api.test.ts` — self-approval flip
  prevention, PATCH allowlist.
- `src/domains/time-entries/time-entry-actions-api.test.ts` — approve/reject
  role scoping, LH gating, bulk actions, push deep-link URLs, export
  eligibility.
- `src/domains/timesheets/timesheets.test.ts` — constants (7.6h/456m), payload
  builders, transitions, `parseFixDate`.
- `src/components/phil/LogHoursSheet.render.test.tsx` — attribution states,
  rejected inline-fix states, deep-linked date.
- `src/components/admin/HoursApprovalsQueue.render.test.tsx` — queue job
  context display.
- `tests/playwright/smoke/field-readiness.spec.ts` — live wire-level
  attribution proof (POST captured + aborted) and the admin queue render.
