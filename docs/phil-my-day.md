# Phil · My Day

`/phil/my-day` implements the approved final **Phil My Day** design (from the
Claude design handoff `Phil My Day.html` + `phil/myday-v2.css`) — a
payroll-focused home that opens straight into the week timesheet.

> Supersedes the interim "A · Right Now" job-hero layout. In the design session
> the user removed the job hero ("this is bad remove") and crew review; the job
> now lives only in the greeting subtitle.

## Layout (top → bottom)

1. **Greeting** — `Arvo, {firstName}` (time-of-day computed in
   `BUSINESS_TIMEZONE`: Morning / Arvo / Evening) + `{weekday day month} · on
   {job}`. The name rides on the session cookie (`session.name`, no fetch); the
   "on {job}" line shows only when there's exactly one assigned job (no
   active-job signal exists, so we never guess). Rendered on warm paper, not a
   second navy band (the shell app-bar is the only navy).
2. **Rejected-hours alert** — the most recent rejected entry with "Fix &
   resubmit". The only real "needs you" signal on this surface; kept at the top
   (a rejected day is about the hours flow right here), not the design's bottom
   slot.
3. **This week** — `PhilWeekStrip`: a Mon–Sun payroll strip with per-day hours,
   a week total, and a "Today not logged" flag. Pure logic in `philWeek.ts`.
4. **Log today's hours** — the unchanged `LogHoursSheet` (preselected via
   `initialJobId` when there's one job). Its client payload and the hours
   write/attribution path are byte-for-byte unchanged.
5. **Under construction** — the unchanged multi-job allocation note.

The centre **Capture shutter** stays on the shell (`PhilTabBar`) — present on
every Phil screen.

## Week strip states (`philWeek.ts` — all real)

| State | Meaning |
|---|---|
| `logged` | a real entry exists for that date (its hours are shown) |
| `today` | the cell is today (prompts "log now" when no entry yet) |
| `miss` | a **past weekday** with no entry — a soft "you haven't logged this" nudge, never a claim of wrongdoing |
| `off` | a weekend with no entry |
| `upcoming` | a future weekday in this week (nothing to show yet) |

Every cell is derived from the worker's real time entries + the calendar.
Nothing is fabricated. The rolling 7-day window the page already fetches always
covers this week's Monday→today, so no extra fetch is needed.

## Honesty gate — design elements NOT shipped (would be fake state)

| Design element | Why omitted |
|---|---|
| **"Submit timesheet"** (weekly batch → office) | Logging a day already creates it as `submitted` (`buildStandardDayPayload`). There is **no weekly batch-submit workflow** — the week helpers are for the *admin* approval rollup. A "Submit timesheet" button would do nothing real. |
| **"Needs you" — "Open RFI"** | RFIs don't exist in Phil (no route, no data). |
| **"Needs you" — "L2 fix is held"** | No "holds" data source feeding a cross-job My Day list. |
| **"Needs you" — "ITP ready to mark · Mark"** | No My-Day-level aggregation of "your ITPs ready to mark". ITP marking lives on the job screen. |
| **Compact job strip + "9 on site · 7:00 start · 19° clear"** | The user removed it in the design session; and start-time / weather aren't wired (weather has no integration). |

These are real product gaps (a weekly-submit workflow, an RFI surface, a
cross-job needs-you feed) — backend/feature work, not UI. They can be wired
later; until then My Day shows only what's real.

## Styling

Existing Tailwind tokens (`brand-navy` / `accent-yellow` / `surface-*` /
`state-*` = the prototype palette) and `font-display`. Per-day tone is carried
by **border + text** (the app's `state-*` tokens are solid, so no tinted fills,
matching `PhilNotice`). Inter Tight / JetBrains Mono are **not** imported (no
new font loading).

## Tests

- `philWeek.test.ts` — the week logic: Mon–Sun states, total, today
  not/logged, ISO week number, the `miss` nudge, and **no fabricated hours**.
- The hours flow + shell + Capture FAB stay covered by Preview Smoke
  (`phil.spec.ts`, `field-readiness.spec.ts`); their selectors (`phil-shell`,
  "Submit Standard day", the job radiogroup, the Capture FAB) are untouched.
