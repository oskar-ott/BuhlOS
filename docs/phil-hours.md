# The Hours screen — log my hours

_Built 2026-10-25 from the Claude Design canvas "BuhlOS · Log my hours" (frames
A–O + spec), briefed in
[design-briefs/hours-logging-redesign-claude-design-brief.md](design-briefs/hours-logging-redesign-claude-design-brief.md).
It **replaced** the old Hours screen in one PR — no flag, no old/new toggle. The
old log form (the spinning day dial, the job dial, the "Custom / overtime hours"
modal, the "Log your day" card) and its fix sheet were deleted._

Constitution: P4 (what now, in three seconds — the picked day and the one
button that names it), P6 (the common case is one tap), P7 (truth over theatre
— every number is a stored sum; loading, loaded-empty and failed are three
screens), P8 (64px primary, 44px+ targets, 15–16px body), P9 (a sent-back day
leads the screen), P10 (one decision at level one; everything else one sheet
deeper), P11 (site words: Log, Send, Waiting on the office, Fix needed, OT),
P12 (leave days never sit beside jobs; every consequence is said first).

## Where things live

| Piece | File |
| --- | --- |
| Route (data + arrival params) | `src/app/phil/hours/page.tsx`, `loading.tsx` |
| The screen | `src/components/phil/hours/PhilHoursView.tsx` |
| Week rows · bottom panel · earlier weeks | `HoursWeekCard.tsx` · `HoursBottomPanel.tsx` · `EarlierWeeks.tsx` |
| Sheets | `OtSheet.tsx` (weekday OT / weekend / change) · `FindJobSheet.tsx` · `LeaveSheet.tsx` · `SplitSheet.tsx` · `DayDetailSheet.tsx` · `FixSheet.tsx` |
| Shell + fields | `HoursSheet.tsx` · `HmField.tsx` (h + m with steppers) · `JobChips.tsx` · `LeavePills.tsx` · `StatusPill.tsx` · `ProblemBlock.tsx` |
| Pure rules | `src/domains/timesheets/hours-view.ts` (window, OT maths, auto-advance, summary, receipts, job search) |
| Sending + Try again | `src/domains/timesheets/hours-save.ts` (re-read first; never send twice) |

Data is the existing model, unchanged: `GET /api/time-entries` (full history,
read in-process), `POST /api/time-entries` to log, `PATCH
/api/time-entries?date=` to change / fix / send a draft, the assigned-jobs
read, and `?scope=history` job search for finished jobs. No new fields, tables
or concepts. Payloads come from the existing builders in `service.ts` and
`resubmit.ts`.

## Hard rules the screen keeps

- **Time is hours + minutes** — `7h 36m`, `+1h OT`, `8h 36m total`. Never
  decimals, never a whole-hour grid. Inputs are h + m with steppers (`HmField`).
- **Standard day = 7h 36m.** Weekday OT is anything over it, always shown as a
  split (`7h 36m + 1h OT`). **Saturday and Sunday: every hour is OT** — there
  is no standard day; the primary reads "Set Saturday's hours →".
- **Max 16h a day** (most OT on a weekday: 8h 24m). **Loggable window: 14 days
  back, today, tomorrow.** Nothing outside it is offered (`isLoggableDate`).
