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
| Shell + fields | `HoursSheet.tsx` · `HmField.tsx` (h + m with steppers) · `JobTiles.tsx` (the capped grid) · `LeavePills.tsx` · `StatusPill.tsx` · `ProblemBlock.tsx` |
| Pure rules | `src/domains/timesheets/hours-view.ts` (window, OT maths, auto-advance, summary, receipts, job ranking + the tile cap, job search) |
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
  logging. A pick applies to the picked day only.
- **The job picker is a fixed, capped grid — the standard (2026-10-30).** The
  dock shows at most **3 job tiles plus a 4th "Find another job" tile** in a
  2-column grid — never more, whatever the job count — so the dock is the same
  height for 3 jobs as for 30 and the week and the Log button stay on screen
  (P10). It replaces the earlier "several jobs → chips that grow with the
  count" rule. `rankJobsByRecency` + `jobTiles` in `hours-view.ts`:
  - **Which 3:** the worker's **last logged job** (the default selection; its
    tile says "Your last job"), then the next two most recently logged. Ties
    (a split day) and never-logged jobs order by **the order the office
    assigned them, newest first** (users.json `assignedJobIds`), then by name.
    _The design asked for "assigned this week first, then most recently
    assigned"; no assigned-at date is stored, so assignment order is the
    nearest real fact and "this week" cannot be told. Add an assigned-at
    stamp before claiming it._
  - **The Find tile** reads "Find another job"; when more of the worker's own
    jobs exist beyond the 3 shown, a subline says "N more of yours" (never
    "0 more"). Its accessible name carries the count.
  - **Counts:** 1 job → no grid, the single "Job for ‹day› · Change" row.
    2 jobs → 2 tiles + Find. 3 jobs → 3 tiles + Find, no subline. 4+ → 3
    tiles + "Find another job · N more of yours".
  - **The job sheet** (behind Find, and behind Change): search at the top
    ("Job name or address, finished too" — every job, finished ones through
    the history search), then **On your week now** (the tiled jobs, the picked
    one ticked), then **Your other jobs · N** (every other assigned job with
    suburb and last-logged date, or "not logged yet"), scrolling inside the
    sheet. Picking closes the sheet and selects the job for the picked day.
  - **A found job takes the place of the oldest unpicked tile — for this
    session only.** The next load ranks the tiles from recency again; there
    is no pinning. The Log button restates the pick.
  - **Split jobs** and the **Fix sheet** use the same capped set: a split
    row's picker is the tiles plus "Find another job" (the same sheet); the
    Fix sheet's tiles lead with the job that was sent.
  - Sick day, Holiday and TAFE day are never tiles and never in search; they
    stay in the action bar (P12).
  - Tiles are a radiogroup labelled "Job for ‹day›"; the Find tile is its own
    button. Targets ≥ 44px, tiles ≥ 52px; at 130% text the tiles grow and
    labels wrap — the cap holds.
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
log on a tiled job 2 · log on a job without a tile 3 (Find → job → Log) · sick
day 2 · fix a wrong job 3 (Fix → tile → Send).

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

Owner rulings on the capped grid (2026-10-30):

7. A job picked from search **replaces a tile for the session only**, never
   permanently — the next load ranks from recency (no pinning yet).
8. With **2 jobs the Find tile still shows** (it is the only way to a
   finished job for callback work).
9. With **exactly 3 jobs the "N more" subline is left off** — nothing is
   hidden, so there is nothing to count.

## Tests

- `hours-view.test.ts` — the 14-day window, OT maths and the 16h cap, the
  weekend all-OT rule, the summary that counts only what's logged, initial
  pick + auto-advance (weekdays only, never a weekend), receipts, earlier
  weeks, job search never returning a leave day, the job tiles (recency
  first, the assignment-order tie-break, the cap at 3, a found job taking the
  oldest unpicked tile, the Find tile's words).
- `hours-save.test.ts` — refused vs unconfirmed, and Try again re-reads first
  and never sends twice (same key when it does resend).
- `PhilHoursView.render.test.tsx` — SSR smoke: every panel state, the fix line,
  the failed-load screen shows **no numbers**, 2 / 3 / 9 jobs render 3, 4 and
  4 cells (never more), the job sheet's two sections, Find another job lists
  no leave.
- Preview Smoke (`tests/playwright/helpers/fieldReadiness.ts`) drives the
  `hours-log-primary` button and asserts the POST carries the assigned job.
