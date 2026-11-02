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
- **A day logged on a job by mistake can become a sick day / holiday — and
  back** (owner pull 2026-10-11: four of the crew logged the 5 Oct public
  holiday as a normal job day, and nothing could turn it into a holiday). The
  same change / fix sheet opens with a "This day" row — Job day · Sick day ·
  Holiday (TAFE day for apprentices) — the same words and order as the
  office's Fix; picking a leave type hides the job and the overtime presets
  and sends `dayType` with a `jobId: null` allocation, all ordinary
  (`buildDayTypeResubmitPayload`). A day-type day opens AS its type; tapping
  "Job day" brings the job picker back and sends `dayType: null` (the server
  keeps a day type unless the patch names one), so the job gate applies
  again. Before this, a sick / holiday / TAFE day couldn't be changed in Phil
  at all.
- **Every failure explains itself (owner pull 2026-10-11: "clear instructions
  to pop up if there is an error — simple explanations of what went wrong and
  why").** A refused or unanswered hours action pops up `ProblemDialog`: what
  didn't happen ("Fix not saved"), what went wrong ("You can't do this to your
  own hours"), why, and **What to do** — plus "Try again" only when retrying
  can work. The words come from ONE pure translator,
  `src/domains/timesheets/problem.ts` (`explainHoursProblem`), which reads the
  server's own reason from the response body — before this the screens showed
  the browser's status word ("Bad Request", "Conflict") because
  `src/lib/http.ts` puts `statusText` in `error.message`. Wired into the
  worker's log sheet, change / fix sheet and send-week, the phone closeout's
  approve / send back / Fix / undo (replacing the "try again" toasts), the
  `/hours/approvals` queue, and both Send to Tia screens. The same words stay
  inline after the pop-up closes; nothing typed is lost.
- **Nothing halts the pay run (owner pull 2026-10-12: "if any problems come
  up approving and exporting timesheets it doesn't halt the process — clear
  instructions and simple remedies").** Every hold-up comes with its fix,
  where the boss already is:
  - **The phone closeout's last screen** ("Week reviewed") lists every day
    still holding the week up, by name and day, each with a one-tap fix
    (`src/domains/timesheets/week-holdups.ts`): *waiting for approval* →
    **Approve** · *approve didn't go through* (an approve this session that
    failed, with why) → **Approve again** · *sent back for a fix* → **Take it
    back** (reopen to submitted, then approve or Fix it) · *saved but not sent
    in* → **Send it in for them** (submitted on the worker's behalf; the
    server records the office as the sender) · *nothing logged* → named only.
    **Check** opens that person's days and comes back. "Wait for the full
    week" is gone; **Send without those N days** is always one tap (the sheet
    names every day it leaves off). Which days hold the send is unchanged —
    mid-flight days only; drafts and missing days inform (owner call
    2026-08-17). Lines move the moment a write lands (a per-day session map),
    never on a re-read that can trail the write by a minute.
  - **A week's days are approved at the same time, not one after another.**
    Each day is its own day-file (own verified read + compare-and-swap), so
    `time-entries-bulk-approve` decides up to 6 at once; the worker's shared
    audit file gets ONE append for the lot (`appendAuditMany`) — that shared
    file was the only reason the loop was sequential. Measured on the stored
    approvedAt stamps: ~2.6s per day on the 5 Oct run and ~16s per day for
    four of the crew on 28 Sep, each day waiting for the one before. Each day
    is still stamped right before its own write (2026-09-21 rule).
  - **Every closeout write ends.** Bulk approve (60s), fix (30s) and reopen /
    send-in (20s) carry timeouts — an unbounded approve on bad signal kept
    "Saving approvals…", and the Send behind it, locked for good. A day the
    server says is ALREADY approved counts as done, so a retry after "no
    answer" never errors (phone and desktop board).
  - **A send that fails always has a way through:** try again; **Send without
    it/them** when days couldn't be read (named, then printed on the sheet as
    "couldn't be read, check before paying"); or **Download the PDF** and email
    it to Tia yourself — on both Send to Tia screens.
  - **Downloads never open a page of JSON.** The /hours/period PDF / CSV
    buttons fetch first: "still saving" is waited out by itself; a day that
    can't be read is named with **Download without it** (PDF only — a CSV is
    keyed into Xero and has no "Not on this sheet" list, so it never skips).
  - **The desktop weekly board speaks the same words** (problem.ts) — no more
    "Conflict" / "Bad Request" — and a bulk approve's failed days get **Try
    again**.