- **Dates read `Thu 15 Oct`; weeks `12–18 Oct`.** Fixed tables, not Intl, so
  every phone and every test agrees (Node's en-AU says "Sept").
- **Status words, exact and everywhere** (`status-words.ts`): Not sent ·
  Waiting on the office · Approved · Fix needed. App-side: Saving… · Not
  confirmed. Always word + icon (`StatusPill`), never colour alone.
- **No assigned days.** The summary counts only what's logged: `3 days logged ·
  23h 48m` or `Nothing logged yet this week`. Never "Off", "3 of 4", "to go",
  "week done".
- **Jobs are never fixed.** Every worker can change the job for the day they're
  logging (one job → a field with Change ›; several → chips). A pick applies to
  the picked day only.
- **Office and Workshop** (owner pull 2026-11-06 — "there's no job for that,
  and it wouldn't make sense to set one up"). Two places that are not jobs sit
  last in the job chips, before Find another job, for every worker. They are
  picked, remembered ("Last time") and split ("4h Workshop + 3h 36m Smith St")
  exactly like a job, and pay as ordinary hours. They are not leave (P12 is
  untouched: leave still never sits beside jobs). Because they are always
  offered, every worker now sees chips, and a worker's one real job still
  picks itself (`soleJobId`). UI slot (P10): two chips inside the existing job
  choice, no new decision. Mechanics: reserved allocation ids `place:office` /
  `place:workshop` (`src/domains/timesheets/work-places.ts`, server twin
  `api/_lib/work-places.js`). They are not in jobs.json, pass the live-job
  check, are named "Office" / "Workshop" on every hours, payroll and export
  surface, never count on job-scoped reads (job hub, profitability), and
  mirror to Postgres as "no job" (Blob keeps the place, as with day types).
- **At most four job chips** (owner pull 2026-11-09 — "the jobs saturating the
  screen when you click on hours"). The chips sit in the sticky log panel, so
  one chip per job let a long job list cover the week. The chips now show the
  last job, then the jobs logged most recently, then the rest by name — four
  real jobs at most, plus Office and Workshop. The picked job and (in Fix) the
  sent job always show. Find another job says how many are left ("12 more jobs
  · search") and still lists every job with search. Rule: `chipJobs` /
  `CHIP_JOB_LIMIT` in `hours-view.ts`. UI slot (P10): removes chips from the
  existing job choice; adds one count line to the existing Find chip. Real
  count only (P7).
- **Every sent-back day leads This week** (owner pull 2026-11-09, restoring
  P9). The fix line counts every Fix-needed day still inside the 14-day window,
  not just this week's. An earlier week's day reads with its date ("1 day needs
  fixing · Thu 5 Nov"). The line is a button that opens the oldest one's Fix
  sheet. Before, a day sent back last week showed only inside Earlier weeks.
- **On Earlier weeks the log panel steps aside** until an earlier day is picked
  (or a save result is showing), so it no longer covers the list (and its Fix
  button) with this week's Monday. UI slot (P10): none added.
- **A worker corrects their own day while it waits** (owner pull 2026-11-09 —
  "they should be able to change it", then "fix it and audit for other
  mistakes"). A day still Waiting on the office offers "Change the job or split
  the day" in its day detail, under "Change these hours". It opens the Fix
  sheet in `mode="change"` (no office reason; "Send changed Tuesday · The
  office sees this instead"): job chips, Find another job, Sick day /
  Holiday, Split jobs, and the hours. The same sheet, sent back by the office,
  is the Fix sheet. Both now cover every correction:
  - another job (one-job day);
  - **a one-job day split across jobs** (before: Split jobs only showed for a
    day that was already split);
  - **a split day back onto one job** (pick a chip; before: impossible);
  - a job day to sick day / holiday, or back.
  Payloads are the existing `buildResubmitPayload` /
  `buildSplitResubmitPayload` / `buildDayTypeResubmitPayload`, which the
  server already accepts on a waiting day. Approved days stay locked. UI slot
  (P10): one row in the existing day-detail sheet.
- **Still needs the office:** a day logged on the **wrong date** (no delete, no
  move — owner ruling), and changing an **approved** day (locked for pay; the
  office reopens it).
- **No delete.** The day-detail sheet says: "Logged days can't be deleted.
  Change the hours instead, or ask the office."
- **No promises**: no "you'll be notified", no approval ETAs, no reviewer
  names, no queueing claims. Offline: the shell's own notice leads the screen
  ("You're offline — showing your last loaded data") and the button's sub-line
  reads "Needs signal to send · you'll see if it fails".
- **A failed load is never an empty state.** `loading.tsx` is the skeleton (no
  numbers); `loadFailed` renders the failed screen (no summary, no rows, no
  zeros); an empty week is "Nothing logged yet this week".
- **Errors sit in the slot that failed** (`ProblemBlock`: what / why / what to
  do, Try again in the same block) — the panel for the primary, the sheet
  footer for a sheet send. Words come from `problem.ts`.
- Copy never says "above", "below", "soon", "notified" or "pending". The UI
  says BuhlOS, never Phil.

## One day's states

```
Unlogged ──log──▶ Saving… ──server confirms──▶ Waiting on the office
                   │  ├── refused ───────────▶ Unlogged + error block (panel / sheet footer)
                   │  └── no answer ─────────▶ Not confirmed ──Try again──▶ re-read the day
                   │                                              ├── it's there ─▶ Waiting (no resend)
                   │                                              └── not there ─▶ Saving… (same key)
Waiting ──Change these hours──▶ Saving… ──▶ Waiting (the office sees the new hours instead)
Waiting ──office──▶ Approved (final, read-only)
Waiting ──office──▶ Fix needed ──Fix sheet──▶ Saving… ──▶ Waiting
Not sent (office draft) ──Send to the office──▶ Saving… ──▶ Waiting
```

Every attempt of one submission carries the same `Idempotency-Key`
(`useSubmissionKey`); a confirmed save clears it. `hours-save.test.ts` pins
"never sends twice".

After a save the picked day moves to the **next unlogged weekday up to today**
(`nextPickAfterSave`) — never into a weekend, never tomorrow. With none left
the panel becomes the receipt ("Saved · Thu 15 Oct · Bondi switchboard · 7h
36m · Waiting on the office · To log another day, tap it."). A confirmed save
is also journalled (`saved-entries-journal.ts`) and overlaid until the store
catches up, so the row never vanishes on refresh.

## Tap counts

Standard day 1 · Mon–Fri catch-up 5 · +1h OT 3 (Custom or OT → chip → Send) ·
log on a different listed job 2 · sick day 2 · fix a wrong job 3 (Fix → chip →
Send) · change the job on a waiting day 4 (day → Change the job or split the day → chip → Send).

## Arrival

`/phil/hours` · `?log=1` (My Day's "Log hours now" — today picked) · `?job=<id>`
(a job screen — that job picked for today) · `?fix=YYYY-MM-DD` (a sent-back day
— its Fix sheet opens; the Needs-you feed and My Day's fix card link here; the
"Hours rejected" push still lands on `/phil/my-day?fixDate=`, whose card hands
on). `/phil/my-day` no longer mounts a log form in either chrome.

## Owner rulings (2026-10-25)

The design left these open; the owner ruled on the PR, and each matches what
was built:

1. A leave day (sick / holiday / TAFE) carries **7h 36m** and pays ordinary.
2. A weekday **shorter** than 7h 36m is allowed: the Custom or OT sheet keeps
   the "Worked less than a standard day?" expander with hours worked (h + m).
3. A **split day can carry OT** — the total may exceed 7h 36m (up to 16h);
   OT is split on the day total, as the server does.
4. A **"Not sent" office draft** can be sent from its day detail ("Send
   Thursday to the office") when every job on it is still assigned.
5. A **waiting day's hours can be changed** by the worker — a job day through
   Change these hours, a leave day with plain hours (no OT).
6. **Pull-to-refresh** exists on every field screen (PhilShell).

## Tests

- `hours-view.test.ts` — the 14-day window, OT maths and the 16h cap, the
  weekend all-OT rule, the summary that counts only what's logged, initial
  pick + auto-advance (weekdays only, never a weekend), receipts, earlier
  weeks, job search never returning a leave day.
- `hours-save.test.ts` — refused vs unconfirmed, and Try again re-reads first
  and never sends twice (same key when it does resend).
- `PhilHoursView.render.test.tsx` — SSR smoke: every panel state, the fix line,
  the failed-load screen shows **no numbers**, Find another job lists no leave.
- Preview Smoke (`tests/playwright/helpers/fieldReadiness.ts`) drives the
  `hours-log-primary` button and asserts the POST carries the assigned job.