- **No hours reminder on a public holiday.** The weekday "Did you log your
  hours?" push (`send-daily-reminders`) skips NSW public holidays — the boards
  never ask for hours on one, and on Labour Day 2026 the push had the crew
  logging the holiday as a job day.
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
  LH's entry. Self-approval is impossible for everyone **except the Admin /
  Owner** (`canApproveOwnHours`: `admin` and its legacy aliases `boss`/`owner`),
  who has nobody above them to sign their hours off (owner pull 2026-10-25).
  Approve only, single and bulk — fixing or sending back your own hours stays
  refused for everyone; the rest of the office (office/pm/estimator/manager)
  and every leading hand still cannot approve their own.
- **Fix it and approve** (admin tier only, reason required, submitted days
  only — `api/time-entries-amend-approve.js`) sits on every day of the phone
  closeout (`/hours/weekly`, "Fix") and on the `/hours/approvals` queue — one
  editor, `AmendHoursEditor`. Since owner pull 2026-10-11 ("switch someone's
  day from the mobile admin process" — the 5 Oct public holiday logged as job
  days) it can also switch **what the day is**: a "This day" row offers Job
  day · Sick day · Holiday (TAFE day for an apprentice). A switched day is one
  job-less time, all ordinary; the before-type is kept in `amendedFrom.dayType`
  and the worker's line reads "Adjusted by the office — Job day → Holiday ·
  7h 36m: <reason>", with a push saying what the day became. On a public
  holiday, picking Holiday starts the reason as "<holiday> — public holiday"
  (editable; never replaces typed text). "Job day" is only offered when the
  day was job work (it restores those jobs); a day already logged as leave
  says so and goes back to job work through the worker, who knows the job
  (the API refuses a job-less "job day").
- **Worker names are FULL names, never nicknames** (owner-directed 2026-08-16,
  #1020; extended to the job hub's Labour card by #1027). Hours feed payroll,
  so every office surface labels a worker the way the payroll PDF does:
  employees-register "First Last" → live `users.json` name → the entry's
  write-time snapshot → username. One resolver, `api/_lib/worker-names.js`,
  serves the hours boards (`api/time-entries-overview.js`) and the per-job
  read (`api/job-hours.js`); the register's `displayName` is greeting
  material and is never shown on a board.

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
- **INTERIM (owner pull 2026-08-15/16, while the Xero push is out of action):**
  the approved period leaves as an **email to accounts** — "Send to Tia" on
  `/hours/period` and as the phone closeout finale emails the period PDF (the
  same sheet as Download PDF) from `timesheets@buhlos.com` via
  `/api/time-entries-email`. The **recipient list on `/settings`** ("Timesheet
  emails" card, stored in `timesheet-email-settings.json`) is the switch: ≥1
  address → the send surfaces render and the Xero finale steps aside; empty →
  Xero resumes. No env var, no flag. Emailing stamps nothing; each send is
  journalled as `hours.timesheets_emailed`, each list change as
  `hours.timesheets_recipients_updated`.
  **Integrity rules for the send (2026-10-09, after the 5 Oct week that never
  went — `docs/regressions/payroll-export-blocked.md`):**
  - the sheet is only read from a **quiet period** — if any hours in the
    period changed in the last ~70s (approvals still saving, or still settling
    in the storage CDN) the server refuses with `code: 'settling'` and the
    seconds to wait, and both send surfaces **wait it out and send by
    themselves** ("still saving — it sends by itself in about N seconds");
  - the phone finale **can't send while its own approvals are saving**
    ("Saving approvals…");
  - the sheet **names everything it doesn't carry** — "Not on this sheet":
    every worker-day with no approved hours and why (waiting for approval,
    sent back for a fix, not sent in, nothing logged, on approved leave) — in
    the PDF, the email body and subject, the approved Download PDF and the
    send receipts; the phone finale names the same days before sending. A
    finished week with nothing outstanding says "Nothing left off".
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
